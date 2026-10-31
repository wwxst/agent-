import test from 'node:test';
import assert from 'node:assert/strict';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// Two independent modeled settlement rules, not the actual project implementations.
function schedule(mode) {
  const A = deferred(), B = deferred();
  const journal = [];
  const ready = [undefined, undefined];
  let next = 0;
  function complete(index, value) {
    if (mode === 'eager-facts') {
      journal.push({ id: index ? 'B' : 'A', value });
    } else {
      ready[index] = { id: index ? 'B' : 'A', value };
      while (ready[next]) journal.push(ready[next++]);
    }
  }
  const tasks = [A.promise.then(v => complete(0, v)), B.promise.then(v => complete(1, v))];
  return { A, B, journal, done: Promise.all(tasks) };
}

test('C01: eager receipts retain evidence of B when A remains pending', async () => {
  const eager = schedule('eager-facts');
  const ordered = schedule('ordered-commit');
  eager.B.resolve('side-effect-done'); ordered.B.resolve('side-effect-done');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(eager.journal.map(x => x.id), ['B']);
  assert.deepEqual(ordered.journal.map(x => x.id), []);
  eager.A.resolve('A-done'); ordered.A.resolve('A-done');
  await Promise.all([eager.done, ordered.done]);
  assert.deepEqual(eager.journal.map(x => x.id), ['B','A']);
  assert.deepEqual(ordered.journal.map(x => x.id), ['A','B']);
  const project = journal => ['A','B'].map(id => journal.find(x => x.id === id));
  assert.deepEqual(project(eager.journal), project(ordered.journal));
});
