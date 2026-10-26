import type { ContextMessage, ModelProvider, ProviderEvent } from '../../contracts/src/index.js';

/** Deterministic, one-stream-per-step fake. Never executes a real model request. */
export class FakeProvider implements ModelProvider {
  readonly id = 'fake';
  readonly requests: ContextMessage[][] = [];
  private index = 0;
  constructor(private readonly steps: readonly (readonly ProviderEvent[])[]) {}
  async *stream(messages: readonly ContextMessage[], signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone([...messages]));
    const step = this.steps[this.index++];
    if (!step) throw new Error('FakeProvider: no response scripted');
    for (const event of step) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      yield structuredClone(event);
    }
  }
}
