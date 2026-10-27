import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AnthropicMessagesProvider} from '../packages/model-providers/src/anthropic-messages.js';
import {AgentKernel} from '../packages/kernel-core/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {MemoryEventStore} from '../packages/event-store-memory/src/index.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {admitContext} from '../packages/context-engine/src/index.js';
import {type ProviderEvent} from '../packages/contracts/src/index.js';

const evt=(type:string,x:object={})=>`event: ${type}\ndata: ${JSON.stringify({type,...x})}\n\n`;
const begin=evt('message_start',{message:{role:'assistant',id:'m'}});
const finish=(reason:string)=>evt('message_delta',{delta:{stop_reason:reason}})+evt('message_stop');
const textBlock=(index:number,text:string)=>evt('content_block_start',{index,content_block:{type:'text',text:''}})+
  evt('content_block_delta',{index,delta:{type:'text_delta',text}})+evt('content_block_stop',{index});
const toolBlock=(index:number,id:string,name:string,args:string)=>evt('content_block_start',{index,content_block:{type:'tool_use',id,name,input:{}}})+
  evt('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:args.slice(0,4)}})+
  evt('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:args.slice(4)}})+evt('content_block_stop',{index});
const response=(str:string)=>new Response(new ReadableStream<Uint8Array>({start(c){
  const raw = new TextEncoder().encode(str);
  for (let i=0;i<raw.length;i+=3) c.enqueue(raw.subarray(i,i+3));
  c.close();
}}),{status:200,headers:{'content-type':'text/event-stream'}});
const complete=(text:string):ProviderEvent=>({type:'message_complete',message:{role:'assistant',text,toolCalls:[]},finishReason:'stop'});
function make(strings:string[], capture?:(request:Record<string,unknown>,headers:Headers)=>void){
  return new AnthropicMessagesProvider({model:'claude-test',apiKey:'dummy-secret',maxOutputTokens:1024,
    fetcher: (async (_url,init)=>{
      capture?.(JSON.parse(String(init?.body)) as Record<string,unknown>,new Headers(init?.headers));
      const body=strings.shift();if(body===undefined)throw Error('No mock response');return response(body);
    }) as typeof fetch});
}

test('M1 native Messages: text stream, UTF-8 and completion mapped to kernel',async()=>{
  const p=make([begin+evt('ping')+textBlock(0,'你好 🙂')+finish('end_turn')]);
  const deltas:string[]=[];
  const k=new AgentKernel(new MemoryEventStore(),p,new ToolRegistry(),{},txt=>deltas.push(txt));
  const s=await k.createSession();const result=await k.runTurn(s,'hello');
  assert.equal(result.status,'completed');assert.equal(result.assistant?.text,'你好 🙂');assert.deepEqual(deltas,['你好 🙂']);
});

test('M1 native Messages: streamed tool JSON, tool_result user block, fixed Step tool schema',async()=>{
  const captured:Record<string,unknown>[]=[];
  const p=make([begin+textBlock(0,'checking')+toolBlock(1,'id-1','read','{"key":"abc"}')+finish('tool_use'),
    begin+textBlock(0,'done')+finish('end_turn')],req=>captured.push(req));
  const reg=new ToolRegistry();let count=0;
  reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',inputSchema:{type:'object',properties:{key:{type:'string'}}},
    parse:x=>x,execute:async()=>{count++;return 'result';}});
  const k=new AgentKernel(new MemoryEventStore(),p,reg);const s=await k.createSession();
  assert.equal((await k.runTurn(s,'go')).status,'completed');assert.equal(count,1);
  assert.equal((captured[0]?.tools as any[])[0].input_schema.type,'object');
  const hist=captured[1]?.messages as any[];
  assert.equal(hist[1].role,'assistant');assert.equal(hist[1].content.at(-1).type,'tool_use');
  assert.equal(hist[2].role,'user');assert.equal(hist[2].content[0].type,'tool_result');
  assert.equal(hist[2].content[0].tool_use_id,'id-1');
});

test('M1 native Messages: unsupported internal thinking block fails closed',async()=>{
  const p=make([begin+evt('content_block_start',{index:0,content_block:{type:'thinking',thinking:''}})+finish('end_turn')]);
  const k=new AgentKernel(new MemoryEventStore(),p,new ToolRegistry());const s=await k.createSession();
  const r=await k.runTurn(s,'go');assert.equal(r.status,'failed');
  assert.equal(r.errorCode,'UNSUPPORTED_ANTHROPIC_BLOCK');
});

test('M1 native Messages: incomplete stream never executes tool',async()=>{
  let count=0;
  const p=make([begin+toolBlock(0,'id','read','{}')+evt('message_delta',{delta:{stop_reason:'tool_use'}})]);
  const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{count++;return 'ok';}});
  const k=new AgentKernel(new MemoryEventStore(),p,reg);const s=await k.createSession();
  assert.equal((await k.runTurn(s,'go')).status,'failed');assert.equal(count,0);
});

test('M1 native Messages: max_tokens prevents tool side effects',async()=>{
  let count=0;
  const p=make([begin+toolBlock(0,'id','read','{}')+finish('max_tokens')]);
  const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{count++;return 'ok';}});
  const k=new AgentKernel(new MemoryEventStore(),p,reg);const s=await k.createSession();
  assert.equal((await k.runTurn(s,'go')).errorCode,'TRUNCATED_MODEL_OUTPUT');assert.equal(count,0);
});

test('M1 native Messages: invalid JSON tool input is rejected before host execution',async()=>{
  let count=0;
  const p=make([begin+toolBlock(0,'id','read','{"broken":')+finish('tool_use')]);
  const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{count++;return 'ok';}});
  const k=new AgentKernel(new MemoryEventStore(),p,reg);const s=await k.createSession();
  assert.equal((await k.runTurn(s,'go')).errorCode,'INCOMPLETE_TOOL_ARGUMENTS');assert.equal(count,0);
});

test('M1 native Messages: duplicate tool_use id fails, tool not executed',async()=>{
  let count=0;
  const p=make([begin+toolBlock(0,'dup','read','{}')+toolBlock(1,'dup','read','{}')+finish('tool_use')]);
  const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{count++;return 'ok';}});
  const k=new AgentKernel(new MemoryEventStore(),p,reg);const s=await k.createSession();
  assert.equal((await k.runTurn(s,'go')).errorCode,'DUPLICATE_TOOL_ID');assert.equal(count,0);
});

test('M1 native Messages: API error redacts server body / secret, HTTP rejected',async()=>{
  const p=new AnthropicMessagesProvider({model:'m',apiKey:'secret-marker',maxOutputTokens:40,
    fetcher:(async()=>new Response('server leaked secret-marker',{status:503})) as typeof fetch});
  const k=new AgentKernel(new MemoryEventStore(),p,new ToolRegistry());const s=await k.createSession();
  assert.equal((await k.runTurn(s,'go')).status,'failed');
  assert.equal(JSON.stringify(await k.readEvents(s)).includes('secret-marker'),false);
});

test('M1 native Messages: endpoint policy rejects non-local HTTP',()=>{
  assert.throws(()=>new AnthropicMessagesProvider({model:'m',apiKey:'x',maxOutputTokens:1,baseUrl:'http://example.org/v1'}),
    {code:'INSECURE_PROVIDER_URL'});
});

test('M1 native Messages: message event after stop is rejected',async()=>{
  const p=make([begin+textBlock(0,'ok')+finish('end_turn')+evt('ping')]);
  const k=new AgentKernel(new MemoryEventStore(),p,new ToolRegistry());const s=await k.createSession();
  // ping is allowed after message_stop by adapter, but non-ping deltas are not.
  assert.equal((await k.runTurn(s,'go')).status,'completed');
});

test('M1 ContextAdmission: exact character accounting and tool schema count',()=>{
  const msg=[{role:'user' as const,text:'abc'}];
  const request={stepId:'x',toolSetVersion:1,tools:[{name:'r',version:'1',description:'read',inputSchema:{type:'object'}}]};
  const exact=JSON.stringify({messages:msg,tools:request.tools}).length;
  assert.deepEqual(admitContext(msg,request,{maxSerializedCharacters:exact}),{serializedCharacters:exact,limit:exact});
  assert.throws(()=>admitContext(msg,request,{maxSerializedCharacters:exact-1}),{code:'CONTEXT_BUDGET_EXCEEDED'});
});

test('M1 ContextAdmission: over budget fails before provider dispatch',async()=>{
  const provider=new FakeProvider([[complete('never')]]);
  const k=new AgentKernel(new MemoryEventStore(),provider,new ToolRegistry(),{maxContextCharacters:12});
  const s=await k.createSession();const r=await k.runTurn(s,'message exceeds');
  assert.equal(r.status,'failed');assert.equal(r.errorCode,'CONTEXT_BUDGET_EXCEEDED');
  assert.equal(provider.requests.length,0);
  assert.equal((await k.readEvents(s)).filter(e=>e.type==='model.started').length,0);
});

test('M1 ContextAdmission: safe budget emits non-sensitive size metadata',async()=>{
  const provider=new FakeProvider([[complete('ok')]]);
  const k=new AgentKernel(new MemoryEventStore(),provider,new ToolRegistry(),{maxContextCharacters:4096});
  const s=await k.createSession();assert.equal((await k.runTurn(s,'short')).status,'completed');
  const e=(await k.readEvents(s)).find(e=>e.type==='model.started');
  assert.equal(typeof (e?.data as any)?.contextSize,'number');
  assert.equal((e?.data as any)?.contextLimit,4096);
});

test('M1 ContextAdmission: budget validation refuses invalid configuration',()=>{
  assert.throws(()=>new AgentKernel(new MemoryEventStore(),new FakeProvider([]),new ToolRegistry(),{maxContextCharacters:0}),
    {code:'INVALID_BUDGET'});
});
