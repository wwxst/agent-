import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {KernelError, type ToolResult} from '../../contracts/src/index.js';
import type {WriterLease} from '../../session-leases-sqlite/src/index.js';
import {inspectConnectionSnapshot} from './index.js';

/**
 * Recovery-only, TRUSTED control-plane journal repair.
 *
 * Repairs one missing receipt/result pair from an already completed Host
 * execution. Does not invoke a tool, approve a write, end a Turn, replay,
 * or make an unfinished Session resumable. Never expose to model tools.
 *
 * The caller MUST authenticate the reviewer and bind the authorization
 * callback to current durable privileges. A recovery-review annotation
 * by itself never grants the right to repair the journal.
 */
export interface WorkspaceReceiptRepairRequest {
  readonly lease: WriterLease;
  readonly turnId: string;
  readonly callId: string;
  readonly reviewId: string;
  readonly reviewerId: string;
  readonly expectedEvidenceHash: string;
}
export interface WorkspaceReceiptRepairResult {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly receiptSeq: number;
  readonly resultSeq: number;
  /** The incomplete turn must remain blocked for independent recovery. */
  readonly pendingTurnId: string;
}
export type WorkspaceReceiptRepairAuthorization = (request:WorkspaceReceiptRepairRequest)=>void;
const validId=(v:unknown,max=256):v is string=>
  typeof v==='string'&&v.length>0&&v.length<=max&&/^[a-zA-Z0-9_-]+$/.test(v);
function reject(code:string,reason:string):never {throw new KernelError(code,reason);}

export class SqliteWorkspaceReceiptRepair {
  private readonly db:DatabaseSync;
  constructor(path:string,private readonly authorize:WorkspaceReceiptRepairAuthorization){
    if(typeof path!=='string'||!path.trim())
      reject('INVALID_STORE_PATH','Recovery database path required');
    if(typeof authorize!=='function')
      reject('REPAIR_AUTH_REQUIRED','Trusted authorization callback required');
    this.db=new DatabaseSync(path,{timeout:5000});
    try {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=FULL');
    } catch(err){this.db.close();throw err;}
  }
  close():void {this.db.close();}

  repair(request:WorkspaceReceiptRepairRequest):WorkspaceReceiptRepairResult{
    if(!request||typeof request!=='object'||!request.lease
      ||!validId(request.lease.sessionId)||!validId(request.lease.ownerId)
      ||!Number.isSafeInteger(request.lease.fenceToken)||request.lease.fenceToken<1
      ||!validId(request.turnId)||!validId(request.callId)||!validId(request.reviewId,128)
      ||!validId(request.reviewerId)||!/^[a-f0-9]{64}$/.test(request.expectedEvidenceHash))
      reject('INVALID_REPAIR_REQUEST','Invalid receipt recovery identity or evidence');
    // Do not obtain permissions from the model, a journal row or a review note.
    this.authorize(request);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const owned=this.db.prepare(`
        SELECT 1 FROM session_writer_leases
        WHERE session_id=? AND owner_id=? AND fence_token=?
          AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      `).get(request.lease.sessionId,request.lease.ownerId,request.lease.fenceToken);
      if(!owned)reject('LEASE_LOST','Receipt repair owner is not currently fenced in');
      const report=inspectConnectionSnapshot(this.db,request.lease.sessionId);
      if(report.evidenceHash!==request.expectedEvidenceHash)
        reject('STALE_REPAIR_EVIDENCE','Dual-ledger fingerprint has changed');
      if(report.pendingTurnId!==request.turnId)
        reject('REPAIR_TURN_NOT_PENDING','Only a still-unresolved turn can be annotated');
      const match=report.calls.filter(c=>c.turnId===request.turnId&&c.callId===request.callId);
      if(match.length!==1||match[0]!.name!=='workspace.patch'
        ||match[0]!.status!=='host_finished_without_receipt'
        ||match[0]!.hostState!=='succeeded'||match[0]!.kernelOutcome!=='missing')
        reject('REPAIR_OUTCOME_NOT_VERIFIED','Host success without Kernel receipt is required');

      const host=this.db.prepare(`
        SELECT tool_name,fence_token,state,content FROM host_tool_executions
        WHERE session_id=? AND turn_id=? AND call_id=?
      `).get(request.lease.sessionId,request.turnId,request.callId);
      const content=host?.content;
      if(host?.tool_name!=='workspace.patch'||host?.state!=='succeeded'
        ||typeof content!=='string'||!/^[a-f0-9]{64}$/.test(content)
        ||typeof host.fence_token!=='number'
        ||request.lease.fenceToken<=host.fence_token)
        reject('REPAIR_OUTCOME_NOT_VERIFIED','Success digest and a successor lease are required');

      // Existing immutable reviews are *evidence*, not authorization. The
      // separate trusted callback must independently approve this operation.
      const reviewTable=this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='recovery_reviews'"
      ).get();
      if(!reviewTable)reject('REPAIR_REVIEW_REQUIRED','No initialized immutable review journal');
      const note=this.db.prepare(`
        SELECT 1 FROM recovery_reviews
        WHERE session_id=? AND review_id=? AND reviewer_id=?
          AND evidence_hash=? AND decision='evidence_noted'
      `).get(request.lease.sessionId,request.reviewId,request.reviewerId,report.evidenceHash);
      if(!note)reject('REPAIR_REVIEW_REQUIRED','Matching immutable evidence note required');
      this.authorize(request); // Re-check current privilege inside write lock.

      const data:ToolResult={
        callId:request.callId,name:'workspace.patch',outcome:'succeeded',
        content,
      };
      const seq=report.lastSeq;
      const timestamp=new Date().toISOString();
      const insert=this.db.prepare(`
        INSERT INTO kernel_events
          (session_id,seq,event_id,turn_id,type,data_json,occurred_at)
        VALUES (?,?,?,?,?,?,?)
      `);
      insert.run(request.lease.sessionId,seq+1,randomUUID(),
        request.turnId,'tool.receipt',JSON.stringify(data),timestamp);
      insert.run(request.lease.sessionId,seq+2,randomUUID(),
        request.turnId,'tool.result',JSON.stringify(data),timestamp);
      // A malformed event pair is rolled back, never partially persisted.
      const check=inspectConnectionSnapshot(this.db,request.lease.sessionId);
      const repaired=check.calls.find(c=>c.turnId===request.turnId&&c.callId===request.callId);
      if(repaired?.status!=='verified'||check.pendingTurnId!==request.turnId)
        reject('REPAIR_VERIFICATION_FAILED','Receipt pair is not internally consistent');
      this.db.exec('COMMIT');
      return {sessionId:request.lease.sessionId,turnId:request.turnId,
        callId:request.callId,receiptSeq:seq+1,resultSeq:seq+2,
        pendingTurnId:request.turnId};
    }catch(err){
      if(this.db.isTransaction)this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
