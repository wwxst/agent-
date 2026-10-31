# 68：Provider Request ID、异步 Job 可恢复性与数据保留合同（2026-10-31）

> **研究/设计补充；未获开发批准。** 本文把报告 67 的 ModelCall Ledger 与当前 OpenAI/Anthropic 官方 API 合同对齐，重点区分 request correlation、provider response/job handle、idempotency、stream resume 和 data retention。固定代码证据为 Pi AI/Durable v1.4.0；官方文档按 2026-10-31 检查。未调用真实 Provider API，未执行断线/费用实验。
> 关联：[67：Model Provider 请求生命周期与费用不确定性](./67-ModelProvider请求生命周期重试与费用不确定性-2026-10-31.md)、[66：Host Capability Manifest](./66-HostCapabilityManifest与工具执行一致性验收合同-2026-10-31.md)。

## 1. 发现：Pi v1.4.0 OpenAI request correlation header 与当前官方合同不一致

Pi Durable ProviderDoc 为每个 Conversation 保存稳定 sessionId（报告 67）；Pi AI v1.4.0 packages/ai/src/api/openai-responses.ts blob 8ddaa6944961ae55fbe3d1e3ce67686e9eb7d7a0 L315–360 将同一个 options.sessionId 写入 session/cache/routing 相关参数，其中包括 x-client-request-id。

OpenAI 当前 API Overview 明确：
- X-Client-Request-Id 是调用方提供的 per-request unique identifier；
- OpenAI 对支持的 endpoints（包括 Responses）记录它；
- 当 client 无法收到 x-request-id 时，可以向 support 提供 X-Client-Request-Id，查询 OpenAI 是否收到该请求及收到时间；
- 它不是服务端生成的 response ID，也没有被定义为 idempotency key 或 result-retrieval key。

来源：[OpenAI API Overview — Supplying your own request ID](https://developers.openai.com/api/reference/overview)，L607–617。

**源码/文档差异**：Pi v1.4.0 的 sessionId 是 conversation-scoped、跨多个 model requests/retries/reopen 稳定；但该 release 的 OpenAI Responses adapter 把它作为 X-Client-Request-Id 使用。按照当前官方文档，这不是 per-request unique ID。由此可推断：同一 conversation 的多次 Provider request 会复用 client request ID，可能导致 support correlation 不唯一；它仍不提供 idempotency。

目标架构要求：
- sessionAffinityId：conversation 级稳定，只用于 prompt cache/session routing；
- clientRequestId：每个物理 HTTP request attempt 唯一；
- providerRequestId（如 OpenAI x-request-id、Anthropic request-id）：服务端返回的单次 request correlation；
- modelCallId：逻辑模型调用组；
- requestAttemptId：每次真正向 Provider 发送的请求；
- providerResponseId/jobId：可检索结果资源 ID；
- idempotencyKey：仅在 Provider 明确提供 server-side effect dedup 合同时使用，绝不能拿上述 correlation ID 替代。

即使 X-Client-Request-Id 可以帮助 support 查明 request 是否被接收，也不代表 API 能按这个 ID 自动恢复原响应/usage，更不代表重发相同 ID 会被去重。

## 2. OpenAI Responses Background Mode：单个请求的 provider-managed async job

当前官方 Background Mode 文档明确：
- create Response 时设置 background=true，返回 Response object/ID；
- 后续 GET /v1/responses/{response_id} 可轮询 queued / in_progress 等状态，直到 terminal；
- 仅 background Response 可调用 cancel endpoint；
- 如果 create 时同时设置 background=true 和 stream=true，可以使用 event sequence_number 保存 cursor；断线后通过 responseId + starting_after 继续 stream；
- keepalive 的连接计数不是 stored-event resume cursor，客户端只应持久化真正 event 的 sequence_number；
- background response 若未显式 store=true，或 store=false，polling 所需数据大约 10 分钟后删除；Modified Abuse Monitoring 项目需要显式 store=true 才会在 polling 后继续保留；ZDR 项目强制 store=false，但仍为 background polling 临时在磁盘保存约 10 分钟。

来源：
- [OpenAI Background mode](https://developers.openai.com/api/docs/guides/background)，尤其 L963–969、L1578–1662、L2159–2163。
- [OpenAI Data controls](https://developers.openai.com/api/docs/guides/your-data)，Responses API application-state retention 规则。
- [OpenAI Cancel a response](https://developers.openai.com/api/reference/resources/responses/methods/cancel)：只有 background=true 的 response 可取消。

### 2.1 对 Agent 的架构价值

这是比同步 SSE 更适合长时间模型请求的 provider-managed job：
- create 成功并取得 responseId 后，客户端断线不必重发 generation request；
- polling 读取同一个 Response resource；
- stream resume 通过 responseId + sequence cursor，而不是客户端自行重建 prompt；
- provider 端继续执行期间，Coordinator 可暂停当前 Worker，将 ModelCall 标为 waiting-provider-job；
- cancel 请求和 response 的 terminal status 分开记录。

但它**仍不能解决 create ACK 丢失**：
- 如果 create 请求可能已被 Provider 接收，但 client 在拿到 responseId 前断线，应用缺少 provider job handle；
- X-Client-Request-Id 只支持 support-side receipt lookup，不等于 API result lookup 或 idempotency；
- 除非 Provider 明确提供可按 clientRequestId 查 response 的 endpoint，否则仍保留 request outcome UNKNOWN。

### 2.2 Retention / privacy 不是附属配置

- store=true 能让 response data 在标准保留政策下持续可取（官方 data controls 文档说明 Responses API 默认/显式 store=true 通常至少保留 30 天，依组织策略和例外而定）；
- store=false / ZDR 模式下 background polling 只有约 10 分钟临时存储窗口；
- 目标产品如果承诺“所有模型结果只保留本地”或严格 ZDR，不能默认启用 background mode 而不告知这段临时 provider-side storage；
- ModelCall manifest 必须 pin store flag、organization data retention mode、background retention window、response retrieval expiry。

## 3. Anthropic Message Batches：多个请求组成的异步 Provider Job

当前 Anthropic 官方 Batch Processing 文档与 Messages Batch API reference 定义：
- POST /v1/messages/batches 一次提交多个独立 Messages requests；每个 item 有 custom_id，在该 batch 内唯一，结果可能乱序返回；
- 创建后立即异步处理；通常大部分 batch 一小时内完成，最长 24 小时；24 小时内未完成会过期；
- GET /v1/messages/batches/{id} retrieve endpoint 可幂等轮询 batch 状态；
- batch 结束后从 results_url 读取 per-item 结果，JSONL 每行带 custom_id 和 result；
- 每个 item 状态含 succeeded / errored / canceled / expired；errored、在发送给模型前被取消、未开始就过期的 item 不计费；
- cancel 会先返回 canceling，最终 ended；在取消前已处理的 item 可以保留 succeeded/partial results；
- results 可在创建后 29 天内下载，之后 batch 元数据仍可见但结果不可下载；
- Batch API 定价按标准 API token 价格的 50%；
- Batch API 支持 tool use 和 server tools；若 server-side agent loop 返回 pause_turn，需要提交 follow-up request 才能完成；
- Batch API 不支持 stream=true、fast speed 和 server-side fallbacks；
- 官方文档标注 Message Batches API 当前不具备 ZDR eligibility / HIPAA eligibility。

来源：
- [Anthropic Batch processing guide](https://platform.claude.com/docs/en/build-with-claude/batch-processing)，L70–121、L128–147、L178–254、L316–416、L523–527。
- [Create a Message Batch API reference](https://platform.claude.com/docs/en/api/messages/batches/create)，L146–197、L974–1024。
- [Anthropic API errors / request ID / retries](https://platform.claude.com/docs/en/api/errors)，L150–162、L196–223。

### 3.1 它与 OpenAI Background Response 不是同一种 Job

| 特性 | OpenAI Background Response | Anthropic Message Batch |
|---|---|---|
| job 粒度 | 一个 Response | 一个 batch 内多个独立 Message requests |
| handle | responseId | batchId + custom_id |
| polling | retrieve response | retrieve batch，完成后 results_url |
| stream resume | responseId + sequence_number（background+stream） | 无单 request SSE stream；读取 batch result JSONL |
| item ordering | 单 Response event sequence | batch results 可乱序，必须按 custom_id 匹配 |
| retention | 未 store=true 时约 10 分钟；store=true 依标准保留策略 | batch results 29 天；processing 最长 24h |
| cancel | 只允许 background response；终态另查 | canceling→ended，可能保留已完成 item |
| 适用场景 | 一个长时间/高延迟的交互式模型调用 | 大量可异步、可独立处理的请求 |
| data policy | ZDR 项目仍临时存储约 10 分钟用于 polling | 文档明确非 ZDR/HIPAA eligible |

**创建请求的 ACK 窗口仍然存在**：responseId/batchId 必须先成功到达客户端并写入本地 ModelCall ledger。官方文档提供 idempotent retrieve，不等于 create endpoint 具有幂等创建合同。Anthropic custom_id 只保证同 batch 内唯一，不能证明两个重复 batch create 会合并成一个 batch。丢失 create response 时仍需 UNKNOWN/Provider support reconciliation。

### 3.2 对 Agent 产品的使用建议

- 实时聊天：默认同步 stream；优先低延迟，允许在中断后出现明确的 request/usage UNKNOWN。
- 长时间模型推理：如果 Provider 支持 Background Response，考虑 background+stream=true，持久化 responseId、event cursor 和 store/retention policy。
- 大规模评估、批量抽取、离线摘要/分类：考虑 Anthropic Message Batches 或其他 provider batch jobs；每个 item 使用内部 operationId 的 opaque mapping/custom_id；按 custom_id 归并，不依赖返回顺序。
- Batch 不是通用交互式 Agent replacement：不支持 SSE stream，可能需要 pause_turn follow-up，且 data compliance / retention 与实时 API 不同。
- 用户要求严格数据不外存/ZDR/HIPAA 时，provider async job 需要额外审查，不能仅以“有 responseId 可恢复”作为默认选择。

## 4. Provider 错误分类不能只按 HTTP status

Anthropic 当前官方 Errors 文档：
- 429 可能是短时 rate limit，也可能是组织月度 spend cap 或 Claude Code workspace spend limit；
- spend-cap 429 没有 retry-after header，且在访问恢复前会持续失败；
- 500 可按指数退避重试；504 是处理超时；529 是 overloaded；
- 官方 SDK 对 transient failures 默认自动重试两次，但 SSE 已经返回 200 后的 mid-stream error 不按标准 retry 机制处理；
- 每个 API response 有 unique request-id header，error body 也包含 request_id，供 support correlation 使用。

Pi v1.4.0 provider-retry helper 对 429 默认视作 retryable（除非 Provider 明确返回不重试提示），且可配置 maxRetries。Pi Coding Agent 文档默认 provider retry=0，说明 provider-level retries 可能延迟 Agent 对 quota/usage-limit error 的处理。目标 adapter 应使用 typed provider error code/headers 分类，而不是对所有 429 一视同仁。

OpenAI 当前 deployment checklist 同样明确：rate-limit 429 / overloaded 503 可以遵循 Retry-After 和指数退避；billing、spend、quota errors 需要先处理，不应把所有 429 当作 transient rate limit。见 [OpenAI deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist)。

## 5. ProviderAdapterManifest v0.2 补充字段

报告 67 的 ModelCall Ledger 和报告 66 的 Host Manifest 需要 provider 专属能力字段：

### Request correlation
- clientRequestIdRequired / uniquenessScope；
- serverRequestIdHeader/bodyPath；
- canSupportLookupByClientRequestId（support lookup vs API result lookup 必须区分）；
- responseId / batchId / customId shape；
- idempotencyKeySupport、idempotency scope、retention TTL、duplicate behavior。

### Provider job
- synchronousStream；
- backgroundResponseCreate / retrieve / cancel；
- streamResumeByResponseId + cursor semantics；
- batchCreate / batchRetrieve / perItemCustomId / resultOrder；
- job max runtime、result expiry、result retrieval URL lifetime；
- create ACK ambiguity behavior；
- cancellation terminal states / partial result semantics。

### Data policy
- store default / explicit store true / store false；
- ZDR compatibility / temporary provider storage exceptions；
- retention after completion、result deletion endpoint；
- workspace/region/data residency、HIPAA eligibility等合规属性；
- prompt cache/session affinity TTL 不得当作 response result retention。

### Usage / billing
- usage returned per response/item；
- usage available after background retrieval/batch results；
- usage lookup by request ID / response ID / batch item ID；
- billing treatment for errored/canceled/expired item；
- actual invoice API support；
- rate-limit vs spend-limit typed error semantics。

未明确的 manifest field 一律 unknown；adapter 不得把“可轮询”写成“create idempotent”，不得把“request ID 可供 support 查询”写成“结果可恢复”。

## 6. ModelCall Ledger 补充状态

为适配 provider-managed async job，建议 ModelCall 独立保留：
- request submission：intent-committed / send-attempted / create-ack-received / create-outcome-unknown；
- provider job：none / queued / in-progress / canceling / terminal / expired / result-retention-expired；
- response stream：not-started / streaming / cursor-known / disconnected / resumed / completed；
- usage：unknown / item-reported / response-reported / invoice-reconciled；
- data retention：store-mode-pinned / retention-expiry / provider-delete-pending / provider-delete-confirmed。

注意 create-outcome-unknown 与 job-in-progress 不同：没有拿到 job ID 时，不能凭空创建一个 polling loop。

## 7. 新增验收计划（未执行）

| Test ID | 场景 | 必须满足 |
|---|---|---|
| PR-01 | Pi v1.4.0 OpenAI adapter 多请求共用 sessionId | conformance test 发现 x-client-request-id 非 per-request unique；目标 adapter 改用独立 request ID |
| PR-02 | OpenAI 同一 conversation 连续三次 request | sessionAffinityId 稳定；X-Client-Request-Id 每个物理请求唯一；server x-request-id 单独记录 |
| PR-03 | OpenAI background create 后 stream 断开 | responseId + last non-keepalive sequence cursor 能恢复；不重发 create |
| PR-04 | OpenAI create 已接收但 responseId 未返回 | 不凭 X-Client-Request-Id 自动 retrieve；标记 create outcome unknown，按 support/query capability 处理 |
| PR-05 | OpenAI background store omitted/false 与 store=true | 验证实际 result retrieval retention；到期后转 result-retention-expired，不重发旧生成 |
| PR-06 | OpenAI ZDR project background | 确认 10min 临时存储例外与产品 data policy 相容，否则禁用 background mode |
| PR-07 | Anthropic batch create ACK 丢失 | 不因 custom_id 重复就假设 batch create 去重；batch creation outcome unknown |
| PR-08 | Anthropic batch results out of order | 仅按 custom_id 对应 operationId，不能按数组顺序关联 |
| PR-09 | Anthropic canceling 状态期间有 succeeded item | 保留已完成 item；未发送的 canceled/expired/errored 不计费按 Provider result 处理 |
| PR-10 | Anthropic batch result 29d 后过期 | 本地已持久化完整结果；否则保留 summary/unknown，不重建新 batch |
| PR-11 | Anthropic 429 spend cap，无 Retry-After | 不进行长时间 provider-level retry storm；向 Agent 层交付 quota/spend error |
| PR-12 | provider response ID 已知、ModelCall local commit 前 crash | retrieve 同 job/response 并幂等补写 usage/answer |
| PR-13 | response retention policy 与 ZDR/HIPAA 发生冲突 | admission 前拒绝或要求明确用户/管理员批准，不能静默启用异步 provider storage |

## 8. 设计结论与未知

### 已证事实
- OpenAI X-Client-Request-Id 官方要求每个 request 唯一，并可由 support 查询是否收到；server x-request-id 是另一个服务端生成的唯一 ID。
- Pi v1.4.0 OpenAI Responses adapter 把 conversation-scoped sessionId 复用为 x-client-request-id，形成源码与当前官方 request-ID 合同的差异。
- OpenAI Background Mode 提供 responseId polling 和 background+stream 的 sequence cursor resume；retention 受 store/ZDR 设置影响。
- Anthropic Message Batches 提供 batchId polling、per-item custom_id、out-of-order results、29d result retention、24h processing expiry 和 cancel partial-result semantics。
- Anthropic API request-id 是 server response correlation；429 也可能是 spend cap，SDK transient retry 与 mid-stream error 处理不同。

### 架构推断
- ModelCall 必须支持同步流、provider background response、provider batch 三种不同 request mode，不能用一个 generic retry loop 代替。
- provider job handle 和 result cursor 是外部可恢复状态，应先写本地 ledger 再开始轮询/stream resume。
- Provider data retention/compliance 是 ModelCall capability manifest 的准入字段，不是仅用于产品隐私文档的静态描述。
- correlation ID 只用于追踪/查收件事实；response/job ID 才能按 API retrieve；idempotency key 才能在服务端保证重复创建去重，三者不能互换。

### 未知
- OpenAI Background Response create endpoint 在 ACK 丢失时是否存在未公开/特定 SDK 的 create dedup contract；当前公开文档未证明。
- Anthropic Message Batch create 的重复 POST 是否有任何未公开 dedup 语义；custom_id 仅声明 batch 内唯一。
- Provider job status/result 在组织删除、workspace archive、key revoke、data retention policy update 下的最终可用性需按实际产品/协议测试。
- 真实账单在 batch cancel、background cancel、mid-stream error 交错时的最终结算仍需 Provider usage/cost API 对账。

**仅新增研究文档与研究进度；没有调用 Provider、没有实现 ModelCall、没有修改业务/Kernel 代码；PR-01–13 未执行，开发批准仍未获得。**
