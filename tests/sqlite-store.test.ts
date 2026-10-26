import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConflictError } from '../packages/contracts/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';

const complete = (text: string) => ({
  type: 'message_complete' as const,
  message: { role: 'assistant' as const, text, toolCalls: [] },
  finishReason: 'stop' as const,
});

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-kernel-sqlite-'));
  return { path: join(dir, 'journal.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('M1 SQLite: committed sessions survive close/reopen and continue at the next sequence', async () => {
  const tmp = tempDb();
  let store: SqliteEventStore | undefined;
  try {
    store = new SqliteEventStore(tmp.path);
    const first = new AgentKernel(store, new FakeProvider([[complete('first')]]), new ToolRegistry());
    const id = await first.createSession('durable');
    assert.equal((await first.runTurn(id, 'hello', 'turn-1')).status, 'completed');
    const oldEvents = await store.read(id);
    store.close();
    store = undefined;

    const next = new SqliteEventStore(tmp.path);
    store = next;
    const provider = new FakeProvider([[complete('second')]]);
    const reopened = new AgentKernel(next, provider, new ToolRegistry());
    assert.equal(await reopened.openSession(id), id);
    assert.equal((await reopened.runTurn(id, 'again', 'turn-2')).status, 'completed');
    const all = await next.read(id);
    assert.deepEqual(all.slice(0, oldEvents.length), oldEvents);
    assert.deepEqual(all.map(x => x.seq), all.map((_, i) => i + 1));
    assert.deepEqual(provider.requests[0]?.map(x => x.role), ['user', 'assistant', 'user']);
    assert.equal(all.filter(x => x.type === 'session.created').length, 1);
  } finally {
    store?.close();
    tmp.cleanup();
  }
});

test('M1 SQLite: competing connections enforce CAS and protect independent sessions', async () => {
  const tmp = tempDb();
  const first = new SqliteEventStore(tmp.path);
  const second = new SqliteEventStore(tmp.path);
  try {
    const a = await first.append('a', 0, [{ type: 'session.created', data: {} }]);
    assert.equal(a[0]?.seq, 1);
    await assert.rejects(second.append('a', 0, [{ type: 'session.created', data: {} }]), ConflictError);
    await second.append('b', 0, [{ type: 'session.created', data: {} }]);
    assert.equal((await second.read('a')).length, 1);
    assert.equal((await first.read('b')).length, 1);
    assert.deepEqual(await second.read('a', 1), []);
    await assert.rejects(second.read('a', -1), { code: 'INVALID_CURSOR' });
  } finally {
    second.close();
    first.close();
    tmp.cleanup();
  }
});

test('M1 SQLite: failure mid-batch rolls back all earlier inserts', async () => {
  const tmp = tempDb();
  const store = new SqliteEventStore(tmp.path);
  try {
    await assert.rejects(store.append('rollback', 0, [
      { type: 'session.created', data: { durable: true } },
      { type: 'turn.queued', turnId: 'broken', data: { unsupported: 1n } },
    ]));
    assert.deepEqual(await store.read('rollback'), []);
    const events = await store.append('rollback', 0, [{ type: 'session.created', data: {} }]);
    assert.equal(events[0]?.seq, 1);
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('M1 SQLite: committed WAL data survives abrupt process termination', async () => {
  const tmp = tempDb();
  try {
    const moduleUrl = new URL('../packages/event-store-sqlite/src/index.js', import.meta.url).href;
    const child = `
      const { SqliteEventStore } = await import(process.argv[1]);
      const store = new SqliteEventStore(process.argv[2]);
      await store.append('crashed-process', 0, [{ type: 'session.created', data: { marker: 1 } }]);
      process.kill(process.pid, 'SIGKILL');
    `;
    const outcome = spawnSync(process.execPath, ['--input-type=module', '-e', child, moduleUrl, tmp.path], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(outcome.error, undefined, outcome.stderr);
    assert.equal(outcome.signal, 'SIGKILL', `Child did not terminate as expected: ${outcome.stderr}`);
    const reopened = new SqliteEventStore(tmp.path);
    try {
      const found = await reopened.read('crashed-process');
      assert.equal(found.length, 1);
      assert.deepEqual(found[0]?.data, { marker: 1 });
      assert.equal(found[0]?.seq, 1);
    } finally {
      reopened.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('M1 SQLite: reopening an incomplete journal fails closed after process restart', async () => {
  const tmp = tempDb();
  let store = new SqliteEventStore(tmp.path);
  try {
    await store.append('unsafe-to-resume', 0, [
      { type: 'session.created', data: {} },
      { type: 'turn.queued', turnId: 'unsettled', data: {} },
      { type: 'user.message', turnId: 'unsettled', data: { text: 'hello' } },
    ]);
    store.close();
    store = new SqliteEventStore(tmp.path);
    const kernel = new AgentKernel(store, new FakeProvider([]), new ToolRegistry());
    await assert.rejects(kernel.openSession('unsafe-to-resume'), { code: 'RECOVERY_REQUIRED' });
    assert.equal((await store.read('unsafe-to-resume')).length, 3);
  } finally {
    store.close();
    tmp.cleanup();
  }
});
