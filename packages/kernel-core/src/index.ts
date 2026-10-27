import { randomUUID } from 'node:crypto';
import { type AssistantMessage, type ContextMessage, type EventDraft, type EventStore, KernelError, type KernelEvent, type ModelProvider, type ModelTokenUsage, type SessionId, type ToolResult, type TurnId, type TurnState } from '../../contracts/src/index.js';
import { executeBatch, ToolRegistry } from '../../tool-scheduler/src/index.js';
import { inspectToolAudit } from '../../tool-audit/src/index.js';
import { admitContext } from '../../context-engine/src/index.js';

interface ActiveTurn { turnId: TurnId; controller: AbortController; state: TurnState | 'admitting'; fenced?: boolean; }
export interface KernelOptions { readonly maxSteps?: number; readonly maxToolCalls?: number; readonly maxContextCharacters?: number; readonly maxTotalTokens?: number; readonly assertExecutionLease?: () => void; }
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
  private readonly maxTotalTokens: number | undefined;
  private readonly assertExecutionLease: (() => void) | undefined;
  constructor(private readonly store: EventStore, private readonly provider: ModelProvider,
    private readonly tools: ToolRegistry, options: KernelOptions = {}, private readonly onDelta?: DeltaListener) {
    this.assertExecutionLease = options.assertExecutionLease;
    this.maxSteps = options.maxSteps ?? 8;
    this.maxToolCalls = options.maxToolCalls ?? 16;
    this.maxContextCharacters = options.maxContextCharacters;
    this.maxTotalTokens = options.maxTotalTokens;
    if (this.maxContextCharacters !== undefined && (!Number.isSafeInteger(this.maxContextCharacters) || this.maxContextCharacters < 1)
      || this.maxTotalTokens !== undefined && (!Number.isSafeInteger(this.maxTotalTokens) || this.maxTotalTokens < 1)) {
      throw new KernelError('INVALID_BUDGET', 'Context and token budgets must be positive safe integers');
    }
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1 || !Number.isSafeInteger(this.maxToolCalls) || this.maxToolCalls < 0) {
      throw new KernelError('INVALID_BUDGET', 'maxSteps must be positive, maxToolCalls nonnegative');
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

  /**
   * Reattach a previously completed session without re-running model steps or tools.
   * Fail closed on damaged logs or in-flight turns: M1 has no recovery coordinator.
   * A durable store still needs a single-writer lease outside this process.
   */
  async openSession(id: SessionId): Promise<SessionId> {
    if (!id.trim() || this.known.has(id) || this.creating.has(id)) {
      throw new KernelError('SESSION_EXISTS', 'Session is already open or reserved');
    }
    this.creating.add(id);
    try {
      const events = await this.store.read(id);
      if (events.length === 0 || events[0]?.type !== 'session.created') {
        throw new KernelError('UNKNOWN_SESSION', 'No session.created event');
      }
      const seen = new Set<TurnId>();
      let pending: TurnId | undefined;
      for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        if (e.sessionId !== id || e.seq !== i + 1 || (i > 0 && e.type === 'session.created')) {
          throw new KernelError('CORRUPT_EVENT_LOG', 'Invalid session identity, sequence, or creation event');
        }
        if (i === 0) {
          if (e.turnId !== undefined) throw new KernelError('CORRUPT_EVENT_LOG', 'session.created must not carry turnId');
          continue;
        }
        // Control-plane ACK is session-scoped and never a ToolCall or Turn.
        if (e.type === 'command.accepted') {
          if (e.turnId !== undefined) throw new KernelError('CORRUPT_EVENT_LOG', 'Command ACK must not have turnId');
          continue;
        }
        if (!e.turnId) throw new KernelError('CORRUPT_EVENT_LOG', 'Turn event missing turnId');
        if (e.type === 'turn.queued') {
          if (pending || seen.has(e.turnId)) throw new KernelError('CORRUPT_EVENT_LOG', 'Overlapping or repeated turn');
          seen.add(e.turnId);
          pending = e.turnId;
        } else {
          if (pending !== e.turnId) throw new KernelError('CORRUPT_EVENT_LOG', 'Event is outside an active turn');
          if (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.cancelled') {
            pending = undefined;
          }
        }
      }
      const audit = inspectToolAudit(events);
      if (pending || audit.some(item => item.needsReconciliation)) {
        throw new KernelError('RECOVERY_REQUIRED', 'Unfinished turn or uncertain tool outcome; do not replay');
      }
      // Install the cursor only after the whole event stream has passed validation.
      this.seq.set(id, events.length);
      this.known.add(id);
      return id;
    } finally {
      this.creating.delete(id);
    }
  }

  /**
   * Loss of lease is NOT user cancellation: abort cooperatively but deliberately
   * leave the admitted turn unresolved for recovery. No terminal event is forged.
   */
  fenceActiveTurn(sessionId: SessionId): boolean {
    const ctl = this.active.get(sessionId);
    if (!ctl || ctl.fenced) return false;
    ctl.fenced = true;
    ctl.controller.abort(new KernelError('LEASE_LOST', 'Writer lease lost'));
    return true;
  }

  private verifyExecution(ctl: ActiveTurn): void {
    if (ctl.fenced) throw new KernelError('LEASE_LOST', 'Writer lease lost');
    this.assertExecutionLease?.();
    if (ctl.fenced) throw new KernelError('LEASE_LOST', 'Writer lease lost');
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

  /** A complete user Turn contains one or more model Steps. Rejects concurrent turns in M0. */
  async runTurn(sessionId: SessionId, text: string, turnId: TurnId = randomUUID()): Promise<TurnResult> {
    this.assertSession(sessionId);
    if (!text.trim()) throw new KernelError('EMPTY_MESSAGE', 'Message must be nonempty');
    if (!turnId.trim() || this.active.has(sessionId)) throw new KernelError('TURN_BUSY', 'Turn is already active');
    // Reserve before the asynchronous admission read to reject racing runTurn calls.
    const ctl: ActiveTurn = { turnId, controller: new AbortController(), state: 'admitting' };
    this.active.set(sessionId, ctl);
    let terminal = false;
    let admitted = false;
    let unsafeToolState = false;
    const record = (...ds: EventDraft[]) => this.record(sessionId, ...ds);
    try {
      const existing = await this.store.read(sessionId);
      if (existing.some(e => e.turnId === turnId)) throw new KernelError('DUPLICATE_TURN', turnId);
      await record({ type: 'turn.queued', turnId, data: {} }, { type: 'user.message', turnId, data: { text } }, { type: 'turn.started', turnId, data: {} });
      admitted = true;
      ctl.state = 'running_model';
      this.verifyExecution(ctl);
      let toolCount = 0;
      let consumedTokens = 0;
      const seenCallIds = new Set<string>();
      for (let step = 1; step <= this.maxSteps; step++) {
        this.verifyExecution(ctl);
        if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
        const boundTools = this.tools.snapshot();
        const stepAdmission = {stepId: `${turnId}/${step}`, toolSetVersion: boundTools.version, tools: boundTools.modelSpecs()};
        if (this.maxTotalTokens !== undefined && consumedTokens >= this.maxTotalTokens) {
          throw new KernelError('TOKEN_BUDGET_EXCEEDED', 'Turn token limit exhausted');
        }
        const messages = await this.context(sessionId);
        const admission = this.maxContextCharacters === undefined ? undefined
          : admitContext(messages, stepAdmission, {maxSerializedCharacters: this.maxContextCharacters});
        await record({ type: 'model.started', turnId,
          data: { step, providerId: this.provider.id, toolSet: boundTools.visibleTools,
            toolSetVersion: stepAdmission.toolSetVersion,
            ...(admission ? {contextSize: admission.serializedCharacters, contextLimit: admission.limit} : {}) } });
        this.verifyExecution(ctl);
        let completed: { message: AssistantMessage; finishReason: 'stop' | 'tool_use' | 'length' } | undefined;
        let usage: ModelTokenUsage | undefined;
        for await (const event of this.provider.stream(messages, ctl.controller.signal, stepAdmission)) {
          this.verifyExecution(ctl);
          if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
          if (event.type === 'text_delta') this.onDelta?.(event.text, {sessionId, turnId});
          if (event.type === 'usage') {
            const u = event.usage;
            if (!Number.isSafeInteger(u.inputTokens) || !Number.isSafeInteger(u.outputTokens)
              || u.inputTokens < 0 || u.outputTokens < 0
              || (usage !== undefined && (u.inputTokens < usage.inputTokens || u.outputTokens < usage.outputTokens))) {
              throw new KernelError('INVALID_PROVIDER_USAGE', 'Invalid or decreasing model token usage');
            }
            usage = structuredClone(u);
          }
          if (event.type === 'message_complete') {
            if (completed) throw new KernelError('MULTIPLE_COMPLETIONS', 'Only one final assistant message permitted');
            completed = { message: event.message, finishReason: event.finishReason };
          }
        }
        this.verifyExecution(ctl);
        if (!completed) throw new KernelError('INCOMPLETE_PROVIDER_STREAM', 'No completed assistant message');
        if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
        const { message, finishReason } = completed;
        if (message.role !== 'assistant' || !Array.isArray(message.toolCalls) || typeof message.text !== 'string') {
          throw new KernelError('INVALID_ASSISTANT_MESSAGE', 'Invalid model output');
        }
        if (usage !== undefined) {
          await record({type:'model.usage', turnId, data:{step,usage}});
          const total = usage.inputTokens + usage.outputTokens;
          if (!Number.isSafeInteger(total) || !Number.isSafeInteger(consumedTokens + total)) {
            throw new KernelError('INVALID_PROVIDER_USAGE', 'Usage total overflow');
          }
          consumedTokens += total;
        }
        if (this.maxTotalTokens !== undefined) {
          if (usage === undefined) throw new KernelError('USAGE_UNAVAILABLE', 'Token budget requires provider-reported usage');
          if (consumedTokens > this.maxTotalTokens) throw new KernelError('TOKEN_BUDGET_EXCEEDED', 'Token budget exceeded; tool calls withheld');
        }
        if (finishReason === 'length') throw new KernelError('TRUNCATED_MODEL_OUTPUT', 'Unsafe to execute truncated tool calls');
        if (message.toolCalls.length > 0 && finishReason !== 'tool_use') throw new KernelError('INVALID_FINISH_REASON', 'Tool calls require tool_use finish reason');
        if (finishReason === 'tool_use' && message.toolCalls.length === 0) throw new KernelError('INVALID_FINISH_REASON', 'tool_use requires tool calls');
        if (message.toolCalls.some(c => seenCallIds.has(c.id))) throw new KernelError('DUPLICATE_CALL_ID', 'Tool call ID reused in same turn');
        if (toolCount + message.toolCalls.length > this.maxToolCalls) throw new KernelError('TOOL_BUDGET_EXCEEDED', 'Tool call limit reached');
        this.verifyExecution(ctl);
        await record({ type: 'assistant.message', turnId, data: structuredClone(message) });
        if (message.toolCalls.length === 0) {
          if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
          this.verifyExecution(ctl);
          // Claim completion synchronously: later cancelTurn calls must not append a post-terminal cancellation.
          ctl.state = 'completed';
          await record({ type: 'turn.completed', turnId, data: { stepCount: step } });
          terminal = true;
          return { turnId, status: 'completed', assistant: message };
        }
        toolCount += message.toolCalls.length;
        for (const call of message.toolCalls) seenCallIds.add(call.id);
        ctl.state = 'running_tools';
        this.verifyExecution(ctl);
        // All intents become durable BEFORE the first tool can start.
        // Assistant message already contains full original arguments; intent
        // points at that call with a stable step and callId.
        // A storage adapter might commit an intent then fail before ACK.
        // Treat the result of this append as ambiguous until audited.
        unsafeToolState = true;
        await record(...message.toolCalls.map(call => ({
          type: 'tool.intent' as const, turnId,
          data: { callId: call.id, name: call.name, step },
        })));
        const results = await executeBatch(
          message.toolCalls, boundTools, ctl.controller.signal,
          () => this.verifyExecution(ctl),
          async receipt => {
            this.verifyExecution(ctl);
            // Atomic pair: persisted receipt + context-visible result.
            await record(
              { type: 'tool.receipt', turnId, data: receipt },
              { type: 'tool.result', turnId, data: receipt },
            );
          },
          { sessionId, turnId },
        );
        this.verifyExecution(ctl);
        // Even an explicit outcome_unknown receipt is not proof of safety:
        // do not continue the model or append a misleading terminal turn.
        if (results.some(result => result.outcome === 'outcome_unknown')) {
          throw new KernelError('TOOL_OUTCOME_UNKNOWN', 'Tool execution outcome requires reconciliation');
        }
        unsafeToolState = false;
        if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
        ctl.state = 'running_model';
      }
      throw new KernelError('STEP_BUDGET_EXCEEDED', 'Model step budget reached');
    } catch (error) {
      // Fence loss is not cancellation/failure: never append a terminal event
      // after ownership is gone. The successor must reconcile this turn.
      if (ctl.fenced || (error instanceof KernelError && error.code === 'LEASE_LOST')) {
        ctl.fenced = true;
        ctl.controller.abort(new KernelError('LEASE_LOST', 'Writer lease lost'));
        throw new KernelError('LEASE_LOST', 'Turn unfinished after losing writer lease');
      }
      // Intent is durable but not all receipts are definitively settled.
      // Writing turn.failed/cancelled here would incorrectly clear recovery.
      if (unsafeToolState) {
        throw new KernelError('TOOL_OUTCOME_UNKNOWN', 'Unsettled tool intents require reconciliation');
      }
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
