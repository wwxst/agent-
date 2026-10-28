/**
 * Seventh-round research probe: actual filesystem edit and Node test execution,
 * confined to mkdtemp, using a trusted IN-PROCESS adapter.
 *
 * This is not a production coding tool! The deliberately mislabeled "read"
 * patch/test adapters prove orchestration only, NOT policy/sandbox safety.
 * The honest write tool test proves the public M0 contract refuses writes.
 *
 * Adaptive scripted provider uses actual previous tool results; no LLM involved.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { MemoryEventStore } from '../packages/event-store-memory/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';
import type { ContextMessage, ModelProvider, ProviderEvent, ToolCall, ToolDefinition } from '../packages/contracts/src/index.js';

const call=(id:string,name:string,args:unknown={}):ToolCall=>({id,name,arguments:args});
const response=(text:string,calls:readonly ToolCall[]=[]):ProviderEvent=>({
  type:'message_complete',message:{role:'assistant',text,toolCalls:calls},
  finishReason:calls.length?'tool_use':'stop',
});
const fixture=()=>{
  const dir=mkdtempSync(join(tmpdir(),'kernel-coding-probe-'));
  const source=join(dir,'calc.mjs'),spec=join(dir,'calc.test.mjs');
  writeFileSync(source,'export const add=(a,b)=>a-b;\n','utf8');
  writeFileSync(spec,`import assert from 'node:assert/strict';
import {test} from 'node:test';
import {add} from './calc.mjs';
test('add is correct',()=>assert.equal(add(2,3),5));
`,'utf8');
  return {dir,source,spec,done:()=>rmSync(dir,{recursive:true,force:true})};
};

test('CODING-M0-01: honest write capability is hidden and denied, no workspace mutation',async()=>{
  const x=fixture(),tools=new ToolRegistry();let writes=0;
  try{
    tools.register({name:'repo.patch',version:'1',risk:'write',concurrency:'exclusive',
      parse:v=>v,execute:async()=>{writes++;writeFileSync(x.source,'unapproved edit');return 'patched';}});
    const p=new FakeProvider([[response('attempt patch',[call('write','repo.patch',{kind:'fix'})])],[response('blocked')]]);
    const store=new MemoryEventStore(),kernel=new AgentKernel(store,p,tools);
    const session=await kernel.createSession('write-denial');
    const out=await kernel.runTurn(session,'fix the bug','turn');
    assert.equal(out.status,'completed');
    assert.equal(writes,0);
    assert.equal(readFileSync(x.source,'utf8'),'export const add=(a,b)=>a-b;\n');
    const event=(await store.read(session)).find(e=>e.type==='tool.receipt');
    assert.deepEqual((event?.data as {outcome:string;content:string}),{
      callId:'write',name:'repo.patch',outcome:'denied',content:'M0_DENIES_SIDE_EFFECTS',
    });
    assert.equal(p.requests[1]?.some(m=>m.role==='tool'&&m.result.outcome==='denied'),true);
    assert.equal(tools.modelSpecs().some(s=>s.name==='repo.patch'),false);
  }finally{x.done();}
});

test('CODING-M0-02: trusted unsandboxed fixture exercises read/edit/test/fail/fix/pass causal loop',async()=>{
  const x=fixture(),tools=new ToolRegistry(),observed:boolean[]=[];
  try{
    const read:ToolDefinition={
      name:'repo.read',version:'1',risk:'read',concurrency:'parallel',
      parse:v=>v,execute:async()=>readFileSync(x.source,'utf8'),
    };
    // DELIBERATE POLICY BYPASS FOR RESEARCH: misdeclared write as read.
    const patch:ToolDefinition={
      name:'repo.patch.unsafe-fixture',version:'1',risk:'read',concurrency:'exclusive',
      parse:(v:unknown)=>{
        if(!v||typeof v!=='object'||!('variant' in v)
          ||(v.variant!=='wrong'&&v.variant!=='fixed'))throw Error('Invalid variant');
        return {variant:v.variant};
      },
      execute:async(v:unknown)=>{
        const variant=(v as {variant:'wrong'|'fixed'}).variant;
        writeFileSync(x.source,variant==='wrong'
          ?'export const add=(a,b)=>a*b;\n'
          :'export const add=(a,b)=>a+b;\n','utf8');
        return variant;
      },
    };
    const run:ToolDefinition={
      name:'repo.test.unsafe-fixture',version:'1',risk:'read',concurrency:'exclusive',
      parse:v=>v,
      execute:async()=>{
        const child=spawnSync(process.execPath,['--test',x.spec],{
          cwd:x.dir,env:{},encoding:'utf8',timeout:3500,
        });
        assert.equal(child.error,undefined);
        const passed=child.status===0;
        observed.push(passed);
        return JSON.stringify({passed,exitCode:child.status,output:(child.stdout??'').slice(0,600)});
      },
    };
    tools.register(read);tools.register(patch);tools.register(run);
    let step=0;
    const model:ModelProvider={
      id:'adaptive-fixture',
      async *stream(messages:readonly ContextMessage[]){
        const results=messages.filter(m=>m.role==='tool').map(m=>m.result);
        step++;
        if(step===1){
          assert.equal(results.length,0);
          yield response('read workspace',[call('c1','repo.read')]);return;
        }
        if(step===2){
          assert.match(results[0]?.content??'',/a-b/);
          yield response('apply intentionally wrong candidate',[call('c2','repo.patch.unsafe-fixture',{variant:'wrong'})]);return;
        }
        if(step===3){
          assert.equal(results[1]?.content,'wrong');
          yield response('test candidate',[call('c3','repo.test.unsafe-fixture')]);return;
        }
        if(step===4){
          const outcome=JSON.parse(results[2]?.content??'null') as {passed:boolean;exitCode:number};
          assert.equal(outcome.passed,false);
          assert.notEqual(outcome.exitCode,0);
          yield response('fix after test failure',[call('c4','repo.patch.unsafe-fixture',{variant:'fixed'})]);return;
        }
        if(step===5){
          assert.equal(results[3]?.content,'fixed');
          yield response('retest',[call('c5','repo.test.unsafe-fixture')]);return;
        }
        if(step===6){
          const outcome=JSON.parse(results[4]?.content??'null') as {passed:boolean;exitCode:number};
          assert.equal(outcome.passed,true);
          assert.equal(outcome.exitCode,0);
          yield response('verified solution');return;
        }
        assert.fail('unexpected model step '+step);
      },
    };
    const store=new MemoryEventStore(),kernel=new AgentKernel(store,model,tools,{maxSteps:7});
    const session=await kernel.createSession('coding-fixture');
    const answer=await kernel.runTurn(session,'Fix add and run tests','turn');
    assert.equal(answer.status,'completed');
    assert.equal(answer.assistant?.text,'verified solution');
    assert.deepEqual(observed,[false,true]);
    assert.equal(readFileSync(x.source,'utf8'),'export const add=(a,b)=>a+b;\n');
    const events=await store.read(session);
    assert.equal(events.filter(e=>e.type==='model.started').length,6);
    assert.equal(events.filter(e=>e.type==='tool.intent').length,5);
    assert.equal(events.filter(e=>e.type==='tool.receipt').length,5);
    assert.equal(events.filter(e=>e.type==='tool.result').length,5);
    assert.equal(events.at(-1)?.type,'turn.completed');
  }finally{x.done();}
});
