import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { KernelError, type ToolResult } from '../../contracts/src/index.js';
import type { WriterLease } from '../../session-leases-sqlite/src/index.js';

export interface HostCall {
  readonly lease: WriterLease;
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}
export interface HostLedgerEntry {
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly fenceToken: number;
  readonly state: 'started' | 'succeeded' | 'failed';
  readonly content: string | null;
}

/**
 * The process-local Host owns this SQLite connection. BEGIN IMMEDIATE couples
 * ownership, persisted intent and the host's execution admission.
 *
 * STARTED is durable *before* a tool body may begin. On process death it is
 * "outcome unknown", never proof that execution did not happen.
 */
export class HostExecutionLedger {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (!path.trim()) throw new KernelError('INVALID_STORE_PATH', 'Host database path required');
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec('PRAGMA journal_mode=WAL');
      this.db.exec('PRAGMA synchronous=FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS host_tool_executions (
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          fence_token INTEGER NOT NULL CHECK (fence_token > 0),
          state TEXT NOT NULL CHECK (state IN ('started','succeeded','failed')),
          content TEXT,
          PRIMARY KEY (session_id,turn_id,call_id)
        ) WITHOUT ROWID
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private owned(lease: WriterLease): void {
    const valid = this.db.prepare(`
      SELECT 1 FROM session_writer_leases
      WHERE session_id = ? AND owner_id = ? AND fence_token = ?
        AND expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    `).get(lease.sessionId, lease.ownerId, lease.fenceToken);
    if (!valid) throw new KernelError('LEASE_LOST', 'Host rejected expired or superseded lease');
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private verifyIntent(call: HostCall): void {
    const rows = this.db.prepare(`
      SELECT seq, type, data_json FROM kernel_events
      WHERE session_id = ? AND turn_id = ?
        AND type IN ('turn.started','assistant.message','tool.intent','tool.receipt',
                     'turn.completed','turn.failed','turn.cancelled')
      ORDER BY seq ASC
    `).all(call.lease.sessionId, call.turnId);
    if (!rows.some(row => row.type === 'turn.started')) {
      throw new KernelError('HOST_INTENT_MISSING', 'Turn not started');
    }
    let matchingAssistantSeq = -1;
    let matchingIntents = 0;
    let intentSeq = -1;
    for (const row of rows) {
      if (row.type === 'turn.completed' || row.type === 'turn.failed' || row.type === 'turn.cancelled') {
        throw new KernelError('HOST_TURN_TERMINAL', 'Host will not execute a finished turn');
      }
      const data = JSON.parse(row.data_json as string) as unknown;
      if (!data || typeof data !== 'object') continue;
      const item = data as Record<string, unknown>;
      if (row.type === 'assistant.message') {
        const calls = item.toolCalls;
        if (Array.isArray(calls) && calls.some(c => {
          if (!c || typeof c !== 'object') return false;
          const o = c as Record<string, unknown>;
          return o.id === call.callId && o.name === call.name && isDeepStrictEqual(o.arguments, call.input);
        })) matchingAssistantSeq = row.seq as number;
      }
      if (row.type === 'tool.intent' && item.callId === call.callId) {
        if (item.name !== call.name) throw new KernelError('HOST_INTENT_MISMATCH', 'Tool name mismatch');
        matchingIntents++;
        intentSeq = row.seq as number;
      }
      if (row.type === 'tool.receipt' && item.callId === call.callId) {
        throw new KernelError('TOOL_OUTCOME_UNKNOWN', 'Already receipted call must not run again');
      }
    }
    if (matchingIntents !== 1 || matchingAssistantSeq < 0 || intentSeq <= matchingAssistantSeq) {
      throw new KernelError('HOST_INTENT_MISSING', 'Matching persisted assistant call and intent required');
    }
  }

  /** Refuse every duplicate, including a completed historical call. */
  begin(call: HostCall): void {
    if (!call.turnId.trim() || !call.callId.trim() || !call.name.trim()
      || !call.lease.sessionId.trim() || !call.lease.ownerId.trim()
      || !Number.isSafeInteger(call.lease.fenceToken) || call.lease.fenceToken < 1) {
      throw new KernelError('HOST_INVALID_REQUEST', 'Invalid host request identifiers');
    }
    this.transaction(() => {
      this.owned(call.lease);
      this.verifyIntent(call);
      const prior = this.db.prepare(`
        SELECT 1 FROM host_tool_executions
        WHERE session_id = ? AND turn_id = ? AND call_id = ?
      `).get(call.lease.sessionId, call.turnId, call.callId);
      if (prior) throw new KernelError('TOOL_OUTCOME_UNKNOWN', 'Call already claimed by host; reconciliation required');
      this.db.prepare(`
        INSERT INTO host_tool_executions
        (session_id,turn_id,call_id,tool_name,fence_token,state,content)
        VALUES (?, ?, ?, ?, ?, 'started', NULL)
      `).run(call.lease.sessionId, call.turnId, call.callId, call.name, call.lease.fenceToken);
    });
  }

  /** Terminal record requires original ownership in SAME SQLite transaction. */
  finish(call: HostCall, outcome: Extract<ToolResult['outcome'], 'succeeded' | 'failed'>, content: string): void {
    this.transaction(() => {
      this.owned(call.lease);
      const r = this.db.prepare(`
        UPDATE host_tool_executions SET state = ?, content = ?
        WHERE session_id = ? AND turn_id = ? AND call_id = ?
          AND tool_name = ? AND fence_token = ? AND state = 'started'
      `).run(outcome, content, call.lease.sessionId, call.turnId, call.callId, call.name, call.lease.fenceToken);
      if (r.changes !== 1) throw new KernelError('TOOL_OUTCOME_UNKNOWN', 'Missing active Host execution claim');
    });
  }

  /** Audit is read-only; 'started' after a crash must be treated as unknown. */
  inspect(sessionId: string): readonly HostLedgerEntry[] {
    if (!sessionId.trim()) throw new KernelError('INVALID_SESSION', 'sessionId required');
    return this.db.prepare(`
      SELECT session_id, turn_id, call_id, tool_name, fence_token, state, content
      FROM host_tool_executions WHERE session_id = ? ORDER BY turn_id,call_id
    `).all(sessionId).map(row => ({
      sessionId: row.session_id as string,
      turnId: row.turn_id as string,
      callId: row.call_id as string,
      name: row.tool_name as string,
      fenceToken: row.fence_token as number,
      state: row.state as HostLedgerEntry['state'],
      content: row.content as string | null,
    }));
  }
  close(): void { this.db.close(); }
}
