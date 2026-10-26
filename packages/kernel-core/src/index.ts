import { randomUUID } from 'node:crypto';
import { type AssistantMessage, type ContextMessage, type EventDraft, type EventStore, KernelError, type KernelEvent, type ModelProvider, type ModelTokenUsage, type SessionId, type ToolResult, type TurnId, type TurnState } from '../../contracts/src/index.js';
import { executeBatch, ToolRegistry } from '../../tool-scheduler/src/index.js';
import {admitContext, type ContextCompactor} from '../../context-engine/src/index.js';

interface Steering { readonly text: string; readonly ready: Promise<unknown>; }
interface ActiveTurn { turnId: TurnId; controller: AbortController; state: TurnState | 'admitting'; steering: Steering[]; }
export interface KernelOptions { readonly maxSteps?: number; readonly maxToolCalls?: number; readonly maxContextCharacters?: number; readonly maxTotalTokens?: number; readonly contextCompactor?: ContextCompactor; }
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
  private readonly compactor: ContextCompactor | undefined;
  constructor(private readonly store: EventStore, private readonly provider: ModelProvider,
    private readonly tools: ToolRegistry, options: KernelOptions = {}, private readonly onDelta?: DeltaListener) {
    this.maxSteps = options.maxSteps ?? 8;
    this.maxToolCalls = options.maxToolCalls ?? 16;
    this.maxContextCharacters = options.maxContextCharacters;
    this.maxTotalTokens = options.maxTotalTokens;
    this.compactor = options.contextCompactor;
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1 || !Number.isSafeInteger(this.maxToolCalls) || this.maxToolCalls < 0) {
      throw new KernelError('INVALID_BUDGET', 'maxSteps must be positive, maxToolCalls nonnegative');
    }
    if (this.maxContextCharacters !== undefined && (!Number.isSafeInteger(this.maxContextCharacters) || this.maxContextCharacters < 1)) {
      throw new KernelError('INVALID_CONTEXT_BUDGET', 'maxContextCharacters must be a positive integer');
    }
    if (this.maxTotalTokens !== undefined && (!Number.isSafeInteger(this.maxTotalTokens) || this.maxTotalTokens < 1)) {
      throw new KernelError('INVALID_TOKEN_BUDGET', 'maxTotalTokens must be a positive integer');
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
   * Reattach a quiescent session from an EventStore. This reconstructs only
   * in-memory indexing and never replays a ToolCall or pretends to close an
   * interrupted operation. M2 provides a durable store and reconciliation.
   */
  async resumeSession(sessionId: SessionId): Promise<SessionId> {
    if (!sessionId.trim() || this.known.has(sessionId) || this.creating.has(sessionId) || this.active.has(sessionId)) {
      throw new KernelError('SESSION_BUSY', 'Session is already open or being attached');
    }
    // Reserve before the first await; two resume/create attempts must not race.
    this.creating.add(sessionId);
    try {
      const events = await this.store.read(sessionId);
      if (events.length === 0) throw new KernelError('UNKNOWN_SESSION', 'No session journal to resume');
      const seenEventIds = new Set<string>();
      const seenTurnIds = new Set<string>();
      let activeTurn: string | undefined;
      let activeStart = 0;
      let lastCheckpointThrough = 0;
      let turnStarted = false;
      const outstandingCalls = new Set<string>();
      const seenCalls = new Set<string>();
      const completedBoundaries = new Set<number>();
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        if (event.sessionId !== sessionId || event.seq !== i + 1 || !event.eventId || seenEventIds.has(event.eventId)) {
          throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Invalid session event identity or sequence');
        }
        seenEventIds.add(event.eventId);
        if (i === 0) {
          if (event.type !== 'session.created' || event.turnId !== undefined) {
            throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Session must start with session.created');
          }
          continue;
        }
        if (event.type === 'session.created') {
          throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Duplicate session.created event');
        }
        // Durable admission facts may be committed between Turns or while a Turn runs.
        // They are audit events, not permission grants to execute any tool.
        if (event.type === 'command.accepted') {
          const cmd = event.data as {commandId?: unknown; kind?: unknown; fingerprint?: unknown} | null;
          if (event.turnId !== undefined || typeof cmd?.commandId !== 'string' || !cmd.commandId ||
              typeof cmd?.kind !== 'string' || !cmd.kind ||
              typeof cmd?.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(cmd.fingerprint)) {
            throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Malformed command acceptance event');
          }
          continue;
        }
        if (event.type === 'turn.queued') {
          if (activeTurn !== undefined || !event.turnId || seenTurnIds.has(event.turnId)) {
            throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Overlapping or duplicate user Turn');
          }
          activeTurn = event.turnId;
          activeStart = event.seq;
          turnStarted = false;
          outstandingCalls.clear();
          seenCalls.clear();
          seenTurnIds.add(activeTurn);
          continue;
        }
        if (activeTurn === undefined || event.turnId !== activeTurn) {
          throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Event does not belong to the active Turn');
        }
        if (event.type === 'turn.started') {
          if (turnStarted) throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Duplicate turn.started event');
          turnStarted = true;
        }
        if (event.type === 'assistant.message') {
          const msg = event.data as AssistantMessage | null;
          if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.toolCalls)) {
            throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Invalid assistant message in journal');
          }
          for (const call of msg.toolCalls) {
            if (!call.id || seenCalls.has(call.id)) {
              throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Reused or empty tool call ID');
            }
            seenCalls.add(call.id);
            outstandingCalls.add(call.id);
          }
        }
        if (event.type === 'tool.result') {
          const result = event.data as ToolResult | null;
          if (!result || !outstandingCalls.delete(result.callId)) {
            throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Orphan or duplicate tool result');
          }
        }
        if (event.type === 'context.checkpoint') {
          const payload = event.data as { throughSeq?: unknown; summary?: unknown } | null;
          const through = payload?.throughSeq;
          if (!Number.isSafeInteger(through) || typeof through !== 'number' ||
              through <= lastCheckpointThrough || through >= activeStart ||
              !completedBoundaries.has(through) ||
              events.some(e => e.seq > lastCheckpointThrough && e.seq <= through &&
                (e.type === 'turn.failed' || e.type === 'turn.cancelled')) ||
              typeof payload?.summary !== 'string' ||
              !payload.summary.trim() || payload.summary.length > 32_768) {
            throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Invalid context checkpoint boundary');
          }
          lastCheckpointThrough = through;
        }
        if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.cancelled') {
          if (!turnStarted) throw new KernelError('CORRUPT_SESSION_JOURNAL', 'Terminal Turn without a start event');
          if (outstandingCalls.size !== 0) {
            throw new KernelError('SESSION_RECOVERY_REQUIRED', 'Unresolved ToolCalls need reconciliation, not automatic replay');
          }
          if (event.type === 'turn.completed') completedBoundaries.add(event.seq);
          activeTurn = undefined;
        }
      }
      if (activeTurn !== undefined) {
        throw new KernelError('SESSION_RECOVERY_REQUIRED', 'Unclosed Turn needs explicit reconciliation; automatic ToolCall replay is forbidden');
      }
      this.seq.set(sessionId, events.length);
      this.known.add(sessionId);
      return sessionId;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  private isCancelling(ctl: ActiveTurn): boolean { return ctl.controller.signal.aborted || ctl.state === 'cancelling'; }
  private assertSession(id: SessionId): void { if (!this.known.has(id)) throw new KernelError('UNKNOWN_SESSION', id); }
  async readEvents(sessionId: SessionId, afterSeq = 0): Promise<readonly KernelEvent[]> {
    this.assertSession(sessionId);
    return this.store.read(sessionId, afterSeq);
  }
  /** Project model context from immutable events; a checkpoint never deletes raw historical facts. */
  private projectContext(events: readonly KernelEvent[]): ContextMessage[] {
    const lastCheckpoint = [...events].reverse().find(e => e.type === 'context.checkpoint');
    let messages: ContextMessage[] = [];
    let after = 0;
    if (lastCheckpoint) {
      const data = lastCheckpoint.data as {summary: string; throughSeq: number};
      after = data.throughSeq;
      messages = [{role:'summary',text:data.summary}];
    }
    for (const event of events) {
      if (event.seq <= after) continue;
      if (event.type === 'user.message') messages.push({ role: 'user', text: (event.data as { text: string }).text });
      if (event.type === 'assistant.message') messages.push(structuredClone(event.data as AssistantMessage));
      if (event.type === 'tool.result') messages.push({ role: 'tool', result: structuredClone(event.data as ToolResult) });
    }
    return messages;
  }
  private async context(sessionId: SessionId): Promise<ContextMessage[]> {
    return this.projectContext(await this.store.read(sessionId));
  }

  /** Compact only a complete, older Turn; the active Turn and original event journal are preserved. */
  private async compactOldContext(sessionId: SessionId, ctl: ActiveTurn): Promise<void> {
    if (!this.compactor) throw new KernelError('CONTEXT_BUDGET_EXCEEDED','Context exceeds serialized character budget');
    const events = await this.store.read(sessionId);
    const currentStart = events.find(e => e.turnId === ctl.turnId && e.type === 'turn.queued')?.seq;
    if (!currentStart) throw new KernelError('CONTEXT_COMPACTION_UNSAFE','Missing current Turn boundary');
    const latestCheckpoint = [...events].reverse().find(e => e.type === 'context.checkpoint');
    const after = latestCheckpoint?.seq ?? 0;
    // Prior completed Turns are eligible. Failed/in-flight Turns and their tool result pairs stay verbatim.
    // Do not skip over a failed older Turn: taking a prefix beyond it could silently erase tool state.
    const older = events.filter(e => e.seq > after && e.seq < currentStart);
    let throughSeq: number | undefined;
    for (const e of older) {
      if (e.type === 'turn.completed') throughSeq = e.seq;
      if ((e.type === 'turn.failed' || e.type === 'turn.cancelled') && throughSeq === undefined) break;
    }
    if (throughSeq === undefined) throw new KernelError('CONTEXT_COMPACTION_UNSAFE','No safe completed Turn to compact');
    // Ensure no unresolved/failed Turn is hidden inside the compacted prefix.
    const covered = older.filter(e => e.seq <= throughSeq);
    if (covered.some(e => e.type === 'turn.failed' || e.type === 'turn.cancelled')) {
      throw new KernelError('CONTEXT_COMPACTION_UNSAFE','Prior non-completed Turn cannot be summarized');
    }
    const projection = this.projectContext(events.filter(e => e.seq <= throughSeq || (latestCheckpoint !== undefined && e.seq === latestCheckpoint.seq)));
    let summary: string;
    try { summary = await this.compactor.compact(structuredClone(projection),ctl.controller.signal); }
    catch {throw new KernelError('CONTEXT_COMPACTION_FAILED','Compactor failed without modifying source history');}
    if (this.isCancelling(ctl)) throw new KernelError('CANCELLED','Cancelled during compaction');
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 32_768) {
      throw new KernelError('CONTEXT_COMPACTION_FAILED','Compactor produced invalid summary');
    }
    await this.record(sessionId, {type:'context.checkpoint',turnId:ctl.turnId,
      data:{throughSeq,summary,sourceEventCount:covered.length}});
  }

  async cancelTurn(sessionId: SessionId, turnId: TurnId): Promise<boolean> {
    this.assertSession(sessionId);
    const active = this.active.get(sessionId);
    if (!active || active.state === 'admitting' || active.turnId !== turnId || active.controller.signal.aborted || active.state === 'cancelling' || active.state === 'completed' || active.state === 'failed' || active.state === 'cancelled') return false;
    active.state = 'cancelling';
    try {
      await this.record(sessionId, { type: 'turn.cancel_requested', turnId, data: {} });
    } finally {
      // Even when the journal is unavailable, do not leave a streaming
      // provider/ToolHost waiting forever. The caller still sees commit failure.
      active.controller.abort(new Error('CANCEL_TURN'));
    }
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
      let consumedTokens = 0;
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
        if (this.maxTotalTokens !== undefined && consumedTokens >= this.maxTotalTokens) {
          throw new KernelError('TOKEN_BUDGET_EXCEEDED','Token budget exhausted before model request');
        }
        let messages = await this.context(sessionId);
        // Enforce deterministic serialized-character admission, with at most one explicit checkpoint attempt.
        let admission;
        if (this.maxContextCharacters !== undefined) {
          try { admission = admitContext(messages, stepAdmission, {maxSerializedCharacters: this.maxContextCharacters}); }
          catch (err) {
            if (!(err instanceof KernelError) || err.code !== 'CONTEXT_BUDGET_EXCEEDED') throw err;
            await this.compactOldContext(sessionId, ctl);
            messages = await this.context(sessionId);
            admission = admitContext(messages, stepAdmission, {maxSerializedCharacters: this.maxContextCharacters});
          }
        }
        await record({ type: 'model.started', turnId, data: { step, providerId: this.provider.id, ...stepAdmission,
          ...(admission === undefined ? {} : {contextSize: admission.serializedCharacters, contextLimit: admission.limit}) } });
        let completed: { message: AssistantMessage; finishReason: 'stop' | 'tool_use' | 'length' } | undefined;
        let usage: ModelTokenUsage | undefined;
        for await (const event of this.provider.stream(messages, ctl.controller.signal, stepAdmission)) {
          if (this.isCancelling(ctl)) throw new KernelError('CANCELLED', 'User cancelled');
          if (event.type === 'text_delta') this.onDelta?.(event.text, {sessionId, turnId});
          if (event.type === 'usage') {
            const u = event.usage;
            if (!Number.isSafeInteger(u.inputTokens) || !Number.isSafeInteger(u.outputTokens) || u.inputTokens < 0 || u.outputTokens < 0) {
              throw new KernelError('INVALID_PROVIDER_USAGE','Model usage must be nonnegative safe integers');
            }
            if (usage !== undefined && (u.inputTokens < usage.inputTokens || u.outputTokens < usage.outputTokens)) {
              throw new KernelError('INVALID_PROVIDER_USAGE','Usage snapshot cannot decrease within a model Step');
            }
            usage = structuredClone(u); // A provider may report interim snapshots: never sum them.
          }
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
        if (usage) {
          // Record the measured usage once per Step, before any tool execution or completion.
          await record({type:'model.usage',turnId,data:{step,usage}});
          consumedTokens += usage.inputTokens + usage.outputTokens;
        }
        if (this.maxTotalTokens !== undefined) {
          if (!usage) throw new KernelError('USAGE_UNAVAILABLE','Token limit needs provider-reported usage');
          if (consumedTokens > this.maxTotalTokens) throw new KernelError('TOKEN_BUDGET_EXCEEDED','Token budget exceeded; tools withheld');
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
