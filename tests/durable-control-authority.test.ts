import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {SqliteControlAuthority} from '../packages/control-plane/src/authority.js';
import {startLoopbackControlServer} from '../packages/control-plane/src/index.js';
import {ManagedSessionRunner} from '../packages/session-runtime/src/index.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';

const secret=()=>randomBytes(32).toString('base64url');
function temporary(){
  const dir=mkdtempSync(join(tmpdir(),'durable-auth-'));
  return {path:join(dir,'authority.sqlite'),done:()=>rmSync(dir,{recursive:true,force:true})};
}
const principal=(key:string,id='operator')=>({
  principalId:id,bearerToken:key,sessionIds:['session_1'],
  permissions:['command.accept','command.inspect','command.dispatch'] as const,
});
const bearer=(value:string)=>'Bearer '+value;
const authorize=(a:SqliteControlAuthority,key:string,permission='command.inspect' as const,
  sessionId='session_1')=>a.authorize(bearer(key),sessionId,permission);
const fail=(fn:()=>unknown,code:string)=>assert.throws(fn,{code});
const done={type:'message_complete' as const,
  message:{role:'assistant' as const,text:'finished',toolCalls:[]},finishReason:'stop' as const};
async function req(origin:string,path:string,method:string,token:string,body?:unknown){
  const response=await fetch(origin+path,{method,headers:{Authorization:bearer(token),
    ...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,text:await response.text()};
}

test('M2 durable authority: bootstrap and successful authorization create committed audit without secrets',()=>{
  const tmp=temporary(),key=secret(),a=new SqliteControlAuthority(tmp.path);
  try{
    a.bootstrap([principal(key)]);
    assert.equal(authorize(a,key),'operator');
    const audit=a.auditLog();
    assert.equal(audit.length,2);
    assert.deepEqual(audit.map(x=>x.action),['bootstrap','authorize']);
    assert.deepEqual(audit.map(x=>x.decision),['allowed','allowed']);
    assert.equal(audit[1]?.credentialVersion,1);
    assert.equal(audit[1]?.sessionId,'session_1');
    assert.equal(audit[1]?.permission,'command.inspect');
    const raw=new DatabaseSync(tmp.path);
    try{
      const credential=raw.prepare('SELECT token_digest,session_ids_json FROM control_credentials').get();
      assert.match(String(credential?.token_digest),/^[a-f0-9]{64}$/);
      const bytes=raw.prepare('SELECT group_concat(sql) AS ddl FROM sqlite_master').get();
      assert.equal(JSON.stringify(bytes).includes(key),false);
      const logs=raw.prepare('SELECT * FROM control_authorization_audit').all();
      assert.equal(JSON.stringify(logs).includes(key),false);
      assert.equal(JSON.stringify(credential).includes(key),false);
    }finally{raw.close();}
  }finally{a.close();tmp.done();}
});

test('M2 durable authority: wrong token, missing header, revoked token are logged as denials',()=>{
  const t=temporary(),key=secret(),a=new SqliteControlAuthority(t.path);
  try{
    a.bootstrap([principal(key)]);
    fail(()=>a.authorize(undefined,'session_1','command.inspect'),'UNAUTHENTICATED');
    fail(()=>authorize(a,secret()),'UNAUTHENTICATED');
    fail(()=>a.authorize('bearer '+key,'session_1','command.inspect'),'UNAUTHENTICATED');
    assert.deepEqual(a.auditLog().slice(1).map(x=>x.decision),
      ['unauthenticated','unauthenticated','unauthenticated']);
    assert.equal(a.inspect('operator')?.version,1);
  }finally{a.close();t.done();}
});

test('M2 durable authority: wrong session and permission are denied and durably audited',()=>{
  const t=temporary(),key=secret(),a=new SqliteControlAuthority(t.path);
  try{
    a.bootstrap([{...principal(key),permissions:['command.inspect']}]);
    fail(()=>a.authorize(bearer(key),'other','command.inspect'),'FORBIDDEN');
    fail(()=>a.authorize(bearer(key),'session_1','command.dispatch'),'FORBIDDEN');
    assert.deepEqual(a.auditLog().slice(1).map(x=>[x.decision,x.principalId]),
      [['forbidden','operator'],['forbidden','operator']]);
  }finally{a.close();t.done();}
});

test('M2 durable authority: rotating credential revokes old token immediately across open connections',()=>{
  const t=temporary(),key=secret(),next=secret(),a=new SqliteControlAuthority(t.path);
  const other=new SqliteControlAuthority(t.path);
  try{
    a.bootstrap([principal(key)]);
    assert.equal(authorize(other,key),'operator');
    const v=a.rotate('operator',1,next);
    assert.equal(v.version,2);
    assert.deepEqual(v.sessionIds,['session_1']);
    fail(()=>authorize(other,key),'UNAUTHENTICATED');
    assert.equal(authorize(other,next),'operator');
    assert.equal(other.inspect('operator')?.version,2);
    assert.equal(a.auditLog().filter(x=>x.action==='rotate').length,1);
    assert.equal(JSON.stringify(a.auditLog()).includes(next),false);
  }finally{other.close();a.close();t.done();}
});

test('M2 durable authority: permanent revocation survives close/reopen and never resurrects on bootstrap',()=>{
  const t=temporary(),key=secret();let a=new SqliteControlAuthority(t.path);
  try{
    a.bootstrap([principal(key)]);
    assert.equal(a.revoke('operator',1).version,2);
    fail(()=>authorize(a,key),'UNAUTHENTICATED');
    a.close();a=new SqliteControlAuthority(t.path);
    fail(()=>authorize(a,key),'UNAUTHENTICATED');
    fail(()=>a.bootstrap([principal(key)]),'AUTHORITY_ALREADY_BOOTSTRAPPED');
    fail(()=>a.rotate('operator',2,secret()),'CREDENTIAL_REVOKED');
    assert.equal(a.inspect('operator')?.revoked,true);
  }finally{a.close();t.done();}
});

test('M2 durable authority: stale revision prevents concurrent rotation and revocation',()=>{
  const t=temporary(),key=secret(),a=new SqliteControlAuthority(t.path),b=new SqliteControlAuthority(t.path);
  try{
    a.bootstrap([principal(key)]);
    a.rotate('operator',1,secret());
    assert.throws(()=>b.rotate('operator',1,secret()),{name:'ConflictError'});
    assert.throws(()=>b.revoke('operator',1),{name:'ConflictError'});
    assert.equal(b.inspect('operator')?.version,2);
    assert.equal(b.revoke('operator',2).revoked,true);
  }finally{b.close();a.close();t.done();}
});

test('M2 durable authority: historically used credentials cannot be reused by rotation',()=>{
  const t=temporary(),original=secret(),next=secret(),a=new SqliteControlAuthority(t.path);
  try{
    a.bootstrap([principal(original)]);
    a.rotate('operator',1,next);
    fail(()=>a.rotate('operator',2,original),'TOKEN_REUSE_FORBIDDEN');
    fail(()=>a.rotate('operator',2,next),'TOKEN_REUSE_FORBIDDEN');
    assert.equal(a.inspect('operator')?.version,2);
    assert.equal(authorize(a,next),'operator');
  }finally{a.close();t.done();}
});

test('M2 durable authority: bad configs and re-bootstrap fail without partially enrolled principals',()=>{
  const t=temporary(),key=secret(),a=new SqliteControlAuthority(t.path);
  try{
    fail(()=>a.bootstrap([principal(key),principal(key,'second')]),'INVALID_CONTROL_CONFIG');
    assert.equal(a.auditLog().length,0);
    fail(()=>a.bootstrap([{...principal(key),sessionIds:['*']}]),'INVALID_CONTROL_CONFIG');
    a.bootstrap([principal(key)]);
    fail(()=>a.bootstrap([principal(secret(),'another')]),'AUTHORITY_ALREADY_BOOTSTRAPPED');
    assert.equal(a.inspect('another'),undefined);
  }finally{a.close();t.done();}
});

test('M2 durable authority: SQL trigger audit failure rolls back allowed auth decision',()=>{
  const t=temporary(),key=secret(),a=new SqliteControlAuthority(t.path),db=new DatabaseSync(t.path);
  try{
    a.bootstrap([principal(key)]);
    db.exec("CREATE TRIGGER fail_auth BEFORE INSERT ON control_authorization_audit BEGIN SELECT RAISE(ABORT,'AUDIT_DOWN'); END");
    assert.throws(()=>authorize(a,key));
    assert.equal(a.auditLog().length,1);
    db.exec('DROP TRIGGER fail_auth');
    assert.equal(authorize(a,key),'operator');
    assert.equal(a.auditLog().length,2);
  }finally{db.close();a.close();t.done();}
});

test('M2 durable authority: rotation failure rolls back digest/version/history together',()=>{
  const t=temporary(),key=secret(),next=secret(),a=new SqliteControlAuthority(t.path),db=new DatabaseSync(t.path);
  try{
    a.bootstrap([principal(key)]);
    db.exec("CREATE TRIGGER fail_rotation BEFORE UPDATE ON control_credentials BEGIN SELECT RAISE(ABORT,'FAILED'); END");
    assert.throws(()=>a.rotate('operator',1,next));
    assert.equal(a.inspect('operator')?.version,1);
    assert.equal(authorize(a,key),'operator');
    db.exec('DROP TRIGGER fail_rotation');
    const row=db.prepare("SELECT COUNT(*) AS n FROM control_credential_history").get();
    assert.equal(row?.n,1);
    a.rotate('operator',1,next);
    fail(()=>authorize(a,key),'UNAUTHENTICATED');
    assert.equal(authorize(a,next),'operator');
  }finally{db.close();a.close();t.done();}
});

test('M2 durable authority: HTTP control uses current SQLite credentials after rotation/revocation',async()=>{
  const t=temporary(),key=secret(),next=secret(),authority=new SqliteControlAuthority(t.path);
  const provider=new FakeProvider([[done]]);
  const runner=new ManagedSessionRunner(t.path,provider,new ToolRegistry());
  await runner.createSession('session_1');
  authority.bootstrap([principal(key)]);
  const server=await startLoopbackControlServer({databasePath:t.path,runner,authority});
  try{
    const base='/v1/sessions/session_1/commands';
    const p={commandId:'cmd',expectedSeq:1,kind:'turn.run',payload:{text:'hidden prompt'}};
    const bad=await req(server.origin,base,'POST',secret(),p);
    assert.equal(bad.status,401);
    const first=await req(server.origin,base,'POST',key,p);
    assert.equal(first.status,200);
    authority.rotate('operator',1,next);
    const old=await req(server.origin,base+'/cmd/dispatch','POST',key);
    assert.equal(old.status,401);
    assert.equal(provider.requests.length,0);
    const allowed=await req(server.origin,base+'/cmd/dispatch','POST',next);
    assert.equal(allowed.status,200);
    assert.equal(provider.requests.length,1);
    authority.revoke('operator',2);
    const blocked=await req(server.origin,base+'/cmd','GET',next);
    assert.equal(blocked.status,401);
    const rows=authority.auditLog();
    assert.equal(rows.filter(r=>r.action==='authorize').length,5);
    assert.equal(JSON.stringify(rows).includes(key),false);
    assert.equal(JSON.stringify(rows).includes(next),false);
    assert.equal(JSON.stringify(rows).includes('hidden prompt'),false);
  }finally{await server.close();authority.close();t.done();}
});

test('M2 durable authority: server rejects both legacy and durable configured simultaneously',async()=>{
  const t=temporary(),key=secret(),authority=new SqliteControlAuthority(t.path);
  try{
    authority.bootstrap([principal(key)]);
    const runner=new ManagedSessionRunner(t.path,new FakeProvider([]),new ToolRegistry());
    await runner.createSession('session_1');
    await assert.rejects(startLoopbackControlServer({
      databasePath:t.path,runner,authority,principals:[principal(key)],
    }),{code:'INVALID_CONTROL_CONFIG'});
    await assert.rejects(startLoopbackControlServer({
      databasePath:t.path,runner,
    }),{code:'INVALID_CONTROL_CONFIG'});
  }finally{authority.close();t.done();}
});


test('M2 durable authority: SIGKILL immediately after committed revoke leaves token permanently denied',()=>{
  const t=temporary(),key=secret(),a=new SqliteControlAuthority(t.path);
  try{
    a.bootstrap([principal(key)]);
    a.close();
    const url=new URL('../packages/control-plane/src/authority.js',import.meta.url).href;
    const script=`
      const {SqliteControlAuthority}=await import(process.argv[1]);
      const store=new SqliteControlAuthority(process.argv[2]);
      store.revoke('operator',1);
      process.kill(process.pid,'SIGKILL');
    `;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,url,t.path],
      {timeout:12000,encoding:'utf8'});
    assert.equal(child.error,undefined,child.stderr);
    assert.equal(child.signal,'SIGKILL',child.stderr);
    const again=new SqliteControlAuthority(t.path);
    try{
      fail(()=>authorize(again,key),'UNAUTHENTICATED');
      assert.equal(again.inspect('operator')?.version,2);
      const rows=again.auditLog();
      assert.equal(rows.filter(x=>x.action==='revoke').length,1);
      assert.equal(rows.filter(x=>x.action==='authorize'&&x.decision==='unauthenticated').length,1);
    }finally{again.close();}
  }finally{t.done();}
});
