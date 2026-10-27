import { randomUUID } from 'node:crypto';
import { KernelError, type KernelEvent, type ModelProvider, type SessionId, type TurnId } from '../../contracts/src/index.js';
import { AgentKernel, type DeltaListener, type KernelOptions, type TurnResult } from '../../kernel-core/src/index.js';
import { SqliteEventStore } from '../../event-store-sqlite/src/index.js';
import { SqliteWriterLeaseStore, type WriterLease } from '../../session-leases-sqlite/src/index.js';
import type { ToolRegistry } from '../../tool-scheduler/src/index.js';

export interface ManagedSessionOptions {
  /** Claim lifetime in DB wall-clock milliseconds. Default: 3000. */
  readonly ttlMs?: number;
  /** Sync heartbeat interval. Must be strictly less than ttlMs. Default: ttlMs/3. */
  readonly renewEveryMs?: number;
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
}

/**
 * Minimal trusted single-turn boundary for M1. It does NOT provide a sandbox,
 * an authenticated Tool Host, side-effect receipts, or hard process termination.
 *
 * Each operation creates a fresh unique owner, acquires its own writer claim,
 * uses an ALWAYS-fenced EventStore, renews while running, then releases.
 * Existing legacy callers can still build unfenced stores; don't use them in
 * multi-process production writers.
 */
export class ManagedSessionRunner {
  private readonly ttlMs: number;
  private readonly renewEveryMs: number;

  constructor(
    private readonly databasePath: string,
    private readonly provider: ModelProvider,
    private readonly tools: ToolRegistry | ((lease: WriterLease) => ToolRegistry),
    private readonly options: ManagedSessionOptions = {},
    private readonly onDelta?: DeltaListener,
  ) {
    this.ttlMs = options.ttlMs ?? 3000;
    this.renewEveryMs = options.renewEveryMs ?? Math.max(10, Math.floor(this.ttlMs / 3));
    if (!databasePath.trim()
      || !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 30 || this.ttlMs > 86_400_000
      || !Number.isSafeInteger(this.renewEveryMs) || this.renewEveryMs < 1
      || this.renewEveryMs >= this.ttlMs) {
      throw new KernelError('INVALID_MANAGED_LEASE_OPTIONS', 'Invalid path, TTL or heartbeat interval');
    }
  }

  private async withLease<T>(sessionId: SessionId, work: (kernel: AgentKernel) => Promise<T>): Promise<T> {
    if (!sessionId.trim()) throw new KernelError('INVALID_SESSION', 'Session ID must be nonempty');
    const leases = new SqliteWriterLeaseStore(this.databasePath);
    let journal: SqliteEventStore | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let claim: import('../../session-leases-sqlite/src/index.js').WriterLease | null = null;
    try {
      claim = leases.acquire(sessionId, randomUUID(), this.ttlMs);
      if (!claim) throw new KernelError('SESSION_BUSY', 'Another writer owns this session');

      let lost = false;
      let kernel: AgentKernel | undefined;
      const markLost = (): void => {
        if (!lost) {
          lost = true;
          kernel?.fenceActiveTurn(sessionId);
        }
      };
      const guard = (): void => {
        if (lost) throw new KernelError('LEASE_LOST', 'Writer lease lost');
        try {
          leases.assertOwned(claim!);
        } catch {
          markLost();
          throw new KernelError('LEASE_LOST', 'Writer lease check failed');
        }
      };

      // This is intentionally the only journal construction in this facade.
      journal = new SqliteEventStore(this.databasePath, claim);
      const kernelOptions: KernelOptions = {
        assertExecutionLease: guard,
        ...(this.options.maxSteps === undefined ? {} : { maxSteps: this.options.maxSteps }),
        ...(this.options.maxToolCalls === undefined ? {} : { maxToolCalls: this.options.maxToolCalls }),
      };
      const tools = typeof this.tools === 'function' ? this.tools(claim) : this.tools;
      kernel = new AgentKernel(journal, this.provider, tools, kernelOptions, this.onDelta);
      // Heartbeat is synchronous, so timer ticks never overlap each other.
      // Timer stalls can still let the claim expire; boundary checks fail closed.
      heartbeat = setInterval(() => {
        if (lost) return;
        try {
          claim = leases.renew(claim!, this.ttlMs);
        } catch {
          markLost(); // cancellation is cooperative, with no fake terminal event
        }
      }, this.renewEveryMs);
      guard();
      const result = await work(kernel);
      guard(); // Do not claim success after ownership was lost.
      return result;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      try {
        if (claim) leases.release(claim); // stale tokens cannot release new owners
      } finally {
        try { journal?.close(); } finally { leases.close(); }
      }
    }
  }

  /** First use only. Never silently creates a missing session in runTurn(). */
  createSession(sessionId: SessionId): Promise<SessionId> {
    return this.withLease(sessionId, kernel => kernel.createSession(sessionId));
  }

  /** Reopens only fully terminal history. No recovery or replay of unknown effects. */
  runTurn(sessionId: SessionId, text: string, turnId?: TurnId): Promise<TurnResult> {
    return this.withLease(sessionId, async kernel => {
      await kernel.openSession(sessionId);
      return turnId === undefined
        ? kernel.runTurn(sessionId, text)
        : kernel.runTurn(sessionId, text, turnId);
    });
  }

  /** Read via short-lived claim to keep the API consistent with the writer facade. */
  readEvents(sessionId: SessionId, afterSeq = 0): Promise<readonly KernelEvent[]> {
    return this.withLease(sessionId, async kernel => {
      await kernel.openSession(sessionId);
      return kernel.readEvents(sessionId, afterSeq);
    });
  }
}
