import { createHash } from 'node:crypto';
import { KernelError, type KernelEvent } from '../../contracts/src/index.js';
import { inspectToolAudit } from '../../tool-audit/src/index.js';
import { inspectSteeringAudit } from '../../steering-audit/src/index.js';

export interface ContextCheckpoint {
  readonly seq: number;
  readonly throughSeq: number;
  readonly summary: string;
  readonly sourceHash: string;
  readonly sourceEventCount: number;
}

function corrupt(message: string): never {
  throw new KernelError('CORRUPT_CONTEXT_CHECKPOINT', message);
}

/** Not an authenticity signature: catches accidental/stale mutations of immutable source rows. */
export function hashContextSource(events: readonly KernelEvent[], throughSeq: number): string {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 1 || throughSeq > events.length) {
    throw new KernelError('INVALID_CHECKPOINT_BOUNDARY', 'Source prefix does not exist');
  }
  const source=events.slice(0,throughSeq).map(e=>({
    sessionId:e.sessionId,seq:e.seq,eventId:e.eventId,turnId:e.turnId??null,
    type:e.type,data:e.data,at:e.at,
  }));
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

/** Only a contiguous prefix of COMPLETED historical turns is compactable. */
export function safeCompletedPrefix(events: readonly KernelEvent[], fromSeq: number, beforeSeq: number): number | undefined {
  // A prior checkpoint lives INSIDE its active Turn. Resume the scan
  // with that Turn open; its turn.queued precedes the checkpoint marker.
  const preceding=fromSeq>0 ? events[fromSeq-1] : undefined;
  let active: string | undefined = preceding?.type==='context.checkpoint' ? preceding.turnId : undefined;
  let boundary: number | undefined;
  for(const event of events){
    if(event.seq<=fromSeq || event.seq>=beforeSeq) continue;
    if(event.type==='command.accepted') continue;
    if(event.type==='turn.queued'){
      if(active) return undefined;
      active=event.turnId;
    } else if(event.type==='turn.completed'){
      if(!active || event.turnId!==active) return undefined;
      boundary=event.seq;
      active=undefined;
    } else if(event.type==='turn.failed' || event.type==='turn.cancelled'){
      // Skip no failed/cancelled turn, even if later completed ones exist.
      break;
    }
  }
  return boundary;
}

/**
 * Every checkpoint is a projection over an immutable, previously completed
 * prefix. Never uses a summary as an execution/authorization source.
 */
export function inspectContextCheckpoints(events: readonly KernelEvent[]): readonly ContextCheckpoint[] {
  const checkpoints:ContextCheckpoint[]=[];
  for (const e of events) {
    if(e.type!=='context.checkpoint') continue;
    const data=e.data;
    if(!data || typeof data!=='object' || Array.isArray(data)) return corrupt('Invalid checkpoint body');
    const value=data as Record<string,unknown>;
    const {throughSeq,summary,sourceHash,sourceEventCount}=value;
    const prev=checkpoints.at(-1);
    const fromSeq=prev?.seq??0;
    if(!Number.isSafeInteger(throughSeq) || (throughSeq as number)<=fromSeq
      || (throughSeq as number)>=e.seq || typeof summary!=='string'
      || !summary.trim() || summary.length>32_768
      || typeof sourceHash!=='string' || !/^[0-9a-f]{64}$/.test(sourceHash)
      || !Number.isSafeInteger(sourceEventCount) || (sourceEventCount as number)<=0) {
      return corrupt('Malformed or backwards checkpoint');
    }
    const through=throughSeq as number;
    const boundary=safeCompletedPrefix(events,fromSeq,e.seq);
    if(boundary!==through || events[through-1]?.type!=='turn.completed'
      || events[through-1]?.turnId===e.turnId
      || sourceEventCount!==events.filter(x=>x.seq>fromSeq && x.seq<=through).length) {
      return corrupt('Checkpoint would hide uncompleted, non-contiguous or current Turn');
    }
    const prefix=events.slice(0,through);
    if(inspectToolAudit(prefix).some(x=>x.needsReconciliation)
      || inspectSteeringAudit(prefix).unconsumedSteers!==0) {
      return corrupt('Checkpoint would hide unresolved ToolCall or Steering');
    }
    if(sourceHash!==hashContextSource(events,through)) return corrupt('Checkpoint source fingerprint mismatch');
    checkpoints.push({seq:e.seq,throughSeq:through,summary,sourceHash,sourceEventCount:sourceEventCount as number});
  }
  return checkpoints;
}
