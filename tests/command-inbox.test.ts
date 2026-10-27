import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {SqliteWriterLeaseStore} from '../packages/session-leases-sqlite/src/index.js';
import {SqliteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {SqliteCommandInbox} from '../packages/command-inbox/src/index.js';
import {ManagedSessionRunner} from '../packages/session-runtime/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {SqliteToolReconciler} from '../packages/tool-reconciliation/src/index.js';
import {SqliteRecoveryReviewStore} from '../packages/recovery-review/src/index.js';

function tempDb(){
  const dir=mkdtempSync(join(tmpdir(),'cmd-inbox-'));
  return {path:join(dir,'journal.sqlite'),close:()=>rmSync(dir,{recursive:true,force:true})};
}
async function seed(path:string,sessionId='s'){
  const store=new SqliteWriterLeaseStore(path);
  const lease=store.acquire(sessionId,'writer-1',5000);
  assert.ok(lease);
  const journal=new SqliteEventStore(path,lease);
  await journal.append(sessionId,0,[{type:'session.created',data:{}}]);
  return {lease,store,journal,close:()=>{journal.close();store.close();}};
}
const accept=(inbox:SqliteCommandInbox,lease:NonNullable<Awaited<ReturnType<typeof seed>>['lease']>,
  commandId='command-1',kind='control.note',payload:unknown={instruction:'keep'} ,expectedSeq=1)=>
  inbox.accept({lease,commandId,kind,payload,expectedSeq});
const done={type:'message_complete' as const,
  message:{role:'assistant' as const,text:'done',toolCalls:[]},finishReason:'stop' as const};

test('M2 Inbox: fenced Runner exposes a durable command ACK without dispatch',async()=>{
  const t=tempDb();
  try{
    const fake=new FakeProvider([[done]]);
    const runner=new ManagedSessionRunner(t.path,fake,new ToolRegistry());
    await runner.createSession('s');
    const ack=await runner.acceptCommand('s',1,'m1','control.note',{text:'accepted'});
    assert.equal(ack.acceptedSeq,2);
    assert.equal(ack.replayed,false);
    assert.match(ack.fingerprint,/^[a-f0-9]{64}$/);
    assert.equal(fake.requests.length,0);
    const ledger=new SqliteCommandInbox(t.path);
    const journal=new SqliteEventStore(t.path);
    try{
      assert.equal(ledger.list('s').length,1);
      assert.deepEqual((await journal.read('s')).map(x=>x.type),['session.created','command.accepted']);
    }finally{ledger.close();journal.close();}
    assert.equal((await runner.runTurn('s','continue','t')).status,'completed');
    assert.equal(fake.requests.length,1);
    const events=new SqliteEventStore(t.path);
    try{assert.equal((await events.read('s')).filter(x=>x.type==='command.accepted').length,1);}
    finally{events.close();}
  }finally{t.close();}
});

test('M2 Inbox: duplicate after lost ACK returns original seq, never appends twice',async()=>{
  const t=tempDb();
  try{
    const runner=new ManagedSessionRunner(t.path,new FakeProvider([]),new ToolRegistry());
    await runner.createSession('s');
    const first=await runner.acceptCommand('s',1,'unique','control.note',{a:1,b:2});
    const retry=new ManagedSessionRunner(t.path,new FakeProvider([]),new ToolRegistry());
    const second=await retry.acceptCommand('s',1,'unique','control.note',{b:2,a:1});
    assert.deepEqual({...second,replayed:false},first);
    assert.equal(second.replayed,true);
    const log=new SqliteEventStore(t.path);
    try{assert.equal((await log.read('s')).length,2);}finally{log.close();}
  }finally{t.close();}
});

test('M2 Inbox: identical command ID with changed payload or kind is a hard conflict',async()=>{
  const t=tempDb(),ctx=await seed(t.path),inbox=new SqliteCommandInbox(t.path);
  try{
    accept(inbox,ctx.lease,'id','control.note',{x:1});
    assert.throws(()=>accept(inbox,ctx.lease,'id','control.note',{x:2}),{name:'ConflictError'});
    assert.throws(()=>accept(inbox,ctx.lease,'id','other.kind',{x:1}),{name:'ConflictError'});
    assert.equal(inbox.list('s').length,1);
  }finally{inbox.close();ctx.close();t.close();}
});

test('M2 Inbox: old cursor cannot admit a new command but same-ID ACK can replay',async()=>{
  const t=tempDb(),ctx=await seed(t.path),inbox=new SqliteCommandInbox(t.path);
  try{
    const a=accept(inbox,ctx.lease,'id');
    assert.equal(a.acceptedSeq,2);
    assert.throws(()=>accept(inbox,ctx.lease,'another','control.note',{},1),{name:'ConflictError'});
    assert.equal(accept(inbox,ctx.lease,'id').replayed,true);
    assert.equal(inbox.list('s').length,1);
  }finally{inbox.close();ctx.close();t.close();}
});

test('M2 Inbox: stale owner denied even for duplicate ACK; successor can replay',async()=>{
  const t=tempDb(),ctx=await seed(t.path),inbox=new SqliteCommandInbox(t.path);
  try{
    accept(inbox,ctx.lease);
    assert.equal(ctx.store.release(ctx.lease),true);
    const next=ctx.store.acquire('s','new-owner',5000);
    assert.ok(next);
    assert.throws(()=>accept(inbox,ctx.lease),{code:'LEASE_LOST'});
    assert.equal(accept(inbox,next).replayed,true);
  }finally{inbox.close();ctx.close();t.close();}
});

test('M2 Inbox: invalid JSON input never invokes getters, persists no ACK',async()=>{
  const t=tempDb(),ctx=await seed(t.path),inbox=new SqliteCommandInbox(t.path);
  let getter=0;
  try{
    const obj=Object.defineProperty({},'x',{enumerable:true,get(){getter++;return 'secret';}});
    for(const payload of [obj,NaN,Infinity,new Map(),new Array(3),(()=>{const x:any={};x.self=x;return x;})()]){
      assert.throws(()=>accept(inbox,ctx.lease,'bad','control.note',payload),{code:'INVALID_COMMAND_PAYLOAD'});
    }
    assert.throws(()=>inbox.accept({lease:ctx.lease,expectedSeq:1,
      commandId:'bad-undefined',kind:'control.note',payload:undefined}),
      {code:'INVALID_COMMAND_PAYLOAD'});
    assert.equal(getter,0);
    assert.throws(()=>accept(inbox,ctx.lease,'big','control.note',{value:'x'.repeat(70_000)}),
      {code:'COMMAND_TOO_LARGE'});
    assert.equal(inbox.list('s').length,0);
  }finally{inbox.close();ctx.close();t.close();}
});

test('M2 Inbox: SQL failure rolls back event and inbox record together',async()=>{
  const t=tempDb(),ctx=await seed(t.path),inbox=new SqliteCommandInbox(t.path);
  const raw=new DatabaseSync(t.path);
  try{
    raw.exec("CREATE TRIGGER block_command BEFORE INSERT ON session_commands BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(()=>accept(inbox,ctx.lease));
    assert.equal((await ctx.journal.read('s')).length,1);
    assert.equal(inbox.list('s').length,0);
    raw.exec('DROP TRIGGER block_command');
    const ack=accept(inbox,ctx.lease);
    assert.equal(ack.acceptedSeq,2);
  }finally{raw.close();inbox.close();ctx.close();t.close();}
});

test('M2 Inbox: corrupt ACK event does not justify idempotent response',async()=>{
  const t=tempDb(),ctx=await seed(t.path),inbox=new SqliteCommandInbox(t.path);
  try{
    accept(inbox,ctx.lease);
    const raw=new DatabaseSync(t.path);
    try{
      raw.prepare("UPDATE kernel_events SET data_json=? WHERE session_id=? AND seq=?")
        .run(JSON.stringify({commandId:'forged',kind:'control.note',fingerprint:'x'}),'s',2);
    }finally{raw.close();}
    assert.throws(()=>accept(inbox,ctx.lease),{code:'CORRUPT_EVENT_LOG'});
    assert.throws(()=>accept(inbox,ctx.lease,'new','control.note',{},2),{code:'CORRUPT_EVENT_LOG'});
  }finally{inbox.close();ctx.close();t.close();}
});

test('M2 Inbox: unfinished Turn blocks fresh acceptance with no model invocation',async()=>{
  const t=tempDb(),ctx=await seed(t.path),inbox=new SqliteCommandInbox(t.path);
  try{
    await ctx.journal.append('s',1,[
      {type:'turn.queued',turnId:'t',data:{}},
      {type:'user.message',turnId:'t',data:{text:'started'}},
      {type:'turn.started',turnId:'t',data:{}},
    ]);
    assert.throws(()=>accept(inbox,ctx.lease,'id','control.note',{},4),{code:'RECOVERY_REQUIRED'});
    assert.equal(inbox.list('s').length,0);
    assert.equal((await ctx.journal.read('s')).length,4);
  }finally{inbox.close();ctx.close();t.close();}
});

test('M2 Inbox: SIGKILL after committed ACK, same ID is deduplicated on restart',async()=>{
  const t=tempDb(),ctx=await seed(t.path);
  try{
    const moduleUrl=new URL('../packages/command-inbox/src/index.js',import.meta.url).href;
    const script=`
      const {SqliteCommandInbox}=await import(process.argv[1]);
      const inbox=new SqliteCommandInbox(process.argv[2]);
      inbox.accept(JSON.parse(process.argv[3]));
      process.kill(process.pid,'SIGKILL');
    `;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,moduleUrl,t.path,
      JSON.stringify({lease:ctx.lease,expectedSeq:1,commandId:'kill-ack',kind:'control.note',payload:{text:'persisted'}})],
      {encoding:'utf8',timeout:12000});
    assert.equal(child.error,undefined,child.stderr);
    assert.equal(child.signal,'SIGKILL',child.stderr);
    const reopened=new SqliteCommandInbox(t.path);
    try{
      const result=accept(reopened,ctx.lease,'kill-ack','control.note',{text:'persisted'});
      assert.equal(result.replayed,true);
      assert.equal(result.acceptedSeq,2);
      assert.equal(reopened.list('s').length,1);
    }finally{reopened.close();}
  }finally{ctx.close();t.close();}
});

test('M2 Inbox: session-scoped ACK is visible to reconciliation but never a Turn',async()=>{
  const t=tempDb(),ctx=await seed(t.path),inbox=new SqliteCommandInbox(t.path);
  try{
    accept(inbox,ctx.lease);
    const observer=new SqliteToolReconciler(t.path);
    try{
      const report=observer.inspect('s');
      assert.equal(report.fullyVerified,true);
      assert.equal(report.pendingTurnId,undefined);
      assert.equal(report.lastSeq,2);
      assert.equal(report.calls.length,0);
    }finally{observer.close();}
  }finally{inbox.close();ctx.close();t.close();}
});

test('M2 Inbox: new ACK invalidates previously captured review evidence',async()=>{
  const t=tempDb(),ctx=await seed(t.path),inbox=new SqliteCommandInbox(t.path);
  try{
    const observer=new SqliteToolReconciler(t.path);
    const before=observer.inspect('s');
    accept(inbox,ctx.lease);
    const after=observer.inspect('s');
    observer.close();
    assert.notEqual(before.evidenceHash,after.evidenceHash);
  }finally{inbox.close();ctx.close();t.close();}
});
