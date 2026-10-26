import { randomUUID } from 'node:crypto';
import { ConflictError, KernelError, type EventDraft, type EventStore, type KernelEvent, type SessionId } from '../../contracts/src/index.js';

/** Test-only event journal: atomic within this Node process, NOT crash durable. */
export class MemoryEventStore implements EventStore {
  private readonly logs = new Map<SessionId, KernelEvent[]>();

  async append(sessionId: SessionId, expectedSeq: number, drafts: readonly EventDraft[]): Promise<readonly KernelEvent[]> {
    const current = this.logs.get(sessionId) ?? [];
    if (expectedSeq !== current.length) throw new ConflictError(`Expected seq ${expectedSeq}, found ${current.length}`);
    const now = new Date().toISOString();
    const events = drafts.map((d, i) => ({
      ...structuredClone(d), sessionId, seq: expectedSeq + i + 1, eventId: randomUUID(), at: now,
    } satisfies KernelEvent));
    this.logs.set(sessionId, [...current, ...events]);
    return structuredClone(events);
  }

  async read(sessionId: SessionId, afterSeq = 0): Promise<readonly KernelEvent[]> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new KernelError('INVALID_CURSOR', 'afterSeq must be >= 0');
    return structuredClone((this.logs.get(sessionId) ?? []).filter((e) => e.seq > afterSeq));
  }
}
