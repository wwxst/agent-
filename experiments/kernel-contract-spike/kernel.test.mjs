import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { MemoryJournal, ExperimentalKernel, projectToolResults, unsafeParallel } from './kernel.mjs';
const call = id => ({ id, name: 'read', args: {} });
const msg = (...calls) => ({ finishReason: calls.length ? 'tool_use' : 'stop', toolCalls: calls });
const kernel = (journal, execute, authorize) => new ExperimentalKernel({ journal, host: { execute }, authorize });

test('T01: completed assistant message before tool execution', async () => {
  const journal = new MemoryJournal();
  const result = await kernel(journal, async () => 42).run(msg(call('A')));
  assert.equal(result.status, 'completed');
  assert.deepEqual(journal.events.map(x => x.type), ['assistant.message','tool.intent','tool.result']);
  assert.equal(result.results[0].data, 42);
});

test('T02: reverse completion writes facts immediately but projects original call order', async () => {
  const journal = new MemoryJournal();
  const result = await kernel(journal, async c => { await sleep(c.id === 'A' ? 45 : 5); return c.id; }).run(msg(call('A'),call('B')));
  assert.equal(result.status, 'completed');
  assert.deepEqual(journal.events.filter(e => e.type === 'tool.result').map(e => e.id), ['B','A']);
  assert.deepEqual(result.results.map(e => e.id), ['A','B']);
  assert.deepEqual(projectToolResults(journal.replay(), ['A','B']).map(e => e.id), ['A','B']);
});

test('T03: entire intent transaction fails => zero host side effects', async () => {
  const journal = new MemoryJournal({ reject: drafts => drafts.some(e => e.type === 'tool.intent') });
  const result = await kernel(journal, async () => assert.fail('host must never start')).run(msg(call('A'),call('B')));
  assert.equal(result.status, 'failed'); assert.equal(result.started, 0); assert.equal(journal.events.length, 0);
});

test('T04: truncated response => no intents, no side effects', async () => {
  const journal = new MemoryJournal();
  const result = await kernel(journal, async () => assert.fail('host must never start')).run({finishReason:'length',toolCalls:[call('A')]});
  assert.equal(result.error, 'TRUNCATED_MODEL_OUTPUT'); assert.equal(journal.events.length, 0);
});

test('T05: duplicate IDs => fail closed before any host call', async () => {
  const journal = new MemoryJournal();
  const result = await kernel(journal, async () => assert.fail('host must never start')).run(msg(call('A'),call('A')));
  assert.equal(result.error, 'DUPLICATE_OR_INVALID_TOOL_CALL_ID'); assert.equal(journal.events.length, 0);
});

test('T06: denied tool never starts; results still pair with the call IDs', async () => {
  const journal = new MemoryJournal();
  const result = await kernel(journal, async () => assert.fail('denied host must never start'), () => false).run(msg(call('A')));
  assert.equal(result.started, 0); assert.equal(result.results[0].outcome, 'denied');
});

test('T07: receipt write failure drains a slower sibling, reports reconciliation', async () => {
  let siblingFinished = false;
  const journal = new MemoryJournal({reject: drafts => drafts.some(e => e.type === 'tool.result' && e.id === 'B')});
  const result = await kernel(journal, async c => {
    if (c.id === 'A') { await sleep(45); siblingFinished = true; return 'A-done'; }
    await sleep(5); return 'B-done';
  }).run(msg(call('A'),call('B')));
  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.started, 2); assert.equal(siblingFinished, true);
  assert.deepEqual(result.results.map(e => e.id), ['A']);
});

test('T08: abort signal does not falsely claim uncooperative host stopped', async () => {
  const journal = new MemoryJournal();
  const controller = new AbortController();
  let actuallyFinished = false;
  const startedAt = performance.now();
  const running = kernel(journal, async () => { await sleep(50); actuallyFinished = true; return 1; }).run(msg(call('A')), {signal:controller.signal});
  setTimeout(() => controller.abort('cancel'), 7);
  const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(actuallyFinished, true);
  assert.ok(performance.now() - startedAt >= 40);
});

test('T09: declared unknown execution cannot be silently retried', async () => {
  const journal = new MemoryJournal();
  const error = new Error('uncertain side effect'); error.outcomeUnknown = true;
  const result = await kernel(journal, async () => {throw error;}).run(msg(call('A')));
  assert.equal(result.status, 'needs_reconciliation'); assert.equal(result.started, 1);
  assert.equal(result.results.length, 0);
});

test('T10: deterministic replay does not depend on in-memory settlement order', async () => {
  const journal = new MemoryJournal();
  await kernel(journal, async c => { await sleep(c.id === 'A' ? 20 : 1); return c.id; }).run(msg(call('A'),call('B')));
  const snapshot = journal.replay();
  assert.deepEqual(projectToolResults(snapshot, ['A','B']), projectToolResults(structuredClone(snapshot), ['A','B']));
});

test('T11: basic unbounded Promise.all can reject before other started work settles', async () => {
  let siblingFinished = false;
  await assert.rejects(unsafeParallel([
    async () => { await sleep(5); throw new Error('receipt failed'); },
    async () => { await sleep(40); siblingFinished = true; },
  ]), /receipt failed/);
  assert.equal(siblingFinished, false);
  await sleep(45);
  assert.equal(siblingFinished, true);
});

test('T12: budget violation prevents tool execution', async () => {
  const journal = new MemoryJournal();
  const result = await new ExperimentalKernel({journal,host:{execute:async () => assert.fail('budget')},maxCalls:1}).run(msg(call('A'),call('B')));
  assert.equal(result.error, 'TOOL_BUDGET_EXCEEDED'); assert.equal(result.started, 0);
});
