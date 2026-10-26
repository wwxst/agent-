import { DatabaseSync } from 'node:sqlite';
import { KernelError, type SessionId } from '../../contracts/src/index.js';

/**
 * An expiring, fenced writer admission claim. This is NOT a capability to run a
 * side-effecting tool: the eventual Tool Host must independently validate tokens.
 */
export interface WriterLease {
  readonly sessionId: SessionId;
  readonly ownerId: string;
  readonly fenceToken: number;
  readonly expiresAtMs: number;
}

/**
 * SQLite-backed writer lease protocol for a single shared database file.
 *
 * No app-side clock: expiry is evaluated by SQLite for every state transition.
 * The database clock is wall-clock time and can jump; a stronger monotonic
 * coordination service is needed for stricter distributed environments.
 */
export class SqliteWriterLeaseStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (!path.trim()) throw new KernelError('INVALID_STORE_PATH', 'SQLite path must be nonempty');
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_writer_leases (
          session_id TEXT NOT NULL PRIMARY KEY,
          owner_id TEXT,
          fence_token INTEGER NOT NULL CHECK (fence_token >= 1),
          expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0)
        ) WITHOUT ROWID
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private validateId(sessionId: string, ownerId: string): void {
    if (typeof sessionId !== 'string' || !sessionId.trim()
      || typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new KernelError('INVALID_LEASE_ID', 'Session and owner IDs must be nonempty');
    }
  }

  private validateTtl(ttlMs: number): void {
    // Keep expiry arithmetic within JS safe integers and bound abandoned leases.
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) {
      throw new KernelError('INVALID_LEASE_TTL', 'Lease TTL must be 1..86400000ms');
    }
  }

  private validateClaim(lease: WriterLease): void {
    this.validateId(lease.sessionId, lease.ownerId);
    if (!Number.isSafeInteger(lease.fenceToken) || lease.fenceToken < 1) {
      throw new KernelError('INVALID_FENCE_TOKEN', 'Fence token must be positive');
    }
  }

  private nowMs(): number {
    const row = this.db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS ms").get();
    const now = row?.ms;
    if (typeof now !== 'number' || !Number.isSafeInteger(now) || now <= 0) {
      throw new KernelError('INVALID_DATABASE_CLOCK', 'SQLite millisecond clock is unavailable');
    }
    return now;
  }

  /**
   * Atomically elect one owner. Busy => null.
   * Expired/released claims are always assigned a strictly larger token, even
   * when ownerId matches an earlier owner.
   */
  acquire(sessionId: SessionId, ownerId: string, ttlMs: number): WriterLease | null {
    this.validateId(sessionId, ownerId);
    this.validateTtl(ttlMs);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.nowMs();
      const row = this.db.prepare(
        'SELECT owner_id, fence_token, expires_at_ms FROM session_writer_leases WHERE session_id = ?'
      ).get(sessionId);
      if (row && row.owner_id !== null && (row.expires_at_ms as number) > now) {
        this.db.exec('COMMIT');
        return null;
      }
      const previousFence = row ? row.fence_token : 0;
      if (typeof previousFence !== 'number' || !Number.isSafeInteger(previousFence)
        || previousFence >= Number.MAX_SAFE_INTEGER) {
        throw new KernelError('FENCE_EXHAUSTED', 'Cannot increment fencing token');
      }
      const fenceToken = previousFence + 1;
      const expiresAtMs = now + ttlMs;
      if (!Number.isSafeInteger(expiresAtMs)) throw new KernelError('INVALID_LEASE_TTL', 'Lease expiry overflow');
      if (row) {
        this.db.prepare(`
          UPDATE session_writer_leases
          SET owner_id = ?, fence_token = ?, expires_at_ms = ?
          WHERE session_id = ?
        `).run(ownerId, fenceToken, expiresAtMs, sessionId);
      } else {
        this.db.prepare(`
          INSERT INTO session_writer_leases(session_id, owner_id, fence_token, expires_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(sessionId, ownerId, fenceToken, expiresAtMs);
      }
      this.db.exec('COMMIT');
      return { sessionId, ownerId, fenceToken, expiresAtMs };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Heartbeat only succeeds while the original claim is STILL valid. A late
   * heartbeat can never resurrect an expired claim or steal a newer token.
   */
  renew(lease: WriterLease, ttlMs: number): WriterLease {
    this.validateClaim(lease);
    this.validateTtl(ttlMs);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.nowMs();
      const expiresAtMs = now + ttlMs;
      if (!Number.isSafeInteger(expiresAtMs)) throw new KernelError('INVALID_LEASE_TTL', 'Lease expiry overflow');
      const updated = this.db.prepare(`
        UPDATE session_writer_leases SET expires_at_ms = ?
        WHERE session_id = ? AND owner_id = ? AND fence_token = ? AND expires_at_ms > ?
      `).run(expiresAtMs, lease.sessionId, lease.ownerId, lease.fenceToken, now);
      if (updated.changes !== 1) throw new KernelError('LEASE_LOST', 'Lease expired or fenced out');
      this.db.exec('COMMIT');
      return { ...lease, expiresAtMs };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Observation only: a lease may expire immediately after this check. */
  assertOwned(lease: WriterLease): void {
    this.validateClaim(lease);
    const row = this.db.prepare(`
      SELECT 1 AS owned FROM session_writer_leases
      WHERE session_id = ? AND owner_id = ? AND fence_token = ?
        AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    `).get(lease.sessionId, lease.ownerId, lease.fenceToken);
    if (!row) throw new KernelError('LEASE_LOST', 'Lease no longer valid');
  }

  /** Idempotent: stale/expired tokens cannot release someone else's claim. */
  release(lease: WriterLease): boolean {
    this.validateClaim(lease);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.nowMs();
      const updated = this.db.prepare(`
        UPDATE session_writer_leases SET owner_id = NULL, expires_at_ms = 0
        WHERE session_id = ? AND owner_id = ? AND fence_token = ? AND expires_at_ms > ?
      `).run(lease.sessionId, lease.ownerId, lease.fenceToken, now);
      this.db.exec('COMMIT');
      return updated.changes === 1;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
