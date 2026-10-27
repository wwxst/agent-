import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {AgentKernel} from '../packages/kernel-core/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {MemoryEventStore} from '../packages/event-store-memory/src/index.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {ManagedSessionRunner} from '../packages/session-runtime/src/index.js';
import {SqliteWriterLeaseStore} from '../packages/session-leases-sqlite/src/index.js';
import {SqliteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {SqliteCommandInbox} from '../packages/command-inbox/src/index.js';
import {SqliteToolReconciler} from '../packages/tool-reconciliation/src/index.js';
import {ProcessToolHost} from '../packages/tool-host/src/index.js';
import {HostExecutionLedger} from '../packages/tool-host/src/ledger.js';
import {inspectSteeringAudit} from '../packages/steering-audit/src/index.js';
import type {ModelProvider,ProviderEvent} from '../packages/contracts/src/index.js';

const done=(text='done'):ProviderEvent=>({type:'message_complete',
  message:{role:'assistant',text,toolCalls:[]},finishReason:'stop'});

function deferred(){
  let resolve!:()=>void;
  const promise=new Promise<void>(r=>resolve=r);
  return {promise,resolve};
}
function temporary(){
  const dir=mkdtempSync(join(tmpdir(),'steering-'));
  return {path:join(dir,'state.sqlite'),close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('M2 steering: matching active Turn receives durable queued and consumed user input',async()=>{
  const started=deferred(),release=deferred();
  const seen:string[][]=[];
  const provider:ModelProvider={id:'gated',async *stream(messages){
    seen.push(messages.filter(m=>m.role==='user').map(m=>m.text));
    if(seen.length===1){started.resolve();await release.promise;yield done('first');}
    else yield done('second');
  }};
  const store=new MemoryEventStore(),kernel=new AgentKernel(store,provider,new ToolRegistry());
  const session=await kernel.createSession('s');
  const work=kernel.runTurn(session,'first prompt','turn-1');
  await started.promise;
  assert.equal(await kernel.steerTurn(session,'wrong','not accepted'),false);
  assert.equal(await kernel.steerTurn(session,'turn-1','additional instruction'),true);
  release.resolve();
  assert.equal((await work).status,'completed');
  assert.deepEqual(seen,[['first prompt'],['first prompt','additional instruction']]);
  const events=await store.read(session);
  assert.equal(events.filter(e=>e.type==='turn.steer_queued').length,1);
  assert.equal(events.filter(e=>e.type==='turn.steer_consumed').length,1);
  assert.equal(inspectSteeringAudit(events).unconsumedSteers,0);
  assert.equal(events.filter(e=>e.type==='user.message').length,2);
});

test('M2 steering: multiple acknowledgments preserve FIFO order',async()=>{
  const started=deferred(),release=deferred(),seen:string[][]=[];
  const provider:ModelProvider={id:'gated',async *stream(messages){
    seen.push(messages.filter(m=>m.role==='user').map(m=>m.text));
    if(seen.length===1){started.resolve();await release.promise;yield done('first');}
    else yield done('second');
  }};
  const store=new MemoryEventStore(),k=new AgentKernel(store,provider,new ToolRegistry());
  await k.createSession('s');
  const work=k.runTurn('s','original','t');await started.promise;
  const first=k.steerTurn('s','t','one');
  const second=k.steerTurn('s','t','two');
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  release.resolve();
  assert.equal((await work).status,'completed');
  assert.deepEqual(seen[1],['original','one','two']);
  assert.equal(inspectSteeringAudit(await store.read('s')).unconsumedSteers,0);
});

test('M2 steering: after Turn is complete or absent, steering cannot persist',async()=>{
  const k=new AgentKernel(new MemoryEventStore(),new FakeProvider([[done()]]),new ToolRegistry());
  await k.createSession('s');
  assert.equal(await k.steerTurn('s','t','early'),false);
  assert.equal((await k.runTurn('s','text','t')).status,'completed');
  assert.equal(await k.steerTurn('s','t','late'),false);
  assert.equal((await k.readEvents('s')).filter(e=>e.type==='turn.steer_queued').length,0);
});

test('M2 steering: fenced ManagedSessionRunner routes accepted input to active lease owner',async()=>{
  const t=temporary(),started=deferred(),release=deferred(),seen:string[][]=[];
  try{
    const provider:ModelProvider={id:'managed-gate',async *stream(messages){
      seen.push(messages.filter(m=>m.role==='user').map(m=>m.text));
      if(seen.length===1){started.resolve();await release.promise;yield done('one');}
      else yield done('two');
    }};
    const runner=new ManagedSessionRunner(t.path,provider,new ToolRegistry());
    await runner.createSession('s');
    const work=runner.runTurn('s','initial','turn');
    await started.promise;
    assert.equal(await runner.steerTurn('s','bad','wrong'),false);
    assert.equal(await runner.steerTurn('s','turn','managed steer'),true);
    release.resolve();
    assert.equal((await work).status,'completed');
    assert.deepEqual(seen[1],['initial','managed steer']);
    assert.equal(await runner.steerTurn('s','turn','late'),false);
    const observer=new SqliteToolReconciler(t.path);
    try{
      const report=observer.inspect('s');
      assert.equal(report.unconsumedSteers,0);
      assert.equal(report.requiresManualReview,false);
    }finally{observer.close();}
  }finally{release.resolve();t.close();}
});

test('M2 steering: accepted but unconsumed instruction after provider failure blocks session reopen',async()=>{
  const started=deferred(),release=deferred();
  const provider:ModelProvider={id:'boom',async *stream(){
    started.resolve();await release.promise;
    throw new Error('provider crashed');
    yield done('unreachable');
  }};
  const store=new MemoryEventStore(),kernel=new AgentKernel(store,provider,new ToolRegistry());
  await kernel.createSession('s');
  const work=kernel.runTurn('s','original','t');await started.promise;
  assert.equal(await kernel.steerTurn('s','t','unconsumed'),true);
  release.resolve();
  assert.equal((await work).status,'failed');
  assert.equal(inspectSteeringAudit(await store.read('s')).unconsumedSteers,1);
  const reopened=new AgentKernel(store,new FakeProvider([]),new ToolRegistry());
  await assert.rejects(reopened.openSession('s'),{code:'RECOVERY_REQUIRED'});
});

test('M2 steering: cancellation with queued input cannot silently consume or complete it',async()=>{
  const started=deferred(),release=deferred();
  const provider:ModelProvider={id:'gated',async *stream(){
    started.resolve();await release.promise;yield done('ignored');
  }};
  const store=new MemoryEventStore(),k=new AgentKernel(store,provider,new ToolRegistry());
  await k.createSession('s');const work=k.runTurn('s','message','turn');
  await started.promise;
  assert.equal(await k.steerTurn('s','turn','not yet used'),true);
  assert.equal(await k.cancelTurn('s','turn'),true);
  release.resolve();
  assert.equal((await work).status,'cancelled');
  const events=await store.read('s');
  assert.equal(events.filter(x=>x.type==='turn.steer_consumed').length,0);
  assert.equal(inspectSteeringAudit(events).unconsumedSteers,1);
  const second=new AgentKernel(store,new FakeProvider([]),new ToolRegistry());
  await assert.rejects(second.openSession('s'),{code:'RECOVERY_REQUIRED'});
});

test('M2 steering: malformed consumption without adjacent matching user.message is corrupt',async()=>{
  const store=new MemoryEventStore();
  await store.append('s',0,[
    {type:'session.created',data:{}},
    {type:'turn.queued',turnId:'t',data:{}},
    {type:'user.message',turnId:'t',data:{text:'hello'}},
    {type:'turn.started',turnId:'t',data:{}},
    {type:'turn.steer_queued',turnId:'t',data:{text:'a'}},
    {type:'turn.steer_consumed',turnId:'t',data:{}},
    {type:'user.message',turnId:'t',data:{text:'wrong'}},
    {type:'turn.completed',turnId:'t',data:{}},
  ]);
  const events=await store.read('s');
  assert.throws(()=>inspectSteeringAudit(events),{code:'CORRUPT_EVENT_LOG'});
});

test('M2 steering: in-process inbox cannot accept a new command with ignored queued steering',async()=>{
  const t=temporary(),leases=new SqliteWriterLeaseStore(t.path);
  let journal:SqliteEventStore|undefined,inbox:SqliteCommandInbox|undefined;
  try{
    const lease=leases.acquire('s','writer',5000);assert.ok(lease);
    journal=new SqliteEventStore(t.path,lease);
    await journal.append('s',0,[
      {type:'session.created',data:{}},
      {type:'turn.queued',turnId:'t',data:{}},
      {type:'user.message',turnId:'t',data:{text:'original'}},
      {type:'turn.started',turnId:'t',data:{}},
      {type:'turn.steer_queued',turnId:'t',data:{text:'lost'}},
      {type:'turn.failed',turnId:'t',data:{}},
    ]);
    inbox=new SqliteCommandInbox(t.path);
    assert.throws(()=>inbox!.accept({lease,expectedSeq:6,commandId:'cmd',kind:'control.note',payload:{}}),
      {code:'RECOVERY_REQUIRED'});
  }finally{inbox?.close();journal?.close();leases.close();t.close();}
});

test('M2 steering: while separate Host runs a read tool, accepted input reaches next model step',async()=>{
  const t=temporary();
  const host=new ProcessToolHost(t.path);
  try{
    const provider=new FakeProvider([[
      {type:'message_complete',message:{role:'assistant',text:'',toolCalls:[
        {id:'sleep',name:'read.sleep',arguments:{ms:600}},
      ]},finishReason:'tool_use'},
    ],[done('final')]]);
    const runner=new ManagedSessionRunner(t.path,provider,lease=>host.createRegistry(lease));
    await runner.createSession('s');
    const running=runner.runTurn('s','start','t');
    const ledger=new HostExecutionLedger(t.path);
    try {
      let found=false;
      for(let i=0;i<120;i++){
        if(ledger.inspect('s').some(e=>e.state==='started')){found=true;break;}
        await sleep(10);
      }
      assert.equal(found,true,'Host did not persist execution start');
    }finally{ledger.close();}
    assert.equal(await runner.steerTurn('s','t','additional'),true);
    assert.equal((await running).status,'completed');
    const requests=provider.requests[1]??[];
    assert.equal(requests.some(m=>m.role==='user' && m.text==='additional'),true);
    const observer=new SqliteToolReconciler(t.path);
    try{
      const report=observer.inspect('s');
      assert.equal(report.calls[0]?.status,'verified');
      assert.equal(report.unconsumedSteers,0);
    }finally{observer.close();}
  }finally{host.close();t.close();}
});
