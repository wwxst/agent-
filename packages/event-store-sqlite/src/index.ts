import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ConflictError, KernelError, type EventDraft, type EventStore, type KernelEvent, type SessionId } from '../../contracts/src/index.js';
import type { WriterLease } from '../../session-leases-sqlite/src/index.js';

/**
 * Single-file SQLite EventStore for Node >= 22.16.
 *
 * WAL + synchronous=FULL protect committed journal writes under SQLite's documented
 * assumptions. BEGIN IMMEDIATE serializes competing appenders across connections.
 * This is storage CAS, NOT a turn lease, process isolation, or side-effect exactly-once.
 */
export class SqliteEventStore implements EventStore {
  private readonly db: DatabaseSync;

  /** When passed a WriterLease, EVERY append is fenced in the same SQLite transaction. */
  constructor(path: string, private readonly writerLease?: WriterLease) {
    if (!path.trim()) throw new KernelError('INVALID_STORE_PATH', 'SQLite path must be nonempty');
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kernel_events (
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL CHECK (seq > 0),
          event_id TEXT NOT NULL UNIQUE,
          turn_id TEXT,
          type TEXT NOT NULL,
          data_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        ) WITHOUT ROWID
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async append(sessionId: SessionId, expectedSeq: number, drafts: readonly EventDraft[]): Promise<readonly KernelEvent[]> {
    if (!sessionId.trim() || !Number.isSafeInteger(expectedSeq) || expectedSeq < 0) {
      throw new KernelError('INVALID_APPEND', 'Invalid sessionId or expectedSeq');
    }
    // An empty batch must not fabricate an event or bypass cursor checking.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Under the same BEGIN IMMEDIATE lock as event insertion, reject expired
      // or superseded owners. Unfenced stores are a backwards-compatible M0/M1
      // adapter; production multi-process writers must always supply a lease.
      if (this.writerLease) {
        const lease = this.writerLease;
        if (lease.sessionId !== sessionId) {
          throw new KernelError('LEASE_SCOPE_VIOLATION', 'Cannot append to a different session');
        }
        const owned = this.db.prepare(`
          SELECT 1 AS valid FROM session_writer_leases
          WHERE session_id = ? AND owner_id = ? AND fence_token = ?
            AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        `).get(sessionId, lease.ownerId, lease.fenceToken);
        if (!owned) throw new KernelError('LEASE_LOST', 'Lease expired or writer fenced out');
      }
      const row = this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS last_seq FROM kernel_events WHERE session_id = ?'
      ).get(sessionId);
      const actualSeq = row?.last_seq;
      if (typeof actualSeq !== 'number' || !Number.isSafeInteger(actualSeq)) {
        throw new KernelError('CORRUPT_EVENT_LOG', 'Stored cursor is not a safe integer');
      }
      if (actualSeq !== expectedSeq) {
        throw new ConflictError(`Expected seq ${expectedSeq}, found ${actualSeq}`);
      }

      const insert = this.db.prepare(`
        INSERT INTO kernel_events (session_id, seq, event_id, turn_id, type, data_json, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const at = new Date().toISOString();
      const result: KernelEvent[] = [];
      for (const draft of drafts) {
        const seq = actualSeq + result.length + 1;
        if (!Number.isSafeInteger(seq)) throw new KernelError('SEQUENCE_EXHAUSTED', 'Event cursor overflow');
        const eventId = randomUUID();
        // Encoding lives inside the transaction: a failure midway rolls back prior inserts.
        const dataJson = JSON.stringify(draft.data);
        if (typeof dataJson !== 'string') throw new KernelError('INVALID_EVENT_DATA', 'Event data must be JSON-serializable');
        insert.run(sessionId, seq, eventId, draft.turnId ?? null, draft.type, dataJson, at);
        result.push({
          sessionId, seq, eventId, ...(draft.turnId === undefined ? {} : { turnId: draft.turnId }), type: draft.type,
          at, data: JSON.parse(dataJson) as unknown,
        });
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async read(sessionId: SessionId, afterSeq = 0): Promise<readonly KernelEvent[]> {
    if (!sessionId.trim()) throw new KernelError('INVALID_SESSION', 'sessionId must be nonempty');
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new KernelError('INVALID_CURSOR', 'afterSeq must be a nonnegative safe integer');
    }
    const rows = this.db.prepare(`
      SELECT session_id, seq, event_id, turn_id, type, data_json, occurred_at
        FROM kernel_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC
    `).all(sessionId, afterSeq);
    return rows.map(row => ({
      sessionId: row.session_id as string,
      seq: row.seq as number,
      eventId: row.event_id as string,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id as string }),
      type: row.type as KernelEvent['type'],
      data: JSON.parse(row.data_json as string) as unknown,
      at: row.occurred_at as string,
    }));
  }

  close(): void { this.db.close(); }
}
