import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AgentKernel } from '../packages/kernel-core/src/index.js';
import { SQLiteEventStore } from '../packages/event-store-sqlite/src/index.js';
import { FakeProvider } from '../packages/model-providers/src/fake.js';
import { ToolRegistry } from '../packages/tool-scheduler/src/index.js';
import type { ModelProvider, ProviderEvent, ToolCall } from '../packages/contracts/src/index.js';

const finalMessage = (text = 'ok'): ProviderEvent => ({
  type: 'message_complete',
  message: { role: 'assistant', text, toolCalls: [] },
  finishReason: 'stop',
});
const call: ToolCall = { id: 'c1', name: 'read', arguments: { path: 'safe' } };

async function stagedUnknown(db: SQLiteEventStore, id = 'pending') {
  await db.append(id, 0, [{ type: 'session.created', data: {} }]);
  await db.append(id, 1, [
    { type: 'turn.queued', turnId: 't1', data: {} },
    { type: 'user.message', turnId: 't1', data: { text: 'read' } },
    { type: 'turn.started', turnId: 't1', data: {} },
    { type: 'assistant.message', turnId: 't1',
      data: { role: 'assistant', text: '', toolCalls: [call] } },
  ]);
  await db.recordToolIntent(id, 5, 't1', call, '1', { path: 'safe' });
  // A cancellation after intent admission can write a synthetic tool.result.
  // A paired message is NOT evidence that the external call was settled.
  await db.append(id, 6, [
    { type: 'tool.result', turnId: 't1',
      data: { callId: 'c1', name: 'read', outcome: 'outcome_unknown', content: 'CANCELLED_AFTER_INTENT' } },
    { type: 'turn.cancelled', turnId: 't1', data: { errorCode: 'CANCELLED' } },
  ]);
}

function withDb(fn: (db: SQLiteEventStore, path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'm2-resume-'));
  const path = join(dir, 'session.db');
  const db = new SQLiteEventStore(path);
  return fn(db, path).finally(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
}

function recovering(db: SQLiteEventStore): AgentKernel {
  const provider: ModelProvider = {
    id: 'must-not-call',
    async *stream() { throw new Error('Recovery must not execute Provider'); yield finalMessage(); },
  };
  return new AgentKernel(db, provider, new ToolRegistry());
}

test('M2 recovery: paired synthetic ToolResult cannot hide a pending execution intent', async () => {
  await withDb(async db => {
    await stagedUnknown(db);
    const before = await db.read('pending');
    const kernel = recovering(db);
    await assert.rejects(kernel.resumeSession('pending'), { code: 'SESSION_RECOVERY_REQUIRED' });
    assert.deepEqual(await db.read('pending'), before);
    assert.equal((await db.listToolIntents('pending'))[0]?.status, 'pending');
  });
});

test('M2 recovery: explicit outcome_unknown reconciliation still forbids automatic resumption', async () => {
  await withDb(async db => {
    await stagedUnknown(db);
    const lastSeq = (await db.read('pending')).length;
    assert.equal(await db.markUnconfirmedToolsUnknown('pending', lastSeq), lastSeq + 1);
    assert.equal((await db.listToolIntents('pending'))[0]?.status, 'outcome_unknown');
    // Reconciliation may be journalled AFTER turn.cancelled; it must be
    // recognizable as a post-terminal fact rather than silently discarded.
    await assert.rejects(recovering(db).resumeSession('pending'), { code: 'SESSION_RECOVERY_REQUIRED' });
    assert.equal((await db.read('pending')).filter(e => e.type === 'tool.local_receipt').length, 0);
  });
});

test('M2 recovery: recorded receipt reporting an UNKNOWN outcome is not a success', async () => {
  await withDb(async db => {
    const id = 'acknowledged-unknown';
    await db.append(id, 0, [{ type: 'session.created', data: {} }]);
    await db.append(id, 1, [
      { type: 'turn.queued', turnId: 't1', data: {} },
      { type: 'user.message', turnId: 't1', data: { text: 'read' } },
      { type: 'turn.started', turnId: 't1', data: {} },
      { type: 'assistant.message', turnId: 't1',
        data: { role: 'assistant', text: '', toolCalls: [call] } },
    ]);
    await db.recordToolIntent(id, 5, 't1', call, '1', { path: 'safe' });
    await db.recordLocalReceipt(id, 6, 't1', {
      callId: 'c1', name: 'read', outcome: 'outcome_unknown', content: 'HOST_OUTCOME_NOT_CONFIRMED',
    });
    await db.append(id, 7, [
      { type: 'tool.result', turnId: 't1',
        data: { callId: 'c1', name: 'read', outcome: 'outcome_unknown', content: 'HOST_OUTCOME_NOT_CONFIRMED' } },
      { type: 'turn.cancelled', turnId: 't1', data: { errorCode: 'CANCELLED' } },
    ]);
    const intent = (await db.listToolIntents(id))[0];
    assert.equal(intent?.status, 'outcome_unknown');
    assert.ok(intent?.receiptId);
    await assert.rejects(recovering(db).resumeSession(id), { code: 'SESSION_RECOVERY_REQUIRED' });
  });
});

test('M2 recovery: complete tool receipt allows safe reattachment and a new turn', async () => {
  await withDb(async db => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read', version: '1', risk: 'read', concurrency: 'exclusive',
      parse: input => input, execute: async () => 'file data',
    });
    const toolMessage: ProviderEvent = {
      type: 'message_complete',
      message: { role: 'assistant', text: '', toolCalls: [call] },
      finishReason: 'tool_use',
    };
    const k = new AgentKernel(db, new FakeProvider([[toolMessage], [finalMessage('done')]]), registry);
    const s = await k.createSession('settled');
    assert.equal((await k.runTurn(s, 'read', 't1')).status, 'completed');
    const receipts = (await db.read(s)).filter(e => e.type === 'tool.local_receipt');
    assert.equal(receipts.length, 1);
    const resumed = new AgentKernel(db, new FakeProvider([[finalMessage('next')]]), registry);
    assert.equal(await resumed.resumeSession(s), s);
    assert.equal((await resumed.runTurn(s, 'next request', 't2')).status, 'completed');
  });
});

test('M2 recovery: tampered receipt journal cannot override the SQLite intent record', async () => {
  await withDb(async (db, path) => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read', version: '1', risk: 'read', concurrency: 'exclusive',
      parse: input => input, execute: async () => 'ok',
    });
    const toolMessage: ProviderEvent = {
      type: 'message_complete',
      message: { role: 'assistant', text: '', toolCalls: [call] },
      finishReason: 'tool_use',
    };
    const k = new AgentKernel(db, new FakeProvider([[toolMessage], [finalMessage()]]), registry);
    const session = await k.createSession('tamper');
    assert.equal((await k.runTurn(session, 'read', 't1')).status, 'completed');
    const raw = new DatabaseSync(path);
    try {
      raw.prepare("UPDATE events SET data_json=? WHERE session_id=? AND type='tool.local_receipt'")
        .run(JSON.stringify({ callId: 'c1', receiptId: 'forged', outcome: 'succeeded' }), session);
    } finally { raw.close(); }
    await assert.rejects(recovering(db).resumeSession(session), { code: 'CORRUPT_SESSION_JOURNAL' });
  });
});
