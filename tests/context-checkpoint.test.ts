import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { MemoryEventStore } from '../packages/event-store-memory/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { SqliteWriterLeaseStore } from '../packages/session-leases-sqlite/src/index.js';
import { ManagedSessionRunner } from '../packages/session-runtime/src/index.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { SqliteToolReconciler } from '../packages/tool-reconciliation/src/index.js';
import { SqliteCommandInbox } from '../packages/command-inbox/src/index.js';
import { hashContextSource, inspectContextCheckpoints } from '../packages/context-engine/src/checkpoint.js';
import type { ContextMessage, ModelProvider, ProviderEvent } from '../packages/contracts/src/index.js';

const finish = (text: string): ProviderEvent => ({type:'message_complete',
  message:{role:'assistant',text,toolCalls:[]},finishReason:'stop'});
function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(r=>resolve=r);
  return {promise,resolve};
}
function temporary(){
  const dir=mkdtempSync(join(tmpdir(),'context-checkpoint-'));
  return {path:join(dir,'events.sqlite'),close:()=>rmSync(dir,{recursive:true,force:true})};
}

test('M2 checkpoint: completed history becomes a verified summary, never deletes source or current user',async()=>{
  const seen: ContextMessage[][]=[];
  let step=0, compactions=0;
  const provider:ModelProvider={id:'checkpoint-provider',async *stream(messages){
    seen.push(structuredClone([...messages]));
    yield finish(++step===1?'x'.repeat(320):'final');
  }};
  const store=new MemoryEventStore();
  const kernel=new AgentKernel(store,provider,new ToolRegistry(),{
    maxContextCharacters:220,
    contextCompactor:{compact:async messages=>{
      compactions++;
      assert.equal(messages.at(-1)?.role,'assistant');
      return 'short historical summary';
    }},
  });
  await kernel.createSession('s');
  assert.equal((await kernel.runTurn('s','first','t1')).status,'completed');
  const original=await store.read('s');
  assert.equal((await kernel.runTurn('s','second','t2')).status,'completed');
  const events=await store.read('s');
  const checkpoints=inspectContextCheckpoints(events);
  assert.equal(checkpoints.length,1);
  assert.equal(compactions,1);
  assert.equal(checkpoints[0]?.throughSeq,original.at(-1)?.seq);
  assert.equal(checkpoints[0]?.sourceHash,hashContextSource(events,original.length));
  assert.equal(checkpoints[0]?.sourceEventCount,original.length);
  assert.deepEqual(events.slice(0,original.length),original);
  assert.deepEqual(seen[1]?.map(m=>m.role),['summary','user']);
  assert.equal((seen[1]?.at(-1) as {text?:string})?.text,'second');
  assert.equal((seen[1]?.[0] as {text?:string})?.text,'short historical summary');
  const reopened=new AgentKernel(store,new FakeProvider([]),new ToolRegistry());
  assert.equal(await reopened.openSession('s'),'s');
});

test('M2 checkpoint: no compactor configured fails closed before a second provider call',async()=>{
  const provider=new FakeProvider([[finish('x'.repeat(320))],[finish('unused')]]);
  const k=new AgentKernel(new MemoryEventStore(),provider,new ToolRegistry(),{maxContextCharacters:220});
  await k.createSession('s');
  assert.equal((await k.runTurn('s','one')).status,'completed');
  const second=await k.runTurn('s','two');
  assert.equal(second.errorCode,'CONTEXT_BUDGET_EXCEEDED');
  assert.equal(provider.requests.length,1);
  assert.equal((await k.readEvents('s')).some(e=>e.type==='context.checkpoint'),false);
});

test('M2 checkpoint: active-only huge request cannot be compacted or sent to model',async()=>{
  const provider=new FakeProvider([[finish('unused')]]);
  let compactions=0;
  const k=new AgentKernel(new MemoryEventStore(),provider,new ToolRegistry(),{
    maxContextCharacters:60,contextCompactor:{compact:async()=>{compactions++;return 'oops';}},
  });
  await k.createSession('s');
  assert.equal((await k.runTurn('s','z'.repeat(300))).errorCode,'CONTEXT_COMPACTION_UNSAFE');
  assert.equal(provider.requests.length,0);
  assert.equal(compactions,0);
});

test('M2 checkpoint: trusted compactor failure leaves source intact and no checkpoint',async()=>{
  const provider=new FakeProvider([[finish('x'.repeat(320))],[finish('unused')]]);
  let calls=0;
  const store=new MemoryEventStore();
  const k=new AgentKernel(store,provider,new ToolRegistry(),{
    maxContextCharacters:220,contextCompactor:{compact:async()=>{calls++;throw Error('private payload');}},
  });
  await k.createSession('s');
  await k.runTurn('s','first');
  const before=await store.read('s');
  assert.equal((await k.runTurn('s','second')).errorCode,'CONTEXT_COMPACTION_FAILED');
  assert.equal(calls,1);
  assert.deepEqual((await store.read('s')).slice(0,before.length),before);
  assert.equal((await store.read('s')).some(e=>e.type==='context.checkpoint'),false);
});

test('M2 checkpoint: overlong summary is rejected without committing any checkpoint',async()=>{
  const p=new FakeProvider([[finish('x'.repeat(320))],[finish('never')]]);
  const store=new MemoryEventStore();
  const k=new AgentKernel(store,p,new ToolRegistry(),{
    maxContextCharacters:220,contextCompactor:{compact:async()=> 'z'.repeat(32_769)},
  });
  await k.createSession('s');await k.runTurn('s','first');
  assert.equal((await k.runTurn('s','second')).errorCode,'CONTEXT_COMPACTION_FAILED');
  assert.equal((await store.read('s')).some(e=>e.type==='context.checkpoint'),false);
});

test('M2 checkpoint: concise but still over-budget summary fails before next model request',async()=>{
  const p=new FakeProvider([[finish('x'.repeat(320))],[finish('never')]]);
  const store=new MemoryEventStore();
  const k=new AgentKernel(store,p,new ToolRegistry(),{
    maxContextCharacters:220,contextCompactor:{compact:async()=> 'z'.repeat(600)},
  });
  await k.createSession('s');await k.runTurn('s','first');
  assert.equal((await k.runTurn('s','second')).errorCode,'CONTEXT_BUDGET_EXCEEDED');
  assert.equal(p.requests.length,1);
  const events=await store.read('s');
  assert.equal(inspectContextCheckpoints(events).length,1);
  assert.equal(events.at(-1)?.type,'turn.failed');
});

test('M2 checkpoint: cancel during a blocked compactor creates no checkpoint or provider call',async()=>{
  const started=deferred(),release=deferred();
  const p=new FakeProvider([[finish('x'.repeat(320))],[finish('never')]]);
  const store=new MemoryEventStore();
  const k=new AgentKernel(store,p,new ToolRegistry(),{
    maxContextCharacters:220,
    contextCompactor:{compact:async()=>{started.resolve();await release.promise;return 'short';}},
  });
  await k.createSession('s');await k.runTurn('s','one');
  const pending=k.runTurn('s','two','t2');
  await started.promise;
  assert.equal(await k.cancelTurn('s','t2'),true);
  release.resolve();
  assert.equal((await pending).status,'cancelled');
  const events=await store.read('s');
  assert.equal(events.some(e=>e.type==='context.checkpoint'),false);
  assert.equal(p.requests.length,1);
});

test('M2 checkpoint: writer fence loss during blocked compaction cannot persist a checkpoint',async()=>{
  const started=deferred(),release=deferred();
  let leaseValid=true;
  const p=new FakeProvider([[finish('x'.repeat(320))],[finish('never')]]);
  const store=new MemoryEventStore();
  const k=new AgentKernel(store,p,new ToolRegistry(),{
    maxContextCharacters:220,
    assertExecutionLease:()=>{if(!leaseValid)throw Object.assign(new Error('lease lost'),{code:'LEASE_LOST'});},
    contextCompactor:{compact:async()=>{started.resolve();await release.promise;return 'short';}},
  });
  await k.createSession('s');await k.runTurn('s','one');
  const pending=k.runTurn('s','two','t2');
  await started.promise;leaseValid=false;
  k.fenceActiveTurn('s');release.resolve();
  await assert.rejects(pending,{code:'LEASE_LOST'});
  assert.equal((await store.read('s')).some(e=>e.type==='context.checkpoint'),false);
  assert.equal(p.requests.length,1);
});

test('M2 checkpoint: steering accepted while summary is awaited reaches next model step',async()=>{
  const started=deferred(),release=deferred();
  const seen:ContextMessage[][]=[];
  let count=0;
  const p:ModelProvider={id:'context-gate',async *stream(messages){
    seen.push(structuredClone([...messages]));
    yield finish(++count===1?'x'.repeat(320):'done');
  }};
  const store=new MemoryEventStore();
  const k=new AgentKernel(store,p,new ToolRegistry(),{
    maxContextCharacters:220,
    contextCompactor:{compact:async()=>{started.resolve();await release.promise;return 'short';}},
  });
  await k.createSession('s');await k.runTurn('s','first','t1');
  const work=k.runTurn('s','second','t2');await started.promise;
  assert.equal(await k.steerTurn('s','t2','additional'),true);
  release.resolve();assert.equal((await work).status,'completed');
  assert.deepEqual(seen[1]?.map(m=>m.role),['summary','user','user']);
  assert.equal((seen[1]?.at(-1) as {text?:string})?.text,'additional');
  const events=await store.read('s');
  assert.equal(inspectContextCheckpoints(events).length,1);
  assert.equal(events.filter(e=>e.type==='turn.steer_consumed').length,1);
});

test('M2 checkpoint: repeated compaction uses previous summary and preserves every immutable event',async()=>{
  const seen:ContextMessage[][]=[];
  let n=0;
  const p:ModelProvider={id:'repeat',async *stream(messages){
    seen.push(structuredClone([...messages]));
    n++;
    yield finish(n===1?'A'.repeat(320):n===2?'B'.repeat(320):'last');
  }};
  const store=new MemoryEventStore();let c=0;
  const k=new AgentKernel(store,p,new ToolRegistry(),{
    maxContextCharacters:220,
    contextCompactor:{compact:async messages=>{
      c++;
      if(c===2) assert.equal(messages[0]?.role,'summary');
      return 'summary '+c;
    }},
  });
  await k.createSession('s');await k.runTurn('s','one','t1');
  await k.runTurn('s','two','t2');
  assert.equal((await k.runTurn('s','three','t3')).status,'completed');
  const events=await store.read('s');
  const checkpoints=inspectContextCheckpoints(events);
  assert.equal(checkpoints.length,2);
  assert.equal(c,2);
  assert.ok(checkpoints[1]!.throughSeq>checkpoints[0]!.seq);
  assert.equal((seen[2]?.[0] as {text?:string})?.text,'summary 2');
  assert.equal(events.filter(e=>e.type==='turn.completed').length,3);
});

test('M2 checkpoint: tampered source row is rejected on reopen, reconciliation and command admission',async()=>{
  const t=temporary();
  try{
    const p=new FakeProvider([[finish('x'.repeat(320))],[finish('done')]]);
    const runner=new ManagedSessionRunner(t.path,p,new ToolRegistry(),{
      maxContextCharacters:220,contextCompactor:{compact:async()=> 'short history'},
    });
    await runner.createSession('s');
    assert.equal((await runner.runTurn('s','first','t1')).status,'completed');
    assert.equal((await runner.runTurn('s','second','t2')).status,'completed');
    const db=new DatabaseSync(t.path);
    try{
      const row=db.prepare("SELECT data_json FROM kernel_events WHERE session_id='s' AND type='user.message' ORDER BY seq LIMIT 1").get();
      assert.ok(row);
      db.prepare("UPDATE kernel_events SET data_json=? WHERE session_id='s' AND type='user.message' AND seq=(SELECT MIN(seq) FROM kernel_events WHERE session_id='s' AND type='user.message')")
        .run(JSON.stringify({text:'tampered'}));
    }finally{db.close();}
    const reviewer=new SqliteToolReconciler(t.path);
    try{assert.throws(()=>reviewer.inspect('s'),{code:'CORRUPT_CONTEXT_CHECKPOINT'});}
    finally{reviewer.close();}
    const journal=new SqliteEventStore(t.path);
    try{
      const reopened=new AgentKernel(journal,new FakeProvider([]),new ToolRegistry());
      await assert.rejects(reopened.openSession('s'),{code:'CORRUPT_CONTEXT_CHECKPOINT'});
    }finally{journal.close();}
    const leases=new SqliteWriterLeaseStore(t.path);
    try{
      const lease=leases.acquire('s','audit',5000);assert.ok(lease);
      const inbox=new SqliteCommandInbox(t.path);
      try{
        const current=new SqliteEventStore(t.path);
        const expected=(await current.read('s')).length;
        current.close();
        assert.throws(()=>inbox.accept({lease,expectedSeq:expected,commandId:'c',kind:'control.note',payload:{}}),
          {code:'CORRUPT_CONTEXT_CHECKPOINT'});
      }finally{inbox.close();}
    }finally{leases.close();}
  }finally{t.close();}
});

test('M2 checkpoint: SIGKILL after checkpoint commit leaves full source and unresolved active Turn',async()=>{
  const t=temporary();
  try{
    const kernelUrl=new URL('../packages/kernel-core/src/index.js',import.meta.url).href;
    const storeUrl=new URL('../packages/event-store-sqlite/src/index.js',import.meta.url).href;
    const registryUrl=new URL('../packages/tool-scheduler/src/index.js',import.meta.url).href;
    const script=`
      const [{AgentKernel},{SqliteEventStore},{ToolRegistry}]=await Promise.all(
        [import(process.argv[1]),import(process.argv[2]),import(process.argv[3])]);
      const store=new SqliteEventStore(process.argv[4]);
      let calls=0;
      const provider={id:'crashing',async *stream(){
        calls++;
        if(calls===2)process.kill(process.pid,'SIGKILL');
        yield {type:'message_complete',message:{role:'assistant',text:'x'.repeat(320),toolCalls:[]},finishReason:'stop'};
      }};
      const kernel=new AgentKernel(store,provider,new ToolRegistry(),{
        maxContextCharacters:220,contextCompactor:{compact:async()=> 'summary'},
      });
      await kernel.createSession('s');
      await kernel.runTurn('s','first','t1');
      await kernel.runTurn('s','second','t2');
      process.exitCode=44;
    `;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,
      kernelUrl,storeUrl,registryUrl,t.path],{encoding:'utf8',timeout:20000});
    assert.equal(child.error,undefined,child.stderr);
    assert.equal(child.signal,'SIGKILL',child.stderr);
    const store=new SqliteEventStore(t.path);
    try{
      const events=await store.read('s');
      assert.equal(inspectContextCheckpoints(events).length,1);
      assert.equal(events.filter(e=>e.type==='turn.completed').length,1);
      const kernel=new AgentKernel(store,new FakeProvider([]),new ToolRegistry());
      await assert.rejects(kernel.openSession('s'),{code:'RECOVERY_REQUIRED'});
    }finally{store.close();}
  }finally{t.close();}
});
