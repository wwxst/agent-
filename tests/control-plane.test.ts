import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ControlKeyring, type ControlPrincipalConfig } from '../packages/control-plane/src/auth.js';
import { startLoopbackControlServer } from '../packages/control-plane/src/index.js';
import { ManagedSessionRunner } from '../packages/session-runtime/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';

const token=()=>randomBytes(32).toString('base64url');
const finish=(text='finished')=>({type:'message_complete' as const,
  message:{role:'assistant' as const,text,toolCalls:[]},finishReason:'stop' as const});
const admin=(secret:string):ControlPrincipalConfig=>({
  principalId:'owner',bearerToken:secret,sessionIds:['sessA'],
  permissions:['command.accept','command.inspect','command.dispatch'],
});
const other=(secret:string):ControlPrincipalConfig=>({
  principalId:'reader',bearerToken:secret,sessionIds:['sessA'],
  permissions:['command.inspect'],
});
function tempDb() {
  const dir=mkdtempSync(join(tmpdir(),'control-plane-'));
  return {path:join(dir,'kernel.sqlite'),close:()=>rmSync(dir,{recursive:true,force:true})};
}
async function fixture(principals?:readonly ControlPrincipalConfig[]){
  const db=tempDb();
  const model=new FakeProvider([[finish('model-private-response')]]);
  const runner=new ManagedSessionRunner(db.path,model,new ToolRegistry());
  await runner.createSession('sessA');
  const secret=token();
  const server=await startLoopbackControlServer({
    databasePath:db.path,runner,principals:principals??[admin(secret)],
  });
  return {db,model,runner,server,secret,
    close:async()=>{await server.close();db.close();}};
}
async function json(origin:string,method:string,path:string,secret?:string,value?:unknown,
  extra:Record<string,string>={}){
  const response=await fetch(origin+path,{method,headers:{
    ...(secret===undefined?{}:{Authorization:'Bearer '+secret}),
    ...(value===undefined?{}:{'Content-Type':'application/json'}),
    ...extra,
  },...(value===undefined?{}:{body:JSON.stringify(value)})});
  const text=await response.text();
  return {status:response.status,body:JSON.parse(text) as Record<string,unknown>,
    headers:response.headers,text};
}
const acceptBody=(id='cmdA',text='super-secret-prompt')=>({
  commandId:id,kind:'turn.run',expectedSeq:1,payload:{text},
});
const base='/v1/sessions/sessA/commands';

test('M2 control: scoped authenticated HTTP accepts and dispatches exactly once without disclosing prompt',async()=>{
  const f=await fixture();
  try{
    const accepted=await json(f.server.origin,'POST',base,f.secret,acceptBody());
    assert.equal(accepted.status,200);
    assert.deepEqual((accepted.body.command as Record<string,unknown>).status,'accepted');
    assert.equal(f.model.requests.length,0);
    assert.equal(accepted.text.includes('super-secret-prompt'),false);
    const dispatched=await json(f.server.origin,'POST',base+'/cmdA/dispatch',f.secret);
    assert.equal(dispatched.status,200);
    const result=dispatched.body.dispatch as Record<string,unknown>;
    assert.equal(result.status,'completed');
    assert.equal(result.replayed,false);
    assert.equal(f.model.requests.length,1);
    assert.equal(dispatched.text.includes('super-secret-prompt'),false);
    assert.equal(dispatched.text.includes('model-private-response'),false);
    assert.equal(dispatched.text.includes(f.secret),false);
    const again=await json(f.server.origin,'POST',base+'/cmdA/dispatch',f.secret);
    assert.equal(again.status,200);
    assert.equal((again.body.dispatch as Record<string,unknown>).replayed,true);
    assert.equal((again.body.dispatch as Record<string,unknown>).turnId,result.turnId);
    assert.equal(f.model.requests.length,1);
    const read=await json(f.server.origin,'GET',base+'/cmdA',f.secret);
    assert.equal(read.status,200);
    assert.equal((read.body.dispatch as Record<string,unknown>).status,'completed');
    assert.equal(read.headers.get('cache-control'),'no-store');
    assert.equal(read.headers.get('access-control-allow-origin'),null);
  }finally{await f.close();}
});

test('M2 control: missing, wrong, malformed and case-changed bearer credentials fail before SQLite writes',async()=>{
  const f=await fixture();
  try{
    for(const key of [undefined,token(),'bad-token','bearer '+f.secret,'Bearer '+f.secret+' ']){
      const route=await json(f.server.origin,'POST',base,key===undefined?undefined:key.startsWith('bearer ')||key.startsWith('Bearer ')?undefined:key,
        acceptBody(),key?.startsWith('bearer ')||key?.startsWith('Bearer ')?{Authorization:key}:{});
      assert.equal(route.status,401,JSON.stringify(route));
      assert.deepEqual(route.body,{error:'UNAUTHENTICATED'});
    }
    const journal=new SqliteEventStore(f.db.path);
    try{assert.equal((await journal.read('sessA')).length,1);}finally{journal.close();}
    assert.equal(f.model.requests.length,0);
  }finally{await f.close();}
});

test('M2 control: session scope and permissions are independently enforced',async()=>{
  const owner=token(),reader=token();
  const f=await fixture([admin(owner),other(reader)]);
  try{
    const unauthAccept=await json(f.server.origin,'POST',base,reader,acceptBody());
    assert.equal(unauthAccept.status,403);
    const unauthDispatch=await json(f.server.origin,'POST',base+'/cmdA/dispatch',reader);
    assert.equal(unauthDispatch.status,403);
    const wrongSession=await json(f.server.origin,'POST','/v1/sessions/sessB/commands',owner,acceptBody());
    assert.equal(wrongSession.status,403);
    const wrongRead=await json(f.server.origin,'GET','/v1/sessions/sessB/commands/cmdA',reader);
    assert.equal(wrongRead.status,403);
    assert.equal(f.model.requests.length,0);
    assert.equal((await json(f.server.origin,'POST',base,owner,acceptBody())).status,200);
    const onlyRead=await json(f.server.origin,'GET',base+'/cmdA',reader);
    assert.equal(onlyRead.status,200);
    assert.equal((onlyRead.body.command as Record<string,unknown>).status,'accepted');
    assert.equal((await json(f.server.origin,'POST',base+'/cmdA/dispatch',reader)).status,403);
    assert.equal(f.model.requests.length,0);
  }finally{await f.close();}
});

test('M2 control: hostile Host and browser Origin are refused even with a valid token',async()=>{
  const f=await fixture();
  try{
    const host=await json(f.server.origin,'POST',base,f.secret,acceptBody(),'',{Host:'attacker.example'} as never);
    assert.equal(host.status,400);
    const origin=await json(f.server.origin,'POST',base,f.secret,acceptBody(),{Origin:'https://attacker.example'});
    assert.equal(origin.status,400);
    const preflight=await json(f.server.origin,'OPTIONS',base,f.secret);
    assert.equal(preflight.status,405);
    const journal=new SqliteEventStore(f.db.path);
    try{assert.equal((await journal.read('sessA')).length,1);}finally{journal.close();}
  }finally{await f.close();}
});

test('M2 control: invalid content-type, JSON, extra fields, overlimit body cannot accept commands',async()=>{
  const f=await fixture();
  try{
    assert.equal((await json(f.server.origin,'POST',base,f.secret,acceptBody(),
      {'Content-Type':'text/plain'})).status,400);
    assert.equal((await json(f.server.origin,'POST',base,f.secret,{...acceptBody(),admin:true})).status,400);
    assert.equal((await json(f.server.origin,'POST',base,f.secret,{...acceptBody(),kind:'tool.write'})).status,400);
    assert.equal((await json(f.server.origin,'POST',base,f.secret,{...acceptBody(),payload:{text:''}})).status,400);
    const huge=await fetch(f.server.origin+base,{method:'POST',headers:{
      Authorization:'Bearer '+f.secret,'Content-Type':'application/json'},
      body:'x'.repeat(75_000)});
    assert.equal(huge.status,400);
    assert.equal((await json(f.server.origin,'POST',base,f.secret,{...acceptBody(),payload:{text:'x'.repeat(40000)}})).status,400);
    const journal=new SqliteEventStore(f.db.path);
    try{assert.equal((await journal.read('sessA')).length,1);}finally{journal.close();}
  }finally{await f.close();}
});

test('M2 control: duplicate accept preserves original ACK and detects changed payload',async()=>{
  const f=await fixture();
  try{
    const first=await json(f.server.origin,'POST',base,f.secret,acceptBody());
    assert.equal(first.status,200);
    const second=await json(f.server.origin,'POST',base,f.secret,acceptBody());
    assert.equal(second.status,200);
    assert.equal((second.body.command as Record<string,unknown>).replayed,true);
    assert.equal((second.body.command as Record<string,unknown>).acceptedSeq,
      (first.body.command as Record<string,unknown>).acceptedSeq);
    const different=await json(f.server.origin,'POST',base,f.secret,acceptBody('cmdA','other text'));
    assert.equal(different.status,409);
    const journal=new SqliteEventStore(f.db.path);
    try{assert.equal((await journal.read('sessA')).length,2);}finally{journal.close();}
    assert.equal(f.model.requests.length,0);
  }finally{await f.close();}
});

test('M2 control: invalid credentials configuration fails closed before server binds',async()=>{
  const db=tempDb();
  try{
    const runner=new ManagedSessionRunner(db.path,new FakeProvider([]),new ToolRegistry());
    await runner.createSession('sessA');
    const wrong=[{...admin('guessable-short')}];
    await assert.rejects(startLoopbackControlServer({databasePath:db.path,runner,principals:wrong}),
      {code:'INVALID_CONTROL_CONFIG'});
    assert.throws(()=>new ControlKeyring([admin(token()),{...admin(token()),principalId:'owner'}]),
      {code:'INVALID_CONTROL_CONFIG'});
    const shared=token();
    assert.throws(()=>new ControlKeyring([admin(shared),{...admin(shared),principalId:'other'}]),
      {code:'INVALID_CONTROL_CONFIG'});
    assert.throws(()=>new ControlKeyring([{...admin(token()),sessionIds:['*']}]),
      {code:'INVALID_CONTROL_CONFIG'});
    assert.throws(()=>new ControlKeyring([{...admin(token()),permissions:['command.accept','command.accept']}]),
      {code:'INVALID_CONTROL_CONFIG'});
  }finally{db.close();}
});

test('M2 control: unsupported routes/methods, query strings and empty GET bodies do not touch execution',async()=>{
  const f=await fixture();
  try{
    assert.equal((await json(f.server.origin,'GET',base+'/cmdA',f.secret)).status,404);
    assert.equal((await json(f.server.origin,'GET',base+'/cmdA?leak=1',f.secret)).status,404);
    assert.equal((await json(f.server.origin,'POST',base+'/cmdA',f.secret)).status,405);
    assert.equal((await json(f.server.origin,'GET','/v1/sessions/sessA/commands/cmdA/dispatch',f.secret)).status,405);
    assert.equal((await json(f.server.origin,'POST',base+'/cmdA/dispatch',f.secret,{text:'disallowed'})).status,400);
    assert.equal(f.model.requests.length,0);
  }finally{await f.close();}
});

test('M2 control: readonly status does not require claiming writer lease',async()=>{
  const f=await fixture();
  try{
    assert.equal((await json(f.server.origin,'POST',base,f.secret,acceptBody())).status,200);
    const leases=(await import('../packages/session-leases-sqlite/src/index.js')).SqliteWriterLeaseStore;
    const ledger=new leases(f.db.path);
    const claim=ledger.acquire('sessA','busy-writer',5000);assert.ok(claim);
    try{
      const read=await json(f.server.origin,'GET',base+'/cmdA',f.secret);
      assert.equal(read.status,200);
      assert.equal((read.body.command as Record<string,unknown>).status,'accepted');
      assert.equal((await json(f.server.origin,'POST',base+'/cmdA/dispatch',f.secret)).status,409);
      assert.equal(f.model.requests.length,0);
    }finally{ledger.release(claim);ledger.close();}
  }finally{await f.close();}
});

test('M2 control: loopback server never exposes wildcard CORS, cookie sessions or tokens in status',async()=>{
  const f=await fixture();
  try{
    assert.equal((await json(f.server.origin,'POST',base,f.secret,acceptBody())).status,200);
    const read=await json(f.server.origin,'GET',base+'/cmdA',f.secret);
    assert.equal(read.status,200);
    assert.equal(read.headers.get('set-cookie'),null);
    assert.equal(read.headers.get('access-control-allow-origin'),null);
    assert.equal(read.text.includes(f.secret),false);
    assert.equal(read.text.includes('super-secret-prompt'),false);
    assert.equal(read.headers.get('x-content-type-options'),'nosniff');
  }finally{await f.close();}
});
