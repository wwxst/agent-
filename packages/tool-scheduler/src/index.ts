import type { ToolCall, ToolDefinition, ToolResult, ToolSpec } from '../../contracts/src/index.js';

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();
  private generation = 0;
  register(tool: ToolDefinition): void {
    if (!tool.name.trim() || !tool.version.trim() || this.byName.has(tool.name)) throw new Error(`Duplicate/invalid tool: ${tool.name}`);
    const safeCopy: ToolDefinition = Object.freeze({
      ...tool,
      ...(tool.inputSchema === undefined ? {} : {inputSchema: structuredClone(tool.inputSchema)}),
    });
    this.byName.set(tool.name, safeCopy);
    this.generation++;
  }
  resolve(name: string): ToolDefinition | undefined { return this.byName.get(name); }
  get visibleTools(): readonly string[] { return [...this.byName.keys()]; }
  get version(): number { return this.generation; }
  /** Tool implementations and model-visible declarations are bound for one Step. */
  snapshot(): ToolRegistry {
    const copy = new ToolRegistry();
    for (const def of this.byName.values()) copy.register(def);
    copy.generation = this.generation;
    return copy;
  }
  modelSpecs(): readonly ToolSpec[] {
    return [...this.byName.values()]
      .filter(t => t.risk === 'read')
      .map(t => ({name: t.name, version: t.version, description: t.description ?? t.name,
        inputSchema: t.inputSchema === undefined ? {type: 'object'} : structuredClone(t.inputSchema)}));
  }
}

/** Hooks are owned by the Kernel, not by plugins. Failure to journal aborts execution. */
export interface ExecutionJournalHooks {
  beforeExecute(call: ToolCall, definition: ToolDefinition, parsedArguments: unknown): Promise<void>;
  afterExecute(call: ToolCall, result: ToolResult): Promise<void>;
}

interface Prepared {
  call: ToolCall;
  definition?: ToolDefinition;
  input?: unknown;
  immediate?: ToolResult;
}
const errorResult = (call: ToolCall, outcome: ToolResult['outcome'], text: string): ToolResult => ({
  callId: call.id, name: call.name, outcome, content: text,
});

/** M0 policy is fail-closed: only declared read-only tools can execute, and only in the fake host. */
export function preflight(calls: readonly ToolCall[], registry: ToolRegistry): readonly Prepared[] {
  const ids = new Set<string>();
  return calls.map(call => {
    if (!call.id || ids.has(call.id)) return { call, immediate: errorResult(call, 'failed', 'DUPLICATE_OR_EMPTY_CALL_ID') };
    ids.add(call.id);
    const definition = registry.resolve(call.name);
    if (!definition) return { call, immediate: errorResult(call, 'failed', 'UNKNOWN_TOOL') };
    if (definition.risk !== 'read') return { call, immediate: errorResult(call, 'denied', 'M0_DENIES_SIDE_EFFECTS') };
    try { return { call, definition, input: definition.parse(structuredClone(call.arguments)) }; }
    catch { return { call, immediate: errorResult(call, 'failed', 'INVALID_TOOL_ARGUMENTS') }; }
  });
}

async function invoke(item: Prepared, signal: AbortSignal, hooks?: ExecutionJournalHooks): Promise<ToolResult> {
  if (item.immediate) return item.immediate;
  if (!item.definition) throw new Error('preflight invariant broken');
  if (signal.aborted) return errorResult(item.call, 'failed', 'CANCELLED_BEFORE_EXECUTION');
  // A journal failure must escape: NEVER run a tool whose intent could not be committed.
  await hooks?.beforeExecute(item.call, item.definition, item.input);
  if (signal.aborted) return errorResult(item.call, 'outcome_unknown', 'CANCELLED_AFTER_INTENT');
  let result: ToolResult;
  try {
    const text = await item.definition.execute(item.input, signal);
    result = errorResult(item.call, 'succeeded', text);
  } catch {
    result = errorResult(item.call, signal.aborted ? 'outcome_unknown' : 'failed', signal.aborted ? 'CANCELLED_DURING_EXECUTION' : 'TOOL_ERROR');
  }
  // If the receipt write fails, never return a success to the Kernel/model.
  await hooks?.afterExecute(item.call, result);
  return result;
}

/** Preflight is synchronous and ordered. Parallel read bodies run together; exclusive tools are barriers. */
export async function executeBatch(calls: readonly ToolCall[], registry: ToolRegistry, signal: AbortSignal, hooks?: ExecutionJournalHooks): Promise<readonly ToolResult[]> {
  const prepared = preflight(calls, registry);
  const results: ToolResult[] = new Array(prepared.length);
  let group: Array<{ index: number; item: Prepared }> = [];
  const flush = async (): Promise<void> => {
    const tasks = group;
    group = [];
    // Await ALL already-started bodies, even if one receipt write fails; never
    // leave a body running beyond Turn failure just because Promise.all rejected early.
    const settled = await Promise.allSettled(tasks.map(async ({ index, item }) => ({ index, value: await invoke(item, signal, hooks) })));
    for (const item of settled) if (item.status === 'fulfilled') results[item.value.index] = item.value.value;
    const rejected = settled.find(x=>x.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  };
  for (let index = 0; index < prepared.length; index++) {
    const item = prepared[index]!;
    if (item.immediate) { results[index] = item.immediate; continue; }
    if (item.definition?.concurrency === 'exclusive') {
      await flush();
      results[index] = await invoke(item, signal, hooks);
    } else group.push({ index, item });
  }
  await flush();
  return results;
}
