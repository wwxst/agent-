import { KernelError, type ToolCall, type ToolDefinition, type ToolExecutionContext, type ToolResult } from '../../contracts/src/index.js';

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void {
    if (!tool.name.trim() || !tool.version.trim() || this.byName.has(tool.name)) throw new Error(`Duplicate/invalid tool: ${tool.name}`);
    this.byName.set(tool.name, tool);
  }
  resolve(name: string): ToolDefinition | undefined { return this.byName.get(name); }
  get visibleTools(): readonly string[] { return [...this.byName.keys()]; }
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

async function invoke(item: Prepared, signal: AbortSignal, assertLease?: () => void, context?: Omit<ToolExecutionContext, 'callId'>): Promise<ToolResult> {
  if (item.immediate) return item.immediate;
  if (!item.definition) throw new Error('preflight invariant broken');
  if (signal.aborted) return errorResult(item.call, 'failed', 'CANCELLED_BEFORE_EXECUTION');
  // Do NOT catch a lease failure and turn it into an ordinary tool failure.
  // Owner loss must propagate to the Kernel without executing the body.
  assertLease?.();
  if (signal.aborted) return errorResult(item.call, 'failed', 'CANCELLED_BEFORE_EXECUTION');
  try {
    const text = await item.definition.execute(item.input, signal, context ? { ...context, callId: item.call.id } : undefined);
    return errorResult(item.call, 'succeeded', text);
  } catch (error) {
    if (error instanceof KernelError && error.code === 'LEASE_LOST') throw error;
    if (error instanceof KernelError && error.code === 'TOOL_OUTCOME_UNKNOWN') {
      return errorResult(item.call, 'outcome_unknown', 'HOST_EXECUTION_OUTCOME_UNKNOWN');
    }
    return errorResult(item.call, signal.aborted ? 'outcome_unknown' : 'failed', signal.aborted ? 'CANCELLED_DURING_EXECUTION' : 'TOOL_ERROR');
  }
}

/** Preflight is synchronous and ordered. Parallel read bodies run together; exclusive tools are barriers. */
export async function executeBatch(
  calls: readonly ToolCall[], registry: ToolRegistry, signal: AbortSignal,
  assertLease?: () => void, onResult?: (result: ToolResult) => Promise<void>,
  context?: Omit<ToolExecutionContext, 'callId'>,
): Promise<readonly ToolResult[]> {
  const prepared = preflight(calls, registry);
  // Every result (including denied/preflight failures) reaches the durable
  // receipt callback before the batch can report successful completion.
  // Callback failure must propagate; NEVER disguise it as a ToolResult failure.
  const commit = async (result: ToolResult): Promise<ToolResult> => {
    await onResult?.(result);
    return result;
  };
  const results: ToolResult[] = new Array(prepared.length);
  let group: Array<{ index: number; item: Prepared }> = [];
  const flush = async (): Promise<void> => {
    const tasks = group;
    group = [];
    // Drain all in-flight read calls before propagating lease failure so a
    // runner does not release the claim while parallel reads are still active.
    const settled = await Promise.allSettled(tasks.map(async ({ index, item }) => ({
      index, value: await commit(await invoke(item, signal, assertLease, context)),
    })));
    for (const item of settled) {
      if (item.status === 'fulfilled') results[item.value.index] = item.value.value;
    }
    const rejected = settled.find(item => item.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  };
  for (let index = 0; index < prepared.length; index++) {
    const item = prepared[index]!;
    if (item.immediate) { results[index] = await commit(item.immediate); continue; }
    if (item.definition?.concurrency === 'exclusive') {
      await flush();
      results[index] = await commit(await invoke(item, signal, assertLease));
    } else group.push({ index, item });
  }
  await flush();
  return results;
}
