import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {AgentKernel} from '../packages/kernel-core/src/index.js';
import {ToolRegistry} from '../packages/tool-scheduler/src/index.js';
import {FakeProvider} from '../packages/model-providers/src/fake.js';
import {SqliteWriterLeaseStore,type WriterLease} from '../packages/session-leases-sqlite/src/index.js';
import {SqliteEventStore} from '../packages/event-store-sqlite/src/index.js';
import {HostExecutionLedger,type HostCall} from '../packages/tool-host/src/ledger.js';
import {TrustedWorkspaceCommitController} from '../packages/tool-host/src/workspace-commit.js';
import {SqliteToolReconciler} from '../packages/tool-reconciliation/src/index.js';
import {SqliteRecoveryReviewStore} from '../packages/recovery-review/src/index.js';
import {SqliteWorkspaceReceiptRepair,type WorkspaceReceiptRepairRequest}
  from '../packages/tool-reconciliation/src/manual-workspace-receipt.js';

const original='export const add=(a,b)=>a-b;\n';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const patch=()=>({path:'src/calc.mjs',expectedSha256:digest(original),
  oldText:'a-b',newText:'a+b'});
function fixture(){
  const folder=mkdtempSync(join(tmpdir(),'manual-receipt-'));
  const root=join(folder,'repo'),src=join(root,'src');
  mkdirSync(src,{recursive:true});
  const file=join(src,'calc.mjs'),db=join(folder,'journal.sqlite');
  writeFileSync(file,original);
  const leases=new SqliteWriterLeaseStore(db);
  return {folder,root,file,db,leases,cleanup:()=>{
    leases.close();rmSync(folder,{recursive:true,force:true});
  }};
}
async function seed(db:string,lease:WriterLease,request:unknown=patch()):Promise<HostCall>{
  const store=new SqliteEventStore(db,lease);
  try{
    await store.append(lease.sessionId,0,[
      {type:'session.created',data:{}},
      {type:'turn.queued',turnId:'turn',data:{}},
      {type:'user.message',turnId:'turn',data:{text:'trusted patch'}},
      {type:'turn.started',turnId:'turn',data:{}},
      {type:'assistant.message',turnId:'turn',data:{role:'assistant',
        text:'proposal',toolCalls:[{id:'call',name:'workspace.patch',arguments:request}]}},
      {type:'tool.intent',turnId:'turn',data:{callId:'call',name:'workspace.patch',step:1}},
    ]);
  }finally{store.close();}
  return {lease,turnId:'turn',callId:'call',name:'workspace.patch',input:request};
}
function report(db:string,id:string){
  const view=new SqliteToolReconciler(db);
  try{return view.inspect(id);}finally{view.close();}
}
function reviewed(db:string,id:string,evidenceHash:string){
  const notes=new SqliteRecoveryReviewStore(db);
  try{
    notes.record({sessionId:id,reviewId:'review-1',reviewerId:'operator',
      expectedEvidenceHash:evidenceHash,decision:'evidence_noted',
      reason:'Independently verified the finished Host receipt ledger evidence.'});
  }finally{notes.close();}
}
function request(lease:WriterLease,expectedEvidenceHash:string):WorkspaceReceiptRepairRequest{
  return {lease,turnId:'turn',callId:'call',reviewId:'review-1',
    reviewerId:'operator',expectedEvidenceHash};
}

test('RECEIPT-BRIDGE-01: real file commit then fenced successor repairs exact receipt/result pair',async()=>{
  const f=fixture();
  try{
    const first=f.leases.acquire('bridge-success','original',15000);assert.ok(first);
    const call=await seed(f.db,first);
    const ctrl=new TrustedWorkspaceCommitController(f.db,f.root,()=>{});
    try{
      const result=ctrl.commit(call,new AbortController().signal);
      assert.equal(result.candidateSha256,digest('export const add=(a,b)=>a+b;\n'));
    }finally{ctrl.close();}
    const prior=report(f.db,'bridge-success');
    assert.equal(prior.calls[0]?.status,'host_finished_without_receipt');
    assert.equal(prior.pendingTurnId,'turn');
    reviewed(f.db,'bridge-success',prior.evidenceHash);
    assert.equal(f.leases.release(first),true);
    const successor=f.leases.acquire('bridge-success','successor',15000);assert.ok(successor);
    let authorized=0;
    const repair=new SqliteWorkspaceReceiptRepair(f.db,()=>{authorized++;});
    try{
      const repaired=repair.repair(request(successor,prior.evidenceHash));
      assert.equal(repaired.receiptSeq,7);
      assert.equal(repaired.resultSeq,8);
      assert.equal(repaired.pendingTurnId,'turn');
      assert.equal(authorized,2);
      assert.throws(()=>repair.repair(request(successor,prior.evidenceHash)),
        {code:'STALE_REPAIR_EVIDENCE'});
    }finally{repair.close();}
    const journal=new SqliteEventStore(f.db);
    try{
      const events=await journal.read('bridge-success');
      assert.equal(events.length,8);
      assert.equal(events[6]?.type,'tool.receipt');
      assert.equal(events[7]?.type,'tool.result');
      assert.deepEqual(events[6]?.data,events[7]?.data);
      assert.deepEqual(events[6]?.data,{
        callId:'call',name:'workspace.patch',outcome:'succeeded',
        content:digest('export const add=(a,b)=>a+b;\n'),
      });
      // No implicit turn completion or replay after manual receipt alignment.
      const kernel=new AgentKernel(journal,new FakeProvider([]),new ToolRegistry());
      await assert.rejects(kernel.openSession('bridge-success'),
        {code:'RECOVERY_REQUIRED'});
    }finally{journal.close();}
    const after=report(f.db,'bridge-success');
    assert.equal(after.calls[0]?.status,'verified');
    assert.equal(after.pendingTurnId,'turn');
    assert.equal(after.fullyVerified,false);
    assert.equal(readFileSync(f.file,'utf8'),'export const add=(a,b)=>a+b;\n');
  }finally{f.cleanup();}
});

test('RECEIPT-BRIDGE-02: STARTED alone is never a successful receipt',async()=>{
  const f=fixture();
  try{
    const initial=f.leases.acquire('bridge-started','original',15000);assert.ok(initial);
    const call=await seed(f.db,initial);
    const ledger=new HostExecutionLedger(f.db);
    try{ledger.begin(call);}finally{ledger.close();}
    const prior=report(f.db,'bridge-started');
    assert.equal(prior.calls[0]?.status,'host_started');
    reviewed(f.db,'bridge-started',prior.evidenceHash);
    assert.equal(f.leases.release(initial),true);
    const next=f.leases.acquire('bridge-started','next',15000);assert.ok(next);
    const repair=new SqliteWorkspaceReceiptRepair(f.db,()=>{});
    try{
      assert.throws(()=>repair.repair(request(next,prior.evidenceHash)),
        {code:'REPAIR_OUTCOME_NOT_VERIFIED'});
    }finally{repair.close();}
    assert.equal(report(f.db,'bridge-started').lastSeq,6);
    assert.equal(readFileSync(f.file,'utf8'),original);
  }finally{f.cleanup();}
});

test('RECEIPT-BRIDGE-03: review note is not permission and missing note never authorizes',async()=>{
  const f=fixture();
  try{
    const initial=f.leases.acquire('bridge-auth','original',15000);assert.ok(initial);
    const call=await seed(f.db,initial);
    const ledger=new HostExecutionLedger(f.db);
    try{
      ledger.begin(call);
      ledger.finish(call,'succeeded',digest(original));
    }finally{ledger.close();}
    const prior=report(f.db,'bridge-auth');
    assert.equal(f.leases.release(initial),true);
    const next=f.leases.acquire('bridge-auth','successor',15000);assert.ok(next);
    const deny=new SqliteWorkspaceReceiptRepair(f.db,()=>{
      throw new Error('independent grant revoked');
    });
    try{
      assert.throws(()=>deny.repair(request(next,prior.evidenceHash)),
        /independent grant revoked/);
    }finally{deny.close();}
    const noNote=new SqliteWorkspaceReceiptRepair(f.db,()=>{});
    try{
      assert.throws(()=>noNote.repair(request(next,prior.evidenceHash)),
        {code:'REPAIR_REVIEW_REQUIRED'});
    }finally{noNote.close();}
    reviewed(f.db,'bridge-auth',prior.evidenceHash);
    const revoked=new SqliteWorkspaceReceiptRepair(f.db,()=>{
      throw new Error('still not approved');
    });
    try{
      assert.throws(()=>revoked.repair(request(next,prior.evidenceHash)),
        /still not approved/);
    }finally{revoked.close();}
    assert.equal(report(f.db,'bridge-auth').lastSeq,6);
  }finally{f.cleanup();}
});

test('RECEIPT-BRIDGE-04: stale evidence and original owner cannot forge repaired receipt',async()=>{
  const f=fixture();
  try{
    const initial=f.leases.acquire('bridge-stale','original',15000);assert.ok(initial);
    const call=await seed(f.db,initial);
    const ledger=new HostExecutionLedger(f.db);
    try{ledger.begin(call);ledger.finish(call,'succeeded',digest(original));}
    finally{ledger.close();}
    const prior=report(f.db,'bridge-stale');
    reviewed(f.db,'bridge-stale',prior.evidenceHash);
    const repair=new SqliteWorkspaceReceiptRepair(f.db,()=>{});
    try{
      assert.throws(()=>repair.repair(request(initial,prior.evidenceHash)),
        {code:'REPAIR_OUTCOME_NOT_VERIFIED'});
      assert.equal(f.leases.release(initial),true);
      const next=f.leases.acquire('bridge-stale','new',15000);assert.ok(next);
      const journal=new SqliteEventStore(f.db,next);
      try{
        await journal.append('bridge-stale',6,[
          {type:'turn.cancel_requested',turnId:'turn',data:{}},
        ]);
      }finally{journal.close();}
      assert.throws(()=>repair.repair(request(next,prior.evidenceHash)),
        {code:'STALE_REPAIR_EVIDENCE'});
    }finally{repair.close();}
    assert.equal(report(f.db,'bridge-stale').lastSeq,7);
  }finally{f.cleanup();}
});

test('RECEIPT-BRIDGE-05: forged Host result and completed Turn cannot be repaired',async()=>{
  const f=fixture();
  try{
    const initial=f.leases.acquire('bridge-bad','original',15000);assert.ok(initial);
    const call=await seed(f.db,initial);
    const ledger=new HostExecutionLedger(f.db);
    try{ledger.begin(call);ledger.finish(call,'succeeded','not-a-digest');}
    finally{ledger.close();}
    const prior=report(f.db,'bridge-bad');
    reviewed(f.db,'bridge-bad',prior.evidenceHash);
    assert.equal(f.leases.release(initial),true);
    const next=f.leases.acquire('bridge-bad','new',15000);assert.ok(next);
    const repair=new SqliteWorkspaceReceiptRepair(f.db,()=>{});
    try{
      assert.throws(()=>repair.repair(request(next,prior.evidenceHash)),
        {code:'REPAIR_OUTCOME_NOT_VERIFIED'});
    }finally{repair.close();}
    assert.equal(report(f.db,'bridge-bad').lastSeq,6);
  }finally{f.cleanup();}
});

test('RECEIPT-BRIDGE-06: terminal Turn cannot receive a late synthetic receipt',async()=>{
  const f=fixture();
  try{
    const initial=f.leases.acquire('bridge-terminal','original',15000);assert.ok(initial);
    const call=await seed(f.db,initial);
    const ledger=new HostExecutionLedger(f.db);
    try{
      ledger.begin(call);
      ledger.finish(call,'succeeded',digest(original));
    }finally{ledger.close();}
    const journal=new SqliteEventStore(f.db,initial);
    try{
      await journal.append('bridge-terminal',6,[{
        type:'turn.completed',turnId:'turn',data:{},
      }]);
    }finally{journal.close();}
    const prior=report(f.db,'bridge-terminal');
    assert.equal(prior.pendingTurnId,undefined);
    assert.equal(prior.calls[0]?.status,'host_finished_without_receipt');
    reviewed(f.db,'bridge-terminal',prior.evidenceHash);
    assert.equal(f.leases.release(initial),true);
    const successor=f.leases.acquire('bridge-terminal','next',15000);assert.ok(successor);
    const repair=new SqliteWorkspaceReceiptRepair(f.db,()=>{});
    try{
      assert.throws(()=>repair.repair(request(successor,prior.evidenceHash)),
        {code:'REPAIR_TURN_NOT_PENDING'});
    }finally{repair.close();}
    assert.equal(report(f.db,'bridge-terminal').lastSeq,7);
  }finally{f.cleanup();}
});
