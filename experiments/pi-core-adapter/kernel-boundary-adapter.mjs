import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const textResult = (text, details, isError = false, terminate = false) => ({
  content: [{ type: "text", text }],
  details,
  isError,
  ...(terminate ? { terminate: true } : {}),
});

/**
 * Research-only adapter boundary. The journal and host are injected so this
 * module cannot accidentally acquire filesystem, shell, or network authority.
 * A production implementation must supply a transactional durable journal and
 * a separately authenticated Tool Host.
 */
export function createKernelBoundaryAdapter({
  model,
  streamFn,
  journal,
  host,
  toolNames,
  systemPrompt = "Kernel-boundary adapter experiment only.",
}) {
  let agent;
  let activeTurnId;
  let blocked = false;
  let terminalOutcome;

  const markUnknown = async (callId, reason, error) => {
    const errorText = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
    if (terminalOutcome?.status === "OUTCOME_UNKNOWN") {
      const callIds = new Set([...(terminalOutcome.callIds ?? [terminalOutcome.callId]), callId]);
      terminalOutcome = { ...terminalOutcome, callIds: [...callIds] };
    } else {
      terminalOutcome = {
        status: "OUTCOME_UNKNOWN",
        turnId: activeTurnId,
        callId,
        callIds: [callId],
        reason,
        error: errorText,
      };
    }
    blocked = true;
    try {
      await journal.markOutcomeUnknown({ turnId: activeTurnId, callId, reason });
    } catch {
      // A missing UNKNOWN marker is still fail-closed: the durable Intent has
      // no Receipt, so hasUnresolved() must prevent a new run from starting.
    }
    agent?.abort();
    return textResult("Execution outcome is unknown; stop and reconcile before retrying.", {
      callId,
      outcome: "unknown",
    }, true, true);
  };

  const tools = toolNames.map(name => ({
    name,
    label: name,
    description: "Kernel-hosted deterministic read-only experiment tool",
    parameters: Type.Object({}),
    replay: "never",
    execute: async (toolCallId, params, signal) => {
      if (blocked) {
        // A concurrent tool may reach this wrapper after another tool has
        // already failed closed. Do not overwrite the original terminal cause.
        agent?.abort();
        return textResult("Execution is blocked by an earlier unresolved outcome.", {
          callId: toolCallId,
          outcome: "blocked",
        }, true, true);
      }

      let intentCommitted = false;
      try {
        intentCommitted = await journal.hasIntent(toolCallId);
      } catch (error) {
        terminalOutcome = {
          status: "RECOVERY_REQUIRED",
          turnId: activeTurnId,
          callId: toolCallId,
          error: error instanceof Error ? error.message : String(error),
        };
        blocked = true;
        agent?.abort();
        return textResult("Intent state could not be verified; execution is blocked.", {
          callId: toolCallId,
          outcome: "recovery-required",
        }, true, true);
      }
      if (!intentCommitted) {
        terminalOutcome = {
          status: "INTENT_NOT_COMMITTED",
          turnId: activeTurnId,
          callId: toolCallId,
        };
        blocked = true;
        agent?.abort();
        return textResult("No committed Intent exists; execution is blocked.", {
          callId: toolCallId,
          outcome: "intent-not-committed",
        }, true, true);
      }

      let hostResult;
      try {
        hostResult = await host.execute({
          turnId: activeTurnId,
          callId: toolCallId,
          name,
          arguments: params,
          signal,
        });
      } catch (error) {
        // A Host exception after invocation does not prove that no effect ran.
        return markUnknown(toolCallId, "host-exception", error);
      }

      if (!hostResult || !["success", "error"].includes(hostResult.status)) {
        return markUnknown(toolCallId, "host-reported-unknown");
      }
      if (!hostResult.receipt || hostResult.receipt.callId !== toolCallId) {
        return markUnknown(toolCallId, "host-receipt-missing-or-mismatched");
      }

      try {
        await journal.commitReceipt(hostResult.receipt);
      } catch (error) {
        return markUnknown(toolCallId, "receipt-persistence-failed", error);
      }

      return textResult(
        String(hostResult.output ?? ""),
        { callId: toolCallId, receiptId: hostResult.receipt.receiptId },
        hostResult.status === "error",
      );
    },
  }));

  agent = new Agent({
    initialState: { systemPrompt, model: { ...model }, tools },
    streamFn,
    toolExecution: "parallel",
  });

  agent.subscribe(async event => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const calls = event.message.content.filter(item => item.type === "toolCall");
    if (calls.length === 0) return;
    // Pi will not execute ToolCalls from these terminal/truncated responses.
    // Do not create durable Intents for calls that the loop itself rejects.
    if (["length", "error", "aborted"].includes(event.message.stopReason)) return;

    // One awaited operation commits the whole assistant batch before Pi can
    // emit tool_execution_start. Never persist one Intent at a time here.
    try {
      await journal.commitIntentBatch({
        turnId: activeTurnId,
        calls: calls.map(call => ({
          id: call.id,
          name: call.name,
          arguments: structuredClone(call.arguments),
        })),
      });
    } catch (error) {
      terminalOutcome = {
        status: "FAILED_INTENT_PERSISTENCE",
        turnId: activeTurnId,
        error: error instanceof Error ? error.message : String(error),
      };
      blocked = true;
      throw error;
    }
  });

  return {
    agent,
    async run(prompt, turnId) {
      let unresolvedAtStart = false;
      try {
        unresolvedAtStart = await journal.hasUnresolved();
      } catch {
        blocked = true;
        const error = new Error("RECOVERY_REQUIRED: journal state could not be verified");
        error.code = "RECOVERY_REQUIRED";
        throw error;
      }
      if (blocked || unresolvedAtStart) {
        const error = new Error("RECOVERY_REQUIRED: unresolved execution state requires reconciliation");
        error.code = "RECOVERY_REQUIRED";
        throw error;
      }
      activeTurnId = turnId;
      terminalOutcome = undefined;
      try {
        await agent.prompt(prompt);
      } catch (error) {
        blocked = true;
        return {
          status: "FAILED",
          turnId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (terminalOutcome) return terminalOutcome;

      let unresolvedAfterRun = true;
      try {
        unresolvedAfterRun = await journal.hasUnresolved();
      } catch {
        blocked = true;
        return { status: "RECOVERY_REQUIRED", turnId, error: "Journal state could not be verified after the run" };
      }
      if (unresolvedAfterRun) {
        blocked = true;
        return { status: "RECOVERY_REQUIRED", turnId, error: "Unresolved Intent/Receipt state remains after the Pi loop" };
      }
      if (agent.state.errorMessage) {
        blocked = true;
        return { status: "FAILED", turnId, error: agent.state.errorMessage };
      }
      return { status: "COMPLETED", turnId };
    },
  };
}
