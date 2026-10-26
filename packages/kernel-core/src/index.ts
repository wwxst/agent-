import { randomUUID } from 'node:crypto';
import { type AssistantMessage, type ContextMessage, type EventDraft, type EventStore, KernelError, type KernelEvent, type ModelProvider, type SessionId, type ToolResult, type TurnId, type TurnState } from '../../contracts/src/index.js';
import { executeBatch, ToolRegistry } from '../../tool-scheduler/src/index.js';
import {admitContext} from '../../context-engine/src/index.js';

interface Steering { readonly text: string; readonly ready: Promise<unknown>; }
interface ActiveTurn { turnId: TurnId; controller: AbortController; state: TurnState | 'admitting'; steering: Steering[]; }
export interface KernelOptions { readonly maxSteps?: number; readonly maxToolCalls?: number; readonly maxContextCharacters?: number; }
export interface TurnResult { readonly turnId: TurnId; readonly status: 'completed' | 'cancelled' | 'failed'; readonly assistant?: AssistantMessage; readonly errorCode?: string; }
export type DeltaListener = (delta: string, context: Readonly<{sessionId: string; turnId: string}>) => void;

/** M0 is a single-process prototype. Durable EventStore and real ToolHost are future adapters. */
export class AgentKernel {
  private readonly active = new Map<SessionId, ActiveTurn>();
  private readonly seq = new Map<SessionId, number>();
  private readonly pendingWrites = new Map<SessionId, Promise<void>>();
  private readonly known = new Set<SessionId>();
  private readonly creating = new Set<SessionId>();
  private readonly maxSteps: number;
  private readonly maxToolCalls: number;
  private readonly maxContextCharacters: number | undefined;
  constructor(private readonly store: EventStore, private readonly provider: ModelProvider,
    private readonly tools: ToolRegistry, options: KernelOptions = {}, private readonly onDelta?: DeltaListener) {
    this.maxSteps = options.maxSteps ?? 8;
    this.maxToolCalls = options.maxToolCalls ?? 16;
    this.maxContextCharacters = options.maxContextCharacters;
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1 || !Number.isSafeInteger(this.maxToolCalls) || this.maxToolCalls < 0) {
      throw new KernelError('INVALID_BUDGET', 'maxSteps must be positive, maxToolCalls nonnegative');
    }
    if (this.maxContextCharacters !== undefined && (!Number.isSafeInteger(this.maxContextCharacters) || this.maxContextCharacters < 1)) {
      throw new KernelError('INVALID_CONTEXT_BUDGET', 'maxContextCharacters must be a positive integer');
    }
  }

  private record(sessionId: SessionId, ...drafts: EventDraft[]): Promise<readonly KernelEvent[]> {
    // Serialize state commits per session, including concurrent cancellation requests.
    const previous = this.pendingWrites.get(sessionId) ?? Promise.resolve();
    const committed = previous.then(async () => {
      const latest = this.seq.get(sessionId) ?? 0;
      const events = await this.store.append(sessionId, latest, drafts);
      this.seq.set(sessionId, latest + events.length);
      return events;
    });
    const tail = committed.then(() => undefined, () => undefined);
    this.pendingWrites.set(sessionId, tail);
    void tail.then(() => { if (this.pendingWrites.get(sessionId) === tail) this.pendingWrites.delete(sessionId); });
    return committed;
  }

  async createSession(id: SessionId = randomUUID()): Promise<SessionId> {
    if (!id.trim() || this.known.has(id) || this.creating.has(id)) throw new KernelError('SESSION_EXISTS', 'Duplicate/invalid session');
    // Reserve before the first await, otherwise two callers can admit the same ID.
    this.creating.add(id);
    try {
      const current = await this.store.read(id);
      if (current.length !== 0) throw new KernelError('SESSION_EXISTS', 'Already exists in store');
      await this.record(id, { type: 'session.created', data: {} });
      this.known.add(id);
      return id;
    } finally {
      this.creating.delete(id);
    }
  }

  private isCancelling(ctl: ActiveTurn): boolean { return ctl.controller.signal.aborted || ctl.state === 'cancelling'; }
  private assertSession(id: SessionId): void { if (!this.known.has(id)) throw new KernelError('UNKNOWN_SESSION', id); }
  async readEvents(sessionId: SessionId, afterSeq = 0): Promise<readonly KernelEvent[]> {
    this.assertSession(sessionId);
    return this.store.read(sessionId, afterSeq);
  }
  private async context(sessionId: SessionId): Promise<ContextMessage[]> {
    const events = await this.store.read(sessionId);
    const messages: ContextMessage[] = [];
    for (const event of events) {
      if (event.type === 'user.message') messages.push({ role: 'user', text: (event.data as { text: string }).text });
      if (event.type === 'assistant.message') messages.push(structuredClone(event.data as AssistantMessage));
      if (event.type === 'tool.result') messages.push({ role: 'tool', result: structuredClone(event.data as ToolResult) });
    }
    return messages;
  }

  async cancelTurn(sessionId: SessionId, turnId: TurnId): Promise<boolean> {
    this.assertSession(sessionId);
    const active = this.active.get(sessionId);
    if (!active || active.state === 'admitting' || active.turnId !== turnId || active.controller.signal.aborted || active.state === 'cancelling' || active.state === 'completed' || active.state === 'failed' || active.state === 'cancelled') return false;
    active.state = 'cancelling';
    await this.record(sessionId, { type: 'turn.cancel_requested', turnId, data: {} });
    active.controller.abort(new Error('CANCEL_TURN'));
    return true;
  }

  /** Enqueue input for the next safe model Step, with an expected active Turn ID. */
  async steerTurn(sessionId: SessionId, expectedTurnId: TurnId, text: string): Promise<boolean> {
    this.assertSession(sessionId);
    if (!text.trim()) throw new KernelError('EMPTY_MESSAGE', 'Steering requires nonempty text');
    const ctl = this.active.get(sessionId);
    if (!ctl || ctl.turnId !== expectedTurnId ||
        !['running_model', 'running_tools'].includes(ctl.state) || ctl.controller.signal.aborted) return false;
    // Reserve synchronously so a concurrently completing model Step cannot miss accepted Steering.
    const ready = this.record(sessionId, {type: 'turn.steer_queued', turnId: expectedTurnId, data: {text}});
    ctl.steering.push({text, ready});
    await ready;
    return true;
  }

  private async consumeSteering(sessionId: SessionId, ctl: ActiveTurn): Promise<void> {
    const batch = ctl.steering.splice(0);
    if (batch.length === 0) return;
    await Promise.all(batch.map(x => x.ready));
    if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
    await this.record(sessionId, ...batch.flatMap(x => [
      {type: 'turn.steer_consumed' as const, turnId: ctl.turnId, data: {}},
      {type: 'user.message' as const, turnId: ctl.turnId, data: {text: x.text}},
    ]));
  }

  /** A complete user Turn contains one or more model Steps. Rejects concurrent turns. */
  async runTurn(sessionId: SessionId, text: string, turnId: TurnId = randomUUID()): Promise<TurnResult> {
    this.assertSession(sessionId);
    if (!text.trim()) throw new KernelError('EMPTY_MESSAGE', 'Message must be nonempty');
    if (!turnId.trim() || this.active.has(sessionId)) throw new KernelError('TURN_BUSY', 'Turn is already active');
    // Reserve before the asynchronous admission read to reject racing runTurn calls.
    const ctl: ActiveTurn = { turnId, controller: new AbortController(), state: 'admitting', steering: [] };
    this.active.set(sessionId, ctl);
    let terminal = false;
    let admitted = false;
    const record = (...ds: EventDraft[]) => this.record(sessionId, ...ds);
    try {
      const existing = await this.store.read(sessionId);
      if (existing.some(e => e.turnId === turnId)) throw new KernelError('DUPLICATE_TURN', turnId);
      await record({ type: 'turn.queued', turnId, data: {} }, { type: 'user.message', turnId, data: { text } }, { type: 'turn.started', turnId, data: {} });
      admitted = true;
      ctl.state = 'running_model';
      let toolCount = 0;
      const seenCallIds = new Set<string>();
      for (let step = 1; step <= this.maxSteps; step++) {
        if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
        await this.consumeSteering(sessionId, ctl);
        const boundTools = this.tools.snapshot();
        const stepAdmission = {
          stepId: `${turnId}/${step}`,
          toolSetVersion: boundTools.version,
          tools: boundTools.modelSpecs(),
        };
        const messages = await this.context(sessionId);
        // No silent truncation and no model call if the context exceeds the configured safety cap.
        const admission = this.maxContextCharacters === undefined ? undefined :
          admitContext(messages, stepAdmission, {maxSerializedCharacters: this.maxContextCharacters});
        await record({ type: 'model.started', turnId, data: { step, providerId: this.provider.id, ...stepAdmission,
          ...(admission === undefined ? {} : {contextSize: admission.serializedCharacters, contextLimit: admission.limit}) } });
        let completed: { message: AssistantMessage; finishReason: 'stop' | 'tool_use' | 'length' } | undefined;
        for await (const event of this.provider.stream(messages, ctl.controller.signal, stepAdmission)) {
          if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
          if (event.type === 'text_delta') this.onDelta?.(event.text, {sessionId, turnId});
          if (event.type === 'message_complete') {
            if (completed) throw new KernelError('MULTIPLE_COMPLETIONS', 'Only one final assistant message permitted');
            completed = { message: event.message, finishReason: event.finishReason };
          }
        }
        if (!completed) throw new KernelError('INCOMPLETE_PROVIDER_STREAM', 'No completed assistant message');
        if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
        const { message, finishReason } = completed;
        if (message.role !== 'assistant' || !Array.isArray(message.toolCalls) || typeof message.text !== 'string') {
          throw new KernelError('INVALID_ASSISTANT_MESSAGE', 'Invalid model output');
        }
        if (finishReason === 'length') throw new KernelError('TRUNCATED_MODEL_OUTPUT', 'Unsafe to execute truncated tool calls');
        if (message.toolCalls.length > 0 && finishReason !== 'tool_use') throw new KernelError('INVALID_FINISH_REASON', 'Tool calls require tool_use finish reason');
        if (finishReason === 'tool_use' && message.toolCalls.length === 0) throw new KernelError('INVALID_FINISH_REASON', 'tool_use requires tool calls');
        if (message.toolCalls.some(c => seenCallIds.has(c.id))) throw new KernelError('DUPLICATE_CALL_ID', 'Tool call ID reused in same turn');
        if (toolCount + message.toolCalls.length > this.maxToolCalls) throw new KernelError('TOOL_BUDGET_EXCEEDED', 'Tool call limit reached');
        await record({ type: 'assistant.message', turnId, data: structuredClone(message) });
        if (message.toolCalls.length === 0) {
          if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
          // Steering accepted during model execution takes precedence over normal completion.
          if (ctl.steering.length) {
            await this.consumeSteering(sessionId, ctl);
            continue;
          }
          // Claim completion synchronously: later cancelTurn calls must not append a post-terminal cancellation.
          ctl.state = 'completed';
          await record({ type: 'turn.completed', turnId, data: { stepCount: step } });
          terminal = true;
          return { turnId, status: 'completed', assistant: message };
        }
        toolCount += message.toolCalls.length;
        for (const call of message.toolCalls) seenCallIds.add(call.id);
        ctl.state = 'running_tools';
        const results = await executeBatch(message.toolCalls, boundTools, ctl.controller.signal);
        await record(...results.map(r => ({ type: 'tool.result' as const, turnId, data: r })));
        if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
        ctl.state = 'running_model';
      }
      throw new KernelError('STEP_BUDGET_EXCEEDED', 'Model step budget reached');
    } catch (error) {
      // Failed admission has no Turn to terminate; never write a phantom terminal event.
      if (!admitted) throw error;
      const cancelled = this.isCancelling(ctl);
      const code = cancelled ? 'CANCELLED' : error instanceof KernelError ? error.code : 'KERNEL_OR_PROVIDER_ERROR';
      if (!terminal) {
        ctl.state = cancelled ? 'cancelled' : 'failed';
        await record({ type: cancelled ? 'turn.cancelled' : 'turn.failed', turnId, data: { errorCode: code } });
      }
      return { turnId, status: cancelled ? 'cancelled' : 'failed', errorCode: code };
    } finally {
      this.active.delete(sessionId);
    }
  }
}
