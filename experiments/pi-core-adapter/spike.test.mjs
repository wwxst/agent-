import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const MODEL = {
  id: "deterministic-spike",
  name: "deterministic-spike",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "http://127.0.0.1",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 8192,
  maxTokens: 1024,
};

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const toolCall = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
const text = value => ({ type: "text", text: value });
const response = (content, stopReason = "stop") => ({ content, stopReason });

function createResponseStream(model, next) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: next.content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: next.stopReason,
    timestamp: Date.now(),
  };
  stream.push({
    type: "start",
    partial: { ...message, content: [], stopReason: "pending" },
  });
  stream.push({ type: "done", reason: next.stopReason, message });
  return stream;
}

function makeTool(name, execute) {
  return {
    name,
    label: name,
    description: "Deterministic read-only adapter-spike tool",
    parameters: Type.Object({}),
    execute: async (toolCallId, params, signal) => ({
      content: [{ type: "text", text: await execute(toolCallId, params, signal) }],
      details: { toolCallId },
    }),
  };
}

function makeAgent(responses, tools, requests = []) {
  let index = 0;
  const streamFn = async (model, context) => {
    requests.push(context.messages.map(message => structuredClone(message)));
    const next = responses[index++];
    if (!next) throw new Error("Unexpected extra model request in deterministic Pi spike");
    return createResponseStream(model, next);
  };
  const agent = new Agent({
    initialState: { systemPrompt: "Deterministic adapter spike only.", model: { ...MODEL }, tools },
    streamFn,
    toolExecution: "parallel",
  });
  return agent;
}

test("Pi Core: awaited message_end listener is a pre-execution intent barrier", { timeout: 5000 }, async () => {
  const intents = new Set();
  let executionStarts = 0;
  let releaseCommit;
  let announceBarrier;
  const commitGate = new Promise(resolve => { releaseCommit = resolve; });
  const barrierReached = new Promise(resolve => { announceBarrier = resolve; });
  const agent = makeAgent([
    response([toolCall("read-1", "read")], "toolUse"),
    response([text("done")], "stop"),
  ], [makeTool("read", async () => "read-result")]);

  agent.subscribe(async event => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const calls = event.message.content.filter(item => item.type === "toolCall");
      if (calls.length > 0) {
        announceBarrier();
        await commitGate;
        for (const call of calls) intents.add(call.id);
      }
    }
    if (event.type === "tool_execution_start") {
      assert.ok(intents.has(event.toolCallId), "tool started before its intent barrier completed");
      executionStarts++;
    }
  });

  const running = agent.prompt("run the read tool");
  await barrierReached;
  assert.equal(executionStarts, 0, "no tool starts while durable intent persistence is blocked");
  releaseCommit();
  await running;
  assert.equal(executionStarts, 1);
  assert.equal(agent.state.errorMessage, undefined);
});

test("Pi Core: reverse completion keeps model-visible tool results in source order", { timeout: 5000 }, async () => {
  let releaseSlow;
  const fastEnded = new Promise(resolve => { releaseSlow = resolve; });
  const completionOrder = [];
  const intentIds = new Set();
  const requests = [];
  const agent = makeAgent([
    response([toolCall("slow", "slow"), toolCall("fast", "fast")], "toolUse"),
    response([text("done")], "stop"),
  ], [
    makeTool("slow", async () => {
      await fastEnded;
      return "slow-result";
    }),
    makeTool("fast", async () => "fast-result"),
  ], requests);

  agent.subscribe(async event => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      for (const call of event.message.content.filter(item => item.type === "toolCall")) {
        intentIds.add(call.id);
      }
    }
    if (event.type === "tool_execution_start") {
      assert.ok(intentIds.has(event.toolCallId), "tool started without its batch intent");
    }
    if (event.type === "tool_execution_end") {
      completionOrder.push(event.toolCallId);
      if (event.toolCallId === "fast") releaseSlow();
    }
  });

  await agent.prompt("run slow and fast in parallel");
  assert.deepEqual(completionOrder, ["fast", "slow"], "completion events expose actual completion order");
  assert.deepEqual(
    agent.state.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId),
    ["slow", "fast"],
    "stored model transcript uses source-call order",
  );
  assert.deepEqual(
    (requests[1] ?? []).filter(message => message.role === "toolResult").map(message => message.toolCallId),
    ["slow", "fast"],
    "the next provider request receives source-call order",
  );
});

test("Pi Core: truncated tool arguments are rejected without executing the tool", { timeout: 5000 }, async () => {
  let executions = 0;
  const requests = [];
  const agent = makeAgent([
    response([toolCall("truncated", "read")], "length"),
    response([text("retry with complete arguments")], "stop"),
  ], [makeTool("read", async () => { executions++; return "must-not-run"; })], requests);

  await agent.prompt("read with truncated output");
  const results = agent.state.messages.filter(message => message.role === "toolResult");
  assert.equal(executions, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  assert.equal(requests.length, 2, "Pi reports the rejected tool call and allows a subsequent model turn");
});

test("Pi Core: intent persistence failure prevents the requested tool from starting", { timeout: 5000 }, async () => {
  let executions = 0;
  const agent = makeAgent([
    response([toolCall("blocked", "read")], "toolUse"),
  ], [makeTool("read", async () => { executions++; return "must-not-run"; })]);

  agent.subscribe(async event => {
    if (event.type === "message_end" && event.message.role === "assistant"
      && event.message.content.some(item => item.type === "toolCall")) {
      throw new Error("simulated durable intent failure");
    }
  });

  await agent.prompt("read with failed intent persistence");
  assert.equal(executions, 0);
  assert.match(agent.state.errorMessage ?? "", /simulated durable intent failure/);
});
