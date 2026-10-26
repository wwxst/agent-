import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { MemoryEventStore } from '../packages/event-store-memory/src/index.js';
import { ToolRegistry, executeBatch } from '../packages/tool-scheduler/src/index.js';
import { ConflictError, type ToolCall, type ToolDefinition, type ModelProvider, type ProviderEvent } from '../packages/contracts/src/index.js';

const finish = (text: string, calls: readonly ToolCall[] = [], reason: 'stop' | 'tool_use' | 'length' = calls.length ? 'tool_use' : 'stop'): ProviderEvent =>
  ({ type: 'message_complete', message: { role: 'assistant', text, toolCalls: calls }, finishReason: reason } as const);
const mkRead = (name: string, fn: (x: unknown, s: AbortSignal) => Promise<string>, concurrency: 'parallel' | 'exclusive' = 'parallel'): ToolDefinition =>
  ({ name, version: '1', risk: 'read', concurrency, parse: x => {
    if (!x || typeof x !== 'object') throw Error('invalid');
    return x;
  }, execute: fn });
const call = (id: string, name: string, args: unknown = {}) => ({ id, name, arguments: args });
const setup = (provider: ModelProvider, registry = new ToolRegistry(), opts = {}) => {
  const store = new MemoryEventStore(), kernel = new AgentKernel(store, provider, registry, opts);
  return { store, kernel, registry };
};

test('M0: text-only turn emits monotonic replayable terminal event', async () => {
  const { kernel } = setup(new FakeProvider([[{type:'text_delta',text:'Hi'},finish('Hi')]]));
  const session = await kernel.createSession();
  const result = await kernel.runTurn(session, 'Hello');
  assert.equal(result.status, 'completed');
  const events = await kernel.readEvents(session);
  assert.deepEqual(events.map(e=>e.seq), events.map((_,i)=>i+1));
  assert.equal(events.at(-1)?.type, 'turn.completed');
  assert.deepEqual((await kernel.readEvents(session, 2)).map(e=>e.seq), events.slice(2).map(e=>e.seq));
});

test('M0: tool results feed next provider request, by call id', async () => {
  const p = new FakeProvider([[finish('run', [call('c1','echo',{value:1})])],[finish('done')]]);
  const {kernel,registry}=setup(p);
  registry.register(mkRead('echo',async x => JSON.stringify(x)));
  const session=await kernel.createSession();const result=await kernel.runTurn(session,'go');
  assert.equal(result.status,'completed');
  assert.equal(p.requests.length,2);
  assert.equal(p.requests[1]?.at(-1)?.role,'tool');
  assert.equal((p.requests[1]?.at(-1) as {result:{callId:string}}).result.callId,'c1');
});

test('M0: unknown, invalid and denied tools never execute', async()=>{
  let called=0;
  const registry=new ToolRegistry();
  registry.register(mkRead('read',async()=>{called++;return 'yes'}));
  registry.register({name:'write',version:'1',risk:'write',concurrency:'exclusive',parse:x=>x,execute:async()=>{called++;return 'danger'}});
  const results=await executeBatch([call('1','missing'),call('2','read',null),call('3','write')],registry,new AbortController().signal);
  assert.deepEqual(results.map(x=>x.outcome),['failed','failed','denied']);
  assert.equal(called,0);
});

test('M0: truncated provider tool output never executes',async()=>{
  let called=0;const p=new FakeProvider([[finish('partial',[call('x','read')],'length')]]);
  const {kernel,registry}=setup(p);registry.register(mkRead('read',async()=>{called++;return 'bad'}));
  const id=await kernel.createSession();const r=await kernel.runTurn(id,'go');
  assert.equal(r.errorCode,'TRUNCATED_MODEL_OUTPUT');assert.equal(called,0);
});

test('M0: incomplete provider stream fails and no tool executes',async()=>{
  const p=new FakeProvider([[{type:'text_delta',text:'partial'}]]);const {kernel}=setup(p);
  const s=await kernel.createSession();const r=await kernel.runTurn(s,'go');
  assert.equal(r.errorCode,'INCOMPLETE_PROVIDER_STREAM');
  assert.equal((await kernel.readEvents(s)).at(-1)?.type,'turn.failed');
});

test('M0: duplicate tool call ids yield error and only one execution', async()=>{
  let n=0;const registry=new ToolRegistry();registry.register(mkRead('read',async()=>{n++;return 'ok'}));
  const results=await executeBatch([call('dup','read'),call('dup','read')],registry,new AbortController().signal);
  assert.equal(n,1);assert.deepEqual(results.map(r=>r.outcome),['succeeded','failed']);
});

test('M0: parallel reads overlap; exclusive is barrier; results preserve model order',async()=>{
  let current=0, max=0, order:string[]=[];
  const make=(name:string,mode:'parallel'|'exclusive')=>mkRead(name,async()=>{
    current++;max=Math.max(max,current);order.push(`start:${name}`);
    await new Promise(r=>setTimeout(r,4));order.push(`end:${name}`);current--;return name;
  },mode);
  const reg=new ToolRegistry();reg.register(make('a','parallel'));reg.register(make('b','parallel'));reg.register(make('w','exclusive'));
  const results=await executeBatch([call('1','a'),call('2','b'),call('3','w'),call('4','a')],reg,new AbortController().signal);
  assert.equal(max,2);assert.deepEqual(results.map(r=>r.callId),['1','2','3','4']);
  assert.ok(order.indexOf('start:w')>order.indexOf('end:a'));
  assert.ok(order.lastIndexOf('start:a')>order.indexOf('end:w'));
});

test('M0: event store reject conflicting append, and clones external data',async()=>{
  const store=new MemoryEventStore();const d={type:'session.created' as const,data:{x:1}};
  await store.append('s',0,[d]);(d.data as {x:number}).x=99;
  assert.deepEqual((await store.read('s'))[0]?.data,{x:1});
  await assert.rejects(store.append('s',0,[d]),ConflictError);
});

test('M0: hard step and tool budgets',async()=>{
  const p=new FakeProvider([[finish('tool',[call('1','read')])]]);const {kernel,registry}=setup(p,new ToolRegistry(),{maxToolCalls:0});
  registry.register(mkRead('read',async()=> 'ok'));
  const s=await kernel.createSession();const r=await kernel.runTurn(s,'go');assert.equal(r.errorCode,'TOOL_BUDGET_EXCEEDED');
  const p2=new FakeProvider([[finish('tool',[call('1','read')])]]);
  const k2=setup(p2,registry,{maxSteps:1});const s2=await k2.kernel.createSession();
  assert.equal((await k2.kernel.runTurn(s2,'go')).errorCode,'STEP_BUDGET_EXCEEDED');
});

test('M0: concurrent turn on same session is rejected',async()=>{
  let start!:()=>void,release!:()=>void;
  const startPromise=new Promise<void>(r=>start=r);
  const gate=new Promise<void>(r=>release=r);
  const provider={id:'gate', async *stream(){start();await gate;yield finish('done');}};
  const {kernel}=setup(provider);const s=await kernel.createSession();
  const first=kernel.runTurn(s,'one');await startPromise;
  await assert.rejects(kernel.runTurn(s,'two'),/already active/);
  release();assert.equal((await first).status,'completed');
});

test('M0: duplicate cancel stays idempotent and does not complete',async()=>{
  let start!:()=>void;let release!:()=>void;
  const started=new Promise<void>(r=>start=r),gate=new Promise<void>(r=>release=r);
  const provider={id:'gate', async *stream(){start();await gate;yield finish('too late');}};
  const {kernel}=setup(provider);const s=await kernel.createSession();
  const pending=kernel.runTurn(s,'go','turn-1');await started;
  assert.equal(await kernel.cancelTurn(s,'turn-1'),true);
  assert.equal(await kernel.cancelTurn(s,'turn-1'),false);
  release();const r=await pending;assert.equal(r.status,'cancelled');
  const types=(await kernel.readEvents(s)).map(x=>x.type);
  assert.equal(types.filter(x=>x==='turn.cancel_requested').length,1);
  assert.equal(types.filter(x=>x==='turn.cancelled').length,1);
  assert.equal(types.includes('turn.completed'),false);
});

test('M0: duplicate tool id across two model steps does not execute again', async () => {
  let count = 0;
  const provider = new FakeProvider([
    [finish('first', [call('same', 'read')])],
    [finish('second', [call('same', 'read')])],
  ]);
  const { kernel, registry } = setup(provider);
  registry.register(mkRead('read', async () => { count++; return 'ok'; }));
  const session = await kernel.createSession();
  const result = await kernel.runTurn(session, 'hello');
  assert.equal(result.errorCode, 'DUPLICATE_CALL_ID');
  assert.equal(count, 1);
  assert.equal((await kernel.readEvents(session)).at(-1)?.type, 'turn.failed');
});

test('M0: cancelling while assistant event commits cannot produce completed turn', async () => {
  const store = new MemoryEventStore();
  let release!: () => void;
  let entered!: () => void;
  const holding = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const gatedStore = {
    append: async (id: string, seq: number, drafts: readonly import('../packages/contracts/src/index.js').EventDraft[]) => {
      if (drafts.some(d => d.type === 'assistant.message')) { entered(); await holding; }
      return store.append(id, seq, drafts);
    },
    read: (id: string, after?: number) => store.read(id, after),
  };
  const kernel = new AgentKernel(gatedStore, new FakeProvider([[finish('complete')]]), new ToolRegistry());
  const session = await kernel.createSession();
  const work = kernel.runTurn(session, 'please', 't');
  await arrived;
  const cancel = kernel.cancelTurn(session, 't');
  release();
  assert.equal(await cancel, true);
  assert.equal((await work).status, 'cancelled');
  const events = await kernel.readEvents(session);
  assert.equal(events.filter(e => e.type === 'turn.completed').length, 0);
  assert.equal(events.filter(e => e.type === 'turn.cancelled').length, 1);
  assert.ok(events.findIndex(e => e.type === 'turn.cancel_requested') < events.findIndex(e => e.type === 'turn.cancelled'));
});

test('M0: event-store completion failure does not report success', async () => {
  const store = new MemoryEventStore();
  const failing = {
    append: async (id: string, seq: number, drafts: readonly import('../packages/contracts/src/index.js').EventDraft[]) => {
      if (drafts.some(d => d.type === 'turn.completed')) throw new Error('disk failure');
      return store.append(id, seq, drafts);
    },
    read: (id: string, after?: number) => store.read(id, after),
  };
  const kernel = new AgentKernel(failing, new FakeProvider([[finish('done')]]), new ToolRegistry());
  const session = await kernel.createSession();
  const result = await kernel.runTurn(session, 'go');
  assert.equal(result.status, 'failed');
  const events = await kernel.readEvents(session);
  assert.equal(events.filter(e => e.type === 'turn.completed').length, 0);
  assert.equal(events.at(-1)?.type, 'turn.failed');
});

test('M0: racing runTurn calls are excluded even while admission read is blocked', async () => {
  const store = new MemoryEventStore();
  let entering!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entering = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let blockReads = false;
  const gated = {
    append: (id: string, seq: number, drafts: readonly import('../packages/contracts/src/index.js').EventDraft[]) => store.append(id, seq, drafts),
    read: async (id: string, after?: number) => {
      if (blockReads) { blockReads = false; entering(); await gate; }
      return store.read(id, after);
    },
  };
  const kernel = new AgentKernel(gated, new FakeProvider([[finish('ok')]]), new ToolRegistry());
  const session = await kernel.createSession();
  blockReads = true;
  const first = kernel.runTurn(session, 'one', 'turn-one');
  await arrived;
  assert.equal(await kernel.cancelTurn(session, 'turn-one'), false); // Not yet admitted.
  await assert.rejects(kernel.runTurn(session, 'two', 'turn-two'), { code: 'TURN_BUSY' });
  release();
  assert.equal((await first).status, 'completed');
  assert.equal((await kernel.readEvents(session)).filter(e => e.type === 'turn.started').length, 1);
});

test('M0: racing createSession with identical ID creates one session', async () => {
  const store = new MemoryEventStore();
  let entering!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entering = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstRead = true;
  const gated = {
    append: (id: string, seq: number, drafts: readonly import('../packages/contracts/src/index.js').EventDraft[]) => store.append(id, seq, drafts),
    read: async (id: string, after?: number) => {
      if (firstRead) { firstRead = false; entering(); await gate; }
      return store.read(id, after);
    },
  };
  const kernel = new AgentKernel(gated, new FakeProvider([]), new ToolRegistry());
  const first = kernel.createSession('same-session');
  await arrived;
  await assert.rejects(kernel.createSession('same-session'), { code: 'SESSION_EXISTS' });
  release();
  assert.equal(await first, 'same-session');
  assert.equal((await kernel.readEvents('same-session')).filter(e => e.type === 'session.created').length, 1);
});

test('M0: rejected duplicate turn does not append a new terminal event', async () => {
  const { kernel } = setup(new FakeProvider([[finish('ok')]]));
  const session = await kernel.createSession();
  await kernel.runTurn(session, 'one', 'same');
  const before = await kernel.readEvents(session);
  await assert.rejects(kernel.runTurn(session, 'again', 'same'), { code: 'DUPLICATE_TURN' });
  assert.deepEqual(await kernel.readEvents(session), before);
});


test('M1: reopen completed session and append contiguous events without rerunning old tools', async () => {
  const store = new MemoryEventStore();
  const first = new AgentKernel(store, new FakeProvider([[finish('first reply')]]), new ToolRegistry());
  const session = await first.createSession('reopen-me');
  assert.equal((await first.runTurn(session, 'first prompt', 't1')).status, 'completed');
  const previous = await store.read(session);
  const nextProvider = new FakeProvider([[finish('second reply')]]);
  const reopened = new AgentKernel(store, nextProvider, new ToolRegistry());
  assert.equal(await reopened.openSession(session), session);
  assert.equal((await reopened.runTurn(session, 'second prompt', 't2')).status, 'completed');
  const events = await reopened.readEvents(session);
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1));
  assert.deepEqual(events.slice(0, previous.length), previous);
  assert.equal(events.filter(e => e.type === 'session.created').length, 1);
  assert.deepEqual(nextProvider.requests[0]?.map(m => m.role), ['user', 'assistant', 'user']);
});

test('M1: unfinished turn blocks reopen and is not silently replayed or amended', async () => {
  const store = new MemoryEventStore();
  await store.append('interrupted', 0, [
    { type: 'session.created', data: {} },
    { type: 'turn.queued', turnId: 'pending', data: {} },
    { type: 'user.message', turnId: 'pending', data: { text: 'run something' } },
    { type: 'turn.started', turnId: 'pending', data: {} },
  ]);
  const before = await store.read('interrupted');
  const kernel = new AgentKernel(store, new FakeProvider([]), new ToolRegistry());
  await assert.rejects(kernel.openSession('interrupted'), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(await store.read('interrupted'), before);
  await assert.rejects(kernel.runTurn('interrupted', 'new turn'), { code: 'UNKNOWN_SESSION' });
});

test('M1: log gaps and overlapping turn admissions fail closed', async () => {
  const store = new MemoryEventStore();
  await store.append('corrupt', 0, [
    { type: 'session.created', data: {} },
    { type: 'turn.queued', turnId: 'a', data: {} },
    { type: 'turn.queued', turnId: 'b', data: {} },
  ]);
  const kernel = new AgentKernel(store, new FakeProvider([]), new ToolRegistry());
  await assert.rejects(kernel.openSession('corrupt'), { code: 'CORRUPT_EVENT_LOG' });
  const gapReader = {
    append: (id: string, seq: number, drafts: readonly import('../packages/contracts/src/index.js').EventDraft[]) =>
      store.append(id, seq, drafts),
    read: async (id: string, afterSeq?: number) => {
      const events = await store.read(id, afterSeq);
      return events.map((e, i) => i === 1 ? { ...e, seq: 99 } : e);
    },
  };
  const gapKernel = new AgentKernel(gapReader, new FakeProvider([]), new ToolRegistry());
  await assert.rejects(gapKernel.openSession('corrupt'), { code: 'CORRUPT_EVENT_LOG' });
  await assert.rejects(kernel.openSession('absent'), { code: 'UNKNOWN_SESSION' });
});

test('M1: concurrent opens share an admission fence and duplicate open is rejected', async () => {
  const store = new MemoryEventStore();
  const original = new AgentKernel(store, new FakeProvider([]), new ToolRegistry());
  await original.createSession('same');
  const kernel = new AgentKernel(store, new FakeProvider([]), new ToolRegistry());
  const a = kernel.openSession('same');
  await assert.rejects(kernel.openSession('same'), { code: 'SESSION_EXISTS' });
  assert.equal(await a, 'same');
  await assert.rejects(kernel.openSession('same'), { code: 'SESSION_EXISTS' });
});
