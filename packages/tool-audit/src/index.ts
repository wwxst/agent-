import { KernelError, type KernelEvent, type ToolResult, type TurnId } from '../../contracts/src/index.js';

export interface ToolAuditEntry {
  readonly turnId: TurnId;
  readonly callId: string;
  readonly name: string;
  readonly intentSeq: number;
  readonly receiptSeq?: number;
  /** Missing receipt is conservatively outcome_unknown, NEVER proof of non-execution. */
  readonly outcome: ToolResult['outcome'];
  readonly needsReconciliation: boolean;
}

interface MutableEntry {
  turnId: string;
  callId: string;
  name: string;
  intentSeq: number;
  receiptSeq?: number;
  outcome: ToolResult['outcome'];
  receiptContent?: string;
  seenResult: boolean;
}

const corrupt = (why: string): never => {
  throw new KernelError('CORRUPT_EVENT_LOG', why);
};

function objectData(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return corrupt('Invalid tool audit payload');
  return data as Record<string, unknown>;
}

/**
 * Pure journal-derived audit. Works for unfinished turns and after a restart.
 * Legacy M0 journals without tool.intent/tool.receipt stay readable.
 * A recorded outcome_unknown or a missing receipt always requires reconciliation.
 */
export function inspectToolAudit(events: readonly KernelEvent[]): readonly ToolAuditEntry[] {
  const byTurn = new Map<string, Map<string, MutableEntry>>();
  const ordered: MutableEntry[] = [];

  for (const event of events) {
    if (event.type !== 'tool.intent' && event.type !== 'tool.receipt' && event.type !== 'tool.result') continue;
    if (!event.turnId) return corrupt('Tool audit event has no turnId');
    const data = objectData(event.data);
    const callId = data.callId;
    const name = data.name;
    if (typeof callId !== 'string' || !callId.trim() || typeof name !== 'string' || !name.trim()) {
      return corrupt('Invalid tool identity');
    }
    let calls = byTurn.get(event.turnId);
    if (!calls) {
      calls = new Map();
      byTurn.set(event.turnId, calls);
    }
    const existing = calls.get(callId);
    if (event.type === 'tool.intent') {
      if (existing) return corrupt('Duplicate tool intent');
      if (typeof data.step !== 'number' || !Number.isSafeInteger(data.step) || data.step < 1) {
        return corrupt('Invalid tool intent step');
      }
      const item: MutableEntry = {
        turnId: event.turnId, callId, name, intentSeq: event.seq,
        outcome: 'outcome_unknown', seenResult: false,
      };
      calls.set(callId, item);
      ordered.push(item);
    } else if (event.type === 'tool.receipt') {
      if (!existing || existing.name !== name || existing.receiptSeq !== undefined || existing.seenResult) {
        return corrupt('Receipt lacks a unique matching intent');
      }
      if (typeof data.content !== 'string'
        || !['succeeded', 'failed', 'denied', 'outcome_unknown'].includes(String(data.outcome))) {
        return corrupt('Invalid tool receipt outcome');
      }
      existing.receiptSeq = event.seq;
      existing.outcome = data.outcome as ToolResult['outcome'];
      existing.receiptContent = data.content;
    } else if (existing) {
      // New-format tool.result must follow its durable receipt.
      if (existing.receiptSeq === undefined || existing.seenResult
        || event.seq !== existing.receiptSeq + 1
        || existing.name !== name || existing.outcome !== data.outcome
        || existing.receiptContent !== data.content) {
        return corrupt('Tool result does not match its receipt');
      }
      existing.seenResult = true;
    }
  }
  // Kernel writes receipt + context result in one atomic append batch;
  // a lone receipt never proves the context-visible result was committed.
  if (ordered.some(entry => entry.receiptSeq !== undefined && !entry.seenResult)) {
    return corrupt('Tool receipt missing its matching result');
  }
  return ordered.map(entry => ({
    turnId: entry.turnId, callId: entry.callId, name: entry.name,
    intentSeq: entry.intentSeq,
    ...(entry.receiptSeq === undefined ? {} : { receiptSeq: entry.receiptSeq }),
    outcome: entry.outcome,
    needsReconciliation: entry.receiptSeq === undefined || entry.outcome === 'outcome_unknown',
  }));
}
