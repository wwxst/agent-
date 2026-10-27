import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ConflictError, KernelError, type KernelEvent } from '../../contracts/src/index.js';
import { verifyJournal } from '../../command-inbox/src/index.js';
import { inspectToolAudit } from '../../tool-audit/src/index.js';
import { inspectSteeringAudit } from '../../steering-audit/src/index.js';
import { inspectContextCheckpoints } from '../../context-engine/src/checkpoint.js';
import { inspectTurnBindings, type TurnBinding } from './audit.js';
import type { WriterLease } from '../../session-leases-sqlite/src/index.js';

export type DispatchStatus = 'admitted' | 'model_started' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
export interface DispatchedTurn {
  readonly sessionId: string;
  readonly commandId: string;
  readonly turnId: string;
  readonly acceptedSeq: number;
  readonly boundSeq: number;
  readonly text: string;
  /** A replay always reports status; it never runs a model or tool. */
  readonly replayed: boolean;
  readonly status: DispatchStatus;
}
export interface BindCommand {
  readonly lease: WriterLease;
  readonly commandId: string;
  readonly expectedSeq: number;
}
const valid=(s:unknown,max:number):s is string=>typeof s==='string'&&!!s.trim()&&s.length<=max;
const corrupt=(message:string):never=>{throw new KernelError('CORRUPT_COMMAND_DISPATCH',message);};

function loadEvents(db:DatabaseSync,sessionId:string):KernelEvent[]{
  const rows=db.prepare(`
    SELECT session_id,seq,event_id,turn_id,type,data_json,occurred_at
    FROM kernel_events WHERE session_id=? ORDER BY seq
  `).all(sessionId);
  return rows.map(row=>({
    sessionId:row.session_id as string,seq:row.seq as number,eventId:row.event_id as string,
    ...(row.turn_id===null?{}:{turnId:row.turn_id as string}),
    type:row.type as KernelEvent['type'],data:JSON.parse(row.data_json as string),at:row.occurred_at as string,
  }));
}

function auditRows(db:DatabaseSync,sessionId:string,events:readonly KernelEvent[]):readonly TurnBinding[]{
  for(let i=0;i<events.length;i++){
    if(events[i]?.sessionId!==sessionId || events[i]?.seq!==i+1)
      corrupt('Session identity or journal sequence changed');
  }
  inspectContextCheckpoints(events);
  inspectSteeringAudit(events);
  inspectToolAudit(events);
  const bindings=inspectTurnBindings(events);
  const rows=db.prepare(`
    SELECT command_id,turn_id,accepted_seq,bound_seq
    FROM command_turn_dispatches WHERE session_id=?
  `).all(sessionId);
  if(rows.length!==bindings.length)return corrupt('Journal bindings and dispatcher ledger count differ');
  for(const bound of bindings){
    const row=rows.find(r=>r.command_id===bound.commandId);
    if(!row || row.turn_id!==bound.turnId || row.accepted_seq!==bound.acceptedSeq
      || row.bound_seq!==bound.boundSeq)return corrupt('Ledger binding does not match durable journal');
  }
  return bindings;
}
function status(events:readonly KernelEvent[],turnId:string):DispatchStatus{
  if(inspectToolAudit(events).some(e=>e.turnId===turnId && e.needsReconciliation))
    return 'outcome_unknown';
  if(inspectSteeringAudit(events).unconsumedSteers>0)
    return 'outcome_unknown';
  const turn=events.filter(x=>x.turnId===turnId);
  if(turn.some(e=>e.type==='turn.completed'))return 'completed';
  if(turn.some(e=>e.type==='turn.failed'))return 'failed';
  if(turn.some(e=>e.type==='turn.cancelled'))return 'cancelled';
  if(turn.some(e=>e.type==='tool.intent' || e.type==='assistant.message')){
    // A model may have produced output or a tool may have started. Never retry.
    return 'outcome_unknown';
  }
  if(turn.some(e=>e.type==='model.started'))return 'model_started';
  return 'admitted';
}
function expose(sessionId:string,binding:TurnBinding,events:readonly KernelEvent[],replayed:boolean):DispatchedTurn{
  return {sessionId,commandId:binding.commandId,turnId:binding.turnId,
    acceptedSeq:binding.acceptedSeq,boundSeq:binding.boundSeq,text:binding.text,
    replayed,status:status(events,binding.turnId)};
}

/**
 * TRUSTED LOCAL control-plane dispatcher, not a background worker.
 *
 * Binding a previously ACKed 'turn.run' command is a fenced SQLite transaction
 * that atomically appends four Turn-admission events. It never calls a model.
 * Execution must be initiated only by the owner that performed a NEW bind.
 */
export class SqliteCommandDispatcher {
  private readonly db: DatabaseSync;
  constructor(path:string, options:Readonly<{readOnly?:boolean}>={}){
    if(!valid(path,4096))throw new KernelError('INVALID_STORE_PATH','DB path required');
    this.db=new DatabaseSync(path,{timeout:5000,...(options.readOnly?{readOnly:true}:{})});
    try {
      if(options.readOnly){
        this.db.exec('PRAGMA query_only=ON');
        return;
      }
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS command_turn_dispatches(
          session_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          accepted_seq INTEGER NOT NULL,
          bound_seq INTEGER NOT NULL,
          PRIMARY KEY(session_id,command_id),
          UNIQUE(session_id,turn_id),
          UNIQUE(session_id,bound_seq)
        ) WITHOUT ROWID
      `);
    } catch(e){this.db.close();throw e;}
  }

  /** Read-only report. No claim to re-execute even when status='admitted'. */
  inspect(sessionId:string,commandId:string):DispatchedTurn|undefined{
    if(!valid(sessionId,256)||!valid(commandId,128))
      throw new KernelError('INVALID_COMMAND','Invalid command identity');
    this.db.exec('BEGIN');
    try{
      const events=loadEvents(this.db,sessionId);
      const bound=auditRows(this.db,sessionId,events).find(b=>b.commandId===commandId);
      const result=bound?expose(sessionId,bound,events,true):undefined;
      this.db.exec('COMMIT');
      return result;
    }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  }

  bind(request:BindCommand):DispatchedTurn{
    const {lease,commandId,expectedSeq}=request;
    if(!valid(lease.sessionId,256)||!valid(lease.ownerId,256)
      ||!Number.isSafeInteger(lease.fenceToken)||lease.fenceToken<1
      ||!valid(commandId,128)||!Number.isSafeInteger(expectedSeq)||expectedSeq<1)
      throw new KernelError('INVALID_COMMAND','Invalid dispatcher inputs');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const owner=this.db.prepare(`
        SELECT 1 FROM session_writer_leases WHERE
          session_id=? AND owner_id=? AND fence_token=?
          AND expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)
      `).get(lease.sessionId,lease.ownerId,lease.fenceToken);
      if(!owner)throw new KernelError('LEASE_LOST','Stale dispatch owner');

      const events=loadEvents(this.db,lease.sessionId);
      const bound=auditRows(this.db,lease.sessionId,events).find(b=>b.commandId===commandId);
      if(bound){
        const result=expose(lease.sessionId,bound,events,true);
        this.db.exec('COMMIT');
        return result;
      }

      // Unfinished Turns, incomplete tool receipts, consumed-but-unmatched
      // steering or invalid checkpoint history block new Turn admission.
      verifyJournal(events,lease.sessionId);
      if(events.length!==expectedSeq)throw new ConflictError('Dispatch sequence CAS failed');
      const command=this.db.prepare(`
        SELECT kind,payload_json,accepted_seq,fingerprint FROM session_commands
        WHERE session_id=? AND command_id=?
      `).get(lease.sessionId,commandId);
      if(!command)throw new KernelError('UNKNOWN_COMMAND','Command must be durably accepted first');
      if(command.kind!=='turn.run')throw new KernelError('UNSUPPORTED_COMMAND','Only turn.run can be dispatched');
      const accepted=events[(command.accepted_seq as number)-1];
      if(!accepted || accepted.type!=='command.accepted' || accepted.turnId!==undefined
        || !accepted.data || typeof accepted.data!=='object' || Array.isArray(accepted.data))
        return corrupt('Missing accepted command event');
      const ack=accepted.data as Record<string,unknown>;
      if(ack.commandId!==commandId || ack.kind!=='turn.run' || ack.fingerprint!==command.fingerprint)
        return corrupt('Accepted command fingerprint mismatch');

      const payload=JSON.parse(command.payload_json as string) as unknown;
      if(!payload || typeof payload!=='object' || Array.isArray(payload))
        throw new KernelError('INVALID_DISPATCH_PAYLOAD','turn.run requires {text}');
      const fields=Object.keys(payload);
      const text=(payload as {text?:unknown}).text;
      if(fields.length!==1 || fields[0]!=='text' || !valid(text,64*1024))
        throw new KernelError('INVALID_DISPATCH_PAYLOAD','turn.run requires nonempty bounded text');
      const turnId=randomUUID(),boundSeq=events.length+1,now=new Date().toISOString();
      const insert=this.db.prepare(`
        INSERT INTO kernel_events(session_id,seq,event_id,turn_id,type,data_json,occurred_at)
        VALUES(?,?,?,?,?,?,?)
      `);
      const append=(seq:number,type:string,turn:string|null,data:unknown):void=>{
        insert.run(lease.sessionId,seq,randomUUID(),turn,type,JSON.stringify(data),now);
      };
      append(boundSeq,'command.turn_bound',null,{commandId,turnId,acceptedSeq:command.accepted_seq,
        textHash:createHash('sha256').update(text).digest('hex')});
      append(boundSeq+1,'turn.queued',turnId,{commandId});
      append(boundSeq+2,'user.message',turnId,{text});
      append(boundSeq+3,'turn.started',turnId,{commandId});
      this.db.prepare(`
        INSERT INTO command_turn_dispatches(session_id,command_id,turn_id,accepted_seq,bound_seq)
        VALUES(?,?,?,?,?)
      `).run(lease.sessionId,commandId,turnId,command.accepted_seq as number,boundSeq);
      this.db.exec('COMMIT');
      return {sessionId:lease.sessionId,commandId,turnId,acceptedSeq:command.accepted_seq as number,
        boundSeq,text,replayed:false,status:'admitted'};
    }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  }

  close():void{this.db.close();}
}
