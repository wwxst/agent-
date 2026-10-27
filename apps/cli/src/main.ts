import { randomUUID } from 'node:crypto';
import { OpenAICompatibleProvider } from '../../../packages/model-providers/src/openai-compatible.js';
import { AnthropicMessagesProvider } from '../../../packages/model-providers/src/anthropic-messages.js';
import { ManagedSessionRunner } from '../../../packages/session-runtime/src/index.js';
import { ToolRegistry } from '../../../packages/tool-scheduler/src/index.js';

const message=process.argv.slice(2).join(' ').trim();
const key=process.env.AGENT_API_KEY;
const model=process.env.AGENT_MODEL;
const type=process.env.AGENT_PROVIDER ?? 'openai-compatible';
const baseUrl=process.env.AGENT_API_BASE_URL;
const path=process.env.AGENT_DB_PATH ?? './agent-cli.sqlite';

function optionalPositive(name:string): number | undefined {
  const raw=process.env[name];
  if (raw === undefined) return undefined;
  const value=Number(raw);
  if (!Number.isSafeInteger(value) || value<1) throw new Error(name+' requires positive safe integer');
  return value;
}

if (!message || !key || !model || !['openai-compatible','anthropic'].includes(type) || !path.trim()) {
  console.error('Usage: AGENT_PROVIDER=openai-compatible|anthropic AGENT_API_KEY=<key> AGENT_MODEL=<model> [AGENT_DB_PATH=./agent-cli.sqlite] [AGENT_API_BASE_URL=https://.../v1] [AGENT_MAX_OUTPUT_TOKENS=1024] [AGENT_MAX_CONTEXT_CHARS=...] [AGENT_MAX_TURN_TOKENS=...] npm run cli -- "your prompt"');
  process.exitCode=2;
} else {
  try {
    const provider=type==='anthropic'
      ? new AnthropicMessagesProvider({apiKey:key,model,
          maxOutputTokens:optionalPositive('AGENT_MAX_OUTPUT_TOKENS')??1024,
          ...(baseUrl?{baseUrl}:{})})
      : new OpenAICompatibleProvider({apiKey:key,model,...(baseUrl?{baseUrl}:{})});
    const context=optionalPositive('AGENT_MAX_CONTEXT_CHARS');
    const tokens=optionalPositive('AGENT_MAX_TURN_TOKENS');
    // Deliberately no Shell/filesystem/web ToolDefinitions. A model cannot
    // grant itself a Tool capability via its JSON response.
    const runner=new ManagedSessionRunner(path,provider,new ToolRegistry(),{
      maxToolCalls:0,
      ...(context===undefined?{}:{maxContextCharacters:context}),
      ...(tokens===undefined?{}:{maxTotalTokens:tokens}),
    },delta=>process.stdout.write(delta));
    const sessionId=randomUUID();
    await runner.createSession(sessionId);
    const result=await runner.runTurn(sessionId,message,'cli-turn');
    process.stdout.write('\n');
    if(result.status!=='completed') {
      console.error('Turn '+result.status+': '+String(result.errorCode));
      process.exitCode=1;
    }
  } catch(error) {
    console.error(error instanceof Error ? error.message : 'Unexpected model error');
    process.exitCode=1;
  }
}
