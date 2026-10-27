import { randomUUID } from 'node:crypto';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readlinkSync } from 'node:fs';
import { buildBubblewrapLaunch, type LinuxBubblewrapSandbox } from './sandbox.js';
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
  private readonly sandboxed:boolean;
  private readonly ready: Promise<void>;
  private signalReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;

  /** A terminated worker leaves STARTED calls requiring reconciliation. */
  constructor(databasePath: string, private readonly timeoutMs = 4000,
    sandbox?: LinuxBubblewrapSandbox) {
    this.sandboxed=sandbox!==undefined;
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
    if(sandbox){
      // A strict namespace launch must be prepared BEFORE any worker can run.
      // No bwrap binary, bad mount allowlist or unsupported Linux => no fallback.
      const compiledRoot=fileURLToPath(new URL('../../../',import.meta.url));
      const launch=buildBubblewrapLaunch(sandbox,databasePath,compiledRoot,fileURLToPath(worker));
      this.child=spawn(launch.executable,[...launch.argv],{
        env:{},stdio:['pipe','pipe','ignore'],
      });
      this.child.stdout?.setEncoding('utf8');
    }else{
      this.child=fork(worker,[databasePath],{
        execArgv:[],
        env:{}, // Never forward credentials, NODE_OPTIONS or tool input as env.
        stdio:['ignore','ignore','ignore','ipc'],serialization:'json',
      });
    }
    const onMessage=(raw:unknown):void => {
      if (raw && typeof raw === 'object' && (raw as {type?: unknown}).type === 'ready') {
        if(this.sandboxed){
          const entry=(raw as {namespaces?:unknown}).namespaces;
          if(!entry || typeof entry!=='object' || Array.isArray(entry)){
            this.close();return;
          }
          const namespaces=entry as Record<string,unknown>;
          try{
            for(const [key,linuxName] of Object.entries({
              mount:'mnt',network:'net',pid:'pid',user:'user',
            })){
              const remote=namespaces[key],local=readlinkSync('/proc/self/ns/'+linuxName);
              if(typeof remote!=='string'||!/^\w+:\[\d+\]$/.test(remote)||remote===local){
                this.close();return;
              }
            }
          }catch{this.close();return;}
        }
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
    };
    if(sandbox){
      let buffered='';
      this.child.stdout?.on('data',(part:string)=>{
        buffered+=part;
        if(Buffer.byteLength(buffered,'utf8')>65536){this.close();return;}
        let boundary:number;
        while((boundary=buffered.indexOf('\n'))>=0){
          const line=buffered.slice(0,boundary);buffered=buffered.slice(boundary+1);
          if(Buffer.byteLength(line,'utf8')>32768){this.close();return;}
          try{onMessage(JSON.parse(line) as unknown);}
          catch{this.close();return;}
        }
      });
      this.child.stdin?.on('error',()=>this.failAll());
    }else{
      this.child.on('message',onMessage);
    }
    this.child.on('error', () => this.failAll());
    this.child.on('exit', () => this.failAll());
  }

  get pid(): number | undefined { return this.child.pid; }

  private failAll(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new KernelError(this.sandboxed?'HOST_SANDBOX_UNAVAILABLE':'TOOL_OUTCOME_UNKNOWN',
        'Host failed before becoming ready'));
    }
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(new KernelError('TOOL_OUTCOME_UNKNOWN', 'Host process exited before reply'));
    }
    this.pending.clear();
  }

  async invoke(call: HostCall, signal: AbortSignal): Promise<string> {
    await this.ready;
    if (this.ended || (this.sandboxed?!this.child.stdin?.writable:!this.child.connected)) {
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
      if(this.sandboxed){
        const wire=JSON.stringify(payload)+'\n';
        if(Buffer.byteLength(wire,'utf8')>32768){this.close();return;}
        this.child.stdin?.write(wire,(error)=>{if(error)this.close();});
      }else{
        this.child.send(payload,error=>{if(error)this.close();});
      }
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
      description: name === 'read.echo' ? 'Return the provided text without external effects'
        : 'Wait for a bounded delay without external effects',
      inputSchema: name === 'read.echo'
        ? {type:'object',properties:{text:{type:'string',maxLength:1024}},required:['text'],additionalProperties:false}
        : {type:'object',properties:{ms:{type:'integer',minimum:0,maximum:1500}},required:['ms'],additionalProperties:false},
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
