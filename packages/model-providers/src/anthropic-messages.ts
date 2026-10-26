import {KernelError, type ContextMessage, type ModelProvider, type ModelStepRequest, type ProviderEvent, type ToolCall} from '../../contracts/src/index.js';
import {decodeSse} from './openai-compatible.js';

type Obj = Record<string, unknown>;
const obj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
function invalid(code: string): never {throw new KernelError(code, `Invalid Anthropic Messages stream: ${code}`);}

export interface AnthropicMessagesOptions {
  readonly model: string;
  readonly apiKey: string;
  readonly maxOutputTokens: number;
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly maxSseFrameBytes?: number;
}

function history(messages: readonly ContextMessage[]): Obj[] {
  const result: Obj[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({role: 'user', content: [{type: 'text', text: msg.text}]});
    } else if (msg.role === 'assistant') {
      const blocks: Obj[] = [];
      if (msg.text) blocks.push({type: 'text', text: msg.text});
      for (const call of msg.toolCalls) {
        blocks.push({type: 'tool_use', id: call.id, name: call.name, input: call.arguments});
      }
      result.push({role: 'assistant', content: blocks});
    } else {
      const block = {type: 'tool_result', tool_use_id: msg.result.callId,
        content: msg.result.content, is_error: msg.result.outcome !== 'succeeded'};
      const last = result[result.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) &&
          last.content.some((x: unknown) => obj(x) && x.type === 'tool_result')) {
        (last.content as Obj[]).push(block);
      } else result.push({role: 'user', content: [block]});
    }
  }
  return result;
}

type Block = {kind: 'text'; text: string} | {kind: 'tool'; id: string; name: string; json: string; initial: unknown};

/** Native Anthropic Messages SSE adapter. No SDK/other Agent runtime dependency. */
export class AnthropicMessagesProvider implements ModelProvider {
  readonly id: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly limit: number;
  constructor(private readonly options: AnthropicMessagesOptions) {
    if (!options.model.trim() || !options.apiKey.trim() || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) {
      throw new KernelError('PROVIDER_CONFIG', 'Missing model, API key or valid maxOutputTokens');
    }
    const base = new URL((options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '') + '/');
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) ||
        base.username || base.password || base.hash || base.search) throw new KernelError('INSECURE_PROVIDER_URL', 'Invalid Anthropic API root');
    this.endpoint = new URL('messages', base).toString();
    this.fetcher = options.fetcher ?? fetch;
    this.limit = options.maxSseFrameBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.limit) || this.limit < 128) throw new KernelError('PROVIDER_CONFIG', 'Invalid SSE limit');
    this.id = `anthropic:${options.model}`;
  }
  async *stream(messages: readonly ContextMessage[], signal: AbortSignal, step?: ModelStepRequest): AsyncIterable<ProviderEvent> {
    const req = {
      model: this.options.model,
      max_tokens: this.options.maxOutputTokens,
      stream: true,
      messages: history(messages),
      ...(step?.tools.length ? {tools: step.tools.map(t=>({name:t.name, description:t.description, input_schema:t.inputSchema}))} : {}),
    };
    const response = await this.fetcher(this.endpoint, {method:'POST',signal,redirect:'error',
      headers: {'content-type':'application/json','accept':'text/event-stream',
        'x-api-key':this.options.apiKey,'anthropic-version':'2023-06-01'}, body:JSON.stringify(req)});
    if (!response.ok) throw new KernelError('PROVIDER_HTTP_ERROR', `Provider HTTP ${response.status}`);
    if (!response.body) throw new KernelError('PROVIDER_NO_STREAM', 'Missing stream body');
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      throw new KernelError('PROVIDER_CONTENT_TYPE', 'Expected text/event-stream');
    }
    let started = false, stopped = false, reason: string | undefined;
    let text = '';
    const blocks = new Map<number, Block>();
    const closed = new Set<number>();
    let totalArgumentChars = 0;
    for await (const data of decodeSse(response.body, signal, this.limit)) {
      let msg: unknown;
      try {msg = JSON.parse(data);} catch {invalid('MALFORMED_SSE_JSON');}
      if (!obj(msg) || typeof msg.type !== 'string') invalid('MALFORMED_CHUNK');
      if (msg.type === 'ping') continue;
      if (msg.type === 'error') invalid('PROVIDER_API_ERROR');
      if (stopped) invalid('DELTA_AFTER_STOP');
      if (msg.type === 'message_start') {
        if (started || !obj(msg.message) || msg.message.role !== 'assistant') invalid('INVALID_MESSAGE_START');
        started = true;
      } else if (msg.type === 'content_block_start') {
        if (!started || !Number.isSafeInteger(msg.index) || (msg.index as number) < 0 || (msg.index as number) > 63 ||
            !obj(msg.content_block) || blocks.has(msg.index as number)) invalid('INVALID_BLOCK_START');
        const index = msg.index as number;
        const cb = msg.content_block as Obj;
        if (cb.type === 'text' && typeof cb.text === 'string') {
          blocks.set(index, {kind:'text',text:cb.text});
          if (cb.text) {text += cb.text; yield {type:'text_delta', text:cb.text};}
        } else if (cb.type === 'tool_use' && typeof cb.id === 'string' && cb.id && typeof cb.name === 'string' && cb.name) {
          blocks.set(index,{kind:'tool',id:cb.id,name:cb.name,json:'',initial:cb.input});
        } else invalid('UNSUPPORTED_ANTHROPIC_BLOCK');
      } else if (msg.type === 'content_block_delta') {
        const index = msg.index;
        if (!Number.isSafeInteger(index) || !obj(msg.delta) || closed.has(index as number)) invalid('INVALID_BLOCK_DELTA');
        const block = blocks.get(index as number);
        if (!block) invalid('INVALID_BLOCK_DELTA');
        const delta = msg.delta as Obj;
        if (block.kind === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text;
          if (text.length > this.limit * 8) invalid('MODEL_OUTPUT_LIMIT');
          if (delta.text) yield {type:'text_delta',text:delta.text};
        } else if (block.kind === 'tool' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.json += delta.partial_json;
          totalArgumentChars += delta.partial_json.length;
          if (totalArgumentChars > this.limit) invalid('TOOL_ARGUMENT_LIMIT');
        } else invalid('UNSUPPORTED_ANTHROPIC_DELTA');
      } else if (msg.type === 'content_block_stop') {
        if (!Number.isSafeInteger(msg.index) || !blocks.has(msg.index as number) || closed.has(msg.index as number)) invalid('INVALID_BLOCK_STOP');
        closed.add(msg.index as number);
      } else if (msg.type === 'message_delta') {
        if (!started || !obj(msg.delta) || typeof msg.delta.stop_reason !== 'string' || reason !== undefined) invalid('INVALID_MESSAGE_DELTA');
        reason = msg.delta.stop_reason;
      } else if (msg.type === 'message_stop') {
        if (!started || stopped || reason === undefined) invalid('INVALID_MESSAGE_STOP');
        stopped = true;
      } else invalid('UNKNOWN_ANTHROPIC_EVENT');
    }
    if (!stopped || !started || reason === undefined || blocks.size !== closed.size) invalid('INCOMPLETE_PROVIDER_STREAM');
    if (!['end_turn','tool_use','max_tokens','stop_sequence'].includes(reason)) invalid('UNSUPPORTED_FINISH_REASON');
    const toolCalls: ToolCall[] = [];
    const used = new Set<string>();
    for (const [,block] of [...blocks.entries()].sort((a,b)=>a[0]-b[0])) {
      if (block.kind !== 'tool') continue;
      if (used.has(block.id)) invalid('DUPLICATE_TOOL_ID');
      used.add(block.id);
      let input: unknown = block.initial;
      if (block.json) {
        try {input = JSON.parse(block.json);} catch {invalid('INCOMPLETE_TOOL_ARGUMENTS');}
      }
      if (!obj(input)) invalid('INVALID_TOOL_ARGUMENTS');
      toolCalls.push({id:block.id,name:block.name,arguments:input});
    }
    if (reason === 'tool_use' && toolCalls.length === 0) invalid('INCOMPLETE_TOOL_CALL');
    if (reason !== 'tool_use' && reason !== 'max_tokens' && toolCalls.length) invalid('INVALID_STOP_REASON');
    yield {type:'message_complete',message:{role:'assistant',text,toolCalls},
      finishReason:reason === 'tool_use' ? 'tool_use' : reason === 'max_tokens' ? 'length' : 'stop'};
  }
}
