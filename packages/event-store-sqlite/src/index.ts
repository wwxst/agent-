/**
 * M2 local durable event journal. Node 22+ node:sqlite is currently experimental.
 * A committed SQLite transaction is the only source of authority for this store.
 * This does NOT make external tool execution atomic with the database.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConflictError, KernelError, type EventDraft, type EventStore, type KernelEvent, type SessionId } from '../../contracts/src/index.js';

const MAX_EVENT_BYTES = 1024 * 1024;

type Row = { session_id: string; seq: number; event_id: string; type: string; turn_id: string | null; data_json: string; at: string };
type CommandRow = { fingerprint: string; accepted_seq: number; last_seq: number };

/** Reject JSON-incompatible values instead of silently erasing event fields. */
function jsonValue(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (depth > 64) throw new KernelError('INVALID_EVENT_PAYLOAD', 'JSON value exceeds nesting limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === undefined) throw new KernelError('INVALID_EVENT_PAYLOAD', 'Only JSON values are allowed');
  if (seen.has(value)) throw new KernelError('INVALID_EVENT_PAYLOAD', 'Circular references are forbidden');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new KernelError('INVALID_EVENT_PAYLOAD', 'Sparse or decorated arrays are not JSON');
      return value.map(v => jsonValue(v, depth + 1, seen));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new KernelError('INVALID_EVENT_PAYLOAD', 'Custom prototype is not an event payload');
    }
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !('value' in desc)) throw new KernelError('INVALID_EVENT_PAYLOAD', 'Accessors not permitted in journal');
      Object.defineProperty(out, key, { value: jsonValue(desc.value, depth + 1, seen), enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally { seen.delete(value); }
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(jsonValue(value));
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) throw new KernelError('EVENT_TOO_LARGE', 'Event payload exceeds 1MiB');
  return serialized;
}

function fingerprint(kind: string, payload: unknown): string {
  return createHash('sha256').update(canonicalJson({ kind, payload })).digest('hex');
}

export interface AcceptedCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly acceptedSeq: number;
  readonly lastSeq: number;
  readonly replayed: boolean;
}

export interface SQLiteEventStoreOptions {
  /** Maximum time SQLite waits for an existing writer (ms). */
  readonly busyTimeoutMs?: number;
}

/** Synchronous SQLite operations wrapped in the existing async EventStore contract. */
export class SQLiteEventStore implements EventStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string, options: SQLiteEventStoreOptions = {}) {
    if (!path.trim()) throw new KernelError('INVALID_DB_PATH', 'Database path required');
    const busy = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(busy) || busy < 0 || busy > 60000) throw new KernelError('INVALID_DB_OPTIONS', 'Invalid busy timeout');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      // WAL is a concurrency strategy, not a promise of perfect physical media durability.
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      this.db.exec(`PRAGMA busy_timeout=${busy};`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL CHECK(last_seq >= 0)
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        seq INTEGER NOT NULL CHECK(seq > 0),
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        turn_id TEXT,
        data_json TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS commands (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        command_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        accepted_seq INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        PRIMARY KEY (session_id, command_id)
      );`);
    } catch (error) { this.db.close(); throw error; }
  }

  private assertOpen(): void {
    if (this.closed) throw new KernelError('STORE_CLOSED', 'SQLiteEventStore was closed');
  }

  /** A transaction covers both session sequence CAS and all event rows. */
  private transact<T>(callback: () => T): T {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve original error. */ }
      throw error;
    }
  }

  private seqFor(sessionId: string): number | undefined {
    return (this.db.prepare('SELECT last_seq FROM sessions WHERE session_id=?').get(sessionId) as {last_seq: number} | undefined)?.last_seq;
  }

  private writeEvents(sessionId: string, expectedSeq: number, drafts: readonly EventDraft[]): KernelEvent[] {
    if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 0 || !sessionId.trim()) {
      throw new KernelError('INVALID_EVENT_WRITE', 'Invalid session ID or expected sequence');
    }
    if (drafts.length === 0) throw new KernelError('INVALID_EVENT_WRITE', 'Empty event batch');
    // Prepare all content before touching SQL; no dropped undefined/NaN/circular fields.
    const prepared = drafts.map(d => {
      if (!d.type || typeof d.type !== 'string' || (d.turnId !== undefined && (typeof d.turnId !== 'string' || !d.turnId))) {
        throw new KernelError('INVALID_EVENT_WRITE', 'Invalid event type/turn ID');
      }
      const dataJson = canonicalJson(d.data);
      return {type: d.type, turnId: d.turnId, dataJson};
    });
    const previousSeq = this.seqFor(sessionId);
    if (previousSeq === undefined) {
      if (expectedSeq !== 0 || prepared[0]?.type !== 'session.created') {
        throw new ConflictError('Session must begin with session.created at sequence zero');
      }
      this.db.prepare('INSERT INTO sessions(session_id,last_seq) VALUES(?,0)').run(sessionId);
    } else if (previousSeq !== expectedSeq) {
      throw new ConflictError(`Expected seq ${expectedSeq}, found ${previousSeq}`);
    }
    const start = expectedSeq + 1;
    const at = new Date().toISOString();
    const insert = this.db.prepare('INSERT INTO events(session_id,seq,event_id,type,turn_id,data_json,at) VALUES(?,?,?,?,?,?,?)');
    const output: KernelEvent[] = [];
    for (let i=0; i<prepared.length; i++) {
      const p = prepared[i]!;
      if ((p.type === 'session.created') !== (expectedSeq === 0 && i === 0)) {
        throw new KernelError('INVALID_EVENT_WRITE', 'session.created only allowed as first event');
      }
      const seq = start + i;
      const eventId = randomUUID();
      insert.run(sessionId, seq, eventId, p.type, p.turnId ?? null, p.dataJson, at);
      output.push({sessionId,seq,eventId,type:p.type as EventDraft['type'],at,
        ...(p.turnId === undefined ? {} : {turnId:p.turnId}),data:JSON.parse(p.dataJson) as unknown});
    }
    this.db.prepare('UPDATE sessions SET last_seq=? WHERE session_id=?').run(expectedSeq + prepared.length,sessionId);
    return output;
  }

  async append(sessionId: SessionId, expectedSeq: number, events: readonly EventDraft[]): Promise<readonly KernelEvent[]> {
    return this.transact(() => this.writeEvents(sessionId,expectedSeq,events));
  }

  /** Atomic command acceptance: dedupe identity and journal events in one transaction. */
  async acceptCommand(sessionId: SessionId, expectedSeq: number, commandId: string, kind: string,
    payload: unknown, accompanyingEvents: readonly EventDraft[] = []): Promise<AcceptedCommand> {
    if (!commandId.trim() || !kind.trim()) throw new KernelError('INVALID_COMMAND', 'Command ID and kind required');
    const digest = fingerprint(kind,payload);
    return this.transact(() => {
      const old = this.db.prepare('SELECT fingerprint,accepted_seq,last_seq FROM commands WHERE session_id=? AND command_id=?')
        .get(sessionId,commandId) as CommandRow | undefined;
      if (old) {
        if (old.fingerprint !== digest) throw new ConflictError('Command ID was reused with different content');
        return {commandId,fingerprint:digest,acceptedSeq:old.accepted_seq,lastSeq:old.last_seq,replayed:true};
      }
      const current = this.seqFor(sessionId);
      if (current === undefined || current !== expectedSeq) throw new ConflictError('Session missing or sequence changed');
      const acceptedEvent: EventDraft = {type:'command.accepted',data:{commandId,kind,fingerprint:digest}};
      const events = this.writeEvents(sessionId, expectedSeq, [acceptedEvent,...accompanyingEvents]);
      const first = events[0]!;
      const last = events[events.length-1]!;
      this.db.prepare('INSERT INTO commands(session_id,command_id,fingerprint,accepted_seq,last_seq) VALUES(?,?,?,?,?)')
        .run(sessionId,commandId,digest,first.seq,last.seq);
      return {commandId,fingerprint:digest,acceptedSeq:first.seq,lastSeq:last.seq,replayed:false};
    });
  }

  async read(sessionId: SessionId, afterSeq = 0): Promise<readonly KernelEvent[]> {
    this.assertOpen();
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new KernelError('INVALID_CURSOR', 'afterSeq must be nonnegative');
    const rows = this.db.prepare('SELECT session_id,seq,event_id,type,turn_id,data_json,at FROM events WHERE session_id=? AND seq>? ORDER BY seq')
      .all(sessionId, afterSeq) as Row[];
    return rows.map(row => {
      let data: unknown;
      try { data = JSON.parse(row.data_json); }
      catch { throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Persisted event payload is not valid JSON'); }
      return {sessionId:row.session_id,seq:row.seq,eventId:row.event_id,type:row.type as EventDraft['type'],at:row.at,
        ...(row.turn_id === null ? {} : {turnId:row.turn_id}),data};
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
