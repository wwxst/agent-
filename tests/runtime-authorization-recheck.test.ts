import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {SqliteControlAuthority} from '../packages/control-plane/src/authority.js';
import {startLoopbackControlServer} from '../packages/control-plane/src/index.js';
import {ManagedSessionRunner} from '../packages/session-runtime/src/index.js';
import {AgentKernel} from '../packages/kernel-core/src/index.js';
import {SqliteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {SqliteToolReconciler} from '../packages/tool-reconciliation/src/index.js';
import {ProcessToolHost} from '../packages/tool-host/src/index.js';
import {HostExecutionLedger} from '../packages/tool-host/src/ledger.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import type {ModelProvider} from '../packages/contracts/src/index.js';

const token=()=>randomBytes(32).toString('base64url');
function tmp(){
  const dir=mkdtempSync(join(tmpdir(),'runtime-auth-'));
  return {path:join(dir,'state.sqlite'),close:()=>rmSync(dir,{recursive:true,force:true})};
}
const credential=(bearerToken:string)=>({
  principalId:'operator',bearerToken,sessionIds:['s'],
  permissions:['command.accept','command.inspect','command.dispatch'] as const,
});
const done=(text='ok')=>({type:'message_complete' as const,
  message:{role:'assistant' as const,text,toolCalls:[]},finishReason:'stop' as const});
function deferred(){
  let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);
  return {promise,resolve};
}
async function http(origin:string,path:string,method:string,key:string,value?:unknown){
  const response=await fetch(origin+path,{method,headers:{
    Authorization:'Bearer '+key,...(value===undefined?{}:{'Content-Type':'application/json'}),
  },...(value===undefined?{}:{body:JSON.stringify(value)})});
  return {status:response.status,body:await response.json() as Record<string,unknown>};
}
const command=(text='execute')=>({expectedSeq:1,commandId:'cmd',kind:'turn.run',payload:{text}});
const commandUrl='/v1/sessions/s/commands';

test('M2 runtime auth: versioned grant accepts same revision and denies rotation or revocation',()=>{
  const t=tmp(),one=token(),next=token(),a=new SqliteControlAuthority(t.path);
  try{
    a.bootstrap([credential(one)]);
    const grant=a.authorizeGrant('Bearer '+one,'s','command.dispatch');
    assert.equal(grant.credentialVersion,1);
    a.assertGrant(grant);
    a.rotate('operator',1,next);
    assert.throws(()=>a.assertGrant(grant),{code:'AUTHORIZATION_REVOKED'});
    const replacement=a.authorizeGrant('Bearer '+next,'s','command.dispatch');
    a.assertGrant(replacement);
    a.revoke('operator',2);
    assert.throws(()=>a.assertGrant(replacement),{code:'AUTHORIZATION_REVOKED'});
    const audit=a.auditLog();
    assert.equal(audit.filter(x=>x.action==='recheck').length,4);
    assert.deepEqual(audit.filter(x=>x.action==='recheck').map(x=>x.decision),
      ['allowed','forbidden','allowed','forbidden']);
    assert.equal(JSON.stringify(audit).includes(one),false);
  }finally{a.close();t.close();}
});

test('M2 runtime auth: expired grant BEFORE first binding cannot reach model or create Turn',async()=>{
  const t=tmp(),one=token(),next=token(),a=new SqliteControlAuthority(t.path);
  try{
    a.bootstrap([credential(one)]);
    const model=new FakeProvider([[done('forbidden')]]);
    const runner=new ManagedSessionRunner(t.path,model,new ToolRegistry(),{ttlMs:500,renewEveryMs:50});
    await runner.createSession('s');
    await runner.acceptCommand('s',1,'cmd','turn.run',{text:'hello'});
    const grant=a.authorizeGrant('Bearer '+one,'s','command.dispatch');
    a.rotate('operator',1,next);
    await assert.rejects(runner.dispatchCommand('s','cmd',()=>a.assertGrant(grant)),{
      code:'AUTHORIZATION_REVOKED',
    });
    assert.equal(model.requests.length,0);
    const events=new SqliteEventStore(t.path);
    try{assert.equal((await events.read('s')).filter(e=>e.type==='command.turn_bound').length,0);}
    finally{events.close();}
  }finally{a.close();t.close();}
});

test('M2 runtime auth: HTTP revoke while model is awaiting aborts, never appends terminal',async()=>{
  const t=tmp(),key=token(),a=new SqliteControlAuthority(t.path),entered=deferred();
  let starts=0;
  const provider:ModelProvider={id:'blocked-provider',async *stream(_messages,signal){
    starts++;entered.resolve();
    await new Promise<void>(resolve=>{
      if(signal.aborted)return resolve();
      signal.addEventListener('abort',()=>resolve(),{once:true});
    });
    yield done('forbidden');
  }};
  const runner=new ManagedSessionRunner(t.path,provider,new ToolRegistry(),{
    ttlMs:600,renewEveryMs:25,
  });
  try{
    await runner.createSession('s');a.bootstrap([credential(key)]);
    const server=await startLoopbackControlServer({databasePath:t.path,runner,authority:a});
    try{
      assert.equal((await http(server.origin,commandUrl,'POST',key,command())).status,200);
      const running=http(server.origin,commandUrl+'/cmd/dispatch','POST',key);
      await entered.promise;
      a.revoke('operator',1);
      const output=await running;
      assert.equal(output.status,409);
      assert.deepEqual(output.body,{error:'AUTHORIZATION_REVOKED'});
      assert.equal(starts,1);
      const journal=new SqliteEventStore(t.path);
      try{
        const events=await journal.read('s');
        assert.equal(events.filter(e=>e.type==='model.started').length,1);
        assert.equal(events.filter(e=>e.type==='turn.completed').length,0);
        assert.equal(events.filter(e=>e.type==='turn.failed').length,0);
        const kernel=new AgentKernel(journal,new FakeProvider([]),new ToolRegistry());
        await assert.rejects(kernel.openSession('s'),{code:'RECOVERY_REQUIRED'});
      }finally{journal.close();}
      assert.equal((await http(server.origin,commandUrl+'/cmd','GET',key)).status,401);
      assert.equal(a.auditLog().some(x=>x.action==='recheck'&&x.decision==='forbidden'),true);
    }finally{await server.close();}
  }finally{a.close();t.close();}
});

test('M2 runtime auth: rotation while HTTP model is running also revokes old grant',async()=>{
  const t=tmp(),key=token(),newKey=token(),a=new SqliteControlAuthority(t.path),entered=deferred();
  let count=0;
  const provider:ModelProvider={id:'rotation-gate',async *stream(_messages,signal){
    count++;entered.resolve();
    await new Promise<void>(resolve=>{
      if(signal.aborted)return resolve();
      signal.addEventListener('abort',()=>resolve(),{once:true});
    });
    yield done('not allowed');
  }};
  const runner=new ManagedSessionRunner(t.path,provider,new ToolRegistry(),{
    ttlMs:600,renewEveryMs:25,
  });
  try{
    await runner.createSession('s');a.bootstrap([credential(key)]);
    const server=await startLoopbackControlServer({databasePath:t.path,runner,authority:a});
    try{
      assert.equal((await http(server.origin,commandUrl,'POST',key,command())).status,200);
      const running=http(server.origin,commandUrl+'/cmd/dispatch','POST',key);
      await entered.promise;
      a.rotate('operator',1,newKey);
      const outcome=await running;
      assert.equal(outcome.status,409);
      assert.equal(count,1);
      const newer=await http(server.origin,commandUrl+'/cmd/dispatch','POST',newKey);
      assert.equal(newer.status,200);
      assert.equal((newer.body.dispatch as Record<string,unknown>).replayed,true);
      assert.equal((newer.body.dispatch as Record<string,unknown>).status,'model_started');
      assert.equal(count,1);
    }finally{await server.close();}
  }finally{a.close();t.close();}
});

test('M2 runtime auth: audit storage failure fences running model, no silent continuation',async()=>{
  const t=tmp(),key=token(),a=new SqliteControlAuthority(t.path),entered=deferred();
  const provider:ModelProvider={id:'audit-fail',async *stream(_messages,signal){
    entered.resolve();
    await new Promise<void>(resolve=>{
      if(signal.aborted)return resolve();
      signal.addEventListener('abort',()=>resolve(),{once:true});
    });
    yield done('no terminal');
  }};
  const runner=new ManagedSessionRunner(t.path,provider,new ToolRegistry(),{ttlMs:600,renewEveryMs:25});
  try{
    await runner.createSession('s');a.bootstrap([credential(key)]);
    const server=await startLoopbackControlServer({databasePath:t.path,runner,authority:a});
    const db=new DatabaseSync(t.path);
    try{
      assert.equal((await http(server.origin,commandUrl,'POST',key,command())).status,200);
      const running=http(server.origin,commandUrl+'/cmd/dispatch','POST',key);
      await entered.promise;
      db.exec("CREATE TRIGGER break_check BEFORE INSERT ON control_authorization_audit WHEN NEW.action='recheck' BEGIN SELECT RAISE(ABORT,'audit_unavailable'); END");
      assert.equal((await running).status,409);
      const events=new SqliteEventStore(t.path);
      try{
        assert.equal((await events.read('s')).some(e=>e.type==='turn.completed'),false);
      }finally{events.close();}
    }finally{db.close();await server.close();}
  }finally{a.close();t.close();}
});

test('M2 runtime auth: revoke during separate Host tool execution does not certify outcome as completed',async()=>{
  const t=tmp(),key=token(),a=new SqliteControlAuthority(t.path),host=new ProcessToolHost(t.path);
  const provider=new FakeProvider([[
    {type:'message_complete',message:{role:'assistant',text:'',toolCalls:[
      {id:'sleep1',name:'read.sleep',arguments:{ms:1100}},
    ]},finishReason:'tool_use'},
  ],[done('should not happen')]]);
  const runner=new ManagedSessionRunner(t.path,provider,lease=>host.createRegistry(lease),{
    ttlMs:600,renewEveryMs:25,
  });
  try{
    await runner.createSession('s');a.bootstrap([credential(key)]);
    const server=await startLoopbackControlServer({databasePath:t.path,runner,authority:a});
    try{
      assert.equal((await http(server.origin,commandUrl,'POST',key,command())).status,200);
      const running=http(server.origin,commandUrl+'/cmd/dispatch','POST',key);
      const ledger=new HostExecutionLedger(t.path);
      try{
        let started=false;
        for(let i=0;i<150;i++){
          if(ledger.inspect('s').some(e=>e.state==='started')){started=true;break;}
          await sleep(10);
        }
        assert.equal(started,true,'Host did not begin before revoke');
      }finally{ledger.close();}
      a.revoke('operator',1);
      const output=await running;
      assert.equal(output.status,409);
      assert.equal(provider.requests.length,1);
      const observer=new SqliteToolReconciler(t.path);
      try{
        const review=observer.inspect('s');
        assert.equal(review.requiresManualReview,true);
      }finally{observer.close();}
      const store=new SqliteEventStore(t.path);
      try{assert.equal((await store.read('s')).some(e=>e.type==='turn.completed'),false);}
      finally{store.close();}
    }finally{await server.close();}
  }finally{host.close();a.close();t.close();}
});
