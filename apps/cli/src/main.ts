import { AgentKernel } from '../../../packages/kernel-core/src/index.js';
import { OpenAICompatibleProvider } from '../../../packages/model-providers/src/openai-compatible.js';
import { AnthropicMessagesProvider } from '../../../packages/model-providers/src/anthropic-messages.js';
import { MemoryEventStore } from '../../../packages/event-store-memory/src/index.js';
import { ToolRegistry } from '../../../packages/tool-scheduler/src/index.js';

const message = process.argv.slice(2).join(' ').trim();
const key = process.env.AGENT_API_KEY;
const model = process.env.AGENT_MODEL;
const type = process.env.AGENT_PROVIDER ?? 'openai-compatible';
const baseUrl = process.env.AGENT_API_BASE_URL;
function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw Error(`${name} must be a positive integer`);
  return value;
}
if (!message || !key || !model || !['openai-compatible', 'anthropic'].includes(type)) {
  console.error('Usage: AGENT_PROVIDER=openai-compatible|anthropic AGENT_API_KEY=<key> AGENT_MODEL=<model> [AGENT_API_BASE_URL=https://.../v1] [AGENT_MAX_OUTPUT_TOKENS=1024] [AGENT_MAX_CONTEXT_CHARS=...] [AGENT_MAX_TURN_TOKENS=...] npm run cli -- "Your prompt"');
  process.exitCode = 2;
} else {
  const ctrl = new AbortController();
  process.once('SIGINT', () => ctrl.abort());
  try {
    const provider = type === 'anthropic'
      ? new AnthropicMessagesProvider({apiKey:key,model,maxOutputTokens:positiveEnv('AGENT_MAX_OUTPUT_TOKENS') ?? 1024,
          ...(baseUrl ? {baseUrl} : {})})
      : new OpenAICompatibleProvider({apiKey:key,model,...(baseUrl ? {baseUrl} : {})});
    const maxContextCharacters = positiveEnv('AGENT_MAX_CONTEXT_CHARS');
    const maxTotalTokens = positiveEnv('AGENT_MAX_TURN_TOKENS');
    const kernel = new AgentKernel(new MemoryEventStore(),provider,new ToolRegistry(),
      {...(maxContextCharacters === undefined ? {} : {maxContextCharacters}),
        ...(maxTotalTokens === undefined ? {} : {maxTotalTokens})},text=>process.stdout.write(text));
    const session=await kernel.createSession();
    // The CLI registers NO OS/file/network tools. Providers only receive text capabilities.
    const work=kernel.runTurn(session,message,'cli-turn');
    if (ctrl.signal.aborted) await kernel.cancelTurn(session,'cli-turn');
    else ctrl.signal.addEventListener('abort',()=>void kernel.cancelTurn(session,'cli-turn'),{once:true});
    const result=await work;
    process.stdout.write('\n');
    if (result.status !== 'completed') {
      console.error(`Turn ${result.status}: ${result.errorCode}`);
      process.exitCode=1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unexpected error');
    process.exitCode=1;
  }
}
