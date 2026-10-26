/** M0 contracts. No provider, tool or storage implementation may own Kernel state. */
export type SessionId = string;
export type TurnId = string;
export type ToolCallId = string;

export type ToolCall = Readonly<{ id: ToolCallId; name: string; arguments: unknown }>;
export type ToolResult = Readonly<{
  callId: ToolCallId;
  name: string;
  outcome: 'succeeded' | 'failed' | 'denied' | 'outcome_unknown';
  content: string;
}>;
export type AssistantMessage = Readonly<{
  role: 'assistant';
  text: string;
  toolCalls: readonly ToolCall[];
}>;
export type ContextMessage =
  | Readonly<{ role: 'user'; text: string }>
  | Readonly<{ role: 'summary'; text: string }>
  | AssistantMessage
  | Readonly<{ role: 'tool'; result: ToolResult }>;

/** Tool calls only become executable when a complete message event is delivered. */
export type ProviderEvent =
  | Readonly<{ type: 'text_delta'; text: string }>
  | Readonly<{type: 'usage'; usage: ModelTokenUsage}>
  | Readonly<{
      type: 'message_complete';
      message: AssistantMessage;
      finishReason: 'stop' | 'tool_use' | 'length';
    }>;
/** Provider-reported usage, not an estimated tokenization of local text. */
export type ModelTokenUsage = Readonly<{inputTokens: number; outputTokens: number}>;
/** Frozen per model step: a provider cannot silently see the next step’s tool catalog. */
export interface ModelStepRequest {
  readonly stepId: string;
  readonly toolSetVersion: number;
  readonly tools: readonly ToolSpec[];
}
export interface ToolSpec {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: unknown;
}
export interface ModelProvider {
  readonly id: string;
  stream(messages: readonly ContextMessage[], signal: AbortSignal, step?: ModelStepRequest): AsyncIterable<ProviderEvent>;
}

export type Risk = 'read' | 'write' | 'external_side_effect';
export type Concurrency = 'parallel' | 'exclusive';
export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly risk: Risk;
  readonly concurrency: Concurrency;
  readonly description?: string;
  readonly inputSchema?: unknown;
  /** Must validate and normalize untrusted model arguments; must not have side effects. */
  parse(input: unknown): unknown;
  /** Fake/read-only host for M0 only. A production Host must return a separate receipt. */
  execute(input: unknown, signal: AbortSignal): Promise<string>;
}

export type TurnState = 'queued' | 'running_model' | 'running_tools' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type KernelEventType =
  | 'session.created' | 'turn.queued' | 'turn.started' | 'turn.cancel_requested'
  | 'user.message' | 'model.started' | 'assistant.message' | 'tool.result'
  | 'turn.completed' | 'turn.failed' | 'turn.cancelled'
  | 'turn.steer_queued' | 'turn.steer_consumed' | 'command.accepted' | 'model.usage' | 'context.checkpoint'
  | 'tool.intent' | 'tool.local_receipt' | 'tool.outcome_unknown';

export interface EventDraft {
  readonly type: KernelEventType;
  readonly turnId?: TurnId;
  readonly data: unknown;
}
export interface KernelEvent extends EventDraft {
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly eventId: string;
  readonly at: string;
}
export interface EventStore {
  /** Atomic compare-and-append per session; reject stale expectedSeq. */
  append(sessionId: SessionId, expectedSeq: number, events: readonly EventDraft[]): Promise<readonly KernelEvent[]>;
  read(sessionId: SessionId, afterSeq?: number): Promise<readonly KernelEvent[]>;
}
/** Durable Store capability. These operations MUST be atomic with journal events. */
export interface AcceptedCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  readonly acceptedSeq: number;
  readonly lastSeq: number;
  readonly replayed: boolean;
}
export type LocalReceiptOutcome = 'succeeded' | 'failed' | 'outcome_unknown';
export interface RecordedToolIntent {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly callId: ToolCallId;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly argsHash: string;
  readonly status: 'pending' | 'settled' | 'outcome_unknown';
  readonly receiptId?: string;
  readonly outcome?: LocalReceiptOutcome;
}
/** This is a TEST-ONLY in-process observation, NOT an authenticated OS ToolHost receipt. */
export interface DurableExecutionStore extends EventStore {
  acceptCommand(sessionId: SessionId, expectedSeq: number, commandId: string, kind: string,
    payload: unknown, accompanyingEvents?: readonly EventDraft[]): Promise<AcceptedCommand>;
  recordToolIntent(sessionId: SessionId, expectedSeq: number, turnId: TurnId,
    call: ToolCall, toolVersion: string, normalizedArguments: unknown): Promise<number>;
  recordLocalReceipt(sessionId: SessionId, expectedSeq: number, turnId: TurnId,
    result: ToolResult): Promise<number>;
  listToolIntents(sessionId: SessionId): Promise<readonly RecordedToolIntent[]>;
  markUnconfirmedToolsUnknown(sessionId: SessionId, expectedSeq: number): Promise<number>;
}
export function isDurableExecutionStore(store: EventStore): store is DurableExecutionStore {
  const x = store as Partial<DurableExecutionStore>;
  return typeof x.acceptCommand === 'function' && typeof x.recordToolIntent === 'function' &&
    typeof x.recordLocalReceipt === 'function' && typeof x.markUnconfirmedToolsUnknown === 'function';
}
export class ConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ConflictError'; }
}
export class KernelError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'KernelError'; }
}
