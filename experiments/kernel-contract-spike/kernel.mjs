/** Experimental execution contracts. Not a Pi/Codex/DSH implementation. */
export class MemoryJournal {
  constructor({ reject = () => false } = {}) { this.events = []; this.reject = reject; }
  async append(...drafts) {
    // A simulated atomic transaction: a rejected batch changes no persisted state.
    if (this.reject(drafts, this.events)) throw new Error('JOURNAL_COMMIT_FAILED');
    const base = this.events.length;
    this.events.push(...drafts.map((draft, i) => ({ seq: base + i + 1, ...draft })));
  }
  replay() { return structuredClone(this.events); }
}

export function projectToolResults(events, callIds) {
  const results = new Map();
  for (const event of events) {
    if (event.type === 'tool.result' && callIds.includes(event.id)) results.set(event.id, event);
  }
  return callIds.map(id => results.get(id)).filter(Boolean);
}

function validateMessage(message) {
  if (!message || !['stop','tool_use','length'].includes(message.finishReason) || !Array.isArray(message.toolCalls)) {
    throw new Error('MODEL_PROTOCOL_ERROR');
  }
  if (message.finishReason === 'length') throw new Error('TRUNCATED_MODEL_OUTPUT');
  if (message.toolCalls.length > 0 && message.finishReason !== 'tool_use') throw new Error('MODEL_PROTOCOL_ERROR');
  const ids = message.toolCalls.map(x => x.id);
  if (ids.some(x => typeof x !== 'string' || !x) || new Set(ids).size !== ids.length) {
    throw new Error('DUPLICATE_OR_INVALID_TOOL_CALL_ID');
  }
}

export class ExperimentalKernel {
  constructor({ journal, host, authorize = () => true, maxCalls = 16 }) {
    this.journal = journal; this.host = host; this.authorize = authorize; this.maxCalls = maxCalls;
  }
  async run(message, { signal } = {}) {
    const live = signal ?? new AbortController().signal;
    const events = this.journal;
    if (live.aborted) return { status: 'cancelled', started: 0, results: [] };
    try { validateMessage(message); }
    catch (error) { return { status: 'rejected', error: error.message, started: 0, results: [] }; }
    const calls = message.toolCalls;
    if (calls.length > this.maxCalls) return { status: 'rejected', error: 'TOOL_BUDGET_EXCEEDED', started: 0, results: [] };
    // Required write barrier: complete message and ALL tool intents share one commit.
    try {
      await events.append({ type: 'assistant.message', callIds: calls.map(x => x.id) },
        ...calls.map(x => ({ type: 'tool.intent', id: x.id, name: x.name })));
    } catch (error) { return { status: 'failed', error: error.message, started: 0, results: [] }; }
    let started = 0;
    let unknown = false;
    const settle = async call => {
      if (live.aborted || !this.authorize(call)) {
        try { await events.append({ type: 'tool.result', id: call.id, outcome: 'denied' }); }
        catch { unknown = true; }
        return;
      }
      started++;
      try {
        const result = await this.host.execute(call, live);
        // Do not hold completed receipts until earlier tools finish.
        await events.append({ type: 'tool.result', id: call.id, outcome: 'succeeded', data: result });
      } catch (error) {
        if (error?.message === 'JOURNAL_COMMIT_FAILED' || error?.outcomeUnknown === true) {
          unknown = true;
          return;
        }
        try { await events.append({ type: 'tool.result', id: call.id, outcome: 'failed', data: String(error.message ?? error) }); }
        catch { unknown = true; }
      }
    };
    // allSettled is intentional. A failed receipt cannot release the turn while a sibling host task is active.
    await Promise.allSettled(calls.map(settle));
    const results = projectToolResults(events.replay(), calls.map(x => x.id));
    return { status: unknown ? 'needs_reconciliation' : live.aborted ? 'cancelled' : 'completed', started, results };
  }
}

/** A deliberately unsafe comparison case illustrating early Promise.all rejection. */
export async function unsafeParallel(tasks) { return Promise.all(tasks.map(job => job())); }
