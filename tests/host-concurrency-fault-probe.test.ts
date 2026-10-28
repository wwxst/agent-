/*
 * Real-process regression guards for Host IPC and SQLite execution ledger.
 * Verify abort fan-out as unknown and duplicate claims across Host workers.
 * These test only the bounded read-only Worker, not arbitrary shell side effects.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ProcessToolHost } from '../packages/tool-host/src/index.js';
import { HostExecutionLedger, type HostCall } from '../packages/tool-host/src/ledger.js';
import { SqliteWriterLeaseStore, type WriterLease } from '../packages/session-leases-sqlite/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'host-race-'));
  return {db:join(dir,'journal.sqlite'),done:()=>rmSync(dir,{force:true,recursive:true})};
}
async function seed(path:string,lease:WriterLease,session:string,callIds:string[],duration:number) {
  const store=new SqliteEventStore(path,lease);
  const toolCalls=callIds.map(id=>({id,name:'read.sleep',arguments:{ms:duration}}));
  try{
    await store.append(session,0,[
      {type:'session.created',data:{}},
      {type:'turn.queued',turnId:'turn',data:{}},
      {type:'user.message',turnId:'turn',data:{text:'concurrent reads'}},
      {type:'turn.started',turnId:'turn',data:{}},
      {type:'assistant.message',turnId:'turn',data:{role:'assistant',text:'run',toolCalls}},
      ...callIds.map(id=>({type:'tool.intent' as const,turnId:'turn',data:{callId:id,name:'read.sleep',step:1}})),
    ]);
  }finally{store.close();}
  return callIds.map(callId=>({lease,turnId:'turn',callId,name:'read.sleep',input:{ms:duration}} satisfies HostCall));
}
async function waitForStarted(path:string,session:string,n:number) {
  const ledger=new HostExecutionLedger(path);
  try{
    for(let i=0;i<120;i++){
      if(ledger.inspect(session).filter(r=>r.state==='started').length===n)return;
      await sleep(10);
    }
    assert.fail('Required STARTED claims not observed before deadline');
  }finally{ledger.close();}
}

test('HOST-RACE-01: aborting one of two in-flight calls terminates worker and leaves both outcomes unknown',async()=>{
  const tmp=fixture(),leases=new SqliteWriterLeaseStore(tmp.db),host=new ProcessToolHost(tmp.db,5000);
  try{
    const lease=leases.acquire('race-cancel','owner',5000);
    assert.ok(lease);
    const [callA,callB]=await seed(tmp.db,lease,'race-cancel',['a','b'],1500);
    const abort=new AbortController();
    const pendingA=assert.rejects(host.invoke(callA!,abort.signal),{code:'TOOL_OUTCOME_UNKNOWN'});
    const pendingB=assert.rejects(host.invoke(callB!,new AbortController().signal),{code:'TOOL_OUTCOME_UNKNOWN'});
    await waitForStarted(tmp.db,'race-cancel',2);
    abort.abort();
    await Promise.all([pendingA,pendingB]);
    const ledger=new HostExecutionLedger(tmp.db);
    try{
      assert.deepEqual(ledger.inspect('race-cancel').map(r=>r.state),['started','started']);
    }finally{ledger.close();}
    const reopened=new ProcessToolHost(tmp.db,5000);
    try{
      await assert.rejects(reopened.invoke(callA!,new AbortController().signal),
        {code:'TOOL_OUTCOME_UNKNOWN'});
      await assert.rejects(reopened.invoke(callB!,new AbortController().signal),
        {code:'TOOL_OUTCOME_UNKNOWN'});
    }finally{reopened.close();}
  }finally{host.close();leases.close();tmp.done();}
});

test('HOST-RACE-02: two worker processes cannot claim the same durable intent',async()=>{
  const tmp=fixture(),leases=new SqliteWriterLeaseStore(tmp.db);
  const first=new ProcessToolHost(tmp.db,5000);
  const second=new ProcessToolHost(tmp.db,5000);
  try{
    const lease=leases.acquire('race-duplicate','owner',5000);
    assert.ok(lease);
    const [call]=await seed(tmp.db,lease,'race-duplicate',['same'],1400);
    const firstCompletion=first.invoke(call!,new AbortController().signal);
    await waitForStarted(tmp.db,'race-duplicate',1);
    await assert.rejects(second.invoke(call!,new AbortController().signal),
      {code:'TOOL_OUTCOME_UNKNOWN'});
    assert.equal(await firstCompletion,'slept:1400');
    const ledger=new HostExecutionLedger(tmp.db);
    try{
      const rows=ledger.inspect('race-duplicate');
      assert.equal(rows.length,1);
      assert.equal(rows[0]?.state,'succeeded');
      assert.equal(rows[0]?.content,'slept:1400');
    }finally{ledger.close();}
  }finally{first.close();second.close();leases.close();tmp.done();}
});
