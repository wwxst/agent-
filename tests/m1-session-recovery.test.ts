import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AgentKernel} from '../packages/kernel-core/src/index.js';
import {MemoryEventStore} from '../packages/event-store-memory/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {type EventDraft, type KernelEvent, type ContextMessage, type ModelProvider, type ProviderEvent} from '../packages/contracts/src/index.js';

const complete = (text='ok'): ProviderEvent => ({type:'message_complete', message:{role:'assistant',text,toolCalls:[]},finishReason:'stop'});
const fake = (responses: readonly (readonly ProviderEvent[])[] = [[complete()]]) => new FakeProvider(responses);
const core = (store: MemoryEventStore, provider: ModelProvider = fake()) => new AgentKernel(store,provider,new ToolRegistry());

async function journal(session='s'): Promise<{store:MemoryEventStore; session:string}> {
  const store=new MemoryEventStore();
  await store.append(session,0,[{type:'session.created',data:{}}]);
  return {store,session};
}
async function record(store: MemoryEventStore, id:string, drafts:EventDraft[]):Promise<void> {
  const old=await store.read(id);
  await store.append(id,old.length,drafts);
}

test('M1 recovery: reattach a completed session and project original message history',async()=>{
  const store=new MemoryEventStore();
  const original=core(store,fake([[complete('first reply')]]));
  const s=await original.createSession('resume');
  assert.equal((await original.runTurn(s,'first question','turn-one')).status,'completed');
  const firstHistory=await original.readEvents(s);
  const nextProvider:ModelProvider={id:'history-verifier',async *stream(messages:readonly ContextMessage[]){
    assert.deepEqual(messages.map(m=>m.role),['user','assistant','user']);
    assert.equal((messages[1] as {text:string}).text,'first reply');
    assert.equal((messages[2] as {text:string}).text,'second question');
    yield complete('second reply');
  }};
  const restarted=core(store,nextProvider);
  await assert.rejects(restarted.runTurn(s,'not yet open'),{code:'UNKNOWN_SESSION'});
  assert.equal(await restarted.resumeSession(s),s);
  assert.equal((await restarted.runTurn(s,'second question','turn-two')).status,'completed');
  const all=await restarted.readEvents(s);
  for(const old of firstHistory) assert.deepEqual(all.find(e=>e.eventId===old.eventId),old);
  assert.equal(all.at(-1)?.type,'turn.completed');
  assert.equal(all.at(-1)?.seq,all.length);
});

test('M1 recovery: resumed checkpoint is used for context, while raw facts stay in EventStore',async()=>{
  const store=new MemoryEventStore();
  const first=core(store,fake([[complete('long response')]]));
  const s=await first.createSession('checkpoint');
  await first.runTurn(s,'history','old');
  const before=await store.read(s);
  const closed=before.find(e=>e.type==='turn.completed')!;
  await record(store,s,[{type:'turn.queued',turnId:'compact',data:{}},{type:'user.message',turnId:'compact',data:{text:'trigger'}},
    {type:'turn.started',turnId:'compact',data:{}},
    {type:'context.checkpoint',turnId:'compact',data:{throughSeq:closed.seq,summary:'Historical facts',sourceEventCount:before.length}},
    {type:'turn.completed',turnId:'compact',data:{}}]);
  const provider:ModelProvider={id:'verify-ck',async *stream(messages){
    assert.deepEqual(messages,[{role:'summary',text:'Historical facts'},{role:'user',text:'trigger'},{role:'user',text:'new'}]);
    yield complete();
  }};
  const after=core(store,provider);
  await after.resumeSession(s);
  assert.equal((await after.runTurn(s,'new')).status,'completed');
  const all=await after.readEvents(s);
  assert.ok(all.some(e=>e.type==='assistant.message' && (e.data as {text:string}).text==='long response'));
});

test('M1 recovery: missing journal is not a new session',async()=>{
  const store=new MemoryEventStore(), k=core(store);
  await assert.rejects(k.resumeSession('absent'),{code:'UNKNOWN_SESSION'});
  assert.equal((await store.read('absent')).length,0);
});

test('M1 recovery: unclosed Turn fails closed without synthetic result or provider replay',async()=>{
  const {store,session}=await journal();
  await record(store,session,[{type:'turn.queued',turnId:'unfinished',data:{}},{type:'user.message',turnId:'unfinished',data:{text:'x'}},{type:'turn.started',turnId:'unfinished',data:{}},
    {type:'assistant.message',turnId:'unfinished',data:{role:'assistant',text:'execute',toolCalls:[{id:'call-1',name:'read',arguments:{}}]}}]);
  const before=await store.read(session);
  let executed=0;
  const p:ModelProvider={id:'never',async *stream(){executed++;yield complete();}};
  const k=core(store,p);
  await assert.rejects(k.resumeSession(session),{code:'SESSION_RECOVERY_REQUIRED'});
  await assert.rejects(k.runTurn(session,'new'),{code:'UNKNOWN_SESSION'});
  assert.deepEqual(await store.read(session),before);
  assert.equal(executed,0);
});

test('M1 recovery: closed Turn with an unmatched ToolCall requires reconciliation',async()=>{
  const {store,session}=await journal('unmatched');
  await record(store,session,[{type:'turn.queued',turnId:'t',data:{}},{type:'user.message',turnId:'t',data:{text:'x'}},{type:'turn.started',turnId:'t',data:{}},
    {type:'assistant.message',turnId:'t',data:{role:'assistant',text:'',toolCalls:[{id:'call',name:'read',arguments:{}}]}},
    {type:'turn.failed',turnId:'t',data:{errorCode:'INTERRUPTED'}}]);
  await assert.rejects(core(store).resumeSession(session),{code:'SESSION_RECOVERY_REQUIRED'});
});

test('M1 recovery: rejects mismatched session ID, sequence gaps and duplicate event IDs',async()=>{
  const {store,session}=await journal('good');
  const original=await store.read(session);
  const mutations:(()=>KernelEvent[])[]=[
    ()=>[{...original[0]!,sessionId:'wrong'}],
    ()=>[{...original[0]!,seq:2}],
    ()=>[original[0]!,{...original[0]!,seq:2}],
  ];
  for(const mutation of mutations){
    const broken={read:async()=>mutation(),append:store.append.bind(store)};
    const k=new AgentKernel(broken,fake(),new ToolRegistry());
    await assert.rejects(k.resumeSession(session),{code:'CORRUPT_SESSION_JOURNAL'});
  }
});

test('M1 recovery: rejects checkpoint referring to uncommitted or failed history',async()=>{
  const {store,session}=await journal('unsafe-ck');
  await record(store,session,[{type:'turn.queued',turnId:'bad',data:{}},{type:'user.message',turnId:'bad',data:{text:'bad'}},{type:'turn.started',turnId:'bad',data:{}},
    {type:'turn.failed',turnId:'bad',data:{errorCode:'BAD'}},
    {type:'turn.queued',turnId:'good',data:{}},{type:'user.message',turnId:'good',data:{text:'good'}},{type:'turn.started',turnId:'good',data:{}},
    {type:'turn.completed',turnId:'good',data:{}},
    {type:'turn.queued',turnId:'current',data:{}},{type:'user.message',turnId:'current',data:{text:'x'}},{type:'turn.started',turnId:'current',data:{}},
    {type:'context.checkpoint',turnId:'current',data:{throughSeq:9,summary:'dangerously skipping failed history'}},
    {type:'turn.completed',turnId:'current',data:{}}]);
  await assert.rejects(core(store).resumeSession(session),{code:'CORRUPT_SESSION_JOURNAL'});
});

test('M1 recovery: concurrent resume calls reserve session before slow store read',async()=>{
  const {store,session}=await journal('racing');
  let entering!:()=>void,release!:()=>void;
  const arrived=new Promise<void>(r=>entering=r),gate=new Promise<void>(r=>release=r);
  let first=true;
  const wrapped={append:store.append.bind(store),read:async (id:string,after?:number)=>{
    if(first){first=false;entering();await gate;}
    return store.read(id,after);
  }};
  const k=new AgentKernel(wrapped,fake(),new ToolRegistry());
  const pending=k.resumeSession(session);
  await arrived;
  await assert.rejects(k.resumeSession(session),{code:'SESSION_BUSY'});
  release();
  assert.equal(await pending,session);
  await assert.rejects(k.createSession(session),{code:'SESSION_EXISTS'});
});

test('M1 cancellation: journal write failure still aborts blocked Provider without false completion',async()=>{
  const underlying=new MemoryEventStore();
  const store={read:underlying.read.bind(underlying),append:async(id:string,seq:number,drafts:readonly EventDraft[])=>{
    if(drafts.some(d=>d.type==='turn.cancel_requested'))throw Error('cancel event unavailable');
    return underlying.append(id,seq,drafts);
  }};
  let entered!:()=>void;
  const started=new Promise<void>(r=>entered=r);
  const p:ModelProvider={id:'blocked',async *stream(_messages,signal){
    entered();
    await new Promise<never>((_resolve,reject)=>{
      if(signal.aborted)return reject(signal.reason);
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    });
    yield complete('cannot reach');
  }};
  const k=new AgentKernel(store,p,new ToolRegistry());
  const session=await k.createSession('cancel-write-failed');
  const job=k.runTurn(session,'start','t');await started;
  await assert.rejects(k.cancelTurn(session,'t'),/cancel event unavailable/);
  const result=await job;
  assert.equal(result.status,'cancelled');
  const events=await k.readEvents(session);
  assert.equal(events.some(e=>e.type==='turn.completed'),false);
  assert.equal(events.at(-1)?.type,'turn.cancelled');
});
