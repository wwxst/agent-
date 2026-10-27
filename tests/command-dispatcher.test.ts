import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ManagedSessionRunner } from '../packages/session-runtime/src/index.js';
import { SqliteCommandInbox } from '../packages/command-inbox/src/index.js';
import { SqliteCommandDispatcher } from '../packages/command-dispatcher/src/index.js';
import { inspectTurnBindings } from '../packages/command-dispatcher/src/audit.js';
import { SqliteWriterLeaseStore } from '../packages/session-leases-sqlite/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { SqliteToolReconciler } from '../packages/tool-reconciliation/src/index.js';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';
import { ProcessToolHost } from '../packages/tool-host/src/index.js';
import { HostExecutionLedger } from '../packages/tool-host/src/ledger.js';

function tempDb() {
  const dir=mkdtempSync(join(tmpdir(),'command-dispatch-'));
  return {path:join(dir,'events.sqlite'),close:()=>rmSync(dir,{recursive:true,force:true})};
}
const done=(text='done')=>({type:'message_complete' as const,
  message:{role:'assistant' as const,text,toolCalls:[]},finishReason:'stop' as const});
async function accepted(path:string,commandId='command-1',kind='turn.run',
  payload:unknown={text:'execute once'}) {
  const provider=new FakeProvider([]);
  const runner=new ManagedSessionRunner(path,provider,new ToolRegistry());
  await runner.createSession('session');
  const ack=await runner.acceptCommand('session',1,commandId,kind,payload);
  return {runner,ack};
}

test('M2 dispatcher: ACK binds to one Turn atomically and model runs once',async()=>{
  const tmp=tempDb();
  try {
    const {ack}=await accepted(tmp.path);
    const provider=new FakeProvider([[done('completed')]]);
    const runner=new ManagedSessionRunner(tmp.path,provider,new ToolRegistry());
    const first=await runner.dispatchCommand('session','command-1');
    assert.equal(first.dispatch.replayed,false);
    assert.equal(first.dispatch.status,'completed');
    assert.equal(first.dispatch.acceptedSeq,ack.acceptedSeq);
    assert.equal(first.execution?.status,'completed');
    assert.equal(provider.requests.length,1);
    const events=new SqliteEventStore(tmp.path);
    try{
      const history=await events.read('session');
      assert.deepEqual(history.slice(1,7).map(e=>e.type),[
        'command.accepted','command.turn_bound','turn.queued',
        'user.message','turn.started','model.started']);
      const bindings=inspectTurnBindings(history);
      assert.equal(bindings.length,1);
      assert.equal(bindings[0]?.turnId,first.dispatch.turnId);
      assert.equal(bindings[0]?.text,'execute once');
      assert.equal(history.filter(e=>e.type==='user.message').length,1);
      assert.equal(history.filter(e=>e.type==='turn.queued').length,1);
      assert.equal(history.filter(e=>e.type==='turn.completed').length,1);
    }finally{events.close();}
    const duplicate=await runner.dispatchCommand('session','command-1');
    assert.equal(duplicate.dispatch.turnId,first.dispatch.turnId);
    assert.equal(duplicate.dispatch.replayed,true);
    assert.equal(duplicate.dispatch.status,'completed');
    assert.equal(duplicate.execution,undefined);
    assert.equal(provider.requests.length,1);
  }finally{tmp.close();}
});

test('M2 dispatcher: new runner after lost execution ACK only reports original completed Turn',async()=>{
  const tmp=tempDb();
  try {
    await accepted(tmp.path);
    const provider=new FakeProvider([[done()]]);
    const first=new ManagedSessionRunner(tmp.path,provider,new ToolRegistry());
    const initial=await first.dispatchCommand('session','command-1');
    const second=new ManagedSessionRunner(tmp.path,new FakeProvider([]),new ToolRegistry());
    const response=await second.dispatchCommand('session','command-1');
    assert.equal(response.dispatch.turnId,initial.dispatch.turnId);
    assert.equal(response.dispatch.status,'completed');
    assert.equal(response.dispatch.replayed,true);
    assert.equal(response.execution,undefined);
  }finally{tmp.close();}
});

test('M2 dispatcher: unaccepted or non turn.run commands never enter a Turn',async()=>{
  const tmp=tempDb();
  try{
    const {runner}=await accepted(tmp.path,'note','control.note',{instruction:'do not run'});
    await assert.rejects(runner.dispatchCommand('session','unknown'),{code:'UNKNOWN_COMMAND'});
    await assert.rejects(runner.dispatchCommand('session','note'),{code:'UNSUPPORTED_COMMAND'});
    const journal=new SqliteEventStore(tmp.path);
    try{assert.equal((await journal.read('session')).some(e=>e.type==='turn.queued'),false);}
    finally{journal.close();}
  }finally{tmp.close();}
});

test('M2 dispatcher: malformed run payload rejected without creating Turn or binding',async()=>{
  const tmp=tempDb();
  try{
    await accepted(tmp.path,'bad','turn.run',{unexpected:'text'});
    const dispatcher=new ManagedSessionRunner(tmp.path,new FakeProvider([]),new ToolRegistry());
    await assert.rejects(dispatcher.dispatchCommand('session','bad'),{code:'INVALID_DISPATCH_PAYLOAD'});
    const journal=new SqliteEventStore(tmp.path);
    try{assert.equal((await journal.read('session')).length,2);}
    finally{journal.close();}
  }finally{tmp.close();}
});

test('M2 dispatcher: binding is atomic when ledger INSERT fails halfway',async()=>{
  const tmp=tempDb();
  try{
    await accepted(tmp.path);
    const raw=new DatabaseSync(tmp.path);
    // Initialize target schema before injecting failure.
    const init=new SqliteCommandDispatcher(tmp.path);init.close();
    raw.exec("CREATE TRIGGER block_dispatch BEFORE INSERT ON command_turn_dispatches BEGIN SELECT RAISE(ABORT,'injected'); END");
    const runner=new ManagedSessionRunner(tmp.path,new FakeProvider([]),new ToolRegistry());
    try{
      await assert.rejects(runner.dispatchCommand('session','command-1'));
      const j=new SqliteEventStore(tmp.path);
      try{assert.equal((await j.read('session')).length,2);}
      finally{j.close();}
      raw.exec('DROP TRIGGER block_dispatch');
      const newRunner=new ManagedSessionRunner(tmp.path,new FakeProvider([[done()]]),new ToolRegistry());
      assert.equal((await newRunner.dispatchCommand('session','command-1')).execution?.status,'completed');
    }finally{raw.close();}
  }finally{tmp.close();}
});

test('M2 dispatcher: bind committed then process SIGKILL before model start remains admitted, never executes on retry',async()=>{
  const tmp=tempDb();
  try{
    await accepted(tmp.path);
    const moduleUrl=new URL('../packages/command-dispatcher/src/index.js',import.meta.url).href;
    const leaseUrl=new URL('../packages/session-leases-sqlite/src/index.js',import.meta.url).href;
    const script=`
      const [{SqliteCommandDispatcher},{SqliteWriterLeaseStore}]=await Promise.all(
        [import(process.argv[1]),import(process.argv[2])]);
      const store=new SqliteWriterLeaseStore(process.argv[3]);
      const claim=store.acquire('session','crashed-owner',100);
      if(!claim)process.exit(18);
      const d=new SqliteCommandDispatcher(process.argv[3]);
      d.bind({lease:claim,commandId:'command-1',expectedSeq:2});
      process.kill(process.pid,'SIGKILL');
    `;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,moduleUrl,leaseUrl,tmp.path],
      {encoding:'utf8',timeout:12000});
    assert.equal(child.error,undefined,child.stderr);
    assert.equal(child.signal,'SIGKILL',child.stderr);
    const dispatcher=new SqliteCommandDispatcher(tmp.path);
    let bound;
    try{
      bound=dispatcher.inspect('session','command-1');
      assert.equal(bound?.status,'admitted');
      assert.equal(bound?.boundSeq,3);
    }finally{dispatcher.close();}
    const fake=new FakeProvider([[done('forbidden')]]);
    const runner=new ManagedSessionRunner(tmp.path,fake,new ToolRegistry());
    // Another writer may still own the short-lived lease until expiry.
    // Release it for the test; this is not a recovery authorization.
    const db=new DatabaseSync(tmp.path);
    try{
      // Explicit crash fixture: force the orphaned test lease to expire;
      // never synthesize a current owner's lease token.
      db.prepare("UPDATE session_writer_leases SET expires_at_ms=0 WHERE session_id=? AND owner_id=?")
        .run('session','crashed-owner');
    }finally{db.close();}
    const response=await runner.dispatchCommand('session','command-1');
    assert.equal(response.dispatch.turnId,bound?.turnId);
    assert.equal(response.dispatch.status,'admitted');
    assert.equal(response.execution,undefined);
    assert.equal(fake.requests.length,0);
  }finally{tmp.close();}
});

test('M2 dispatcher: model.started is a hard replay barrier after an interrupted execution',async()=>{
  const tmp=tempDb();
  try{
    await accepted(tmp.path);
    const leases=new SqliteWriterLeaseStore(tmp.path);
    const lease=leases.acquire('session','manual',5000);assert.ok(lease);
    const dispatcher=new SqliteCommandDispatcher(tmp.path);
    let turnId='';
    try{
      const bound=dispatcher.bind({lease,commandId:'command-1',expectedSeq:2});
      turnId=bound.turnId;
      const journal=new SqliteEventStore(tmp.path,lease);
      try{await journal.append('session',6,[{type:'model.started',turnId,data:{step:1}}]);}
      finally{journal.close();}
    }finally{dispatcher.close();assert.equal(leases.release(lease),true);leases.close();}
    const fake=new FakeProvider([[done('must not happen')]]);
    const runner=new ManagedSessionRunner(tmp.path,fake,new ToolRegistry());
    const result=await runner.dispatchCommand('session','command-1');
    assert.equal(result.dispatch.status,'model_started');
    assert.equal(result.dispatch.turnId,turnId);
    assert.equal(result.execution,undefined);
    assert.equal(fake.requests.length,0);
  }finally{tmp.close();}
});

test('M2 dispatcher: old fencing token cannot bind even after new owner takes over',async()=>{
  const tmp=tempDb();
  try{
    await accepted(tmp.path);
    const leases=new SqliteWriterLeaseStore(tmp.path);
    const old=leases.acquire('session','old-owner',5000);assert.ok(old);
    assert.equal(leases.release(old),true);
    const successor=leases.acquire('session','new-owner',5000);assert.ok(successor);
    const dispatcher=new SqliteCommandDispatcher(tmp.path);
    try{
      assert.throws(()=>dispatcher.bind({lease:old,commandId:'command-1',expectedSeq:2}),{code:'LEASE_LOST'});
      const fresh=dispatcher.bind({lease:successor,commandId:'command-1',expectedSeq:2});
      assert.equal(fresh.status,'admitted');
      assert.throws(()=>dispatcher.bind({lease:old,commandId:'command-1',expectedSeq:2}),{code:'LEASE_LOST'});
      assert.equal(dispatcher.bind({lease:successor,commandId:'command-1',expectedSeq:2}).replayed,true);
    }finally{dispatcher.close();leases.close();}
  }finally{tmp.close();}
});

test('M2 dispatcher: same session cannot admit new Turn while prior dispatched Turn is unresolved',async()=>{
  const tmp=tempDb();
  try{
    const {runner}=await accepted(tmp.path);
    const secondAck=await runner.acceptCommand('session',2,'next','turn.run',{text:'second'});
    assert.equal(secondAck.acceptedSeq,3);
    const leases=new SqliteWriterLeaseStore(tmp.path);
    const lease=leases.acquire('session','owner',5000);assert.ok(lease);
    const dispatcher=new SqliteCommandDispatcher(tmp.path);
    try{
      const initial=dispatcher.bind({lease,commandId:'command-1',expectedSeq:3});
      assert.equal(initial.status,'admitted');
      assert.throws(()=>dispatcher.bind({lease,commandId:'next',expectedSeq:7}),{code:'RECOVERY_REQUIRED'});
    }finally{dispatcher.close();leases.close();}
  }finally{tmp.close();}
});

test('M2 dispatcher: corrupted binding journal is rejected by Kernel, reconciler and dispatcher',async()=>{
  const tmp=tempDb();
  try{
    await accepted(tmp.path);
    const leases=new SqliteWriterLeaseStore(tmp.path);
    const lease=leases.acquire('session','writer',5000);assert.ok(lease);
    const dispatcher=new SqliteCommandDispatcher(tmp.path);
    try{dispatcher.bind({lease,commandId:'command-1',expectedSeq:2});}
    finally{dispatcher.close();leases.release(lease);leases.close();}
    const raw=new DatabaseSync(tmp.path);
    try{
      raw.prepare("UPDATE kernel_events SET data_json=? WHERE session_id='session' AND seq=5")
        .run(JSON.stringify({text:'forged'}));
    }finally{raw.close();}
    const j=new SqliteEventStore(tmp.path);
    try{
      const kernel=new AgentKernel(j,new FakeProvider([]),new ToolRegistry());
      await assert.rejects(kernel.openSession('session'),{code:'CORRUPT_COMMAND_DISPATCH'});
    }finally{j.close();}
    const view=new SqliteToolReconciler(tmp.path);
    try{assert.throws(()=>view.inspect('session'),{code:'CORRUPT_COMMAND_DISPATCH'});}
    finally{view.close();}
    const insp=new SqliteCommandDispatcher(tmp.path);
    try{assert.throws(()=>insp.inspect('session','command-1'),{code:'CORRUPT_COMMAND_DISPATCH'});}
    finally{insp.close();}
  }finally{tmp.close();}
});

test('M2 dispatcher: real separate Host ToolCall retains one Intent/Receipt across duplicate delivery',async()=>{
  const tmp=tempDb(),host=new ProcessToolHost(tmp.path);
  try{
    const create=new ManagedSessionRunner(tmp.path,new FakeProvider([]),new ToolRegistry());
    await create.createSession('session');
    await create.acceptCommand('session',1,'command-1','turn.run',{text:'echo'});
    const provider=new FakeProvider([[
      {type:'message_complete',message:{role:'assistant',text:'',toolCalls:[
        {id:'call',name:'read.echo',arguments:{text:'echo-result'}},
      ]},finishReason:'tool_use'},
    ],[done('finished')]]);
    const runner=new ManagedSessionRunner(tmp.path,provider,lease=>host.createRegistry(lease));
    const first=await runner.dispatchCommand('session','command-1');
    assert.equal(first.execution?.status,'completed');
    assert.equal(first.dispatch.status,'completed');
    const second=await runner.dispatchCommand('session','command-1');
    assert.equal(second.dispatch.turnId,first.dispatch.turnId);
    assert.equal(second.execution,undefined);
    assert.equal(provider.requests.length,2);
    const j=new SqliteEventStore(tmp.path),ledger=new HostExecutionLedger(tmp.path);
    try {
      const events=await j.read('session');
      assert.equal(events.filter(e=>e.type==='tool.intent').length,1);
      assert.equal(events.filter(e=>e.type==='tool.receipt').length,1);
      assert.equal(ledger.inspect('session').length,1);
    }finally{j.close();ledger.close();}
  }finally{host.close();tmp.close();}
});

test('M2 dispatcher: already failed Turn remains terminal and cannot be executed again',async()=>{
  const tmp=tempDb();
  try{
    await accepted(tmp.path);
    const provider=new FakeProvider([]);
    const runner=new ManagedSessionRunner(tmp.path,provider,new ToolRegistry());
    const first=await runner.dispatchCommand('session','command-1');
    assert.equal(first.execution?.status,'failed');
    const second=await runner.dispatchCommand('session','command-1');
    assert.equal(second.dispatch.status,'failed');
    assert.equal(second.execution,undefined);
    assert.equal(provider.requests.length,1);
  }finally{tmp.close();}
});
