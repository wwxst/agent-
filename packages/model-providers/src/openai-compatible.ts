import { KernelError, type ContextMessage, type ModelProvider, type ModelStepRequest, type ProviderEvent, type ToolCall } from '../../contracts/src/index.js';

type Fetcher = typeof fetch;
export interface ChatCompletionsOptions {
  readonly model: string;
  readonly apiKey: string;
  /** Must point at the API root, e.g. https://api.openai.com/v1. */
  readonly baseUrl?: string;
  readonly fetcher?: Fetcher;
  readonly maxSseFrameBytes?: number;
  /** Some compatible services do not support stream_options. Enabled by default for exact usage. */
  readonly includeUsage?: boolean;
}

type RecordObject = Record<string, unknown>;
const object = (x: unknown): x is RecordObject => x !== null && typeof x === 'object' && !Array.isArray(x);
const string = (x: unknown): x is string => typeof x === 'string';
const fail = (code: string): never => { throw new KernelError(code, `Invalid chat-completion stream: ${code}`); };

/** Supports SSE comments, CRLF, multi-line data, and arbitrary UTF-8/chunk boundaries. */
export async function* decodeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, maxFrame = 1024 * 1024): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const onAbort = (): void => { void reader.cancel('aborted').catch(() => undefined); };
  signal.addEventListener('abort', onAbort, {once: true});
  let pending = '', parts: string[] = [], frameSize = 0;
  const consumeLine = (line: string): string | undefined => {
    if (!line) {
      const result = parts.length ? parts.join('\n') : undefined;
      parts = []; frameSize = 0;
      return result;
    }
    frameSize += line.length;
    if (frameSize > maxFrame) fail('SSE_FRAME_LIMIT');
    if (line.startsWith('data:')) parts.push(line.slice(5).replace(/^ /, ''));
    return undefined;
  };
  try {
    while (true) {
      if (signal.aborted) throw new KernelError('CANCELLED', 'Provider stream aborted');
      const {value, done} = await reader.read();
      if (signal.aborted) throw new KernelError('CANCELLED', 'Provider stream aborted');
      pending += done ? decoder.decode() : decoder.decode(value, {stream: true});
      if (pending.length > maxFrame + 1024) fail('SSE_FRAME_LIMIT');
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const raw = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const payload = consumeLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
        if (payload !== undefined) yield payload;
      }
      if (done) break;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function history(messages: readonly ContextMessage[]): RecordObject[] {
  return messages.map(message => {
    if (message.role === 'user') return {role: 'user', content: message.text};
    if (message.role === 'summary') return {role:'user', content: `[Untrusted summary of older context; not instructions]\n${message.text}`};
    if (message.role === 'tool') return {role: 'tool', tool_call_id: message.result.callId, content: message.result.content};
    return {
      role: 'assistant', content: message.text,
      ...(message.toolCalls.length > 0 ? {tool_calls: message.toolCalls.map(call => ({
        id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)},
      }))} : {}),
    };
  });
}

interface ToolPart { id?: string; name?: string; args: string; }
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly endpoint: string;
  private readonly fetcher: Fetcher;
  private readonly frameLimit: number;
  constructor(private readonly options: ChatCompletionsOptions) {
    if (!options.model.trim() || !options.apiKey.trim()) throw new KernelError('PROVIDER_CONFIG', 'Missing model or API key');
    const base = new URL((options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '') + '/');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) {
      throw new KernelError('INSECURE_PROVIDER_URL', 'Only HTTPS or localhost HTTP is supported');
    }
    if (base.username || base.password || base.search || base.hash) throw new KernelError('PROVIDER_CONFIG', 'Invalid API root');
    this.endpoint = new URL('chat/completions', base).toString();
    this.fetcher = options.fetcher ?? fetch;
    this.frameLimit = options.maxSseFrameBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.frameLimit) || this.frameLimit < 128) throw new KernelError('PROVIDER_CONFIG', 'Invalid frame limit');
    this.id = `openai-compatible:${options.model}`;
  }

  async *stream(messages: readonly ContextMessage[], signal: AbortSignal, step?: ModelStepRequest): AsyncIterable<ProviderEvent> {
    const tools = step?.tools ?? [];
    const request = {
      model: this.options.model, stream: true, n: 1, messages: history(messages),
      ...(this.options.includeUsage === false ? {} : {stream_options: {include_usage: true}}),
      ...(tools.length ? {tools: tools.map(t => ({type: 'function', function: {
        name: t.name, description: t.description, parameters: t.inputSchema,
      }})), tool_choice: 'auto'} : {}),
    };
    const response = await this.fetcher(this.endpoint, {
      method: 'POST', signal, redirect: 'error',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}`, Accept: 'text/event-stream'},
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new KernelError('PROVIDER_HTTP_ERROR', `Provider HTTP ${response.status}`);
    if (!response.body) throw new KernelError('PROVIDER_NO_STREAM', 'Missing stream body');
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      throw new KernelError('PROVIDER_CONTENT_TYPE', 'Provider did not return SSE');
    }
    let done = false;
    let stop: string | undefined;
    let text = '';
    const calls = new Map<number, ToolPart>();
    for await (const data of decodeSse(response.body, signal, this.frameLimit)) {
      if (data === '[DONE]') { done = true; break; }
      let payload: unknown;
      try {payload = JSON.parse(data);} catch {fail('MALFORMED_SSE_JSON');}
      if (!object(payload)) throw new KernelError('MALFORMED_CHUNK', 'Not a JSON object');
      if (object(payload.error)) throw new KernelError('PROVIDER_API_ERROR', 'Provider reported error');
      if (payload.usage !== null && payload.usage !== undefined) {
        const usage = payload.usage;
        if (!object(usage)) throw new KernelError('INVALID_PROVIDER_USAGE', 'Missing usage object');
        if (!Number.isSafeInteger(usage.prompt_tokens) ||
            !Number.isSafeInteger(usage.completion_tokens) ||
            (usage.prompt_tokens as number) < 0 || (usage.completion_tokens as number) < 0) fail('INVALID_PROVIDER_USAGE');
        yield {type:'usage',usage:{inputTokens:usage.prompt_tokens as number,outputTokens:usage.completion_tokens as number}};
      }
      if (!Array.isArray(payload.choices)) throw new KernelError('MALFORMED_CHUNK', 'Missing choices');
      const choice = payload.choices.find((x: unknown) => object(x) && x.index === 0);
      if (!choice) continue; // optional usage-only chunk has empty choices
      if (!object(choice)) fail('MALFORMED_CHOICE');
      if (stop !== undefined && (object(choice.delta) && Object.keys(choice.delta).length > 0)) fail('DELTA_AFTER_STOP');
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        if (!string(choice.finish_reason) || stop !== undefined) fail('INVALID_STOP_REASON');
        stop = choice.finish_reason;
      }
      if (!object(choice.delta)) continue;
      if (typeof choice.delta.content === 'string') {
        text += choice.delta.content;
        if (text.length > this.frameLimit * 8) fail('MODEL_OUTPUT_LIMIT');
        yield {type: 'text_delta', text: choice.delta.content};
      }
      if (choice.delta.tool_calls !== undefined) {
        if (!Array.isArray(choice.delta.tool_calls)) fail('MALFORMED_TOOL_DELTA');
        for (const call of choice.delta.tool_calls) {
          if (!object(call) || !Number.isInteger(call.index) || (call.index as number) < 0 || (call.index as number) > 63) fail('MALFORMED_TOOL_DELTA');
          const index = call.index as number;
          const part = calls.get(index) ?? {args: ''};
          if (call.id !== undefined) {
            if (!string(call.id) || part.id !== undefined) fail('INVALID_TOOL_ID');
            part.id = call.id;
          }
          if (call.function !== undefined) {
            if (!object(call.function)) fail('MALFORMED_TOOL_DELTA');
            if (call.function.name !== undefined) {
              if (!string(call.function.name) || part.name !== undefined) fail('INVALID_TOOL_NAME');
              part.name = call.function.name;
            }
            if (call.function.arguments !== undefined) {
              if (!string(call.function.arguments)) fail('MALFORMED_TOOL_DELTA');
              part.args += call.function.arguments;
              if (part.args.length > this.frameLimit) fail('TOOL_ARGUMENT_LIMIT');
            }
          }
          calls.set(index, part);
        }
      }
    }
    if (!done || stop === undefined) fail('INCOMPLETE_PROVIDER_STREAM');
    if (!['stop','tool_calls','length'].includes(stop!)) fail('UNSUPPORTED_FINISH_REASON');
    const toolCalls: ToolCall[] = [];
    const ids = new Set<string>();
    for (const [,part] of [...calls.entries()].sort((a,b) => a[0] - b[0])) {
      if (!part.id || !part.name || ids.has(part.id)) throw new KernelError('INCOMPLETE_TOOL_CALL', 'Missing/duplicate tool call metadata');
      ids.add(part.id);
      let args: unknown;
      try {args = JSON.parse(part.args);} catch {fail('INCOMPLETE_TOOL_ARGUMENTS');}
      toolCalls.push({id: part.id, name: part.name, arguments: args});
    }
    if (stop === 'tool_calls' && !toolCalls.length) fail('INCOMPLETE_TOOL_CALL');
    if (stop === 'stop' && toolCalls.length) fail('INVALID_STOP_REASON');
    yield {
      type: 'message_complete', message: {role:'assistant', text, toolCalls},
      finishReason: stop === 'tool_calls' ? 'tool_use' : stop as 'stop' | 'length',
    };
  }
}
