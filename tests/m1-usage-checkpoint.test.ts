import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AgentKernel} from '../packages/kernel-core/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {MemoryEventStore} from '../packages/event-store-memory/src/index.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {OpenAICompatibleProvider} from '../packages/model-providers/src/openai-compatible.js';
import {AnthropicMessagesProvider} from '../packages/model-providers/src/anthropic-messages.js';
import {type ContextMessage,type ProviderEvent, type ModelProvider} from '../packages/contracts/src/index.js';

const done=(text='ok',calls: {id:string;name:string;arguments:unknown}[]=[]):ProviderEvent=>
  ({type:'message_complete',message:{role:'assistant',text,toolCalls:calls},finishReason:calls.length?'tool_use':'stop'});
const usage=(inputTokens:number,outputTokens:number):ProviderEvent=>({type:'usage',usage:{inputTokens,outputTokens}});
const make=(p:ModelProvider,opts:ConstructorParameters<typeof AgentKernel>[3]={}, reg=new ToolRegistry())=>{
 const store=new MemoryEventStore(),kernel=new AgentKernel(store,p,reg,opts);return {store,kernel,reg};
};
const apiSse=(chunks: string[]):Response=>new Response(new ReadableStream<Uint8Array>({start(controller){
 const encoded=new TextEncoder().encode(chunks.join(''));for(let i=0;i<encoded.length;i+=5) controller.enqueue(encoded.slice(i,i+5));controller.close();
}}),{headers:{'content-type':'text/event-stream'}});
const jsonChunk=(x:unknown)=>`data: ${JSON.stringify(x)}\n\n`;
const anthropic=(type:string,data:Record<string,unknown>={})=>`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`;

test('M1 usage: reported snapshot is committed once and not summed twice',async()=>{
 const {kernel}=make(new FakeProvider([[usage(4,2),usage(5,3),done()]]),{maxTotalTokens:8});
 const s=await kernel.createSession();assert.equal((await kernel.runTurn(s,'go')).status,'completed');
 const us=(await kernel.readEvents(s)).filter(e=>e.type==='model.usage');
 assert.equal(us.length,1);assert.deepEqual((us[0]?.data as {usage:unknown}).usage,{inputTokens:5,outputTokens:3});
});

test('M1 usage: provider without usage cannot bypass configured hard budget',async()=>{
 const {kernel}=make(new FakeProvider([[done('ok')]]),{maxTotalTokens:100});const s=await kernel.createSession();
 assert.equal((await kernel.runTurn(s,'go')).errorCode,'USAGE_UNAVAILABLE');
 assert.equal((await kernel.readEvents(s)).some(e=>e.type==='assistant.message'),false);
});

test('M1 usage: over-budget first step prevents any tool execution',async()=>{
 let executed=0;const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{executed++;return 'done';}});
 const {kernel}=make(new FakeProvider([[usage(10,3),done('',[{id:'c',name:'read',arguments:{}}])]]),{maxTotalTokens:12},reg);
 const s=await kernel.createSession();assert.equal((await kernel.runTurn(s,'go')).errorCode,'TOKEN_BUDGET_EXCEEDED');assert.equal(executed,0);
 assert.equal((await kernel.readEvents(s)).filter(e=>e.type==='model.usage').length,1);
});

test('M1 usage: budget carried into second step, no extra model request after exhausted',async()=>{
 const p=new FakeProvider([[usage(7,3),done('',[{id:'c',name:'read',arguments:{}}])],[usage(1,1),done('late')]]);
 const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=> 'ok'});
 const {kernel}=make(p,{maxTotalTokens:10},reg);const s=await kernel.createSession();
 assert.equal((await kernel.runTurn(s,'go')).errorCode,'TOKEN_BUDGET_EXCEEDED');assert.equal(p.requests.length,1);
});

test('M1 usage: decreasing intermediate usage snapshot is rejected',async()=>{
 const {kernel}=make(new FakeProvider([[usage(9,1),usage(2,2),done()]]));const s=await kernel.createSession();
 assert.equal((await kernel.runTurn(s,'go')).errorCode,'INVALID_PROVIDER_USAGE');
});

test('M1 usage: invalid token budgets fail at construction',()=>{
 assert.throws(()=>make(new FakeProvider([]),{maxTotalTokens:0}),/maxTotalTokens/);
 assert.throws(()=>make(new FakeProvider([]),{maxTotalTokens:1.2}),/maxTotalTokens/);
});

test('M1 usage: OpenAI SSE usage-only chunk is parsed; request asks for stream usage',async()=>{
 let body:unknown;
 const p=new OpenAICompatibleProvider({model:'m',apiKey:'dummy',fetcher: (async(_url,init)=>{
  body=JSON.parse(String(init?.body));return apiSse([
    jsonChunk({choices:[{index:0,delta:{content:'hello'},finish_reason:'stop'}]}),
    jsonChunk({choices:[],usage:{prompt_tokens:11,completion_tokens:4,total_tokens:15}}),'data: [DONE]\n\n']);
 }) as typeof fetch});
 const events:ProviderEvent[]=[];for await(const e of p.stream([{role:'user',text:'hey'}],new AbortController().signal))events.push(e);
 assert.deepEqual(events.find(e=>e.type==='usage'),usage(11,4));
 assert.deepEqual((body as {stream_options:unknown}).stream_options,{include_usage:true});
});

test('M1 usage: malformed OpenAI usage response fails instead of inventing tokens',async()=>{
 const p=new OpenAICompatibleProvider({model:'m',apiKey:'dummy',fetcher:(async()=>apiSse([
   jsonChunk({choices:[],usage:{prompt_tokens:-1,completion_tokens:2}}),'data: [DONE]\n\n'])) as typeof fetch});
 await assert.rejects(async()=>{for await(const _ of p.stream([{role:'user',text:'hi'}],new AbortController().signal)){}}, {code:'INVALID_PROVIDER_USAGE'});
});

test('M1 usage: Anthropic final snapshot combines start input with delta output once',async()=>{
 const p=new AnthropicMessagesProvider({model:'m',apiKey:'dummy',maxOutputTokens:64,fetcher:(async()=>apiSse([
  anthropic('message_start',{message:{role:'assistant',usage:{input_tokens:23,output_tokens:1}}}),
  anthropic('content_block_start',{index:0,content_block:{type:'text',text:''}}),
  anthropic('content_block_delta',{index:0,delta:{type:'text_delta',text:'ok'}}),
  anthropic('content_block_stop',{index:0}),
  anthropic('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:5}}),
  anthropic('message_stop')])) as typeof fetch});
 const events:ProviderEvent[]=[];for await(const e of p.stream([{role:'user',text:'hi'}],new AbortController().signal))events.push(e);
 assert.deepEqual(events.find(e=>e.type==='usage'),usage(23,5));
});

test('M1 checkpoint: compresses completed historical turn while preserving immutable source events',async()=>{
 const requests:ContextMessage[][]=[];let calls=0, summaries=0;
 const p:ModelProvider={id:'script',async *stream(messages){requests.push(structuredClone([...messages]));calls++;yield done(calls===1?'x'.repeat(260):'after compact');}};
 const {kernel}=make(p,{maxContextCharacters:250,contextCompactor:{compact:async messages=>{summaries++;assert.ok(messages.some(m=>m.role==='assistant'));return 'Condensed task history';}}});
 const s=await kernel.createSession();assert.equal((await kernel.runTurn(s,'first')).status,'completed');
 const before=await kernel.readEvents(s);
 assert.equal((await kernel.runTurn(s,'second')).status,'completed');
 const after=await kernel.readEvents(s);
 const ck=after.find(e=>e.type==='context.checkpoint');assert.ok(ck);
 assert.equal((ck.data as {summary:string}).summary,'Condensed task history');
 assert.ok(requests[1]?.some(m=>m.role==='summary'));
 assert.ok(requests[1]?.some(m=>m.role==='user' && m.text==='second'));
 assert.equal(summaries,1);
 for(const ev of before)assert.deepEqual(after.find(x=>x.eventId===ev.eventId),ev);
});

test('M1 checkpoint: no completed older turn cannot be compacted and provider is never called',async()=>{
 let invoked=0,compact=0;
 const p:ModelProvider={id:'fake',async *stream(){invoked++;yield done();}};
 const {kernel}=make(p,{maxContextCharacters:40,contextCompactor:{compact:async()=>{compact++;return 'x';}}});
 const s=await kernel.createSession();const r=await kernel.runTurn(s,'huge'.repeat(50));
 assert.equal(r.errorCode,'CONTEXT_COMPACTION_UNSAFE');assert.equal(invoked,0);assert.equal(compact,0);
});

test('M1 checkpoint: compactor errors fail closed without writing checkpoint',async()=>{
 let n=0;
 const p:ModelProvider={id:'fake',async *stream(){n++;yield done('z'.repeat(n===1?260:1));}};
 const {kernel}=make(p,{maxContextCharacters:250,contextCompactor:{compact:async()=>{throw Error('summarizer failed');}}});
 const s=await kernel.createSession();assert.equal((await kernel.runTurn(s,'one')).status,'completed');
 assert.equal((await kernel.runTurn(s,'two')).errorCode,'CONTEXT_COMPACTION_FAILED');
 assert.equal(n,1);assert.equal((await kernel.readEvents(s)).some(e=>e.type==='context.checkpoint'),false);
});

test('M1 checkpoint: summary which still exceeds budget causes failure before provider',async()=>{
 let n=0;
 const p:ModelProvider={id:'fake',async *stream(){n++;yield done('z'.repeat(n===1?260:1));}};
 const {kernel}=make(p,{maxContextCharacters:250,contextCompactor:{compact:async()=> 'x'.repeat(700)}});
 const s=await kernel.createSession();await kernel.runTurn(s,'one');
 assert.equal((await kernel.runTurn(s,'two')).errorCode,'CONTEXT_BUDGET_EXCEEDED');assert.equal(n,1);
 assert.equal((await kernel.readEvents(s)).filter(e=>e.type==='context.checkpoint').length,1);
});

test('M1 checkpoint: cancellation during pending compaction does not persist checkpoint or run model',async()=>{
 let unblock!:()=>void, begin!:()=>void, count=0;
 const waiting=new Promise<void>(r=>unblock=r),entered=new Promise<void>(r=>begin=r);
 const p:ModelProvider={id:'f',async *stream(){count++;yield done('z'.repeat(count===1?260:1));}};
 const {kernel}=make(p,{maxContextCharacters:250,contextCompactor:{compact:async()=>{begin();await waiting;return 'short';}}});
 const s=await kernel.createSession();await kernel.runTurn(s,'first');
 const pending=kernel.runTurn(s,'second','second-turn');await entered;
 const cancelled=kernel.cancelTurn(s,'second-turn');unblock();
 assert.equal(await cancelled,true);assert.equal((await pending).status,'cancelled');
 const events=await kernel.readEvents(s);assert.equal(events.some(e=>e.type==='context.checkpoint'),false);
 assert.equal(count,1);assert.equal(events.at(-1)?.type,'turn.cancelled');
});

test('M1 usage: failed event commit withholds completion instead of reporting success',async()=>{
 const source=new MemoryEventStore();
 const store={read:(id:string,seq?:number)=>source.read(id,seq),
  append:(id:string,seq:number,drafts:readonly import('../packages/contracts/src/index.js').EventDraft[])=>{
   if(drafts.some(e=>e.type==='model.usage')) throw new Error('usage journal offline');
   return source.append(id,seq,drafts);
  }};
 const kernel=new AgentKernel(store,new FakeProvider([[usage(2,1),done()]]),new ToolRegistry());
 const s=await kernel.createSession();
 // A terminal write can succeed, but a missing mandatory Usage write must never produce 'completed'.
 assert.equal((await kernel.runTurn(s,'hi')).status,'failed');
 const events=await kernel.readEvents(s);
 assert.equal(events.some(e=>e.type==='turn.completed'),false);
 assert.equal(events.at(-1)?.type,'turn.failed');
});
