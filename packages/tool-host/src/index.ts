import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { KernelError, type ToolExecutionContext } from '../../contracts/src/index.js';
import type { WriterLease } from '../../session-leases-sqlite/src/index.js';
import { ToolRegistry } from '../../tool-scheduler/src/index.js';
import { SqliteWriterLeaseStore } from '../../session-leases-sqlite/src/index.js';
import { SqliteEventStore } from '../../event-store-sqlite/src/index.js';
import { HostExecutionLedger } from './ledger.js';
import type { HostCall } from './ledger.js';

interface Pending {
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
interface Reply {
  id: string;
  ok: boolean;
  content?: string;
  code?: string;
}
function isReply(x: unknown): x is Reply {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.ok === 'boolean';
}

export class ProcessToolHost {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private ended = false;
  private readonly ready: Promise<void>;
  private signalReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;

  /** A terminated worker leaves STARTED calls requiring reconciliation. */
  constructor(databasePath: string, private readonly timeoutMs = 4000) {
    if (!databasePath.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new KernelError('HOST_INVALID_OPTIONS', 'Invalid Host database path or timeout');
    }
    // Ensure all three schema boundaries are initialized BEFORE forking a
    // worker. Previously worker, lease store and journal could race through
    // SQLite's first WAL/schema setup and intermittently reject a safe call.
    // This is only schema bootstrapping, NOT a lease or execution admission.
    const leases = new SqliteWriterLeaseStore(databasePath);
    try {
      const journal = new SqliteEventStore(databasePath);
      journal.close();
      const ledger = new HostExecutionLedger(databasePath);
      ledger.close();
    } finally {
      leases.close();
    }
    this.ready = new Promise<void>((resolve, reject) => {
      this.signalReady = resolve;
      this.rejectReady = reject;
    });
    // A worker can fail during startup even if nobody ever invokes it.
    void this.ready.catch(() => undefined);
    const worker = new URL('./worker.js', import.meta.url);
    this.child = fork(worker, [databasePath], {
      execArgv: [],
      env: {}, // Do not forward credentials, NODE_OPTIONS, or model-controlled environment.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
    this.child.on('message', (raw: unknown) => {
      if (raw && typeof raw === 'object' && (raw as {type?: unknown}).type === 'ready') {
        if (!this.readySettled) {
          this.readySettled = true;
          this.signalReady();
        }
        return;
      }
      if (!isReply(raw)) return;
      const request = this.pending.get(raw.id);
      if (!request) return;
      this.pending.delete(raw.id);
      request.cleanup();
      if (raw.ok && typeof raw.content === 'string') request.resolve(raw.content);
      else if (raw.code === 'LEASE_LOST') request.reject(new KernelError('LEASE_LOST', 'Host rejected writer token'));
      else request.reject(new KernelError('TOOL_OUTCOME_UNKNOWN',
        'Host rejected or did not confirm execution: ' + String(raw.code ?? 'UNKNOWN')));
    });
    this.child.on('error', () => this.failAll());
    this.child.on('exit', () => this.failAll());
  }

  get pid(): number | undefined { return this.child.pid; }

  private failAll(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new KernelError('TOOL_OUTCOME_UNKNOWN', 'Host failed before becoming ready'));
    }
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(new KernelError('TOOL_OUTCOME_UNKNOWN', 'Host process exited before reply'));
    }
    this.pending.clear();
  }

  async invoke(call: HostCall, signal: AbortSignal): Promise<string> {
    await this.ready;
    if (this.ended || !this.child.connected) {
      throw new KernelError('TOOL_OUTCOME_UNKNOWN', 'Host process unavailable');
    }
    if (signal.aborted) throw new KernelError('TOOL_OUTCOME_UNKNOWN', 'Call already cancelled');
    const id = randomUUID();
    const payload = { type: 'run', id, call };
    if (JSON.stringify(payload).length > 32768) throw new KernelError('HOST_INVALID_REQUEST', 'Request too large');
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        // Kill the whole worker to stop an in-flight tool cooperatively: all
        // pending requests then become unknown rather than wrongly "failed".
        this.close();
      };
      const timeout = setTimeout(() => this.close(), this.timeoutMs);
      const cleanup = (): void => { clearTimeout(timeout); signal.removeEventListener('abort', onAbort); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {resolve, reject, cleanup});
      this.child.send(payload, error => {
        if (error) this.close();
      });
      if (signal.aborted) onAbort();
    });
  }

  /**
   * Registry is scoped to a specific writer token. Real call/turn identity
   * flows from Kernel, not from untrusted tool arguments.
   */
  createRegistry(lease: WriterLease): ToolRegistry {
    const registry = new ToolRegistry();
    const create = (name: string) => registry.register({
      name, version: '1', risk: 'read', concurrency: 'parallel',
      parse: input => input,
      execute: async (input: unknown, signal: AbortSignal, context?: ToolExecutionContext) => {
        if (!context || context.sessionId !== lease.sessionId) {
          throw new KernelError('TOOL_OUTCOME_UNKNOWN', 'Missing trusted Kernel tool context');
        }
        return this.invoke({
          lease, turnId: context.turnId, callId: context.callId, name, input,
        }, signal);
      },
    });
    create('read.echo');
    create('read.sleep');
    return registry;
  }

  /** Idempotent. Host death never implies pending calls were not started. */
  close(): void {
    if (this.ended) return;
    this.failAll();
    this.child.kill('SIGKILL');
  }
}
