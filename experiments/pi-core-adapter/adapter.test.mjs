import assert from "node:assert/strict";
import { test } from "node:test";
import { createKernelBoundaryAdapter } from "./kernel-boundary-adapter.mjs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const MODEL = {
  id: "kernel-boundary-spike",
  name: "kernel-boundary-spike",
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
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const toolCall = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
const text = value => ({ type: "text", text: value });
const response = (content, stopReason = "stop") => ({ content, stopReason });

function scriptedStream(responses, requests) {
  let index = 0;
  return async (model, context) => {
    requests.push(context.messages.map(message => structuredClone(message)));
    const next = responses[index++];
    if (!next) throw new Error("Unexpected extra model request in adapter experiment");
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
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: next.stopReason, message });
    return stream;
  };
}

function createJournal({ failIntentBatch = false, failReceipt = false, failUnknown = false, onReceiptCommitted } = {}) {
  const intentBatches = [];
  const receipts = [];
  const unknown = [];
  return {
    intentBatches,
    receipts,
    unknown,
    async commitIntentBatch(batch) {
      if (failIntentBatch) throw new Error("simulated atomic Intent batch failure");
      intentBatches.push(structuredClone(batch));
    },
    async hasIntent(callId) {
      return intentBatches.some(batch => batch.calls.some(call => call.id === callId));
    },
    async commitReceipt(receipt) {
      if (failReceipt) throw new Error("simulated Receipt persistence failure");
      receipts.push(structuredClone(receipt));
      await onReceiptCommitted?.(receipt);
    },
    async markOutcomeUnknown(record) {
      if (failUnknown) throw new Error("simulated UNKNOWN marker failure");
      unknown.push(structuredClone(record));
    },
    async hasUnresolved() {
      if (unknown.length > 0) return true;
      const receiptIds = new Set(receipts.map(receipt => receipt.callId));
      const intentIds = intentBatches.flatMap(batch => batch.calls.map(call => call.id));
      return intentIds.some(callId => !receiptIds.has(callId));
    },
  };
}

function hostReceipt(callId, name) {
  return { callId, toolName: name, receiptId: `receipt-${callId}`, outcome: "success" };
}

test("adapter: commits one complete Intent batch before parallel tools and preserves result order", { timeout: 5000 }, async () => {
  let releaseSlow;
  const fastReceiptCommitted = new Promise(resolve => { releaseSlow = resolve; });
  const journal = createJournal({
    onReceiptCommitted: async receipt => {
      if (receipt.callId === "fast") releaseSlow();
    },
  });
  const host = {
    started: [],
    completed: [],
    async execute({ callId, name }) {
      this.started.push(callId);
      if (callId === "slow") await fastReceiptCommitted;
      this.completed.push(callId);
      return { status: "success", output: `${name}-output`, receipt: hostReceipt(callId, name) };
    },
  };
  const requests = [];
  const adapter = createKernelBoundaryAdapter({
    model: MODEL,
    streamFn: scriptedStream([
      response([toolCall("slow", "slow"), toolCall("fast", "fast")], "toolUse"),
      response([text("done")], "stop"),
    ], requests),
    journal,
    host,
    toolNames: ["slow", "fast"],
  });

  const outcome = await adapter.run("run both tools", "turn-atomic");
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(journal.intentBatches.length, 1, "the batch is committed in one journal operation");
  assert.equal(journal.intentBatches[0].turnId, "turn-atomic");
  assert.deepEqual(journal.intentBatches[0].calls.map(call => call.id), ["slow", "fast"]);
  assert.deepEqual(host.completed, ["fast", "slow"], "trusted Host completion order is retained");
  assert.deepEqual(journal.receipts.map(receipt => receipt.callId), ["fast", "slow"]);
  assert.deepEqual(
    (requests[1] ?? []).filter(message => message.role === "toolResult").map(message => message.toolCallId),
    ["slow", "fast"],
    "Pi's model transcript remains in original ToolCall order",
  );
  assert.equal(await journal.hasUnresolved(), false);
});

test("adapter: failed atomic Intent commit blocks every tool and blocks reuse of stale Agent state", { timeout: 5000 }, async () => {
  const journal = createJournal({ failIntentBatch: true });
  const host = {
    started: [],
    async execute(input) {
      this.started.push(input.callId);
      return { status: "success", output: "must-not-run", receipt: hostReceipt(input.callId, input.name) };
    },
  };
  const requests = [];
  const adapter = createKernelBoundaryAdapter({
    model: MODEL,
    streamFn: scriptedStream([
      response([toolCall("a", "read-a"), toolCall("b", "read-b")], "toolUse"),
      response([text("must-not-be-requested")], "stop"),
    ], requests),
    journal,
    host,
    toolNames: ["read-a", "read-b"],
  });

  const outcome = await adapter.run("read two things", "turn-intent-fail");
  assert.equal(outcome.status, "FAILED_INTENT_PERSISTENCE");
  assert.equal(journal.intentBatches.length, 0);
  assert.deepEqual(host.started, [], "no tool starts after batch persistence fails");
  assert.equal(requests.length, 1);
  await assert.rejects(adapter.run("blind retry", "turn-retry"), { code: "RECOVERY_REQUIRED" });
  assert.equal(requests.length, 1, "stale in-memory transcript is never blindly replayed");
});

test("adapter: Receipt persistence failure becomes OUTCOME_UNKNOWN and forbids replay", { timeout: 5000 }, async () => {
  const journal = createJournal({ failReceipt: true });
  const host = {
    started: [],
    async execute({ callId, name }) {
      this.started.push(callId);
      return { status: "success", output: "effect may have occurred", receipt: hostReceipt(callId, name) };
    },
  };
  const requests = [];
  const adapter = createKernelBoundaryAdapter({
    model: MODEL,
    streamFn: scriptedStream([
      response([toolCall("effect-1", "write-like")], "toolUse"),
      response([text("must-not-continue")], "stop"),
    ], requests),
    journal,
    host,
    toolNames: ["write-like"],
  });

  const outcome = await adapter.run("perform one effect", "turn-receipt-fail");
  assert.equal(outcome.status, "OUTCOME_UNKNOWN");
  assert.deepEqual(host.started, ["effect-1"]);
  assert.equal(journal.receipts.length, 0);
  assert.equal(journal.unknown.length, 1);
  assert.equal(await journal.hasUnresolved(), true);
  assert.equal(requests.length, 1, "Pi must not receive a follow-up request after UNKNOWN");
  await assert.rejects(adapter.run("retry effect", "turn-retry"), { code: "RECOVERY_REQUIRED" });
  assert.equal(requests.length, 1);
});

test("adapter: if UNKNOWN marker persistence also fails, the unresolved Intent still blocks replay", { timeout: 5000 }, async () => {
  const journal = createJournal({ failReceipt: true, failUnknown: true });
  const host = {
    async execute({ callId, name }) {
      return { status: "success", output: "effect may have occurred", receipt: hostReceipt(callId, name) };
    },
  };
  const requests = [];
  const adapter = createKernelBoundaryAdapter({
    model: MODEL,
    streamFn: scriptedStream([
      response([toolCall("effect-2", "write-like")], "toolUse"),
      response([text("must-not-continue")], "stop"),
    ], requests),
    journal,
    host,
    toolNames: ["write-like"],
  });

  const outcome = await adapter.run("perform one effect", "turn-unknown-marker-fail");
  assert.equal(outcome.status, "OUTCOME_UNKNOWN");
  assert.equal(journal.unknown.length, 0, "the UNKNOWN marker itself failed");
  assert.equal(await journal.hasUnresolved(), true, "unreceipted durable Intent remains a recovery blocker");
  assert.equal(requests.length, 1);
  await assert.rejects(adapter.run("retry effect", "turn-retry"), { code: "RECOVERY_REQUIRED" });
  assert.equal(requests.length, 1);
});
