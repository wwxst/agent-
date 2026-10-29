# Pi Agent Core adapter spike

**Status: isolated research experiment; not adopted and not part of the production runtime. Loop + Host-boundary tests passed (11/11); real EventStore/ToolHost integration is still unverified. This is not approval to migrate the production loop.**

This spike tests the published `@earendil-works/pi-agent-core@1.4.0` package with a deterministic fake stream and in-memory tools. The corresponding source review is pinned separately to `earendil-works/pi@d5b3de22d0e24a3e9c38a9410d3329b099717283`; package/source equivalence is not assumed without a provenance check.

## What it checks

- An awaited `message_end` listener can act as an intent-persistence barrier before tool execution starts.
- Parallel tools may finish in reverse order while Pi's model-visible ToolResult messages remain in source-call order.
- A truncated (`length`) assistant message containing ToolCalls does not execute those tools.
- Failure to persist an intent batch must block every requested tool from executing.

All model responses and tools are deterministic and local. No credentials, network model requests, write tools, shell, or production Host are involved.

## What this does not prove

- It does not prove that Pi Core can replace the current Kernel without an adapter.
- It does not map Pi tool outcomes to the Kernel's durable Intent/Receipt, Lease/Fencing, authorization revocation, cancellation, or `OUTCOME_UNKNOWN` contracts.
- The adapter uses an in-memory fake journal and fake Host; it does not prove database transactions, process crash recovery, real external side effects, OS isolation, or product-level performance.
- It does not authorize adding Pi Core as a production dependency.

## Run

The experiment requires Node.js `>=22.19.0`, matching the published Pi Core package engine declaration.

```bash
npm install
npm run build
npm install --prefix experiments/pi-core-adapter
npm test --prefix experiments/pi-core-adapter
```

The adoption gate is explicit: if the spike passes, continue with a thin adapter design and fault-injection tests; do not migrate the production loop until the adapter preserves all current safety and recovery invariants with lower total maintenance cost.
