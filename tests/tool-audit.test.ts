import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type EventDraft, type EventStore, type KernelEvent, type ModelProvider, KernelError } from '../packages/contracts/src/index.js';
import { MemoryEventStore } from '../packages/event-store-memory/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ManagedSessionRunner } from '../packages/session-runtime/src/index.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';
import { inspectToolAudit } from '../packages/tool-audit/src/index.js';

const toolMessage = (name = 'read', id = 'call-1') => ({
  type: 'message_complete' as const,
  message: { role: 'assistant' as const, text: 'execute', toolCalls: [{ id, name, arguments: { input: 7 } }] },
  finishReason: 'tool_use' as const,
});
const done = () => ({
  type: 'message_complete' as const,
  message: { role: 'assistant' as const, text: 'done', toolCalls: [] },
  finishReason: 'stop' as const,
});
function readTools(fn: () => Promise<string> = async () => 'ok'): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({ name: 'read', version: '1', risk: 'read', concurrency: 'parallel',
    parse: input => input, execute: fn });
  return tools;
}
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-intent-'));
  return { path: join(dir, 'kernel.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('M1 tool audit: every real tool is preceded by committed intent and followed by atomic receipt/result', async () => {
  const store = new MemoryEventStore();
  let count = 0;
  const tools = readTools(async () => {
    const events = await store.read('audit');
    assert.equal(events.filter(e => e.type === 'tool.intent').length, 1);
    assert.equal(events.filter(e => e.type === 'tool.receipt').length, 0);
    count++;
    return 'done-reading';
  });
  const provider = new FakeProvider([[toolMessage()], [done()]]);
  const kernel = new AgentKernel(store, provider, tools);
  await kernel.createSession('audit');
  const result = await kernel.runTurn('audit', 'hello', 'turn-1');
  assert.equal(result.status, 'completed');
  assert.equal(count, 1);
  const events = await store.read('audit');
  const indexes = (type: string) => events.filter(e => e.type === type).map(e => e.seq);
  assert.equal(indexes('tool.intent').length, 1);
  assert.equal(indexes('tool.receipt').length, 1);
  assert.equal(indexes('tool.result').length, 1);
  assert.ok(indexes('assistant.message')[0]! < indexes('tool.intent')[0]!);
  assert.ok(indexes('tool.intent')[0]! < indexes('tool.receipt')[0]!);
  assert.equal(indexes('tool.result')[0], indexes('tool.receipt')[0]! + 1);
  assert.equal((events.find(e => e.type === 'tool.receipt')?.data as {content:string}).content, 'done-reading');
  assert.deepEqual(inspectToolAudit(events).map(e => [e.callId,e.outcome,e.needsReconciliation]),
    [['call-1','succeeded',false]]);
  assert.deepEqual(provider.requests[1]?.map(m => m.role), ['user', 'assistant', 'tool']);
  const reopened = new AgentKernel(store, new FakeProvider([]), tools);
  assert.equal(await reopened.openSession('audit'), 'audit');
});

test('M1 tool audit: denied tool never executes yet receives a definitive denial receipt', async () => {
  const store = new MemoryEventStore();
  const tools = readTools();
  let executed = 0;
  tools.register({ name: 'unsafe', version: '1', risk: 'external_side_effect',
    concurrency: 'exclusive', parse: input => input,
    execute: async () => { executed++; return 'forbidden'; } });
  const kernel = new AgentKernel(store, new FakeProvider([[toolMessage('unsafe')], [done()]]), tools);
  await kernel.createSession('denial');
  assert.equal((await kernel.runTurn('denial','request','t')).status,'completed');
  assert.equal(executed,0);
  const events = await store.read('denial');
  const [entry] = inspectToolAudit(events);
  assert.equal(entry?.outcome,'denied');
  assert.equal(entry?.needsReconciliation,false);
  assert.equal((events.find(e=>e.type==='tool.receipt')?.data as {content:string}).content,'M0_DENIES_SIDE_EFFECTS');
});

test('M1 tool audit: crash after intent, before execution is uncertain and cannot reopen', async () => {
  const base = new MemoryEventStore();
  let calls = 0;
  const wrapped: EventStore = {
    read: (id, after) => base.read(id, after),
    append: async (id, seq, drafts) => {
      if (drafts.some(e => e.type === 'tool.intent')) {
        await base.append(id, seq, drafts);
        throw new Error('simulated crash before ACK');
      }
      return base.append(id,seq,drafts);
    },
  };
  const kernel = new AgentKernel(wrapped, new FakeProvider([[toolMessage()]]),
    readTools(async () => {calls++;return 'never';}));
  await kernel.createSession('intent-no-ack');
  await assert.rejects(kernel.runTurn('intent-no-ack', 'go', 't'), { code: 'TOOL_OUTCOME_UNKNOWN' });
  assert.equal(calls,0);
  const events = await base.read('intent-no-ack');
  assert.equal(events.filter(e => e.type === 'turn.failed').length,0);
  const audit = inspectToolAudit(events);
  assert.equal(audit[0]?.outcome,'outcome_unknown');
  assert.equal(audit[0]?.receiptSeq,undefined);
  assert.equal(audit[0]?.needsReconciliation,true);
  const restarted = new AgentKernel(base, new FakeProvider([]),readTools());
  await assert.rejects(restarted.openSession('intent-no-ack'),{code:'RECOVERY_REQUIRED'});
});

test('M1 tool audit: execute succeeded but receipt storage failed leaves unknown, no retry', async () => {
  const base = new MemoryEventStore();
  let count = 0;
  const wrapped: EventStore = {
    read: (id, after) => base.read(id,after),
    append: (id, seq, drafts) => {
      if (drafts.some(e => e.type === 'tool.receipt')) throw new Error('disk IO failed');
      return base.append(id,seq,drafts);
    },
  };
  const kernel = new AgentKernel(wrapped, new FakeProvider([[toolMessage()]]),
    readTools(async () => {count++; return 'already-done';}));
  await kernel.createSession('lost-receipt');
  await assert.rejects(kernel.runTurn('lost-receipt','go','turn'),{code:'TOOL_OUTCOME_UNKNOWN'});
  assert.equal(count,1);
  const events = await base.read('lost-receipt');
  assert.equal(events.filter(e=>e.type==='tool.intent').length,1);
  assert.equal(events.filter(e=>e.type==='tool.receipt').length,0);
  assert.equal(events.filter(e=>e.type==='tool.result').length,0);
  assert.equal(events.filter(e=>e.type==='turn.failed').length,0);
  assert.equal(inspectToolAudit(events)[0]?.needsReconciliation,true);
  const restarted = new AgentKernel(base,new FakeProvider([[toolMessage()]]),readTools(async()=>{count++;return 'duplicated';}));
  await assert.rejects(restarted.openSession('lost-receipt'),{code:'RECOVERY_REQUIRED'});
  assert.equal(count,1);
});

test('M1 tool audit: explicit outcome_unknown receipt blocks a future session restart', async () => {
  const store = new MemoryEventStore();
  const kernel = new AgentKernel(store, new FakeProvider([[toolMessage()]]), readTools(async () => {
    throw new Error('tool failure not automatically an unknown outcome');
  }));
  await kernel.createSession('unknown');
  // A deterministic failure is receipt "failed" and can continue the model,
  // while an unknown receipt must not be treated as failed/denied.
  const runner = new AgentKernel(store, new FakeProvider([]), readTools());
  assert.equal(inspectToolAudit(await store.read('unknown')).length,0);
  // Test a persisted legacy-looking terminal log with an explicit unknown receipt.
  await store.append('unknown',1,[
    {type:'turn.queued',turnId:'t',data:{}},
    {type:'turn.started',turnId:'t',data:{}},
    {type:'tool.intent',turnId:'t',data:{callId:'x',name:'read',step:1}},
    {type:'tool.receipt',turnId:'t',data:{callId:'x',name:'read',outcome:'outcome_unknown',content:'maybe'}},
    {type:'tool.result',turnId:'t',data:{callId:'x',name:'read',outcome:'outcome_unknown',content:'maybe'}},
    {type:'turn.failed',turnId:'t',data:{errorCode:'unknown'}},
  ]);
  const audit = inspectToolAudit(await store.read('unknown'));
  assert.equal(audit[0]?.receiptSeq,5);
  assert.equal(audit[0]?.needsReconciliation,true);
  await assert.rejects(runner.openSession('unknown'), {code:'RECOVERY_REQUIRED'});
});

test('M1 tool audit: duplicate, orphan and mismatched receipts are corrupt', async () => {
  const base = [
    {sessionId:'a',seq:1,eventId:'e1',at:'t',type:'tool.intent' as const,turnId:'t',
      data:{callId:'c',name:'read',step:1}},
  ] satisfies KernelEvent[];
  const add=(type:'tool.intent'|'tool.receipt'|'tool.result',data:unknown):KernelEvent => (
    {sessionId:'a',seq:2,eventId:'e2',at:'t',type,turnId:'t',data}
  );
  assert.throws(()=>inspectToolAudit([...base,add('tool.intent',{callId:'c',name:'read',step:1})]),
    {code:'CORRUPT_EVENT_LOG'});
  assert.throws(()=>inspectToolAudit([add('tool.receipt',
    {callId:'c',name:'read',outcome:'succeeded',content:'ok'})]),{code:'CORRUPT_EVENT_LOG'});
  assert.throws(()=>inspectToolAudit([...base,add('tool.receipt',
    {callId:'c',name:'other',outcome:'succeeded',content:'ok'})]),{code:'CORRUPT_EVENT_LOG'});
  assert.throws(()=>inspectToolAudit([...base,add('tool.result',
    {callId:'c',name:'read',outcome:'succeeded',content:'ok'})]),{code:'CORRUPT_EVENT_LOG'});
});

test('M1 tool audit: SQLite ManagedSessionRunner durably preserves receipts across processes', async () => {
  const db = tempDb();
  try {
    let count=0;
    const runner = new ManagedSessionRunner(db.path,new FakeProvider([[toolMessage()], [done()]]),
      readTools(async()=>{count++;return 'persisted';}));
    await runner.createSession('sqlite-audit');
    assert.equal((await runner.runTurn('sqlite-audit','hello','t')).status,'completed');
    const journal = new SqliteEventStore(db.path);
    try {
      const events = await journal.read('sqlite-audit');
      assert.equal(count,1);
      assert.deepEqual(inspectToolAudit(events).map(x=>x.outcome),['succeeded']);
      assert.equal(events.filter(x=>x.type==='tool.intent').length,1);
      assert.equal(events.filter(x=>x.type==='tool.receipt').length,1);
    } finally {journal.close();}
    const reopened = new ManagedSessionRunner(db.path,new FakeProvider([[done()]]),readTools());
    assert.equal((await reopened.runTurn('sqlite-audit','next','t2')).status,'completed');
  } finally {db.cleanup();}
});

test('M1 tool audit: legacy completed logs without intent remain readable',async()=>{
  const store = new MemoryEventStore();
  await store.append('legacy',0,[
    {type:'session.created',data:{}},
    {type:'turn.queued',turnId:'old',data:{}},
    {type:'tool.result',turnId:'old',data:{callId:'legacy',name:'old',outcome:'succeeded',content:'ok'}},
    {type:'turn.completed',turnId:'old',data:{}},
  ]);
  assert.deepEqual(inspectToolAudit(await store.read('legacy')),[]);
  assert.equal(await new AgentKernel(store,new FakeProvider([]),new ToolRegistry()).openSession('legacy'),'legacy');
});

test('M1 tool audit: real SIGKILL after committed intent is inspectable and not replayed', async () => {
  const tmp = tempDb();
  try {
    const moduleUrl = new URL('../packages/event-store-sqlite/src/index.js', import.meta.url).href;
    const child = `
      const { SqliteEventStore } = await import(process.argv[1]);
      const journal = new SqliteEventStore(process.argv[2]);
      await journal.append('killed-after-intent', 0, [
        { type: 'session.created', data: {} },
        { type: 'turn.queued', turnId: 'crashed', data: {} },
        { type: 'user.message', turnId: 'crashed', data: { text: 'run' } },
        { type: 'turn.started', turnId: 'crashed', data: {} },
        { type: 'assistant.message', turnId: 'crashed',
          data: { role: 'assistant', text: '', toolCalls: [{ id: 'risk', name: 'read', arguments: {} }] } },
        { type: 'tool.intent', turnId: 'crashed', data: { callId: 'risk', name: 'read', step: 1 } },
      ]);
      process.kill(process.pid, 'SIGKILL');
    `;
    const outcome = spawnSync(process.execPath, ['--input-type=module','-e',child,moduleUrl,tmp.path],
      {encoding:'utf8',timeout:10000});
    assert.equal(outcome.error,undefined,outcome.stderr);
    assert.equal(outcome.signal,'SIGKILL',outcome.stderr);
    const journal = new SqliteEventStore(tmp.path);
    try {
      const events = await journal.read('killed-after-intent');
      assert.equal(events.at(-1)?.type,'tool.intent');
      assert.deepEqual(inspectToolAudit(events).map(e=>({outcome:e.outcome,needs:e.needsReconciliation})),
        [{outcome:'outcome_unknown',needs:true}]);
    } finally {journal.close();}
    let replayed=0;
    const resumed = new ManagedSessionRunner(tmp.path,new FakeProvider([[toolMessage()]]),
      readTools(async()=>{replayed++;return 'bad replay';}));
    await assert.rejects(resumed.runTurn('killed-after-intent','again'),
      {code:'RECOVERY_REQUIRED'});
    assert.equal(replayed,0);
  } finally {tmp.cleanup();}
});

test('M1 tool audit: even an artificially closed turn cannot hide a missing receipt', async () => {
  const store = new MemoryEventStore();
  await store.append('closed-without-receipt',0,[
    {type:'session.created',data:{}},
    {type:'turn.queued',turnId:'t',data:{}},
    {type:'turn.started',turnId:'t',data:{}},
    {type:'tool.intent',turnId:'t',data:{callId:'x',name:'read',step:1}},
    {type:'turn.failed',turnId:'t',data:{errorCode:'CRASH'}},
  ]);
  const kernel = new AgentKernel(store,new FakeProvider([]),readTools());
  await assert.rejects(kernel.openSession('closed-without-receipt'),{code:'RECOVERY_REQUIRED'});
});

test('M1 tool audit: receipt content mismatch invalidates log', () => {
  const events: KernelEvent[] = [
    {sessionId:'x',seq:1,eventId:'i',at:'now',type:'tool.intent',turnId:'t',
      data:{callId:'x',name:'read',step:1}},
    {sessionId:'x',seq:2,eventId:'r',at:'now',type:'tool.receipt',turnId:'t',
      data:{callId:'x',name:'read',outcome:'succeeded',content:'original'}},
    {sessionId:'x',seq:3,eventId:'c',at:'now',type:'tool.result',turnId:'t',
      data:{callId:'x',name:'read',outcome:'succeeded',content:'tampered'}},
  ];
  assert.throws(()=>inspectToolAudit(events),{code:'CORRUPT_EVENT_LOG'});
});


test('M1 tool audit: cancellation during started tool persists explicit unknown receipt, not false cancellation', async () => {
  const store = new MemoryEventStore();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const tools = new ToolRegistry();
  tools.register({
    name: 'read', version: '1', risk: 'read', concurrency: 'parallel', parse: input => input,
    execute: async (_input, signal) => {
      entered();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted after start')), { once: true });
      });
    },
  });
  const kernel = new AgentKernel(store, new FakeProvider([[toolMessage()]]), tools);
  await kernel.createSession('cancel-unknown');
  const run = kernel.runTurn('cancel-unknown','run','turn');
  await started;
  assert.equal(await kernel.cancelTurn('cancel-unknown','turn'),true);
  await assert.rejects(run,{code:'TOOL_OUTCOME_UNKNOWN'});
  const events = await store.read('cancel-unknown');
  assert.equal(events.filter(e=>e.type==='turn.cancelled').length,0);
  assert.equal(events.filter(e=>e.type==='tool.receipt').length,1);
  assert.equal(inspectToolAudit(events)[0]?.outcome,'outcome_unknown');
  assert.equal(inspectToolAudit(events)[0]?.needsReconciliation,true);
  await assert.rejects(new AgentKernel(store,new FakeProvider([]),tools).openSession('cancel-unknown'),
    {code:'RECOVERY_REQUIRED'});
});

test('M1 tool audit: parallel result is committed while another read is still in flight', async () => {
  const base = new MemoryEventStore();
  let quickPersisted!: () => void;
  const quickReceipt = new Promise<void>(resolve => { quickPersisted=resolve; });
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>(resolve => { releaseSlow=resolve; });
  const journal: EventStore = {
    read: (id, after) => base.read(id,after),
    append: async (id,seq,ds) => {
      const outcome=await base.append(id,seq,ds);
      if(ds.some(x=>x.type==='tool.receipt' && (x.data as {callId:string}).callId==='quick')) {
        quickPersisted();
      }
      return outcome;
    },
  };
  const tools = new ToolRegistry();
  tools.register({name:'quick',version:'1',risk:'read',concurrency:'parallel',
    parse:x=>x,execute:async()=> 'fast'});
  tools.register({name:'slow',version:'1',risk:'read',concurrency:'parallel',
    parse:x=>x,execute:async()=> {await slowGate;return 'slow';}});
  const provider = new FakeProvider([[
    {type:'message_complete',message:{role:'assistant',text:'parallel',toolCalls:[
      {id:'quick',name:'quick',arguments:{}},{id:'slow',name:'slow',arguments:{}},
    ]},finishReason:'tool_use'},
  ],[done()]]);
  const kernel = new AgentKernel(journal,provider,tools);
  await kernel.createSession('parallel-receipts');
  const pending = kernel.runTurn('parallel-receipts','go','t');
  try {
    await quickReceipt;
    const events = await base.read('parallel-receipts');
    assert.deepEqual(events.filter(e=>e.type==='tool.receipt')
      .map(e=>(e.data as {callId:string}).callId),['quick']);
  } finally { releaseSlow(); }
  assert.equal((await pending).status,'completed');
  assert.deepEqual(inspectToolAudit(await base.read('parallel-receipts'))
    .map(x=>x.needsReconciliation),[false,false]);
});
