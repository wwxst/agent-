import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AgentKernel} from '../packages/kernel-core/src/index.js';
import {OpenAICompatibleProvider, decodeSse} from '../packages/model-providers/src/openai-compatible.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {MemoryEventStore} from '../packages/event-store-memory/src/index.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {type ModelProvider, type ProviderEvent, KernelError} from '../packages/contracts/src/index.js';

const enc = new TextEncoder();
const ev = (obj: unknown) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
const finish = (text: string, calls: Array<{id:string;name:string;arguments:unknown}> = []): ProviderEvent => ({
  type:'message_complete',message:{role:'assistant',text,toolCalls:calls},finishReason:calls.length?'tool_use':'stop',
});
const chunk = (delta: unknown, stop: string|null = null) => ({choices:[{index:0,delta,finish_reason:stop}]});
function httpSse(source: string, cuts: number[] = []): Response {
  const bytes = enc.encode(source), pieces: Uint8Array[] = [];
  let at = 0;
  for (const size of cuts) {pieces.push(bytes.slice(at, at+size));at += size;}
  pieces.push(bytes.slice(at));
  return new Response(new ReadableStream({start(ctrl){for(const part of pieces)ctrl.enqueue(part);ctrl.close();}}),{
    status:200, headers:{'content-type':'text/event-stream; charset=utf-8'},
  });
}
function adapter(payloads: string[], onCall?: (url:string, init:RequestInit) => void): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({model:'test-model',apiKey:'not-a-real-secret',baseUrl:'https://api.example/v1',
    fetcher: (async (url, init) => {
      onCall?.(String(url), init ?? {});
      const str = payloads.shift();
      if (str === undefined) throw Error('No scripted response');
      return httpSse(str, [1,3,7,12,6]);
    }) as typeof fetch,
  });
}

test('M1: SSE parser tolerates comments, CRLF, split UTF-8 and multiple data lines',async()=>{
  const raw = ': ping\r\ndata: {\r\ndata: "x":"🙂"}\r\n\r\n';
  const bytes=enc.encode(raw);
  const body=new ReadableStream<Uint8Array>({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
  const out:string[]=[];
  for await (const data of decodeSse(body,new AbortController().signal))out.push(data);
  assert.deepEqual(out,['{\n"x":"🙂"}']);
});

test('M1: streaming adapter assembles split tool JSON; result flows into next model request',async()=>{
  const captured:Array<{url:string;input:any}>=[];
  const responses=[
    ev(chunk({content:'Reading '},null))+ev(chunk({tool_calls:[{index:0,id:'tool-1',type:'function',function:{name:'lookup',arguments:'{"key":'}}]}))+
    ev(chunk({tool_calls:[{index:0,function:{arguments:'"value"}'}}]}))+ev(chunk({},'tool_calls'))+'data: [DONE]\r\n\r\n',
    ev(chunk({content:'Done 🙂'}))+ev(chunk({},'stop'))+'data: [DONE]\r\n\r\n',
  ];
  const registry=new ToolRegistry();let called=0;
  registry.register({name:'lookup',version:'1',risk:'read',concurrency:'parallel',description:'Return value',
    inputSchema:{type:'object',properties:{key:{type:'string'}}},parse:x=>x,execute:async x=>{called++;return JSON.stringify(x);}});
  const p=adapter(responses,(url,init)=>captured.push({url,input:JSON.parse(String(init.body))}));
  const deltas:string[]=[];
  const kernel=new AgentKernel(new MemoryEventStore(),p,registry,{},t=>deltas.push(t));
  const session=await kernel.createSession();
  const result=await kernel.runTurn(session,'Start');
  assert.equal(result.status,'completed');assert.equal(called,1);
  assert.deepEqual(deltas,['Reading ','Done 🙂']);
  assert.equal(captured[0]?.url,'https://api.example/v1/chat/completions');
  assert.equal(captured[0]?.input.tools[0].function.name,'lookup');
  assert.equal(captured[1]?.input.messages.at(-1).tool_call_id,'tool-1');
  assert.ok(captured[0]?.input.stream);
  const events=await kernel.readEvents(session);
  assert.equal(events.filter(x=>x.type==='model.started').length,2);
  assert.equal(events.filter(x=>x.type==='tool.result').length,1);
});

test('M1: streaming partial tool args without DONE must not execute',async()=>{
  let count=0;const registry=new ToolRegistry();registry.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{count++;return 'ok';}});
  const p=adapter([ev(chunk({tool_calls:[{index:0,id:'x',function:{name:'read',arguments:'{"x":'}}]}))+ev(chunk({},'tool_calls'))]);
  const k=new AgentKernel(new MemoryEventStore(),p,registry);const s=await k.createSession();
  const result=await k.runTurn(s,'hi');assert.equal(result.status,'failed');assert.equal(count,0);
});

test('M1: malformed JSON tool args with DONE also cannot execute',async()=>{
  let count=0;const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{count++;return 'ok';}});
  const p=adapter([ev(chunk({tool_calls:[{index:0,id:'x',function:{name:'read',arguments:'{oops'}}]}))+ev(chunk({},'tool_calls'))+'data: [DONE]\n\n']);
  const kernel=new AgentKernel(new MemoryEventStore(),p,reg);const s=await kernel.createSession();
  assert.equal((await kernel.runTurn(s,'go')).status,'failed');assert.equal(count,0);
});

test('M1: non-SSE HTTP and HTTP failures produce failed turns without secret leakage',async()=>{
  const provider=new OpenAICompatibleProvider({apiKey:'top-secret',model:'test-model',fetcher:(async()=>new Response('bad',{status:429})) as typeof fetch});
  const kernel=new AgentKernel(new MemoryEventStore(),provider,new ToolRegistry());const s=await kernel.createSession();
  const result=await kernel.runTurn(s,'go');
  assert.equal(result.status,'failed');
  const events=JSON.stringify(await kernel.readEvents(s));assert.equal(events.includes('top-secret'),false);
  assert.throws(()=>new OpenAICompatibleProvider({apiKey:'x',model:'model',baseUrl:'http://random.example/v1'}),{code:'INSECURE_PROVIDER_URL'});
});

test('M1: response with duplicate tool identifiers cannot execute',async()=>{
  let count=0;
  const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{count++;return 'ok';}});
  const p=adapter([ev(chunk({tool_calls:[{index:0,id:'x',function:{name:'read',arguments:'{}'}},{index:1,id:'x',function:{name:'read',arguments:'{}'}}]}))+
    ev(chunk({},'tool_calls'))+'data: [DONE]\n\n']);
  const kernel=new AgentKernel(new MemoryEventStore(),p,reg);const s=await kernel.createSession();
  assert.equal((await kernel.runTurn(s,'go')).status,'failed');assert.equal(count,0);
});

test('M1: toolset is bound per Step even if new tool registers mid-stream',async()=>{
  const registry=new ToolRegistry();let invoked=0;
  let observations: string[][]=[];
  const provider:ModelProvider={id:'late-tool',async *stream(_messages,_signal,step){
    observations.push(step?.tools.map(t=>t.name) ?? []);
    if(observations.length===1){
      registry.register({name:'new',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{invoked++;return 'ok';}});
      yield finish('',[{id:'late',name:'new',arguments:{}}]);
    }else yield finish('done');
  }};
  const kernel=new AgentKernel(new MemoryEventStore(),provider,registry);
  const s=await kernel.createSession();assert.equal((await kernel.runTurn(s,'go')).status,'completed');
  assert.equal(invoked,0);
  assert.deepEqual(observations,[[],['new']]);
});

test('M1: only read-only model tool schemas are advertised',async()=>{
  const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>''});
  reg.register({name:'write',version:'1',risk:'write',concurrency:'exclusive',parse:x=>x,execute:async()=>''});
  let offered:string[]=[];
  const provider:ModelProvider={id:'fake',async *stream(_m,_s,step){offered=step?.tools.map(t=>t.name)??[];yield finish('done');}};
  const kernel=new AgentKernel(new MemoryEventStore(),provider,reg);const s=await kernel.createSession();
  await kernel.runTurn(s,'test');assert.deepEqual(offered,['read']);
});

test('M1: cancelling blocked SSE reader terminates turn and does not execute tools',async()=>{
  let entered!:()=>void;
  const started=new Promise<void>(r=>entered=r);
  let cancelled=false;
  const response=new Response(new ReadableStream<Uint8Array>({
    start(controller){controller.enqueue(enc.encode(ev(chunk({content:'partial'}))));},
    cancel(){cancelled=true;},
  }),{headers:{'content-type':'text/event-stream'}});
  const p=new OpenAICompatibleProvider({apiKey:'x',model:'fake',fetcher:(async()=>{entered();return response;}) as typeof fetch});
  const k=new AgentKernel(new MemoryEventStore(),p,new ToolRegistry());const s=await k.createSession();
  const work=k.runTurn(s,'go','t');await started;
  // Wait until model.stream actually starts reading; cancellation may race its first read.
  assert.equal(await k.cancelTurn(s,'t'),true);
  const result=await work;
  assert.equal(result.status,'cancelled');
  assert.equal((await k.readEvents(s)).at(-1)?.type,'turn.cancelled');
  assert.equal(cancelled,true);
});

test('M1: length finish reason refuses even complete-looking tool call',async()=>{
  let count=0;
  const reg=new ToolRegistry();reg.register({name:'read',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,execute:async()=>{count++;return 'ok';}});
  const p=adapter([ev(chunk({tool_calls:[{index:0,id:'x',function:{name:'read',arguments:'{}'}}]})) + ev(chunk({},'length'))+'data: [DONE]\n\n']);
  const kernel=new AgentKernel(new MemoryEventStore(),p,reg);const s=await kernel.createSession();
  const result=await kernel.runTurn(s,'go');
  assert.equal(result.errorCode,'TRUNCATED_MODEL_OUTPUT');assert.equal(count,0);
});

test('M1: streamed API error and content_filter do not commit tool execution',async()=>{
  const requests=[ev({error:{code:'rate_limit_exceeded',message:'private'}})+'data: [DONE]\n\n',
    ev(chunk({},'content_filter'))+'data: [DONE]\n\n'];
  const p=adapter(requests);const k=new AgentKernel(new MemoryEventStore(),p,new ToolRegistry());
  const s=await k.createSession();assert.equal((await k.runTurn(s,'a')).status,'failed');
  assert.equal((await k.runTurn(s,'b')).status,'failed');
  const log=JSON.stringify(await k.readEvents(s));assert.equal(log.includes('private'),false);
});

test('M1: SSE frame limit rejects oversized input',async()=>{
  const resp=httpSse('data: '+ 'x'.repeat(2048)+'\n\n');
  const p=new OpenAICompatibleProvider({apiKey:'x',model:'fake',maxSseFrameBytes:128,
    fetcher:(async()=>resp) as typeof fetch});
  const kernel=new AgentKernel(new MemoryEventStore(),p,new ToolRegistry());const s=await kernel.createSession();
  assert.equal((await kernel.runTurn(s,'go')).status,'failed');
});
