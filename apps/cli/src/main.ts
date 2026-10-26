import { AgentKernel } from '../../../packages/kernel-core/src/index.js';
import { OpenAICompatibleProvider } from '../../../packages/model-providers/src/openai-compatible.js';
import { MemoryEventStore } from '../../../packages/event-store-memory/src/index.js';
import { ToolRegistry } from '../../../packages/tool-scheduler/src/index.js';

const message = process.argv.slice(2).join(' ').trim();
const key = process.env.AGENT_API_KEY;
const model = process.env.AGENT_MODEL;
if (!message || !key || !model) {
  console.error('Usage: AGENT_API_KEY=<key> AGENT_MODEL=<chat-completions-model> [AGENT_API_BASE_URL=https://.../v1] npm run cli -- "Your prompt"');
  process.exitCode = 2;
} else {
  const ctrl = new AbortController();
  process.once('SIGINT', () => ctrl.abort());
  try {
    const provider = new OpenAICompatibleProvider({apiKey:key, model,
      ...(process.env.AGENT_API_BASE_URL ? {baseUrl: process.env.AGENT_API_BASE_URL} : {})});
    const kernel = new AgentKernel(new MemoryEventStore(), provider, new ToolRegistry(), {}, text => process.stdout.write(text));
    const session = await kernel.createSession();
    // M1 CLI intentionally registers NO OS/file tools.
    const work = kernel.runTurn(session, message, 'cli-turn');
    if (ctrl.signal.aborted) await kernel.cancelTurn(session, 'cli-turn');
    else ctrl.signal.addEventListener('abort', () => void kernel.cancelTurn(session, 'cli-turn'), {once:true});
    const result = await work;
    process.stdout.write('\n');
    if (result.status !== 'completed') {
      console.error(`Turn ${result.status}: ${result.errorCode}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unexpected error');
    process.exitCode = 1;
  }
}
