# Agent Kernel V0 · Deterministic execution-contract spike

This is an independently authored **experimental contract harness**, not the implementation of Pi, Claude, Codex, or DeepSeek Harness. Runs on Node.js >=22 with no dependencies.

```bash
node --test kernel.test.mjs
```

Checks: atomic intent admission; truncated/duplicate/budget fail-closed; authorization; unordered receipt time vs stable model projection; persistence-failure joining; cooperative-vs-real cancellation; explicit unknown side effects; deterministic replay. Test T11 is a deliberately unsafe Promise.all control showing why a rejection alone does not join siblings.

**Evidence scope:** This is a deterministic simulated-host test, not the actual Pi Core adapter, not a real shell/OS sandbox and not an end-to-end provider or production crash test. Comparison arguments are based on source inspection; the four reference implementations were not dynamically executed here. This spike must not be labeled a cross-product benchmark or security validation.

**Open gaps before architectural freeze:** independently executable ToolHost with process-tree termination, durable EventStore with crash injection, StepContext model/tool/policy snapshots, approval TTL and revocation, cross-provider context, actual Pi adapter, real Coding-task benchmarks, extension lifecycle and subagent isolation.

**References:**
- Pi: `earendil-works/pi/packages/agent/src/agent-loop.ts`
- DeepSeek Harness: `deepseek-ai/deepseek-harness/packages/core/tools/src/batch.ts`
- Codex: `openai/codex/codex-rs/core/src/session/step_context.rs`
- Claude: local research bundle CLI 2.1.304 static evidence (`04-analysis/evidence/local-agent-core.md`)