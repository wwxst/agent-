import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { KernelEvent, EventDraft } from '../packages/contracts/src/index.js';
import { SqliteWriterLeaseStore, type WriterLease } from '../packages/session-leases-sqlite/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { ProcessToolHost } from '../packages/tool-host/src/index.js';
import { HostExecutionLedger, type HostCall, type HostLedgerEntry } from '../packages/tool-host/src/ledger.js';
import { ManagedSessionRunner } from '../packages/session-runtime/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { MemoryEventStore } from '../packages/event-store-memory/src/index.js';
import { SqliteToolReconciler, reconcileSnapshot } from '../packages/tool-reconciliation/src/index.js';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dual-ledger-'));
  return { path: join(dir, 'events.sqlite'), cleanup: () => rmSync(dir,{recursive:true,force:true}) };
}
async function seedIntent(path: string, lease: WriterLease, tool = 'read.echo',
  input: unknown = {text:'hello'}, callId = 'call', turnId = 'turn'): Promise<HostCall> {
  const store = new SqliteEventStore(path,lease);
  try {
    await store.append(lease.sessionId,0,[
      {type:'session.created',data:{}},
      {type:'turn.queued',turnId,data:{}},
      {type:'user.message',turnId,data:{text:'hello'}},
      {type:'turn.started',turnId,data:{}},
      {type:'assistant.message',turnId,data:{
        role:'assistant',text:'',toolCalls:[{id:callId,name:tool,arguments:input}],
      }},
      {type:'tool.intent',turnId,data:{callId,name:tool,step:1}},
    ]);
  } finally {store.close();}
  return {lease,turnId,callId,name:tool,input};
}
async function append(path: string, lease: WriterLease, drafts: readonly EventDraft[]) {
  const store = new SqliteEventStore(path,lease);
  try {
    const events = await store.read(lease.sessionId);
    await store.append(lease.sessionId,events.length,drafts);
  } finally {store.close();}
}
const finish = (text = 'done') => ({
  type:'message_complete' as const,
  message:{role:'assistant' as const,text,toolCalls:[]},
  finishReason:'stop' as const,
});
const invoke = (id='c') => ({
  type:'message_complete' as const,
  message:{role:'assistant' as const,text:'',toolCalls:[
    {id,name:'read.echo',arguments:{text:'hello'}},
  ]},
  finishReason:'tool_use' as const,
});

test('M1 reconciliation: normal real-process host + Kernel receipts verify on single read-only snapshot',async()=>{
  const tmp=tempDb(),host=new ProcessToolHost(tmp.path);
  try {
    const runner = new ManagedSessionRunner(tmp.path,
      new FakeProvider([[invoke()],[finish()]]),lease=>host.createRegistry(lease));
    await runner.createSession('verified');
    assert.equal((await runner.runTurn('verified','run','turn')).status,'completed');
    const inspector=new SqliteToolReconciler(tmp.path);
    try {
      const a=inspector.inspect('verified');
      assert.equal(a.pendingTurnId,undefined);
      assert.equal(a.requiresManualReview,false);
      assert.equal(a.fullyVerified,true);
      assert.deepEqual(a.calls.map(e=>[e.status,e.hostState,e.kernelOutcome,e.requiresManualReview]),
        [['verified','succeeded','succeeded',false]]);
      const b=inspector.inspect('verified');
      assert.deepEqual(b,a);
      assert.ok(b.lastSeq>6);
    } finally {inspector.close();}
  } finally {host.close();tmp.cleanup();}
});

test('M1 reconciliation: intent exists but no Host STARTED still cannot prove safe retry',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('unclaimed','a',5000);
    assert.ok(lease);
    await seedIntent(tmp.path,lease);
    const inspector=new SqliteToolReconciler(tmp.path);
    try {
      const report=inspector.inspect('unclaimed');
      assert.equal(report.pendingTurnId,'turn');
      assert.equal(report.calls[0]?.status,'intent_without_host');
      assert.equal(report.calls[0]?.kernelOutcome,'missing');
      assert.equal(report.calls[0]?.hostState,'missing');
      assert.equal(report.fullyVerified,false);
      assert.equal(report.requiresManualReview,true);
    } finally {inspector.close();}
  } finally {leases.close();tmp.cleanup();}
});

test('M1 reconciliation: STARTED without receipt is unresolved after process failure',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('started','a',5000);
    assert.ok(lease);
    const call=await seedIntent(tmp.path,lease);
    const host=new HostExecutionLedger(tmp.path);
    try {
      host.begin(call);
    } finally {host.close();}
    const view=new SqliteToolReconciler(tmp.path);
    try {
      const report=view.inspect('started');
      assert.equal(report.calls[0]?.status,'host_started');
      assert.equal(report.calls[0]?.hostFenceToken,lease.fenceToken);
      assert.equal(report.requiresManualReview,true);
    } finally {view.close();}
  } finally {leases.close();tmp.cleanup();}
});

test('M1 reconciliation: Host succeeded but Kernel receipt absent remains unresolved',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('gap','a',5000);
    assert.ok(lease);
    const call=await seedIntent(tmp.path,lease);
    const ledger=new HostExecutionLedger(tmp.path);
    try {
      ledger.begin(call);
      ledger.finish(call,'succeeded','hello');
    } finally {ledger.close();}
    const view=new SqliteToolReconciler(tmp.path);
    try {
      const report=view.inspect('gap');
      assert.equal(report.calls[0]?.status,'host_finished_without_receipt');
      assert.equal(report.calls[0]?.hostState,'succeeded');
      assert.equal(report.calls[0]?.kernelOutcome,'missing');
      assert.equal(report.requiresManualReview,true);
    } finally {view.close();}
  } finally {leases.close();tmp.cleanup();}
});

test('M1 reconciliation: complete Host + Kernel receipts with conflicting content are flagged',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('mismatch','a',5000);
    assert.ok(lease);
    const call=await seedIntent(tmp.path,lease);
    const ledger=new HostExecutionLedger(tmp.path);
    try {
      ledger.begin(call);
      ledger.finish(call,'succeeded','actual Host result');
    } finally {ledger.close();}
    await append(tmp.path,lease,[
      {type:'tool.receipt',turnId:'turn',data:{callId:'call',name:'read.echo',outcome:'succeeded',content:'tampered'}},
      {type:'tool.result',turnId:'turn',data:{callId:'call',name:'read.echo',outcome:'succeeded',content:'tampered'}},
      {type:'turn.completed',turnId:'turn',data:{}},
    ]);
    const view=new SqliteToolReconciler(tmp.path);
    try {
      const report=view.inspect('mismatch');
      assert.equal(report.pendingTurnId,undefined);
      assert.equal(report.calls[0]?.status,'mismatch');
      assert.equal(report.requiresManualReview,true);
      assert.equal(report.fullyVerified,false);
    } finally {view.close();}
  } finally {leases.close();tmp.cleanup();}
});

test('M1 reconciliation: legacy in-process Kernel receipt is NOT Host-attested',async()=>{
  const store=new MemoryEventStore();
  const registry=new ToolRegistry();
  registry.register({name:'read',version:'1',risk:'read',concurrency:'parallel',
    parse:x=>x,execute:async()=> 'ok'});
  const provider=new FakeProvider([[
    {type:'message_complete',message:{role:'assistant',text:'',toolCalls:[
      {id:'plain',name:'read',arguments:{}},
    ]},finishReason:'tool_use'},
  ],[finish()]]);
  const kernel=new AgentKernel(store,provider,registry);
  await kernel.createSession('plain');
  assert.equal((await kernel.runTurn('plain','hello','t')).status,'completed');
  const events=await store.read('plain');
  const report=reconcileSnapshot('plain',events,[]);
  assert.equal(report.pendingTurnId,undefined);
  assert.equal(report.calls[0]?.status,'kernel_receipt_without_host');
  assert.equal(report.requiresManualReview,true);
  assert.equal(report.fullyVerified,false);
});

test('M1 reconciliation: explicit outcome_unknown cannot be normalized by successful Host row',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('unknown','a',5000);
    assert.ok(lease);
    const call=await seedIntent(tmp.path,lease);
    const ledger=new HostExecutionLedger(tmp.path);
    try {ledger.begin(call);ledger.finish(call,'succeeded','hello');}
    finally {ledger.close();}
    await append(tmp.path,lease,[
      {type:'tool.receipt',turnId:'turn',data:{callId:'call',name:'read.echo',outcome:'outcome_unknown',content:'uncertain'}},
      {type:'tool.result',turnId:'turn',data:{callId:'call',name:'read.echo',outcome:'outcome_unknown',content:'uncertain'}},
      {type:'turn.failed',turnId:'turn',data:{}},
    ]);
    const view=new SqliteToolReconciler(tmp.path);
    try {
      const report=view.inspect('unknown');
      assert.equal(report.calls[0]?.status,'kernel_outcome_unknown');
      assert.equal(report.requiresManualReview,true);
    } finally {view.close();}
  } finally {leases.close();tmp.cleanup();}
});

test('M1 reconciliation: orphan Host row is conspicuous, not treated as successful journal call',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('orphan','a',5000);
    assert.ok(lease);
    const store=new SqliteEventStore(tmp.path,lease);
    try {await store.append('orphan',0,[{type:'session.created',data:{}}]);}
    finally {store.close();}
    // This is a deliberately tampered Host ledger row; initialize the schema
    // but never call Host.begin(), which correctly rejects orphan requests.
    const init=new HostExecutionLedger(tmp.path);
    init.close();
    const db=new DatabaseSync(tmp.path);
    try {
      db.prepare(`
        INSERT INTO host_tool_executions(session_id,turn_id,call_id,tool_name,fence_token,state,content)
        VALUES (?, ?, ?, ?, ?, 'started', NULL)
      `).run('orphan','ghost','c','read.echo',lease.fenceToken);
    } finally {db.close();}
    const view=new SqliteToolReconciler(tmp.path);
    try {
      const report=view.inspect('orphan');
      assert.equal(report.calls[0]?.status,'orphan_host');
      assert.equal(report.calls[0]?.hostState,'started');
      assert.equal(report.requiresManualReview,true);
    } finally {view.close();}
  } finally {leases.close();tmp.cleanup();}
});

test('M1 reconciliation: session not found and corrupted journal both fail closed',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('corrupt','a',5000);
    assert.ok(lease);
    const db=new SqliteEventStore(tmp.path,lease);
    try {
      await db.append('corrupt',0,[{type:'session.created',data:{}},
        {type:'turn.queued',turnId:'t',data:{}},
        {type:'turn.queued',turnId:'other',data:{}}]);
    } finally {db.close();}
    const view=new SqliteToolReconciler(tmp.path);
    try {
      assert.throws(()=>view.inspect('missing'),{code:'UNKNOWN_SESSION'});
      assert.throws(()=>view.inspect('corrupt'),{code:'CORRUPT_EVENT_LOG'});
      assert.throws(()=>view.inspect(''),{code:'INVALID_SESSION'});
    } finally {view.close();}
  } finally {leases.close();tmp.cleanup();}
});

test('M1 reconciliation: readonly observer does not change any persisted rows or fence token',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('unmodified','a',5000);
    assert.ok(lease);
    await seedIntent(tmp.path,lease);
    // Existing empty host table must remain untouched by readonly inspection.
    const init=new HostExecutionLedger(tmp.path);
    init.close();
    const db=new DatabaseSync(tmp.path);
    let eventsBefore: unknown, leasesBefore: unknown;
    try {
      eventsBefore=db.prepare('SELECT * FROM kernel_events ORDER BY seq').all();
      leasesBefore=db.prepare('SELECT * FROM session_writer_leases').all();
    } finally {db.close();}
    const inspector=new SqliteToolReconciler(tmp.path);
    try {
      inspector.inspect('unmodified');
      inspector.inspect('unmodified');
    } finally {inspector.close();}
    const verify=new DatabaseSync(tmp.path);
    try {
      assert.deepEqual(verify.prepare('SELECT * FROM kernel_events ORDER BY seq').all(),eventsBefore);
      assert.deepEqual(verify.prepare('SELECT * FROM session_writer_leases').all(),leasesBefore);
      assert.deepEqual(verify.prepare('SELECT * FROM host_tool_executions').all(),[]);
    } finally {verify.close();}
  } finally {leases.close();tmp.cleanup();}
});


test('M1 reconciliation: receipt without its atomic tool.result is corrupt, not verified',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('half-pair','a',5000);
    assert.ok(lease);
    const call=await seedIntent(tmp.path,lease);
    const ledger=new HostExecutionLedger(tmp.path);
    try {ledger.begin(call);ledger.finish(call,'succeeded','hello');}
    finally {ledger.close();}
    // Synthetic DB corruption: new Kernel never writes lone receipts.
    await append(tmp.path,lease,[
      {type:'tool.receipt',turnId:'turn',
        data:{callId:'call',name:'read.echo',outcome:'succeeded',content:'hello'}},
      {type:'turn.completed',turnId:'turn',data:{}},
    ]);
    const inspector=new SqliteToolReconciler(tmp.path);
    try {assert.throws(()=>inspector.inspect('half-pair'),{code:'CORRUPT_EVENT_LOG'});}
    finally {inspector.close();}
  } finally {leases.close();tmp.cleanup();}
});

test('M1 reconciliation: result after an intervening event is corrupt (not atomic)',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease=leases.acquire('non-atomic','a',5000);
    assert.ok(lease);
    await seedIntent(tmp.path,lease);
    const receipt={callId:'call',name:'read.echo',outcome:'succeeded',content:'hello'};
    await append(tmp.path,lease,[
      {type:'tool.receipt',turnId:'turn',data:receipt},
      {type:'model.started',turnId:'turn',data:{step:2}},
      {type:'tool.result',turnId:'turn',data:receipt},
      {type:'turn.completed',turnId:'turn',data:{}},
    ]);
    const inspector=new SqliteToolReconciler(tmp.path);
    try {assert.throws(()=>inspector.inspect('non-atomic'),{code:'CORRUPT_EVENT_LOG'});}
    finally {inspector.close();}
  } finally {leases.close();tmp.cleanup();}
});
