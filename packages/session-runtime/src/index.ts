import { randomUUID } from 'node:crypto';
import { KernelError, type KernelEvent, type ModelProvider, type SessionId, type TurnId } from '../../contracts/src/index.js';
import { AgentKernel, type DeltaListener, type KernelOptions, type TurnResult } from '../../kernel-core/src/index.js';
import { SqliteEventStore } from '../../event-store-sqlite/src/index.js';
import { SqliteWriterLeaseStore, type WriterLease } from '../../session-leases-sqlite/src/index.js';
import type { ToolRegistry } from '../../tool-scheduler/src/index.js';
import { SqliteCommandInbox, type AcceptedCommand } from '../../command-inbox/src/index.js';
import { SqliteCommandDispatcher, type DispatchedTurn } from '../../command-dispatcher/src/index.js';
import type { ContextCompactor } from '../../context-engine/src/index.js';

export interface ManagedSessionOptions {
  /** Claim lifetime in DB wall-clock milliseconds. Default: 3000. */
  readonly ttlMs?: number;
  /** Sync heartbeat interval. Must be strictly less than ttlMs. Default: ttlMs/3. */
  readonly renewEveryMs?: number;
  readonly maxSteps?: number;
  readonly maxToolCalls?: number;
  readonly maxContextCharacters?: number;
  readonly maxTotalTokens?: number;
  readonly contextCompactor?: ContextCompactor;
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
  private readonly activeKernels = new Map<SessionId, AgentKernel>();

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

  private async withLease<T>(sessionId: SessionId, work: (kernel: AgentKernel, lease: WriterLease) => Promise<T>,
    executionAuthorization?: () => void): Promise<T> {
    if (!sessionId.trim()) throw new KernelError('INVALID_SESSION', 'Session ID must be nonempty');
    const leases = new SqliteWriterLeaseStore(this.databasePath);
    let journal: SqliteEventStore | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let claim: import('../../session-leases-sqlite/src/index.js').WriterLease | null = null;
    let kernel: AgentKernel | undefined;
    try {
      claim = leases.acquire(sessionId, randomUUID(), this.ttlMs);
      if (!claim) throw new KernelError('SESSION_BUSY', 'Another writer owns this session');

      let lostReason: 'LEASE_LOST'|'AUTHORIZATION_REVOKED'|undefined;
      const markLost = (reason:'LEASE_LOST'|'AUTHORIZATION_REVOKED'): void => {
        if (!lostReason) {
          lostReason=reason;
          kernel?.fenceActiveTurn(sessionId,reason);
        }
      };
      const guard = (): void => {
        if(lostReason)throw new KernelError(lostReason,'Fenced execution');
        try {
          leases.assertOwned(claim!);
        } catch {
          markLost('LEASE_LOST');
          throw new KernelError('LEASE_LOST', 'Writer lease check failed');
        }
        if(executionAuthorization){
          try{ executionAuthorization(); }
          catch{
            // Audit storage errors are revocation-equivalent: fail closed.
            markLost('AUTHORIZATION_REVOKED');
            throw new KernelError('AUTHORIZATION_REVOKED','Execution authorization not current');
          }
        }
      };

      // This is intentionally the only journal construction in this facade.
      journal = new SqliteEventStore(this.databasePath, claim);
      const kernelOptions: KernelOptions = {
        assertExecutionLease: guard,
        ...(this.options.maxSteps === undefined ? {} : { maxSteps: this.options.maxSteps }),
        ...(this.options.maxToolCalls === undefined ? {} : { maxToolCalls: this.options.maxToolCalls }),
        ...(this.options.maxContextCharacters === undefined ? {} : { maxContextCharacters: this.options.maxContextCharacters }),
        ...(this.options.maxTotalTokens === undefined ? {} : { maxTotalTokens: this.options.maxTotalTokens }),
        ...(this.options.contextCompactor === undefined ? {} : { contextCompactor: this.options.contextCompactor }),
      };
      const tools = typeof this.tools === 'function' ? this.tools(claim) : this.tools;
      kernel = new AgentKernel(journal, this.provider, tools, kernelOptions, this.onDelta);
      this.activeKernels.set(sessionId,kernel);
      // Heartbeat is synchronous, so timer ticks never overlap each other.
      // Timer stalls can still let the claim expire; boundary checks fail closed.
      heartbeat = setInterval(() => {
        if (lostReason) return;
        try {
          guard(); // Check authorization even while provider/tool awaits I/O.
          claim = leases.renew(claim!, this.ttlMs);
        } catch (error) {
          markLost(error instanceof KernelError && error.code==='AUTHORIZATION_REVOKED'
            ? 'AUTHORIZATION_REVOKED':'LEASE_LOST');
        }
      }, this.renewEveryMs);
      guard();
      const result = await work(kernel, claim!);
      guard(); // Do not claim success after ownership was lost.
      return result;
    } finally {
      if (kernel && this.activeKernels.get(sessionId) === kernel) this.activeKernels.delete(sessionId);
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

  /**
   * Accept an inert command into the durable control-plane inbox.
   * No model dispatch, replay or Turn queueing is performed by this ACK API.
   * If the accepted ACK is lost, resend the same commandId and payload.
   */
  acceptCommand(sessionId: SessionId, expectedSeq: number, commandId: string,
    kind: string, payload: unknown): Promise<AcceptedCommand> {
    return this.withLease(sessionId, async (kernel, lease) => {
      await kernel.openSession(sessionId); // Never bypass unresolved Turn/ToolCall.
      const inbox = new SqliteCommandInbox(this.databasePath);
      try {
        return inbox.accept({lease,expectedSeq,commandId,kind,payload});
      } finally {
        inbox.close();
      }
    });
  }

  /**
   * First delivery: binds an existing 'turn.run' ACK to exactly one Turn and
   * drives the model under the SAME Writer Lease. Re-delivery: read status
   * only; never invoke Kernel/Provider/ToolHost again.
   */
  dispatchCommand(sessionId:SessionId,commandId:string,
    executionAuthorization?:()=>void):Promise<{
    readonly dispatch:DispatchedTurn;
    readonly execution?:TurnResult;
  }> {
    return this.withLease(sessionId,async (kernel,lease)=>{
      const dispatcher=new SqliteCommandDispatcher(this.databasePath);
      try{
        const prior=dispatcher.inspect(sessionId,commandId);
        if(prior)return {dispatch:prior};
        await kernel.openSession(sessionId);
        const events=await kernel.readEvents(sessionId);
        const bound=dispatcher.bind({lease,commandId,expectedSeq:events.length});
        if(bound.replayed)return {dispatch:bound};
        // runTurn's dispatch proof must equal the exact committed tail.
        // A crash after bind or model.started is never retried by this API.
        const execution=await kernel.runTurn(sessionId,bound.text,bound.turnId,{
          commandId:bound.commandId,boundSeq:bound.boundSeq,
        });
        const current=dispatcher.inspect(sessionId,commandId);
        if(!current)throw new KernelError('CORRUPT_COMMAND_DISPATCH','Dispatch mapping disappeared');
        return {dispatch:{...current,replayed:false},execution};
      } finally { dispatcher.close(); }
    },executionAuthorization);
  }

  /** Route steering to the *currently leased* in-process Turn; no new writer claim. */
  steerTurn(sessionId: SessionId, expectedTurnId: TurnId, text: string): Promise<boolean> {
    const kernel = this.activeKernels.get(sessionId);
    return kernel ? kernel.steerTurn(sessionId,expectedTurnId,text) : Promise.resolve(false);
  }

  /** Read via short-lived claim to keep the API consistent with the writer facade. */
  readEvents(sessionId: SessionId, afterSeq = 0): Promise<readonly KernelEvent[]> {
    return this.withLease(sessionId, async kernel => {
      await kernel.openSession(sessionId);
      return kernel.readEvents(sessionId, afterSeq);
    });
  }
}
