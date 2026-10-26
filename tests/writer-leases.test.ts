import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { SqliteWriterLeaseStore } from '../packages/session-leases-sqlite/src/index.js';
import { SqliteEventStore } from '../packages/event-store-sqlite/src/index.js';

function temporaryDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-lease-'));
  return { path: join(dir, 'journal.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('M1 lease: exactly one live writer across independent SQLite connections', () => {
  const tmp = temporaryDb();
  const a = new SqliteWriterLeaseStore(tmp.path);
  const b = new SqliteWriterLeaseStore(tmp.path);
  try {
    const first = a.acquire('s1', 'writer-A', 5000);
    assert.ok(first);
    assert.equal(first.fenceToken, 1);
    assert.equal(b.acquire('s1', 'writer-B', 5000), null);
    assert.equal(b.acquire('s1', 'writer-A', 5000), null); // same name cannot bypass held claim
    assert.doesNotThrow(() => b.assertOwned(first));
    const otherSession = b.acquire('s2', 'writer-B', 5000);
    assert.ok(otherSession);
    assert.equal(otherSession.fenceToken, 1);
    assert.equal(a.release(first), true);
    assert.equal(a.release(first), false);
    const successor = b.acquire('s1', 'writer-B', 5000);
    assert.ok(successor);
    assert.equal(successor.fenceToken, 2);
    assert.throws(() => a.assertOwned(first), { code: 'LEASE_LOST' });
    assert.equal(a.release(first), false);
    assert.doesNotThrow(() => b.assertOwned(successor));
  } finally {
    b.close();
    a.close();
    tmp.cleanup();
  }
});

test('M1 lease: an expired owner cannot renew, release or regain its old fencing token', async () => {
  const tmp = temporaryDb();
  const a = new SqliteWriterLeaseStore(tmp.path);
  const b = new SqliteWriterLeaseStore(tmp.path);
  try {
    const first = a.acquire('expired', 'worker-A', 70);
    assert.ok(first);
    await delay(220);
    assert.throws(() => a.renew(first, 5000), { code: 'LEASE_LOST' });
    const successor = b.acquire('expired', 'worker-B', 5000);
    assert.ok(successor);
    assert.equal(successor.fenceToken, first.fenceToken + 1);
    assert.throws(() => a.assertOwned(first), { code: 'LEASE_LOST' });
    assert.equal(a.release(first), false);
    assert.throws(() => a.renew(first, 5000), { code: 'LEASE_LOST' });
    assert.doesNotThrow(() => b.assertOwned(successor));
    const refreshed = b.renew(successor, 5000);
    assert.equal(refreshed.fenceToken, successor.fenceToken);
    assert.ok(refreshed.expiresAtMs >= successor.expiresAtMs);
  } finally {
    b.close();
    a.close();
    tmp.cleanup();
  }
});

test('M1 lease: tokens survive connection close/reopen and explicit release', () => {
  const tmp = temporaryDb();
  const a = new SqliteWriterLeaseStore(tmp.path);
  try {
    const first = a.acquire('persisted', 'writer-A', 5000);
    assert.ok(first);
    a.close();
    const b = new SqliteWriterLeaseStore(tmp.path);
    try {
      assert.equal(b.acquire('persisted', 'writer-B', 5000), null);
      assert.equal(b.release(first), true);
      const next = b.acquire('persisted', 'writer-A', 5000);
      assert.ok(next);
      assert.equal(next.fenceToken, 2);
      assert.equal(b.release(first), false);
      assert.equal(b.release(next), true);
      const third = b.acquire('persisted', 'writer-A', 5000);
      assert.ok(third);
      assert.equal(third.fenceToken, 3);
    } finally {
      b.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('M1 lease: invalid claims fail before database mutation', () => {
  const tmp = temporaryDb();
  const store = new SqliteWriterLeaseStore(tmp.path);
  try {
    assert.throws(() => store.acquire('', 'o', 10), { code: 'INVALID_LEASE_ID' });
    assert.throws(() => store.acquire('s', '', 10), { code: 'INVALID_LEASE_ID' });
    assert.throws(() => store.acquire('s', 'o', 0), { code: 'INVALID_LEASE_TTL' });
    assert.throws(() => store.acquire('s', 'o', NaN), { code: 'INVALID_LEASE_TTL' });
    assert.throws(() => store.acquire('s', 'o', 86400001), { code: 'INVALID_LEASE_TTL' });
    const lease = store.acquire('s', 'o', 5000);
    assert.ok(lease);
    assert.equal(lease.fenceToken, 1);
    assert.throws(() => store.renew(lease, -1), { code: 'INVALID_LEASE_TTL' });
    assert.doesNotThrow(() => store.assertOwned(lease));
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('M1 lease: SIGKILL leaves an expiring claim, then a higher fence is issued', async () => {
  const tmp = temporaryDb();
  try {
    const moduleUrl = new URL('../packages/session-leases-sqlite/src/index.js', import.meta.url).href;
    const child = `
      const { SqliteWriterLeaseStore } = await import(process.argv[1]);
      const store = new SqliteWriterLeaseStore(process.argv[2]);
      const claim = store.acquire('crash-lease', 'dead-worker', 180);
      if (!claim || claim.fenceToken !== 1) process.exit(2);
      process.kill(process.pid, 'SIGKILL');
    `;
    const outcome = spawnSync(process.execPath, ['--input-type=module', '-e', child, moduleUrl, tmp.path], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(outcome.error, undefined, outcome.stderr);
    assert.equal(outcome.signal, 'SIGKILL', `Child did not SIGKILL: ${outcome.stderr}`);
    const recovered = new SqliteWriterLeaseStore(tmp.path);
    try {
      assert.equal(recovered.acquire('crash-lease', 'successor', 5000), null);
      await delay(300);
      const successor = recovered.acquire('crash-lease', 'successor', 5000);
      assert.ok(successor);
      assert.equal(successor.fenceToken, 2);
      assert.doesNotThrow(() => recovered.assertOwned(successor));
    } finally {
      recovered.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('M1 lease: lease metadata and journal events share the file but not yet an execution fence', async () => {
  const tmp = temporaryDb();
  const store = new SqliteEventStore(tmp.path);
  const leases = new SqliteWriterLeaseStore(tmp.path);
  try {
    const lease = leases.acquire('s', 'A', 5000);
    assert.ok(lease);
    const ev = await store.append('s', 0, [{ type: 'session.created', data: {} }]);
    assert.equal(ev.length, 1);
    assert.equal((await store.read('s'))[0]?.seq, 1);
    // Deliberate contract check: bare EventStore.append is not fenced yet.
    assert.equal(leases.release(lease), true);
    assert.equal((await store.read('s')).length, 1);
  } finally {
    leases.close();
    store.close();
    tmp.cleanup();
  }
});
