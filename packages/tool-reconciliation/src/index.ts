import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { KernelError, type KernelEvent, type KernelEventType, type ToolResult } from '../../contracts/src/index.js';
import { inspectToolAudit } from '../../tool-audit/src/index.js';
import { inspectSteeringAudit } from '../../steering-audit/src/index.js';
import { inspectContextCheckpoints } from '../../context-engine/src/checkpoint.js';
import type { HostLedgerEntry } from '../../tool-host/src/ledger.js';

export type ReconciliationStatus =
  | 'verified'
  | 'intent_without_host'
  | 'host_started'
  | 'host_finished_without_receipt'
  | 'kernel_receipt_without_host'
  | 'kernel_outcome_unknown'
  | 'mismatch'
  | 'orphan_host';

export interface ReconciliationCall {
  readonly turnId: string;
  readonly callId: string;
  readonly name: string;
  readonly intentSeq?: number;
  readonly receiptSeq?: number;
  readonly hostFenceToken?: number;
  readonly kernelOutcome: ToolResult['outcome'] | 'missing';
  readonly hostState: HostLedgerEntry['state'] | 'missing';
  readonly status: ReconciliationStatus;
  /** No status, even 'verified', grants permission to replay a tool. */
  readonly requiresManualReview: boolean;
}

export interface ReconciliationReport {
  readonly sessionId: string;
  readonly lastSeq: number;
  readonly unconsumedSteers: number;
  /** SHA-256 of complete event and Host records, including receipt content; never authorization. */
  readonly evidenceHash: string;
  readonly pendingTurnId?: string;
  readonly calls: readonly ReconciliationCall[];
  readonly requiresManualReview: boolean;
  /** Cross-ledger evidence only; this is NOT permission to resume or replay. */
  readonly fullyVerified: boolean;
}

interface Receipt {
  readonly outcome: ToolResult['outcome'];
  readonly content: string;
}

function failLog(message: string): never {
  throw new KernelError('CORRUPT_EVENT_LOG', message);
}

function validReceipt(data: unknown): data is Receipt & { callId: string; name: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const value = data as Record<string, unknown>;
  return typeof value.callId === 'string' && typeof value.name === 'string'
    && typeof value.content === 'string'
    && (value.outcome === 'succeeded' || value.outcome === 'failed'
      || value.outcome === 'denied' || value.outcome === 'outcome_unknown');
}

const keyFor = (turnId: string, callId: string): string => JSON.stringify([turnId, callId]);

/** Fail closed on damaged session event order, even when there are no tool calls. */
function journalState(events: readonly KernelEvent[], sessionId: string): string | undefined {
  if (events.length === 0 || events[0]?.type !== 'session.created') {
    throw new KernelError('UNKNOWN_SESSION', 'Session not found in event journal');
  }
  const seenTurns = new Set<string>();
  let pending: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.sessionId !== sessionId || event.seq !== i + 1
      || (i > 0 && event.type === 'session.created')) {
      return failLog('Invalid session event sequence or identity');
    }
    if (i === 0) {
      if (event.turnId !== undefined) return failLog('Creation event must not have turnId');
      continue;
    }
    if (event.type === 'command.accepted') {
      if (event.turnId !== undefined) return failLog('Command ACK must be session-scoped');
      continue;
    }
    if (!event.turnId) return failLog('Turn event missing turnId');
    if (event.type === 'turn.queued') {
      if (pending || seenTurns.has(event.turnId)) return failLog('Overlapping or duplicate turn');
      pending = event.turnId;
      seenTurns.add(event.turnId);
    } else {
      if (pending !== event.turnId) return failLog('Event outside active turn');
      if (event.type === 'turn.completed' || event.type === 'turn.failed'
        || event.type === 'turn.cancelled') pending = undefined;
    }
  }
  return pending;
}

/**
 * Strictly read-only, point-in-time dual-ledger audit of a single SQLite DB.
 * It does not acquire a lease or trust in-memory Kernel cursors and NEVER
 * writes receipts, alters a Turn or invokes a tool.
 *
 * BEGIN DEFERRED guarantees Kernel and Host rows are evaluated from one SQLite
 * snapshot, including while other connections append/finish concurrently.
 */
export class SqliteToolReconciler {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (!path.trim()) throw new KernelError('INVALID_STORE_PATH', 'Database path required');
    this.db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
    try {
      this.db.exec('PRAGMA query_only=ON');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  inspect(sessionId: string): ReconciliationReport {
    if (!sessionId.trim()) throw new KernelError('INVALID_SESSION', 'sessionId required');
    this.db.exec('BEGIN');
    try {
      const report = inspectConnectionSnapshot(this.db, sessionId);
      this.db.exec('COMMIT');
      return report;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}

/**
 * Caller must own a SQLite transaction: SELECTs of both ledgers must use one
 * snapshot. Writable review transactions use BEGIN IMMEDIATE; read-only
 * observers use BEGIN. Never export an unfenced multi-query reader.
 */
export function inspectConnectionSnapshot(db: DatabaseSync, sessionId: string): ReconciliationReport {
  if (!sessionId.trim()) throw new KernelError('INVALID_SESSION', 'sessionId required');
      const journalTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_events'"
      ).get();
      if (!journalTable) throw new KernelError('UNKNOWN_SESSION', 'No Kernel journal in database');
      const hostTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_tool_executions'"
      ).get();
      const raw = db.prepare(`
        SELECT session_id, seq, event_id, turn_id, type, data_json, occurred_at
        FROM kernel_events WHERE session_id = ? ORDER BY seq
      `).all(sessionId);
      const events: KernelEvent[] = raw.map(row => ({
        sessionId: row.session_id as string,
        seq: row.seq as number,
        eventId: row.event_id as string,
        ...(row.turn_id === null ? {} : { turnId: row.turn_id as string }),
        type: row.type as KernelEventType,
        data: JSON.parse(row.data_json as string) as unknown,
        at: row.occurred_at as string,
      }));
      // Legacy sessions may never have initialized the Host ledger table.
      // Missing table means no Host attestation, not permission to replay.
      const hostRows = hostTable ? db.prepare(`
        SELECT session_id, turn_id, call_id, tool_name, fence_token, state, content
        FROM host_tool_executions WHERE session_id = ? ORDER BY turn_id,call_id
      `).all(sessionId) : [];
      const hosts: HostLedgerEntry[] = hostRows.map(row => ({
        sessionId: row.session_id as string,
        turnId: row.turn_id as string,
        callId: row.call_id as string,
        name: row.tool_name as string,
        fenceToken: row.fence_token as number,
        state: row.state as HostLedgerEntry['state'],
        content: row.content as string | null,
      }));
      return reconcileSnapshot(sessionId, events, hosts);
}

/** Pure decision function for deterministic recovery tests and other adapters. */
export function reconcileSnapshot(
  sessionId: string,
  events: readonly KernelEvent[],
  hosts: readonly HostLedgerEntry[],
): ReconciliationReport {
  const pendingTurnId = journalState(events, sessionId);
  const journal = inspectToolAudit(events);
  const steering = inspectSteeringAudit(events);
  inspectContextCheckpoints(events);
  const receipts = new Map<string, Receipt>();
  for (const event of events) {
    if (event.type !== 'tool.receipt') continue;
    if (!event.turnId || !validReceipt(event.data)) return failLog('Malformed tool receipt');
    const key = keyFor(event.turnId, event.data.callId);
    if (receipts.has(key)) return failLog('Duplicate tool receipt');
    receipts.set(key, { outcome: event.data.outcome, content: event.data.content });
  }

  const hostsByKey = new Map<string, HostLedgerEntry>();
  for (const host of hosts) {
    if (host.sessionId !== sessionId || !host.turnId.trim() || !host.callId.trim()
      || !host.name.trim() || !Number.isSafeInteger(host.fenceToken) || host.fenceToken < 1
      || !['started', 'succeeded', 'failed'].includes(host.state)
      || (host.state === 'started' ? host.content !== null : typeof host.content !== 'string')) {
      return failLog('Malformed or cross-session Host execution row');
    }
    const key = keyFor(host.turnId, host.callId);
    if (hostsByKey.has(key)) return failLog('Duplicate Host execution');
    hostsByKey.set(key, host);
  }

  const calls: ReconciliationCall[] = [];
  for (const entry of journal) {
    const key = keyFor(entry.turnId, entry.callId);
    const host = hostsByKey.get(key);
    if (host) hostsByKey.delete(key);
    const receipt = receipts.get(key);
    let status: ReconciliationStatus;

    if (host && host.name !== entry.name) status = 'mismatch';
    else if (!host && !receipt) status = 'intent_without_host';
    else if (!host) status = 'kernel_receipt_without_host';
    else if (host.state === 'started') status = 'host_started';
    else if (!receipt) status = 'host_finished_without_receipt';
    else if (receipt.outcome === 'outcome_unknown') status = 'kernel_outcome_unknown';
    else if (entry.receiptSeq === undefined || entry.outcome !== receipt.outcome
      || host.state !== receipt.outcome || host.content !== receipt.content) status = 'mismatch';
    else status = 'verified';

    calls.push({
      turnId: entry.turnId, callId: entry.callId, name: entry.name,
      intentSeq: entry.intentSeq,
      ...(entry.receiptSeq === undefined ? {} : { receiptSeq: entry.receiptSeq }),
      ...(host === undefined ? {} : { hostFenceToken: host.fenceToken }),
      kernelOutcome: receipt?.outcome ?? 'missing',
      hostState: host?.state ?? 'missing',
      status, requiresManualReview: status !== 'verified',
    });
  }

  for (const host of hostsByKey.values()) {
    calls.push({
      turnId: host.turnId, callId: host.callId, name: host.name,
      hostFenceToken: host.fenceToken, kernelOutcome: 'missing',
      hostState: host.state, status: 'orphan_host', requiresManualReview: true,
    });
  }
  const requiresManualReview = Boolean(pendingTurnId) || steering.unconsumedSteers>0
    || calls.some(item => item.requiresManualReview);
  const evidenceHash = createHash('sha256').update(JSON.stringify({
    sessionId,
    events: events.map(event => ({ eventId: event.eventId, seq: event.seq,
      turnId: event.turnId ?? null, type: event.type, data: event.data, at: event.at })),
    hosts: [...hosts].sort((a,b) => a.turnId.localeCompare(b.turnId) || a.callId.localeCompare(b.callId)),
  })).digest('hex');
  return {
    sessionId, lastSeq: events.length, evidenceHash, unconsumedSteers:steering.unconsumedSteers,
    ...(pendingTurnId === undefined ? {} : { pendingTurnId }),
    calls, requiresManualReview,
    fullyVerified: !requiresManualReview,
  };
}
