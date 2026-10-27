import { DatabaseSync } from 'node:sqlite';
import { KernelError } from '../../contracts/src/index.js';
import { inspectConnectionSnapshot, type ReconciliationReport } from '../../tool-reconciliation/src/index.js';

export type ReviewDecision = 'investigate' | 'evidence_noted';

/** A review is an immutable annotation, NOT a tool execution or recovery capability. */
export interface ReviewRequest {
  readonly sessionId: string;
  readonly reviewId: string;
  /** Identity is supplied by a trusted/authenticated caller, not verified by this module. */
  readonly reviewerId: string;
  readonly expectedEvidenceHash: string;
  readonly decision: ReviewDecision;
  readonly reason: string;
}
export interface RecoveryReview extends ReviewRequest {
  readonly reviewSeq: number;
  readonly createdAt: string;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function parseReview(row: Record<string, unknown>): RecoveryReview {
  return {
    sessionId: row.session_id as string,
    reviewId: row.review_id as string,
    reviewerId: row.reviewer_id as string,
    expectedEvidenceHash: row.evidence_hash as string,
    decision: row.decision as ReviewDecision,
    reason: row.reason as string,
    reviewSeq: row.review_seq as number,
    createdAt: row.created_at as string,
  };
}

/**
 * Review log is a separate control-plane table. It cannot unblock a Session,
 * forge a Receipt, or retry a ToolCall. BEGIN IMMEDIATE locks the journal and
 * Host evidence while validating its SHA-256 fingerprint and inserting review.
 */
export class SqliteRecoveryReviewStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (!validText(path, 4096)) throw new KernelError('INVALID_STORE_PATH', 'Review database path required');
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS recovery_reviews (
          session_id TEXT NOT NULL,
          review_seq INTEGER NOT NULL CHECK (review_seq >= 1),
          review_id TEXT NOT NULL,
          reviewer_id TEXT NOT NULL,
          evidence_hash TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('investigate','evidence_noted')),
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, review_seq),
          UNIQUE (session_id, review_id)
        ) WITHOUT ROWID
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /**
   * The caller MUST authenticate the human reviewer before invoking this API.
   * Review IDs are single-use and never reassigned even if evidence changes.
   * No "approved" or "retry" decision exists in the contract.
   */
  record(request: ReviewRequest): RecoveryReview {
    if (!validText(request.sessionId, 256) || !validText(request.reviewId, 128)
      || !validText(request.reviewerId, 256)
      || !/^[a-f0-9]{64}$/.test(request.expectedEvidenceHash)
      || !['investigate', 'evidence_noted'].includes(request.decision)
      || !validText(request.reason, 2048) || request.reason.trim().length < 12) {
      throw new KernelError('INVALID_REVIEW_REQUEST', 'Review requires identity, snapshot fingerprint and meaningful reason');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const report: ReconciliationReport = inspectConnectionSnapshot(this.db, request.sessionId);
      if (report.evidenceHash !== request.expectedEvidenceHash) {
        throw new KernelError('STALE_REVIEW_EVIDENCE', 'Journal or Host records changed after review snapshot');
      }
      if (!report.requiresManualReview) {
        throw new KernelError('NO_REVIEW_REQUIRED', 'No unresolved evidence to review');
      }
      const previous = this.db.prepare(`
        SELECT 1 FROM recovery_reviews WHERE session_id = ? AND review_id = ?
      `).get(request.sessionId, request.reviewId);
      if (previous) throw new KernelError('DUPLICATE_REVIEW_ID', 'Review ID is already used in this session');
      const count = this.db.prepare(`
        SELECT COALESCE(MAX(review_seq),0) AS version
        FROM recovery_reviews WHERE session_id = ?
      `).get(request.sessionId);
      const version = Number(count?.version);
      if (!Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) {
        throw new KernelError('REVIEW_SEQUENCE_EXHAUSTED', 'Review sequence overflow');
      }
      const reviewSeq = version + 1;
      const createdAt = this.db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS timestamp")
        .get()?.timestamp as string;
      this.db.prepare(`
        INSERT INTO recovery_reviews
        (session_id, review_seq, review_id, reviewer_id, evidence_hash, decision, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(request.sessionId, reviewSeq, request.reviewId, request.reviewerId,
        request.expectedEvidenceHash, request.decision, request.reason, createdAt);
      this.db.exec('COMMIT');
      return { ...request, reviewSeq, createdAt };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');

      throw error;
    }
  }

  /** Stored review history is immutable. It does not report present authorization. */
  list(sessionId: string): readonly RecoveryReview[] {
    if (!validText(sessionId, 256)) throw new KernelError('INVALID_SESSION', 'Session ID required');
    const rows = this.db.prepare(`
      SELECT session_id, review_seq, review_id, reviewer_id, evidence_hash, decision, reason, created_at
      FROM recovery_reviews WHERE session_id = ? ORDER BY review_seq
    `).all(sessionId);
    return rows.map(row => parseReview(row));
  }

  close(): void { this.db.close(); }
}
