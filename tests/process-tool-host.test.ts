import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { SqliteWriterLeaseStore, type WriterLease } from '../packages/session-leases-sqlite/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { ManagedSessionRunner } from '../packages/session-runtime/src/index.js';
import { ProcessToolHost } from '../packages/tool-host/src/index.js';
import { HostExecutionLedger, type HostCall } from '../packages/tool-host/src/ledger.js';
import { inspectToolAudit } from '../packages/tool-audit/src/index.js';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'host-m1-'));
  return { path: join(dir, 'journal.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function journalWithIntent(path: string, lease: WriterLease, name: string, input: unknown,
  callId = 'call-1', turnId = 't'): Promise<HostCall> {
  const store = new SqliteEventStore(path, lease);
  try {
    await store.append(lease.sessionId, 0, [
      {type:'session.created',data:{}},
      {type:'turn.queued',turnId,data:{}},
      {type:'user.message',turnId,data:{text:'do safe thing'}},
      {type:'turn.started',turnId,data:{}},
      {type:'assistant.message',turnId,data:{
        role:'assistant',text:'run',toolCalls:[{id:callId,name,arguments:input}],
      }},
      {type:'tool.intent',turnId,data:{callId,name,step:1}},
    ]);
  } finally {store.close();}
  return {lease,turnId,callId,name,input};
}

function complete(text = 'done') {
  return {type:'message_complete' as const,message:{
    role:'assistant' as const,text,toolCalls:[],
  },finishReason:'stop' as const};
}

async function waitForStarted(path: string, sessionId: string): Promise<void> {
  const ledger = new HostExecutionLedger(path);
  try {
    for(let i=0;i<90;i++){
      if(ledger.inspect(sessionId).some(row=>row.state==='started')) return;
      await delay(10);
    }
    assert.fail('Host did not commit STARTED within bounded retry window');
  } finally {ledger.close();}
}

test('M1 Host: real child process executes read.echo with Kernel-bound intent, receipt and ledger', async()=>{
  const tmp=tempDb();
  const host=new ProcessToolHost(tmp.path);
  try {
    assert.ok(host.pid && host.pid!==process.pid);
    const provider=new FakeProvider([[
      {type:'message_complete',message:{role:'assistant',text:'',toolCalls:[
        {id:'one',name:'read.echo',arguments:{text:'hello isolated host'}},
      ]},finishReason:'tool_use'},
    ],[complete()]]);
    const runner=new ManagedSessionRunner(tmp.path,provider,lease=>host.createRegistry(lease));
    await runner.createSession('host-integrated');
    const result=await runner.runTurn('host-integrated','run host','turn1');
    assert.equal(result.status,'completed');
    const store=new SqliteEventStore(tmp.path);
    const ledger=new HostExecutionLedger(tmp.path);
    try {
      const events=await store.read('host-integrated');
      assert.deepEqual(inspectToolAudit(events).map(x=>[x.name,x.outcome,x.needsReconciliation]),
        [['read.echo','succeeded',false]]);
      const receipt=events.find(x=>x.type==='tool.receipt');
      assert.equal((receipt?.data as {content:string}).content,'hello isolated host');
      const [row]=ledger.inspect('host-integrated');
      assert.equal(row?.state,'succeeded');
      assert.equal(row?.name,'read.echo');
      assert.equal(row?.content,'hello isolated host');
      assert.ok(row?.fenceToken && row.fenceToken>=2);
      assert.equal(provider.requests[1]?.at(-1)?.role,'tool');
    } finally {store.close();ledger.close();}
  } finally {host.close();tmp.cleanup();}
});

test('M1 Host: missing persistent intent, forged input and unknown tool fail closed',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path),host=new ProcessToolHost(tmp.path);
  try {
    const lease=leases.acquire('reject','trusted',5000);
    assert.ok(lease);
    const signal=new AbortController().signal;
    await assert.rejects(host.invoke({lease,turnId:'t',callId:'c',name:'read.echo',
      input:{text:'no intent'}},signal),{code:'TOOL_OUTCOME_UNKNOWN'});
    const call=await journalWithIntent(tmp.path,lease,'read.echo',{text:'correct'});
    await assert.rejects(host.invoke({...call,input:{text:'forged'}},signal),
      {code:'TOOL_OUTCOME_UNKNOWN'});
    await assert.rejects(host.invoke({...call,name:'shell.exec'},signal),
      {code:'TOOL_OUTCOME_UNKNOWN'});
    const ledger=new HostExecutionLedger(tmp.path);
    try {assert.deepEqual(ledger.inspect('reject'),[]);}finally{ledger.close();}
    assert.equal(await host.invoke(call,signal),'correct');
  } finally {host.close();leases.close();tmp.cleanup();}
});

test('M1 Host: privileged names are denied by worker even with a matching persisted intent',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path),host=new ProcessToolHost(tmp.path);
  try{
    const lease=leases.acquire('unsafe','worker',5000);
    assert.ok(lease);
    const call=await journalWithIntent(tmp.path,lease,'shell.exec',{command:'echo nope'});
    await assert.rejects(host.invoke(call,new AbortController().signal),
      {code:'TOOL_OUTCOME_UNKNOWN'});
    const ledger=new HostExecutionLedger(tmp.path);
    try{ assert.deepEqual(ledger.inspect('unsafe'),[]); }finally{ledger.close();}
  }finally{host.close();leases.close();tmp.cleanup();}
});

test('M1 Host: duplicate call never re-executes even when the first result was known',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path),host=new ProcessToolHost(tmp.path);
  try{
    const lease=leases.acquire('duplicate','worker',5000);
    assert.ok(lease);
    const call=await journalWithIntent(tmp.path,lease,'read.echo',{text:'once'});
    assert.equal(await host.invoke(call,new AbortController().signal),'once');
    await assert.rejects(host.invoke(call,new AbortController().signal),
      {code:'TOOL_OUTCOME_UNKNOWN'});
    const ledger=new HostExecutionLedger(tmp.path);
    try{
      const rows=ledger.inspect('duplicate');
      assert.equal(rows.length,1);
      assert.equal(rows[0]?.state,'succeeded');
    }finally{ledger.close();}
  }finally{host.close();leases.close();tmp.cleanup();}
});

test('M1 Host: expired or superseded fence rejected by child before starting a tool',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path),host=new ProcessToolHost(tmp.path);
  try{
    const lease=leases.acquire('stale','first',5000);
    assert.ok(lease);
    const call=await journalWithIntent(tmp.path,lease,'read.echo',{text:'old'});
    assert.equal(leases.release(lease),true);
    const second=leases.acquire('stale','successor',5000);
    assert.ok(second);
    await assert.rejects(host.invoke(call,new AbortController().signal),{code:'LEASE_LOST'});
    const ledger=new HostExecutionLedger(tmp.path);
    try{assert.deepEqual(ledger.inspect('stale'),[]);}finally{ledger.close();}
  }finally{host.close();leases.close();tmp.cleanup();}
});

test('M1 Host: fence takeover after STARTED forbids stale success, retains unknown ledger',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path),host=new ProcessToolHost(tmp.path);
  try{
    const lease=leases.acquire('takeover','first',5000);
    assert.ok(lease);
    const call=await journalWithIntent(tmp.path,lease,'read.sleep',{ms:450});
    const promise=host.invoke(call,new AbortController().signal);
    await waitForStarted(tmp.path,'takeover');
    assert.equal(leases.release(lease),true);
    const second=leases.acquire('takeover','new-owner',5000);
    assert.ok(second);
    await assert.rejects(promise,{code:'LEASE_LOST'});
    const ledger=new HostExecutionLedger(tmp.path);
    try{
      const rows=ledger.inspect('takeover');
      assert.equal(rows.length,1);
      assert.equal(rows[0]?.state,'started');
      assert.equal(rows[0]?.fenceToken,lease.fenceToken);
    }finally{ledger.close();}
  }finally{host.close();leases.close();tmp.cleanup();}
});

test('M1 Host: killing an active child leaves durable STARTED and duplicate remains unknown',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path),host=new ProcessToolHost(tmp.path);
  try{
    const lease=leases.acquire('killed','worker',5000);
    assert.ok(lease);
    const call=await journalWithIntent(tmp.path,lease,'read.sleep',{ms:800});
    const pending=host.invoke(call,new AbortController().signal);
    await waitForStarted(tmp.path,'killed');
    host.close(); // SIGKILL, no in-memory successful receipt can be fabricated
    await assert.rejects(pending,{code:'TOOL_OUTCOME_UNKNOWN'});
    const ledger=new HostExecutionLedger(tmp.path);
    try{assert.equal(ledger.inspect('killed')[0]?.state,'started');}finally{ledger.close();}
    const restarted=new ProcessToolHost(tmp.path);
    try{
      await assert.rejects(restarted.invoke(call,new AbortController().signal),
        {code:'TOOL_OUTCOME_UNKNOWN'});
      const audit=new SqliteEventStore(tmp.path);
      try{
        assert.equal(inspectToolAudit(await audit.read('killed'))[0]?.needsReconciliation,true);
      }finally{audit.close();}
    }finally{restarted.close();}
  }finally{host.close();leases.close();tmp.cleanup();}
});

test('M1 Host: IPC timeout is an uncertain outcome, never a clean tool failure',async()=>{
  const tmp=tempDb(),leases=new SqliteWriterLeaseStore(tmp.path),host=new ProcessToolHost(tmp.path,200);
  try{
    const lease=leases.acquire('timeout','worker',5000);
    assert.ok(lease);
    const call=await journalWithIntent(tmp.path,lease,'read.sleep',{ms:900});
    await assert.rejects(host.invoke(call,new AbortController().signal),
      {code:'TOOL_OUTCOME_UNKNOWN'});
    const ledger=new HostExecutionLedger(tmp.path);
    try{assert.equal(ledger.inspect('timeout')[0]?.state,'started');}finally{ledger.close();}
  }finally{host.close();leases.close();tmp.cleanup();}
});
