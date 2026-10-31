# 67：Model Provider 请求生命周期、重试层级与费用不确定性（2026-10-31）

> **研究/设计补充；未获开发批准。** 本文研究 Agent 系统中的模型调用本身也是远端、可能计费的操作，不能只把 Tool 当成外部副作用。固定证据为 Pi Durable/AI v1.4.0 源码与已有 Claude CLI 2.1.304 报告 36；本轮未调用真实 Provider、未做断网/计费/重复请求实验。
> 关联：[53：Pi GenerationTask](./53-Pi-Durable-HarnessTaskScheduler与GenerationToolTask状态机复核-2026-10-30.md)、[57：CompactionTask](./57-Pi-Durable-CompactionTask上下文边界重放与失效风险-2026-10-30.md)、[62：Operation UNKNOWN](./62-Operation执行协议未知结果对账与多Owner恢复合同-2026-10-30.md)、[65：可靠性向量](./65-可靠性保证向量存储ACK与事件游标合同-2026-10-31.md)、[66：Host Manifest](./66-HostCapabilityManifest与工具执行一致性验收合同-2026-10-31.md)。

## 1. 核心结论

**一次模型请求必须作为独立的远端 Operation 记录，其 outcome 与 usage/billing evidence 分离。** 不能把 GenerationTask attempt、provider sessionId、HTTP attempt、stream transport attempt 和 Provider response ID 混为一谈。

至少有四层不同的重试/恢复：
1. Transport adapter 内部握手或 HTTP retry（例如 WebSocket→SSE、Retry-After）；
2. Provider adapter 的 request retry（可配置 maxRetries）；
3. Agent/Generation 层遇到 transient error 的完整 model-call retry；
4. 进程崩溃后，持久 Task 恢复当前 request phase 并重新发起调用。

这四层可能都产生新的实际网络请求。没有 provider 原生 idempotency/response query 时，即使最终 transcript 只有一条 answer，也不能推断 provider 只处理/计费了一次。

## 2. Pi Durable v1.4.0：GenerationTask 的持久化边界

### 2.1 Request checkpoint 保存什么，不保存什么

packages/durable/src/harness/generation.ts blob c8d26791cd5a2e26287f73255b75f65ec21c3f22：
- GenerationCheckpoint 的 request phase 保存 attempt、compacted Task ID、model ref、thinkingLevel、streamOptions、cutoff entry ID；
- prepare commit system prompt entries 和 request checkpoint 后，request phase 重新 derive 固定 cutoff 的 ContextView；
- beforeRequest hooks 可修改本次 messages；
- request 调用 streamSimple，附带 Task AbortSignal、telemetry、ProviderDoc sessionId 和 reasoning；
- checkpoint 没有 modelRequestId、每个 HTTP transport attempt ID、provider response ID、provider request idempotency key、payload hash 或 billing uncertainty record。

这意味着 Task checkpoint 能恢复“该对话应继续请求哪个模型、使用哪个上下文边界和参数”，但没有建立可查询的 Provider-side logical request ledger。

### 2.2 Process restart 的 request phase

packages/durable/src/harness/scheduler.ts blob 23951e89934a6214329e7511f3fc8bca2d23f921 L374–423：Harness open 扫描 live Task，把 running 改为 pending，保留原 checkpoint 并增加 restart count。

GenerationTask 的 request phase 被重新调度时会再次执行 streamSimple；如果进程在 Provider 已收到请求、但完整 AssistantMessage 尚未结算前死亡，恢复路径没有通用的 provider query/idempotency contract。它可能再次发送同一逻辑请求。这个行为是源码控制流推断；本轮未做真实 Provider crash 实验。

### 2.3 Partial 与 Usage

- streamResponse 默认每 100ms 最多有一个 partial commit in-flight；finally 停止 timer 并 await 最后一次 partial commit，避免 terminal result 后出现 stale partial。
- process interruption/abort/fault 时 convertPartial 将已提交 partial 变为 stopReason=aborted 的 AssistantEntry。
- appendAssistant 在同一 commit 记录 UsageDoc 与 AssistantEntry；UsageDoc 聚合 provider/model 的 input/output/cache tokens 和 cost。
- partial 可能没有完整 provider usage；若没有终态响应，UsageDoc 不能证明 Provider 实际没有产生费用。
- packages/durable/src/harness/usage.ts blob 24cd9d721d9205b943758eda32306e2f536ac7a4 的 UsageDoc 是按 provider/model 累加的 bucket，不是 per-request attempt ledger。
- packages/ai/src/models.ts blob ac0396f9027e7b111ad3cd6cc04ec05b59e7b5f9 L1236–1255：calculateCost 使用 model catalog 的 cost rates 乘 token usage 计算 cost。它是客户端按已报告 token 和价格 metadata 得到的估算，不等同 Provider 最终 invoice/折扣/税费/订阅额度扣费。

## 3. Provider sessionId 不是 request idempotency key

Pi Durable packages/durable/src/harness/provider.ts blob b838982a686d3eb49c64324d91d281c9f55fb407：
- 每个 Conversation 持久化一个 UUIDv7 sessionId；
- fork 初始化新 sessionId；
- 它跨 reopen、retry、reset、compaction、model changes 保持稳定；
- GenerationTask 将其传入 pi-ai。

Pi AI packages/ai/src/types.ts blob c0f3b56277fb2277dd9a26f41043dfae3f04c2c5 明确把 sessionId 定义为 session-based caching / request routing / session-aware feature，不是 idempotency key。

Provider adapter 的实际映射进一步验证：
- OpenAI Responses packages/ai/src/api/openai-responses.ts blob 8ddaa6944961ae55fbe3d1e3ce67686e9eb7d7a0 L315–360：同一个 options.sessionId 可被映射到 prompt_cache_key、session_id、x-client-request-id/session affinity header；这段代码没有定义 server-side dedup/at-most-once contract。
- OpenAI Codex Responses packages/ai/src/api/openai-codex-responses.ts blob 90a599e665eedb756d4838696b6eb6c792b3b961 L270–405：websocketRequestId 可复用 codexSessionId，否则生成 UUID；它用于该 adapter 的 websocket request/routing path，不能因此视为所有 Provider 通用的 logical request ID。
- sessionId 是 Conversation affinity/cache identity；同一 conversation 可有多次不同 model requests。不得将它当 modelRequestId 或 effectKey。

## 4. Provider retry 与 Agent retry 是不同层

### 4.1 Pi Provider request retry

packages/ai/src/utils/provider-retry.ts blob 9d7ef81f25c2773149b0068f24c8005706701ffc：
- retryable provider response 先看 x-should-retry；否则无 status 的 Error、408、409、429、500+ 默认可 retry；
- 使用 retry-after-ms / retry-after 或指数退避；
- 该 helper 每次 retry 都重新调用 SDK request factory；
- OpenAI/Anthropic SDK 内部 maxRetries 被显式设为 0，再由该 helper 统一 retry，以使 backoff 可 AbortSignal 中断；
- 它只包裹请求创建并拿到 response headers 的阶段，不包裹完整 stream consumption。流开始后的 interrupted stream 会进入上层错误处理，而不是由这个 helper 从头续接相同 stream。

Anthropic packages/ai/src/api/anthropic-messages.ts blob 2754794c3138f8853ee4faa2f9fbae6d652f2b3c L655–675 与 OpenAI Responses packages/ai/src/api/openai-responses.ts blob 8ddaa6944961ae55fbe3d1e3ce67686e9eb7d7a0 L220–233 均可见：SDK maxRetries=0，外层 retryProviderRequest 接收可配置 maxRetries/signal。

Pi Coding Agent settings 文档将 retry.provider.maxRetries 默认设为 0，并建议除非确实需要 provider-level retries，否则保持 0；provider-level retry 可能延迟 Agent 自己处理 quota/usage-limit errors。见 packages/coding-agent/docs/settings.md L129–136 与 settings-defaults.ts blob 1f90280457f4d4d9563269754e7fa28ff0a2903f。

### 4.2 Agent / Generation retry

packages/ai/src/utils/retry.ts blob a1e98403264e53bfece844f8608c1a342672ed59：
- retryDelayMs 使用 baseDelayMs * 2^(attempt-1)，受 maxAgentDelayMs 限制；
- isRetryableAssistantError 以 error text pattern 分类 transient network/HTTP/server errors；
- 明确排除 quota/billing exhaustion；
- aborted 不 retry；
- retryAssistantCall 可按回调记录 scheduled/start/finished。

Pi Durable GenerationTask 的 classify 也先单独处理 context overflow，再按 retryable assistant error、settings.retry.enabled 和 attempt budget 进入 durable sleeping retry phase。上游默认 retry enabled、maxRetries=3、baseDelayMs=2000、maxAgentDelayMs=60000；见 packages/durable/test/harness-generation.test.ts blob 50bae0a58917477ad787b2f0124f7879128a7fb6 L507–523 和报告 53。

### 4.3 Codex transport fallback/retry

packages/ai/src/api/openai-codex-responses.ts blob 90a599e665eedb756d4838696b6eb6c792b3b961：
- WebSocket transport 在 stream 未开始时，遇到特定 connection-limit / previous_response_not_found 可各自有限重试；
- WebSocket 在 stream 已开始后失败，不切换 SSE 继续同一 response，而是抛出错误；
- stream 尚未开始时可记录 transport failure 并 fallback 到 SSE；
- SSE fetch 对配置的 retryable status/network error 使用 maxRetries（默认 0）重试；
- HTTP headers / body stream 的处理是不同阶段，headers 之前 retry 不等于 stream 之后恢复。

因此 transport fallback、provider request retry、Agent generation retry、process restart 必须各自留下 attempt 记录。

## 5. UNKNOWN 不只是“答案未知”，还包括 Usage/Billing UNKNOWN

| 失败点 | 模型内容状态 | Provider 处理/计费状态 | 允许的动作 |
|---|---|---|---|
| 发送前本地失败，且可证明未发送 | 无 answer | not submitted | 可重新准备 |
| request 已发出，但无 response headers，网络断开 | 无完整 answer | 可能已被 Provider 接收；usage unknown | 查询 provider request ID（若有）；无查询能力时提示可能重复计费 |
| 收到 HTTP 429/5xx terminal response，Provider 明确拒绝 | 无 answer | 需按 provider contract 分类；不能仅凭通用 status 推断零费用 | 按 retry policy；记录响应证据 |
| stream 已开始，部分 token 后中断 | partial/aborted 可保存 | Provider 可能已产生部分 token/费用 | 新请求是新 provider attempt；保留前次 usage uncertainty |
| final response + usage 已收到、AssistantEntry commit 前 crash | terminal result 在内存丢失 | Provider usage 可能已知但本地未提交 | 若 Provider 可查询，回收同 response；否则重新请求有重复费用风险 |
| AssistantEntry + UsageDoc 已同一事务提交 | answer/usage committed | 本地 reported usage 已知 | 不重复调用 |
| Deferred handle 已持久化 | provider job pending | 按 provider handle 继续 | poll 同一 handle；cancelDeferred 仅按 provider capability 评估 |

注意：HTTP 429/5xx 是否收费、流中断是否收费、响应完成后是否可以按 request ID 查 usage 都是 Provider-specific contract；不能对所有 API 作统一假设。

## 6. 目标架构：ModelCall Ledger

建议新增与 Tool Operation 同级但专属模型请求的 ModelCall aggregate。它不是把模型请求强行套成普通 Tool，而是共享 Operation Journal 的 identity/evidence/recovery 原语。

### 6.1 Identity

- modelCallId：一个语义 Generation 请求组（可能包含 Agent-level retries）；
- requestAttemptId：每次 Provider request 的唯一尝试，包括 provider helper 内部 retry；
- transportAttemptId：WebSocket/SSE/HTTP transport 子尝试；
- providerRequestId：Provider response header/body 返回的 correlation ID；
- providerResponseId / deferredHandle：Provider 返回的可查询 response/job identity；
- conversationSessionId：prompt cache/session affinity，不用于 request dedup；
- contextRevision/securityRevision、modelConfigVersion、providerAdapterVersion、toolSchemaHash、payloadHash。

### 6.2 持久化阶段

proposed ModelCall state axes：
- Control: prepared / dispatching / waiting / completing / terminal / parked；
- Request evidence: not-sent / may-have-sent / response-headers / stream-started / deferred-handle / terminal-response / unknown；
- Usage evidence: none / partial / provider-reported / locally-estimated / invoice-reconciled / unknown；
- Cancellation: requested / provider-cancel-sent / provider-cancel-confirmed / local-stream-stopped；
- Retry policy: stored retry policy + current adapter policy + provider idempotency/query capabilities。

每个物理网络 attempt 记录：
- requestAttemptId、parent modelCallId、transportAttemptId；
- provider/model/endpoint fingerprint、request payload hash、session affinity ID（不含 token/secret）；
- sentAt、headersAt、streamStartedAt、terminalAt、timeout/cancel reason；
- provider request/response ID、status code、retry-after、provider stream terminal event；
- partial token/usage snapshot、final usage、estimated cost、billing evidence state；
- retry decision source（transport/provider/agent/restart）与 policy version。

### 6.3 Retry policy 约束

- 禁止 SDK/adapter 隐藏 retry。每个 adapter 必须声明内部 retry 层级和是否可能在响应丢失后重新提交；
- provider retry 默认 0，除非 adapter 有明确可证明的 pre-acceptance retry semantics 或 provider idempotency；
- Agent-level retry 生成新的 requestAttemptId；如果复用 provider idempotency key，必须有 provider 官方合同和 TTL；
- process restart 发现 request evidence=may-have-sent/stream-started 且无 terminal receipt 时，先查 provider request/response ID；查不到则 ModelCall 进入 UNKNOWN，不能悄悄视为一次干净的新请求；
- 用户允许“重新请求并接受可能重复计费”时，创建新的 requestAttemptId，保留与旧 attempt 的 retryOf 关系，并向 UI 暴露 cost uncertainty；
- Deferred handle 已存在则 poll 同 handle，不新建 Generation request；poll attempt 单独计数。
- Prompt cache/session affinity ID 不得用来 dedup request。

### 6.4 Usage 与 Billing Ledger

区分三个账本：
1. Provider-reported usage：响应报告的 token/cost fields；
2. Estimated cost：本地 model catalog rates 计算的估算；
3. Actual invoice/credit consumption：Provider billing/usage API 或财务账单对账的实际金额。

三者不能覆盖彼此。建议按 requestAttemptId 存储 usage evidence，conversation/model totals 只是可重算的 materialized aggregate。若某个 attempt 可能已处理但无 usage，显式记 usage_unknown；不能把它加成 0，也不能从 UsageDoc 缺记录推断未计费。

## 7. Claude 与 Pi 对比

| 维度 | Claude CLI/Desktop 发布源码研究 | Pi Durable/AI v1.4.0 | 目标架构 |
|---|---|---|---|
| Agent retry | streaming fallback/refusal/model fallback 会 abandon attempt，整理 partial/tool state 后继续 | retry classifier + durable backoff checkpoint；默认 provider retry 0 | 统一记录每层 retry source/attempt IDs |
| Provider session identity | CLI/SDK 有各自 session/request protocol identity；报告 47–50 | conversation ProviderDoc sessionId，用于 cache/affinity | session ID 与 request/attempt ID 分开 |
| Process restart during request | Claude 依据 transcript/attempt fallback 处理；具体 Provider billing unknown | request phase 重跑；partial 可能转 aborted entry | ModelCall ledger + provider query + usage unknown |
| Stream interruption | Claude 有 fallback/abandonAttempt 和 in-flight Tool abort | Provider adapter error 由 Generation classify，外层 Agent retry | transport fallback 不等同 provider request idempotency |
| Cost evidence | transcript/provider usage/产品订阅限额有多种路径；实际账单不完全可见 | UsageDoc 聚合 provider-reported token 与 model metadata cost | provider usage、estimated cost、invoice 三账本 |
| Deferred response | 依 provider/Host protocol | durable handle + pollAt checkpoint，继续 poll 同一 handle | handle/lease/expiry/query semantics 独立建模 |

Claude 证据见报告 [36](./36-Claude-CLI写入失败与流式Fallback收敛-2026-10-29.md)、[47](./47-Claude-Desktop与SDKSession启动双向协议及宿主生命周期-2026-10-30.md)、[50](./50-Claude-Desktop-SDKHooks与Pending请求重交付复核-2026-10-30.md)。它们是固定发布 bundle 静态研究，不是 Provider billing 实验。

## 8. 新增验收计划（未执行）

| Test ID | 场景 | 必须观察/保证 |
|---|---|---|
| MC-01 | request intent commit 后、socket send 前 kill | 重开能确定 not-sent，或保守标记 unknown；同一 ModelCall identity 保留 |
| MC-02 | Provider 接收 request 后、headers 前断网 | 不把 transport error 误作 not-submitted；usage unknown |
| MC-03 | headers 收到、stream 首 token 前 kill | 保存 providerRequestId/status；query 能力按 manifest 评估 |
| MC-04 | stream partial 后 kill | partial transcript 与 usage evidence 分离；重试显示前次 usage unknown |
| MC-05 | terminal response 已到、UsageDoc commit 前 kill | Provider response ID/usage 可以恢复则幂等补账，否则 UNKNOWN |
| MC-06 | provider-level retry + agent-level retry 同时启用 | 物理请求总数与每层 attempt 逐一可见，不隐藏重试 |
| MC-07 | Codex WebSocket before-start fallback 与 after-start disconnect | 前者可按 adapter contract fallback；后者不可假装同一 stream 恢复 |
| MC-08 | stable conversation sessionId 跨多个 model requests | 不得将 sessionId 误当 request idempotency key |
| MC-09 | deferred handle poll/restart/cancel | 同 handle poll；cancel ack 与实际 provider job terminal state 分开 |
| MC-10 | provider 429/5xx/network errors | retry classifier 与 provider response evidence 可审计；账单状态按 provider contract |
| MC-11 | Usage reported but model catalog rates changed | 历史 estimated cost 使用 pinned rates version，不被新 catalog 静默重算 |
| MC-12 | UsageDoc aggregate 重建 | per-request attempt ledger 能重建总计；unknown attempt 不被归零 |
| MC-13 | Agent restart limit 与 request retry budget 同时达到 | 分开报告 Task restart 与 Provider request attempt，不产生无限重试环 |
| MC-14 | user retry after unknown billing | 新 attempt 明确关联旧 attempt，并提示可能重复费用 |

## 9. 证据与未知

### 固定源码事实
- GenerationTask checkpoint/stream/retry/poll/partial：packages/durable/src/harness/generation.ts blob c8d26791cd5a2e26287f73255b75f65ec21c3f22。
- Provider conversation session identity：packages/durable/src/harness/provider.ts blob b838982a686d3eb49c64324d91d281c9f55fb407。
- Provider retry wrapper：packages/ai/src/utils/provider-retry.ts blob 9d7ef81f25c2773149b0068f24c8005706701ffc。
- Agent retry classifier：packages/ai/src/utils/retry.ts blob a1e98403264e53bfece844f8608c1a342672ed59。
- OpenAI Responses adapter：packages/ai/src/api/openai-responses.ts blob 8ddaa6944961ae55fbe3d1e3ce67686e9eb7d7a0。
- Anthropic adapter：packages/ai/src/api/anthropic-messages.ts blob 2754794c3138f8853ee4faa2f9fbae6d652f2b3c。
- Codex Responses adapter：packages/ai/src/api/openai-codex-responses.ts blob 90a599e665eedb756d4838696b6eb6c792b3b961。
- Usage ledger：packages/durable/src/harness/usage.ts blob 24cd9d721d9205b943758eda32306e2f536ac7a4。
- Cost estimate：packages/ai/src/models.ts blob ac0396f9027e7b111ad3cd6cc04ec05b59e7b5f9 L1236–1255。

### 架构推断
- 目前 Pi Durable 的 persisted Generation request checkpoint 不足以跨 process restart 对 Provider request 做 idempotent query；同一 sessionId 只是 cache/affinity。
- 没有 provider request ledger 时，agent answer 恢复成功不能证明请求只发送/计费一次。
- UsageDoc 的 aggregate totals 不足以支持 per-request billing reconciliation。
- 统一 retry budget 应按物理 Provider requests 而非仅 GenerationTask attempt 计数。

### 未知
- 每个 Provider 的请求接收、响应中断、计费规则和 usage query 语义。
- OpenAI/Anthropic 等 Provider 的某些 endpoint 是否有适用的 idempotency/request lookup contract；Pi 统一 API 当前未给出通用合同。
- Codex WebSocket request identity 与后端实际 dedup/response retention 的完整服务端语义。
- Claude CLI/SDK 在模型请求流中断后的实际费用如何从 provider/account ledger 对账。
- 真实 crash 时 partial usage 字段是否包含足以准确结算的 token 数据。

**本轮只提交研究设计；未运行真实 provider 请求/计费实验、未修改业务/Kernel 代码，开发批准仍未获得。**
