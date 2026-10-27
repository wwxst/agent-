import { setTimeout as sleep } from 'node:timers/promises';
import { KernelError } from '../../contracts/src/index.js';
import { HostExecutionLedger, type HostCall } from './ledger.js';

/**
 * Child-process-only entrypoint. No arbitrary JS, filesystem, shell, web, or
 * model-provided code is executed. The whitelist is revalidated IN the Host.
 * This process is NOT an OS sandbox (it shares the user's OS privileges).
 */
if (!process.send || !process.argv[2]) {
  throw new Error('Tool Host worker must be forked with an IPC channel and database path');
}
// Parent may be creating session/lease tables at the same time this worker
// starts. Retry *only* SQLite busy initialization rather than silently
// exiting and losing the IPC request. Calls are queued until READY.
let ledger: HostExecutionLedger | undefined;
for (let attempt = 0; attempt < 16; attempt++) {
  try {
    ledger = new HostExecutionLedger(process.argv[2]);
    break;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (!code.startsWith('SQLITE_BUSY') || attempt === 15) throw error;
    await sleep(40);
  }
}
const readyLedger = ledger;
if (!readyLedger) throw new Error('Unable to initialize Host execution ledger');

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

function parseCall(msg: unknown): { id: string; call: HostCall } {
  if (!isRecord(msg) || msg.type !== 'run' || typeof msg.id !== 'string'
    || msg.id.length < 1 || msg.id.length > 128 || !isRecord(msg.call)) {
    throw new KernelError('HOST_INVALID_REQUEST', 'Invalid IPC envelope');
  }
  const p = msg.call;
  if (!isRecord(p.lease) || typeof p.lease.sessionId !== 'string'
    || typeof p.lease.ownerId !== 'string' || typeof p.lease.fenceToken !== 'number'
    || !Number.isSafeInteger(p.lease.fenceToken) || p.lease.fenceToken < 1
    || typeof p.turnId !== 'string' || typeof p.callId !== 'string'
    || typeof p.name !== 'string') {
    throw new KernelError('HOST_INVALID_REQUEST', 'Invalid execution call');
  }
  const call: HostCall = {
    lease: {
      sessionId: p.lease.sessionId,
      ownerId: p.lease.ownerId,
      fenceToken: p.lease.fenceToken,
      expiresAtMs: 0, // ignored by Host: expiry is always checked in SQLite
    },
    turnId: p.turnId,
    callId: p.callId,
    name: p.name,
    input: p.input,
  };
  return { id: msg.id, call };
}

function validatedInput(call: HostCall): { text: string } | { ms: number } {
  if (!isRecord(call.input)) throw new KernelError('HOST_INVALID_ARGUMENTS', 'Expected JSON object');
  if (call.name === 'read.echo') {
    if (typeof call.input.text !== 'string' || call.input.text.length > 1024) {
      throw new KernelError('HOST_INVALID_ARGUMENTS', 'read.echo requires text <= 1024 characters');
    }
    return { text: call.input.text };
  }
  if (call.name === 'read.sleep') {
    if (!Number.isSafeInteger(call.input.ms) || (call.input.ms as number) < 0
      || (call.input.ms as number) > 1500) {
      throw new KernelError('HOST_INVALID_ARGUMENTS', 'read.sleep requires 0..1500ms');
    }
    return { ms: call.input.ms as number };
  }
  // Ignore any risk or policy label provided by a client/model.
  throw new KernelError('HOST_TOOL_DENIED', 'Tool not on the Host read-only whitelist');
}

async function execute(call: HostCall): Promise<string> {
  const input = validatedInput(call);
  readyLedger.begin(call);
  let content: string;
  try {
    if ('text' in input) content = input.text;
    else {
      await sleep(input.ms);
      content = `slept:${input.ms}`;
    }
  } catch {
    // A STARTED execution can fail. Its receipt still requires a live lease.
    readyLedger.finish(call, 'failed', 'HOST_EXECUTION_FAILED');
    throw new KernelError('HOST_EXECUTION_FAILED', 'Read-only execution failed');
  }
  // A stale worker cannot finalize even if the tool body already ran.
  readyLedger.finish(call, 'succeeded', content);
  return content;
}

process.on('message', (raw: unknown) => {
  const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : null;
  void (async () => {
    try {
      // Disallow unreasonable IPC envelopes before costly ledger operations.
      if (JSON.stringify(raw).length > 32768) {
        throw new KernelError('HOST_INVALID_REQUEST', 'IPC payload too large');
      }
      const request = parseCall(raw);
      const content = await execute(request.call);
      process.send?.({ id: request.id, ok: true, content });
    } catch (error) {
      const code = error instanceof KernelError ? error.code : 'HOST_EXECUTION_FAILED';
      // Avoid returning SQLite/stack/credentials across IPC.
      process.send?.({ id, ok: false, code });
    }
  })();
});
process.on('disconnect', () => {
  // A disconnect during a request leaves a durable STARTED row; never replay it.
  readyLedger.close();
  process.exit(0);
});
process.send?.({ type: 'ready' });
