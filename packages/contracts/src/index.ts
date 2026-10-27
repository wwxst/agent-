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
  | AssistantMessage
  | Readonly<{ role: 'tool'; result: ToolResult }>;

/** Tool calls only become executable when a complete message event is delivered. */
export type ProviderEvent =
  | Readonly<{ type: 'text_delta'; text: string }>
  | Readonly<{
      type: 'message_complete';
      message: AssistantMessage;
      finishReason: 'stop' | 'tool_use' | 'length';
    }>;
export interface ModelProvider {
  readonly id: string;
  stream(messages: readonly ContextMessage[], signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export type Risk = 'read' | 'write' | 'external_side_effect';
export type Concurrency = 'parallel' | 'exclusive';
export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly risk: Risk;
  readonly concurrency: Concurrency;
  /** Must validate and normalize untrusted model arguments; must not have side effects. */
  parse(input: unknown): unknown;
  /** Fake/read-only host for M0 only. A production Host must return a separate receipt. */
  execute(input: unknown, signal: AbortSignal): Promise<string>;
}

export type TurnState = 'queued' | 'running_model' | 'running_tools' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type KernelEventType =
  | 'session.created' | 'turn.queued' | 'turn.started' | 'turn.cancel_requested'
  | 'user.message' | 'model.started' | 'assistant.message' | 'tool.intent' | 'tool.receipt' | 'tool.result'
  | 'turn.completed' | 'turn.failed' | 'turn.cancelled';

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
export class ConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ConflictError'; }
}
export class KernelError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'KernelError'; }
}
