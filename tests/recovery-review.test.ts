import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryEventStore } from '../packages/event-store-memory/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { SqliteWriterLeaseStore } from '../packages/session-leases-sqlite/src/index.js';
import { HostExecutionLedger } from '../packages/tool-host/src/ledger.js';
import { SqliteToolReconciler, reconcileSnapshot } from '../packages/tool-reconciliation/src/index.js';
import { SqliteRecoveryReviewStore, type ReviewRequest } from '../packages/recovery-review/src/index.js';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ManagedSessionRunner } from '../packages/session-runtime/src/index.js';

function tempDb() {
  const dir=mkdtempSync(join(tmpdir(),'review-m1-'));
  return {path:join(dir,'session.sqlite'),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

function seed(path:string, id='session'){
  const leaseStore=new SqliteWriterLeaseStore(path);
  const claim=leaseStore.acquire(id,'writer',5000);
  assert.ok(claim);
  const journal=new SqliteEventStore(path,claim);
  const events=[
    {type:'session.created' as const,data:{}},
    {type:'turn.queued' as const,turnId:'turn',data:{}},
    {type:'user.message' as const,turnId:'turn',data:{text:'please echo'}},
    {type:'turn.started' as const,turnId:'turn',data:{}},
    {type:'assistant.message' as const,turnId:'turn',data:{role:'assistant',text:'',
      toolCalls:[{id:'call',name:'read.echo',arguments:{text:'hello'}}]}},
    {type:'tool.intent' as const,turnId:'turn',data:{callId:'call',name:'read.echo',step:1}},
  ];
  return {leaseStore, claim,journal, append:()=>journal.append(id,0,events),
    close:()=>{journal.close();leaseStore.close();}};
}

function decision(sessionId:string,evidenceHash:string,reviewId='review-1'): ReviewRequest {
  return {sessionId,reviewId,reviewerId:'authenticated-operator-42',
    expectedEvidenceHash:evidenceHash,decision:'investigate',
    reason:'Need external verification of host execution receipt.'};
}
test('M1 review: evidence-bound immutable note survives restart; no Kernel state changed',async()=>{
  const db=tempDb(),ctx=seed(db.path);
  try{
    await ctx.append();
    const observer=new SqliteToolReconciler(db.path);
    const before=observer.inspect('session');
    observer.close();
    assert.equal(before.calls[0]?.status,'intent_without_host');
    assert.match(before.evidenceHash,/^[a-f0-9]{64}$/);
    const reviews=new SqliteRecoveryReviewStore(db.path);
    let first;
    try{
      first=reviews.record(decision('session',before.evidenceHash));
      assert.equal(first.reviewSeq,1);
      assert.equal(first.decision,'investigate');
      assert.match(first.createdAt,/^20/);
      assert.deepEqual(reviews.list('session'),[first]);
      assert.deepEqual(reviews.list('another'),[]);
      assert.equal(reviews.record({...decision('session',before.evidenceHash,'review-2'),
        decision:'evidence_noted',reason:'External investigation pending by independent owner.'}).reviewSeq,2);
    }finally{reviews.close();}
    const reopened=new SqliteRecoveryReviewStore(db.path);
    try{assert.equal(reopened.list('session').length,2);}finally{reopened.close();}
    const after=new SqliteToolReconciler(db.path);
    try{
      assert.deepEqual(after.inspect('session'),before);
    }finally{after.close();}
    assert.equal((await ctx.journal.read('session')).length,6);
  }finally{ctx.close();db.cleanup();}
});

test('M1 review: journal append invalidates stale fingerprint and cannot persist note',async()=>{
  const db=tempDb(),ctx=seed(db.path);
  try{
    await ctx.append();
    const observer=new SqliteToolReconciler(db.path);
    const evidence=observer.inspect('session').evidenceHash;observer.close();
    await ctx.journal.append('session',6,[{type:'turn.cancel_requested',turnId:'turn',data:{}}]);
    const store=new SqliteRecoveryReviewStore(db.path);
    try{
      assert.throws(()=>store.record(decision('session',evidence)),{code:'STALE_REVIEW_EVIDENCE'});
      assert.deepEqual(store.list('session'),[]);
    }finally{store.close();}
  }finally{ctx.close();db.cleanup();}
});

test('M1 review: Host STARTED changes evidence hash even without Kernel event append',async()=>{
  const db=tempDb(),ctx=seed(db.path);
  try{
    await ctx.append();
    const observer=new SqliteToolReconciler(db.path);
    const evidence=observer.inspect('session').evidenceHash;observer.close();
    const ledger=new HostExecutionLedger(db.path);
    try{
      ledger.begin({lease:ctx.claim,turnId:'turn',callId:'call',name:'read.echo',input:{text:'hello'}});
    }finally{ledger.close();}
    const store=new SqliteRecoveryReviewStore(db.path);
    try{
      assert.throws(()=>store.record(decision('session',evidence)),{code:'STALE_REVIEW_EVIDENCE'});
      assert.deepEqual(store.list('session'),[]);
    }finally{store.close();}
  }finally{ctx.close();db.cleanup();}
});

test('M1 review: Host FINISHED changes hash; even a matching outcome does not grant replay',async()=>{
  const db=tempDb(),ctx=seed(db.path);
  try{
    await ctx.append();
    const ledger=new HostExecutionLedger(db.path);
    const call={lease:ctx.claim,turnId:'turn',callId:'call',name:'read.echo',input:{text:'hello'}};
    ledger.begin(call);
    const view=new SqliteToolReconciler(db.path);
    const started=view.inspect('session');
    ledger.finish(call,'succeeded','hello');
    const done=view.inspect('session');
    ledger.close();view.close();
    assert.notEqual(started.evidenceHash,done.evidenceHash);
    assert.equal(done.calls[0]?.status,'host_finished_without_receipt');
    const reviews=new SqliteRecoveryReviewStore(db.path);
    try {
      assert.throws(()=>reviews.record(decision('session',started.evidenceHash)),
        {code:'STALE_REVIEW_EVIDENCE'});
      assert.equal(reviews.record(decision('session',done.evidenceHash)).reviewSeq,1);
    }finally{reviews.close();}
  }finally{ctx.close();db.cleanup();}
});

test('M1 review: duplicate review ID and invalid requests fail without overwriting history',async()=>{
  const db=tempDb(),ctx=seed(db.path);
  try{
    await ctx.append();
    const view=new SqliteToolReconciler(db.path);
    const hash=view.inspect('session').evidenceHash;view.close();
    const store=new SqliteRecoveryReviewStore(db.path);
    try{
      const first=store.record(decision('session',hash));
      assert.throws(()=>store.record(decision('session',hash)),{code:'DUPLICATE_REVIEW_ID'});
      assert.throws(()=>store.record({...decision('session',hash,'other'),
        reviewerId:'',reason:'A valid explanation'}),{code:'INVALID_REVIEW_REQUEST'});
      assert.throws(()=>store.record({...decision('session',hash,'other'),
        decision:'retry' as 'investigate'}),{code:'INVALID_REVIEW_REQUEST'});
      assert.throws(()=>store.record({...decision('session',hash,'other'),
        reason:'short'}),{code:'INVALID_REVIEW_REQUEST'});
      assert.throws(()=>store.record({...decision('session',hash,'other'),
        expectedEvidenceHash:'0'.repeat(64)}),{code:'STALE_REVIEW_EVIDENCE'});
      assert.deepEqual(store.list('session'),[first]);
    }finally{store.close();}
  }finally{ctx.close();db.cleanup();}
});

test('M1 review: two independent reviewers serialize review sequence and retain original evidence',async()=>{
  const db=tempDb(),ctx=seed(db.path);
  try{
    await ctx.append();
    const view=new SqliteToolReconciler(db.path);
    const hash=view.inspect('session').evidenceHash;view.close();
    const a=new SqliteRecoveryReviewStore(db.path);
    const b=new SqliteRecoveryReviewStore(db.path);
    try{
      const first=a.record(decision('session',hash,'independent-1'));
      const second=b.record({...decision('session',hash,'independent-2'),reviewerId:'reviewer-2'});
      assert.deepEqual([first.reviewSeq,second.reviewSeq],[1,2]);
      assert.deepEqual(a.list('session'),[first,second]);
      assert.equal(a.list('session')[0]?.expectedEvidenceHash,hash);
    }finally{a.close();b.close();}
  }finally{ctx.close();db.cleanup();}
});

test('M1 review: review notes never unblock an unfinished Turn or execute a tool',async()=>{
  const db=tempDb(),ctx=seed(db.path);
  try{
    await ctx.append();
    const view=new SqliteToolReconciler(db.path);
    const hash=view.inspect('session').evidenceHash;view.close();
    const store=new SqliteRecoveryReviewStore(db.path);
    try{store.record({...decision('session',hash),decision:'evidence_noted'});}
    finally{store.close();}
    const kernel=new AgentKernel(ctx.journal,new FakeProvider([]),new ToolRegistry());
    await assert.rejects(kernel.openSession('session'),{code:'RECOVERY_REQUIRED'});
    assert.equal((await ctx.journal.read('session')).length,6);
    assert.equal(ctx.leaseStore.release(ctx.claim),true);
    let executed=0;
    const provider=new FakeProvider([]);
    const registry=new ToolRegistry();
    registry.register({name:'read.echo',version:'1',risk:'read',concurrency:'parallel',
      parse:x=>x,execute:async()=>{executed++;return 'unsafe';}});
    const runner=new ManagedSessionRunner(db.path,provider,registry);
    await assert.rejects(runner.runTurn('session','please resume'),{code:'RECOVERY_REQUIRED'});
    assert.equal(executed,0);
  }finally{ctx.close();db.cleanup();}
});

test('M1 review: fully verified terminal session cannot be given spurious recovery clearance',async()=>{
  const db=tempDb();
  try{
    const store=new SqliteEventStore(db.path);
    await store.append('normal',0,[{type:'session.created',data:{}}]);
    store.close();
    const view=new SqliteToolReconciler(db.path);
    const r=view.inspect('normal');view.close();
    assert.equal(r.fullyVerified,true);
    const reviews=new SqliteRecoveryReviewStore(db.path);
    try{
      assert.throws(()=>reviews.record(decision('normal',r.evidenceHash)),{code:'NO_REVIEW_REQUIRED'});
      assert.deepEqual(reviews.list('normal'),[]);
    }finally{reviews.close();}
  }finally{db.cleanup();}
});

test('M1 review: SIGKILL after review transaction commit preserves immutable review row',async()=>{
  const db=tempDb(),ctx=seed(db.path);
  try {
    await ctx.append();
    const view=new SqliteToolReconciler(db.path);
    const hash=view.inspect('session').evidenceHash;view.close();
    const url=new URL('../packages/recovery-review/src/index.js',import.meta.url).href;
    const script=`
      const {SqliteRecoveryReviewStore}=await import(process.argv[1]);
      const review=new SqliteRecoveryReviewStore(process.argv[2]);
      review.record(JSON.parse(process.argv[3]));
      process.kill(process.pid,'SIGKILL');
    `;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,url,db.path,
      JSON.stringify(decision('session',hash))],{encoding:'utf8',timeout:10000});
    assert.equal(child.error,undefined,child.stderr);
    assert.equal(child.signal,'SIGKILL',child.stderr);
    const store=new SqliteRecoveryReviewStore(db.path);
    try {
      assert.equal(store.list('session').length,1);
      assert.equal(store.list('session')[0]?.expectedEvidenceHash,hash);
    }finally{store.close();}
  }finally{ctx.close();db.cleanup();}
});

test('M1 review: evidence hash reacts to content tampering even when journal sequence unchanged',async()=>{
  const store=new MemoryEventStore();
  await store.append('in-memory',0,[
    {type:'session.created',data:{}},
    {type:'turn.queued',turnId:'t',data:{}},
    {type:'user.message',turnId:'t',data:{text:'private'}},
    {type:'turn.started',turnId:'t',data:{}},
  ]);
  const events=await store.read('in-memory');
  const original=reconcileSnapshot('in-memory',events,[]);
  const tampered=events.map(event=>event.type==='user.message'
    ? {...event,data:{text:'different'}}:event);
  const altered=reconcileSnapshot('in-memory',tampered,[]);
  assert.equal(original.lastSeq,altered.lastSeq);
  assert.notEqual(original.evidenceHash,altered.evidenceHash);
  assert.equal(original.requiresManualReview,true);
});
