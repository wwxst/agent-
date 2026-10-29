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

function createJournal({
  failIntentBatch = false,
  failReceipt = false,
  failReceiptFor = [],
  failUnknown = false,
  onHasIntent,
  onReceiptCommitted,
  onUnknownMarked,
} = {}) {
  const assistantMessages = [];
  const intentBatches = [];
  const receipts = [];
  const unknown = [];
  return {
    assistantMessages,
    intentBatches,
    receipts,
    unknown,
    async commitAssistantMessage(record) {
      if (failIntentBatch && record.intents.length > 0) {
        throw new Error("simulated atomic Assistant+Intent batch failure");
      }
      // The experiment treats this method as one transaction: either both the
      // Assistant message and all executable Intents become durable, or none do.
      assistantMessages.push(structuredClone({
        turnId: record.turnId,
        message: record.assistantMessage,
        intents: record.intents,
      }));
      if (record.intents.length > 0) {
        intentBatches.push({ turnId: record.turnId, calls: structuredClone(record.intents) });
      }
    },
    async hasIntent(callId) {
      await onHasIntent?.(callId);
      return intentBatches.some(batch => batch.calls.some(call => call.id === callId));
    },
    async commitReceipt(receipt) {
      if (failReceipt || failReceiptFor.includes(receipt.callId)) {
        throw new Error("simulated Receipt persistence failure");
      }
      receipts.push(structuredClone(receipt));
      await onReceiptCommitted?.(receipt);
    },
    async markOutcomeUnknown(record) {
      if (failUnknown) throw new Error("simulated UNKNOWN marker failure");
      unknown.push(structuredClone(record));
      await onUnknownMarked?.(record);
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
  assert.equal(journal.assistantMessages.length, 2, "both tool-call and final Assistant messages are persisted");
  assert.equal(journal.intentBatches.length, 1, "the executable Intent batch is committed in one journal operation");
  assert.equal(journal.intentBatches[0].turnId, "turn-atomic");
  assert.deepEqual(journal.intentBatches[0].calls.map(call => call.id), ["slow", "fast"]);
  assert.deepEqual(
    journal.assistantMessages[0].intents.map(call => call.id),
    ["slow", "fast"],
    "the Assistant message and complete Intent batch share one commit",
  );
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

test("adapter: truncated ToolCalls create no Intent and remain non-executable", { timeout: 5000 }, async () => {
  const journal = createJournal();
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
      response([toolCall("truncated", "read")], "length"),
      response([text("retry with complete arguments")], "stop"),
    ], requests),
    journal,
    host,
    toolNames: ["read"],
  });

  const outcome = await adapter.run("truncated call", "turn-truncated");
  assert.equal(outcome.status, "COMPLETED");
  assert.equal(journal.assistantMessages.length, 2, "the truncated Assistant response is still journaled");
  assert.equal(journal.intentBatches.length, 0, "Pi rejects the truncated call before an executable Intent is created");
  assert.deepEqual(journal.assistantMessages[0].intents, []);
  assert.deepEqual(host.started, []);
  assert.equal(requests.length, 2);
  assert.equal(await journal.hasUnresolved(), false);
});

test("adapter: a late parallel tool cannot start after another call becomes OUTCOME_UNKNOWN", { timeout: 5000 }, async () => {
  let releaseLaterIntentCheck;
  const unknownRecorded = new Promise(resolve => { releaseLaterIntentCheck = resolve; });
  const journal = createJournal({
    failReceiptFor: ["uncertain"],
    onHasIntent: async callId => {
      if (callId === "later") await unknownRecorded;
    },
    onUnknownMarked: async record => {
      if (record.callId === "uncertain") releaseLaterIntentCheck();
    },
  });
  const host = {
    started: [],
    async execute({ callId, name }) {
      this.started.push(callId);
      return { status: "success", output: "fake-host-output", receipt: hostReceipt(callId, name) };
    },
  };
  const requests = [];
  const adapter = createKernelBoundaryAdapter({
    model: MODEL,
    streamFn: scriptedStream([
      response([toolCall("uncertain", "uncertain"), toolCall("later", "later")], "toolUse"),
      response([text("must-not-continue")], "stop"),
    ], requests),
    journal,
    host,
    toolNames: ["uncertain", "later"],
  });

  const outcome = await adapter.run("parallel tools with one unknown", "turn-parallel-unknown");
  assert.equal(outcome.status, "OUTCOME_UNKNOWN");
  assert.deepEqual(outcome.callIds, ["uncertain"]);
  assert.deepEqual(host.started, ["uncertain"], "late tool execution is blocked after the unresolved outcome");
  assert.equal(requests.length, 1);
  assert.equal(await journal.hasUnresolved(), true);
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
