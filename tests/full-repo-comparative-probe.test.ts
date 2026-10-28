/*
 * OPTIONAL OBSERVATION PROBE, NOT A CONFORMANCE TEST.
 * Copy to tests/ of wwxst/agent- at commit
 * 72bf0ce79d8beaf83565072d9c5ade39ae15803d.
 * Assertions describe observed behavior, including shortcomings.
 * This full-repository probe has NOT BEEN RUN in this research environment.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventStore } from '../packages/contracts/src/index.js';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { MemoryEventStore } from '../packages/event-store-memory/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ToolRegistry, executeBatch } from '../packages/tool-scheduler/src/index.js';

const done = () => ({
  type: 'message_complete' as const,
  message: {role:'assistant' as const,text:'finished',toolCalls:[]},
  finishReason:'stop' as const,
});

test('T02 original Kernel: the next Provider request can receive tool B before tool A', async () => {
  const base=new MemoryEventStore();
  let releaseA!:()=>void;
  const waitA=new Promise<void>(r=>{releaseA=r;});
  const store:EventStore={
    read:(id,after)=>base.read(id,after),
    append:async(id,seq,drafts)=>{
      const committed=await base.append(id,seq,drafts);
      if(drafts.some(d=>d.type==='tool.receipt'&& (d.data as {callId?:string}).callId==='b')) releaseA();
      return committed;
    },
  };
  const tools=new ToolRegistry();
  tools.register({name:'a',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,
    execute:async()=>{await waitA;return 'A';}});
  tools.register({name:'b',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,
    execute:async()=> 'B'});
  const provider=new FakeProvider([[
    {type:'message_complete',message:{role:'assistant',text:'go',toolCalls:[
      {id:'a',name:'a',arguments:{}},{id:'b',name:'b',arguments:{}},
    ]},finishReason:'tool_use'},
  ],[done()]]);
  const kernel=new AgentKernel(store,provider,tools);
  await kernel.createSession('repro-t02');
  const out=await kernel.runTurn('repro-t02','test','turn');
  assert.equal(out.status,'completed');
  const receipts=(await base.read('repro-t02')).filter(e=>e.type==='tool.receipt')
    .map(e=>(e.data as {callId:string}).callId);
  const modelResults=provider.requests[1]?.filter(m=>m.role==='tool').map(m=>m.result.callId);
  assert.deepEqual(receipts,['b','a']);
  assert.deepEqual(modelResults,['b','a']);
});

test('T-EX original Scheduler: exclusive tool receives no execution context',async()=>{
  const tools=new ToolRegistry();let context:unknown='not called';
  tools.register({name:'exclusive',version:'1',risk:'read',concurrency:'exclusive',parse:x=>x,
    execute:async(_input,_signal,ctx)=>{context=ctx;return 'ok';}});
  const result=await executeBatch([{id:'call-1',name:'exclusive',arguments:{}}],tools,new AbortController().signal,
    undefined,undefined,{sessionId:'s',turnId:'t'});
  assert.equal(result[0]?.outcome,'succeeded');
  assert.equal(context,undefined);
});

test('T-OBS original Kernel: a throwing text delta observer can fail the Turn',async()=>{
  const store=new MemoryEventStore();
  const p=new FakeProvider([[{type:'text_delta',text:'hello'},done()]]);
  const kernel=new AgentKernel(store,p,new ToolRegistry(),{},()=>{throw new Error('observer-error');});
  await kernel.createSession('repro-observer');
  const result=await kernel.runTurn('repro-observer','hi','turn');
  assert.equal(result.status,'failed');
  assert.equal(result.errorCode,'KERNEL_OR_PROVIDER_ERROR');
});

test('B01 real Scheduler: read label cannot stop a trusted in-process tool from writing',async()=>{
  const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'agent-b01-')); const path=join(dir,'proof.txt');
  try{
    writeFileSync(path,'before');
    const tools=new ToolRegistry();
    tools.register({name:'read.declared',version:'1',risk:'read',concurrency:'parallel',parse:x=>x,
      execute:async()=>{writeFileSync(path,'after');return 'ok';}});
    const result=await executeBatch([{id:'c',name:'read.declared',arguments:{}}],tools,new AbortController().signal);
    assert.equal(result[0]?.outcome,'succeeded');
    assert.equal(readFileSync(path,'utf8'),'after');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('B06 real Scheduler: a throwing parse may have side effects without execute',async()=>{
  const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'agent-b06-'));const path=join(dir,'proof.txt');
  let executions=0;
  try{
    writeFileSync(path,'before');
    const tools=new ToolRegistry();
    tools.register({name:'read.parse',version:'1',risk:'read',concurrency:'parallel',
      parse:()=>{writeFileSync(path,'changed');throw Error('invalid');},
      execute:async()=>{executions++;return 'unexpected';}});
    const result=await executeBatch([{id:'c',name:'read.parse',arguments:{}}],tools,new AbortController().signal);
    assert.equal(result[0]?.content,'INVALID_TOOL_ARGUMENTS');
    assert.equal(executions,0);
    assert.equal(readFileSync(path,'utf8'),'changed');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
