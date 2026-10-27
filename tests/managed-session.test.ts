import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { ContextMessage, ModelProvider, ProviderEvent } from '../packages/contracts/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ManagedSessionRunner } from '../packages/session-runtime/src/index.js';
import { SqliteWriterLeaseStore, type WriterLease } from '../packages/session-leases-sqlite/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'managed-session-'));
  return { path: join(dir, 'journal.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const finish = (text: string): ProviderEvent => ({
  type: 'message_complete',
  message: { role: 'assistant', text, toolCalls: [] },
  finishReason: 'stop',
});

test('M1 managed runner: acquire, heartbeat, complete and release across sequential turns', async () => {
  const tmp = tempDb();
  try {
    const provider: ModelProvider = {
      id: 'slow-model',
      async *stream(_messages: readonly ContextMessage[], signal: AbortSignal) {
        await delay(330);
        if (signal.aborted) throw signal.reason;
        yield finish('finished');
      },
    };
    const runner = new ManagedSessionRunner(tmp.path, provider, new ToolRegistry(), {
      ttlMs: 180, renewEveryMs: 25,
    });
    assert.equal(await runner.createSession('managed'), 'managed');
    const first = await runner.runTurn('managed', 'first', 't1');
    assert.equal(first.status, 'completed');
    const second = await runner.runTurn('managed', 'second', 't2');
    assert.equal(second.status, 'completed');
    const events = await runner.readEvents('managed');
    assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1));
    assert.equal(events.filter(e => e.type === 'turn.completed').length, 2);

    // Completed operations release their claims. The next owner gets a new token.
    const leaseStore = new SqliteWriterLeaseStore(tmp.path);
    try {
      const next = leaseStore.acquire('managed', 'external', 5000);
      assert.ok(next);
      assert.ok(next.fenceToken >= 4); // create, run1, run2, read, external
    } finally {
      leaseStore.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('M1 managed runner: rival cannot start while first owner has a live turn', async () => {
  const tmp = tempDb();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { started = r; });
  try {
    const writer: ModelProvider = {
      id: 'blocked',
      async *stream() { started(); await gate; yield finish('ok'); },
    };
    const first = new ManagedSessionRunner(tmp.path, writer, new ToolRegistry(), {
      ttlMs: 3000, renewEveryMs: 50,
    });
    const rival = new ManagedSessionRunner(tmp.path, new FakeProvider([[finish('rival')]]), new ToolRegistry());
    await first.createSession('contended');
    const pending = first.runTurn('contended', 'one', 'first');
    await entered;
    await assert.rejects(rival.runTurn('contended', 'two', 'second'), { code: 'SESSION_BUSY' });
    release();
    assert.equal((await pending).status, 'completed');
    assert.equal((await rival.runTurn('contended', 'after release', 'second')).status, 'completed');
  } finally {
    release?.();
    tmp.cleanup();
  }
});

test('M1 managed runner: stolen claim aborts turn, refuses stale terminal and forbids auto replay', async () => {
  const tmp = tempDb();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { started = r; });
  let toolCalls = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: 'read', version: '1', risk: 'read', concurrency: 'parallel', parse: x => x,
    execute: async () => { toolCalls++; return 'unexpected'; },
  });
  try {
    const provider: ModelProvider = {
      id: 'pending',
      async *stream() {
        started();
        await gate; // intentionally ignores AbortSignal to exercise boundary guards
        yield {
          type: 'message_complete',
          message: {
            role: 'assistant', text: 'execute', toolCalls: [{ id: 'call1', name: 'read', arguments: {} }],
          },
          finishReason: 'tool_use',
        };
      },
    };
    const runner = new ManagedSessionRunner(tmp.path, provider, tools, {
      ttlMs: 400, renewEveryMs: 20,
    });
    await runner.createSession('taken');
    const ongoing = runner.runTurn('taken', 'run', 'lost');
    await entered;

    // Emulate a coordinator revoking ownership, then awarding a new fence.
    const db = new DatabaseSync(tmp.path);
    let old: WriterLease;
    try {
      const row = db.prepare('SELECT owner_id, fence_token, expires_at_ms FROM session_writer_leases WHERE session_id = ?')
        .get('taken');
      assert.ok(row);
      old = {
        sessionId: 'taken', ownerId: row.owner_id as string,
        fenceToken: row.fence_token as number, expiresAtMs: row.expires_at_ms as number,
      };
    } finally {
      db.close();
    }
    const control = new SqliteWriterLeaseStore(tmp.path);
    try {
      assert.equal(control.release(old), true);
      const successor = control.acquire('taken', 'new-owner', 5000);
      assert.ok(successor);
      assert.equal(successor.fenceToken, old.fenceToken + 1);
      await delay(100); // heartbeat detects loss and aborts the waiting provider
      release();
      await assert.rejects(ongoing, { code: 'LEASE_LOST' });
      assert.equal(toolCalls, 0);
      const journal = new SqliteEventStore(tmp.path, successor);
      try {
        const events = await journal.read('taken');
        assert.equal(events.filter(e => e.type === 'turn.completed').length, 0);
        assert.equal(events.filter(e => e.type === 'turn.cancelled').length, 0);
        assert.equal(events.filter(e => e.type === 'turn.started').length, 1);
      } finally {
        journal.close();
      }
      assert.equal(control.release(successor), true);
      await assert.rejects(runner.runTurn('taken', 'blind replay'), { code: 'RECOVERY_REQUIRED' });
    } finally {
      control.close();
    }
  } finally {
    release?.();
    tmp.cleanup();
  }
});

test('M1 managed runner: missing session never implicitly creates a journal', async () => {
  const tmp = tempDb();
  try {
    const runner = new ManagedSessionRunner(tmp.path, new FakeProvider([]), new ToolRegistry());
    await assert.rejects(runner.runTurn('missing', 'hello'), { code: 'UNKNOWN_SESSION' });
    const journal = new SqliteEventStore(tmp.path);
    try { assert.deepEqual(await journal.read('missing'), []); }
    finally { journal.close(); }
    await assert.rejects(runner.createSession(''), { code: 'INVALID_SESSION' });
    assert.throws(() => new ManagedSessionRunner(tmp.path, new FakeProvider([]), new ToolRegistry(),
      { ttlMs: 10 }), { code: 'INVALID_MANAGED_LEASE_OPTIONS' });
  } finally {
    tmp.cleanup();
  }
});

test('M1 scheduler: a lease guard is checked again after an exclusive barrier', async () => {
  const { executeBatch } = await import('../packages/tool-scheduler/src/index.js');
  const registry = new ToolRegistry();
  let calls = 0, owned = true;
  registry.register({
    name: 'barrier', version: '1', risk: 'read', concurrency: 'exclusive', parse: x => x,
    execute: async () => { calls++; owned = false; return 'ok'; },
  });
  registry.register({
    name: 'second', version: '1', risk: 'read', concurrency: 'parallel', parse: x => x,
    execute: async () => { calls++; return 'should-not-run'; },
  });
  await assert.rejects(executeBatch([
    { id: '1', name: 'barrier', arguments: {} },
    { id: '2', name: 'second', arguments: {} },
  ], registry, new AbortController().signal, () => {
    if (!owned) throw new Error('LEASE_LOST');
  }), /LEASE_LOST/);
  assert.equal(calls, 1);
});


test('M1 scheduler: lease failure drains already running parallel reads before returning', async () => {
  const { executeBatch } = await import('../packages/tool-scheduler/src/index.js');
  const registry = new ToolRegistry();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, guardChecks = 0, finished = false;
  registry.register({
    name: 'first', version: '1', risk: 'read', concurrency: 'parallel', parse: x => x,
    execute: async () => {
      active++;
      entered();
      await gate;
      active--;
      return 'complete';
    },
  });
  registry.register({
    name: 'second', version: '1', risk: 'read', concurrency: 'parallel', parse: x => x,
    execute: async () => { throw new Error('second should never start'); },
  });
  const running = executeBatch([
    { id: 'a', name: 'first', arguments: {} },
    { id: 'b', name: 'second', arguments: {} },
  ], registry, new AbortController().signal, () => {
    if (++guardChecks === 2) throw new Error('LEASE_LOST');
  }).finally(() => { finished = true; });
  try {
    await started;
    await delay(20);
    assert.equal(finished, false);
    assert.equal(active, 1);
  } finally {
    release();
  }
  await assert.rejects(running, /LEASE_LOST/);
  assert.equal(active, 0);
});
