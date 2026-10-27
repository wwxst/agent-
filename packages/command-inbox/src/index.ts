import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ConflictError, KernelError, type KernelEvent } from '../../contracts/src/index.js';
import type { WriterLease } from '../../session-leases-sqlite/src/index.js';
import { inspectToolAudit } from '../../tool-audit/src/index.js';
import { inspectSteeringAudit } from '../../steering-audit/src/index.js';
import { inspectTurnBindings } from '../../command-dispatcher/src/audit.js';
import { inspectContextCheckpoints } from '../../context-engine/src/checkpoint.js';

const MAX_PAYLOAD_BYTES = 64*1024;

export interface AcceptedCommand {
  readonly sessionId: string;
  readonly commandId: string;
  readonly kind: string;
  readonly fingerprint: string;
  readonly acceptedSeq: number;
  /** Duplicate requests return the original durable ACK; they never dispatch work. */
  readonly replayed: boolean;
}
export interface AcceptCommandRequest {
  readonly lease: WriterLease;
  readonly expectedSeq: number;
  readonly commandId: string;
  readonly kind: string;
  readonly payload: unknown;
}

function validText(s: unknown, max: number): s is string {
  return typeof s === 'string' && s.trim().length>0 && s.length<=max;
}
function normalize(value:unknown, depth=0, path=new Set<object>()):unknown {
  if(depth>64) throw new KernelError('INVALID_COMMAND_PAYLOAD','Maximum JSON depth exceeded');
  if(value===null || typeof value==='string' || typeof value==='boolean') return value;
  if(typeof value==='number' && Number.isFinite(value)) return value;
  if(value===undefined || typeof value!=='object') throw new KernelError('INVALID_COMMAND_PAYLOAD','JSON value required');
  if(path.has(value)) throw new KernelError('INVALID_COMMAND_PAYLOAD','Cyclic command payload');
  path.add(value);
  try{
    if(Array.isArray(value)){
      if(Object.keys(value).length!==value.length)
        throw new KernelError('INVALID_COMMAND_PAYLOAD','Sparse or decorated array');
      return value.map(item=>normalize(item,depth+1,path));
    }
    if(Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null)
      throw new KernelError('INVALID_COMMAND_PAYLOAD','Custom prototype rejected');
    const result:Record<string,unknown>=Object.create(null);
    for(const key of Object.keys(value).sort()){
      const d=Object.getOwnPropertyDescriptor(value,key);
      if(!d || !('value' in d)) throw new KernelError('INVALID_COMMAND_PAYLOAD','Getters are not accepted');
      result[key]=normalize(d.value,depth+1,path);
    }
    return result;
  }finally{path.delete(value);}
}
function canonical(value:unknown):string {
  const json=JSON.stringify(normalize(value));
  if(Buffer.byteLength(json,'utf8')>MAX_PAYLOAD_BYTES)
    throw new KernelError('COMMAND_TOO_LARGE','Command payload exceeds 64 KiB');
  return json;
}

export function verifyJournal(events:readonly KernelEvent[],sessionId:string):void {
  if(events[0]?.type!=='session.created')
    throw new KernelError('UNKNOWN_SESSION','Missing session creation event');
  const seen=new Set<string>();
  let active:string|undefined;
  for(let i=0;i<events.length;i++){
    const e=events[i]!;
    if(e.sessionId!==sessionId || e.seq!==i+1)
      throw new KernelError('CORRUPT_EVENT_LOG','Session sequence invalid');
    if(i===0){
      if(e.turnId!==undefined) throw new KernelError('CORRUPT_EVENT_LOG','Invalid creation');
      continue;
    }
    if(e.type==='command.accepted' || e.type==='command.turn_bound'){
      if(e.turnId!==undefined) throw new KernelError('CORRUPT_EVENT_LOG','Command ACK cannot impersonate a Turn');
      continue;
    }
    if(!e.turnId) throw new KernelError('CORRUPT_EVENT_LOG','Turn ID required');
    if(e.type==='turn.queued'){
      if(active || seen.has(e.turnId)) throw new KernelError('CORRUPT_EVENT_LOG','Turn overlap');
      active=e.turnId;seen.add(e.turnId);
    }else {
      if(active!==e.turnId) throw new KernelError('CORRUPT_EVENT_LOG','Event without active turn');
      if(e.type==='turn.completed' || e.type==='turn.failed' || e.type==='turn.cancelled')
        active=undefined;
    }
  }
  inspectContextCheckpoints(events);
  inspectTurnBindings(events);
  if(active || inspectToolAudit(events).some(x=>x.needsReconciliation)
    || inspectSteeringAudit(events).unconsumedSteers>0)
    throw new KernelError('RECOVERY_REQUIRED','Unsettled turn or ToolCall blocks new command admission');
}

/**
 * Local control-plane inbox: durable ACK only, no model dispatch.
 *
 * Session writer lease is checked inside the SAME BEGIN IMMEDIATE transaction
 * as sequence CAS, persisted command and command.accepted event.
 */
export class SqliteCommandInbox {
  private readonly db: DatabaseSync;
  constructor(path:string, options:Readonly<{readOnly?:boolean}>={}) {
    if(!validText(path,4096)) throw new KernelError('INVALID_STORE_PATH','SQLite path required');
    this.db=new DatabaseSync(path,{timeout:5000,...(options.readOnly?{readOnly:true}:{})});
    try{
      if(options.readOnly){
        this.db.exec('PRAGMA query_only=ON');
        return;
      }
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_commands(
          session_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          accepted_seq INTEGER NOT NULL CHECK(accepted_seq>0),
          PRIMARY KEY(session_id,command_id)
        ) WITHOUT ROWID
      `);
    }catch(error){this.db.close();throw error;}
  }

  accept(request:AcceptCommandRequest):AcceptedCommand {
    const {lease,expectedSeq,commandId,kind,payload}=request;
    if(!validText(lease.sessionId,256) || !validText(lease.ownerId,256)
      || !Number.isSafeInteger(lease.fenceToken) || lease.fenceToken<=0
      || !Number.isSafeInteger(expectedSeq) || expectedSeq<1
      || !validText(commandId,128) || !validText(kind,128))
      throw new KernelError('INVALID_COMMAND','Invalid command ID, type, sequence or writer identity');
    const payloadJson=canonical(payload);
    const fingerprint=createHash('sha256').update(canonical({kind,payload:JSON.parse(payloadJson)})).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const owned=this.db.prepare(`
        SELECT 1 FROM session_writer_leases WHERE
          session_id=? AND owner_id=? AND fence_token=?
          AND expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)
      `).get(lease.sessionId,lease.ownerId,lease.fenceToken);
      if(!owned) throw new KernelError('LEASE_LOST','Command admission denied for stale writer');

      // A duplicate command may be replayed with an old expectedSeq, returning
      // ONLY the old accepted ACK; it must never create new journal events.
      const prior=this.db.prepare(`
        SELECT kind, fingerprint, accepted_seq FROM session_commands
        WHERE session_id=? AND command_id=?
      `).get(lease.sessionId,commandId);
      if(prior){
        if(prior.fingerprint!==fingerprint || prior.kind!==kind)
          throw new ConflictError('Command ID collision with different content');
        const ack=this.db.prepare(`
          SELECT type,turn_id,data_json FROM kernel_events
          WHERE session_id=? AND seq=?
        `).get(lease.sessionId,prior.accepted_seq as number);
        if(!ack || ack.type!=='command.accepted' || ack.turn_id!==null)
          throw new KernelError('CORRUPT_EVENT_LOG','Accepted command missing journal ACK');
        const data=JSON.parse(ack.data_json as string) as Record<string,unknown>;
        if(data.commandId!==commandId || data.kind!==kind || data.fingerprint!==fingerprint)
          throw new KernelError('CORRUPT_EVENT_LOG','Persisted command ACK mismatch');
        this.db.exec('COMMIT');
        return {sessionId:lease.sessionId,commandId,kind,fingerprint,
          acceptedSeq:prior.accepted_seq as number,replayed:true};
      }

      const rows=this.db.prepare(`
        SELECT session_id,seq,event_id,turn_id,type,data_json,occurred_at
        FROM kernel_events WHERE session_id=? ORDER BY seq
      `).all(lease.sessionId);
      const events:KernelEvent[]=rows.map(row=>({
        sessionId:row.session_id as string,seq:row.seq as number,eventId:row.event_id as string,
        ...(row.turn_id===null?{}:{turnId:row.turn_id as string}),
        type:row.type as KernelEvent['type'],data:JSON.parse(row.data_json as string),at:row.occurred_at as string,
      }));
      verifyJournal(events,lease.sessionId);
      // Detect orphaned, deleted or tampered ACK rows before admitting more
      // commands. All checks share the admission transaction snapshot.
      for(const e of events.filter(item=>item.type==='command.accepted')){
        if(!e.data || typeof e.data!=='object') throw new KernelError('CORRUPT_EVENT_LOG','Bad command ACK');
        const data=e.data as Record<string,unknown>;
        const row=this.db.prepare(`
          SELECT command_id,kind,fingerprint,accepted_seq FROM session_commands
          WHERE session_id=? AND accepted_seq=?
        `).get(lease.sessionId,e.seq);
        if(!row || row.command_id!==data.commandId || row.kind!==data.kind
          || row.fingerprint!==data.fingerprint || row.accepted_seq!==e.seq)
          throw new KernelError('CORRUPT_EVENT_LOG','Command ACK and Inbox ledger diverged');
      }
      if(expectedSeq!==events.length) throw new ConflictError('Stale command admission journal cursor');

      const acceptedSeq=events.length+1;
      const commandEvent={commandId,kind,fingerprint};
      this.db.prepare(`
        INSERT INTO kernel_events(session_id,seq,event_id,turn_id,type,data_json,occurred_at)
        VALUES(?,?,?,NULL,'command.accepted',?,?)
      `).run(lease.sessionId,acceptedSeq,randomUUID(),JSON.stringify(commandEvent),new Date().toISOString());
      this.db.prepare(`
        INSERT INTO session_commands(session_id,command_id,kind,fingerprint,payload_json,accepted_seq)
        VALUES(?,?,?,?,?,?)
      `).run(lease.sessionId,commandId,kind,fingerprint,payloadJson,acceptedSeq);
      this.db.exec('COMMIT');
      return {sessionId:lease.sessionId,commandId,kind,fingerprint,acceptedSeq,replayed:false};
    }catch(error){
      if(this.db.isTransaction)this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Consistent read-only ACK lookup, suitable for authenticated status APIs.
   * Never trust the command table alone: the original event must match.
   */
  inspectAccepted(sessionId:string,commandId:string):AcceptedCommand|undefined {
    if(!validText(sessionId,256) || !validText(commandId,128))
      throw new KernelError('INVALID_COMMAND','Invalid command identity');
    this.db.exec('BEGIN');
    try{
      const row=this.db.prepare(`
        SELECT command_id,kind,fingerprint,accepted_seq FROM session_commands
        WHERE session_id=? AND command_id=?
      `).get(sessionId,commandId);
      if(!row) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const event=this.db.prepare(`
        SELECT type,turn_id,data_json FROM kernel_events
        WHERE session_id=? AND seq=?
      `).get(sessionId,row.accepted_seq as number);
      if(!event || event.type!=='command.accepted' || event.turn_id!==null)
        throw new KernelError('CORRUPT_EVENT_LOG','Command ACK missing original event');
      const data=JSON.parse(event.data_json as string) as unknown;
      if(!data || typeof data!=='object' || Array.isArray(data))
        throw new KernelError('CORRUPT_EVENT_LOG','Invalid ACK payload');
      const ack=data as Record<string,unknown>;
      if(ack.commandId!==row.command_id || ack.kind!==row.kind
        ||ack.fingerprint!==row.fingerprint)
        throw new KernelError('CORRUPT_EVENT_LOG','Command ACK mismatch');
      this.db.exec('COMMIT');
      return {sessionId,commandId,kind:row.kind as string,
        fingerprint:row.fingerprint as string,
        acceptedSeq:row.accepted_seq as number,replayed:true};
    }catch(error){
      if(this.db.isTransaction)this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Audit returns metadata only. Do not expose persisted payloads by default. */
  list(sessionId:string):readonly AcceptedCommand[] {
    if(!validText(sessionId,256)) throw new KernelError('INVALID_SESSION','Session required');
    return this.db.prepare(`
      SELECT session_id, command_id, kind, fingerprint, accepted_seq
      FROM session_commands WHERE session_id=? ORDER BY accepted_seq
    `).all(sessionId).map(row=>({
      sessionId:row.session_id as string,commandId:row.command_id as string,
      kind:row.kind as string,fingerprint:row.fingerprint as string,
      acceptedSeq:row.accepted_seq as number,replayed:false,
    }));
  }
  close():void{this.db.close();}
}
