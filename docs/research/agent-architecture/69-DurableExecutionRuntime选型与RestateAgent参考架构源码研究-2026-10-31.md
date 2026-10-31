# 69：Durable Execution Runtime 选型与 Restate Agent 参考架构源码研究（2026-10-31）

> 研究阶段补充；没有开发批准。评估自研 TaskScheduler/恢复引擎，还是采用成熟 Durable Execution Runtime。研究对象：Temporal TypeScript SDK、Restate Server/TypeScript SDK、DBOS TypeScript SDK，以及 Restate 官方 Agent reference repository。源码固定到 commit/tag；官方文档按 2026-10-31 检查。没有运行 benchmark、故障注入或真实 Provider 调用。

## 1. 结论

**不建议从零自研通用分布式 Durable Execution Engine。** 任务受理、执行历史、重放、超时、取消、所有权、重试、定时器、持久 Future、并发、恢复与版本迁移的复杂度远超 Agent loop 本身。

但也**不建议把 Agent Kernel 等同于某个工作流引擎**。Durable Runtime 只证明自己的执行命令/历史可恢复；它不自动提供 Provider/MCP/Shell exactly-once、ModelCall billing reconciliation、权限/撤销、sandbox 隔离、transcript/租户删除、业务 Operation/UNKNOWN 状态。

| 候选 | 最适合 | 优势 | 代价/风险 |
|---|---|---|---|
| **Restate** | TypeScript Agent、多轮会话、per-key state、Signals、长任务挂起、细粒度 durable steps | Virtual Objects、Invocation Journal、Durable Futures/Timers、嵌入式 KV；有完整 Agent reference | Server BSL 1.1；自运维分布式日志集群；版本/协议迁移；外部效果仍需幂等；reference 有生产缺口 |
| **Temporal** | 长生命周期业务 workflow、成熟生态/跨语言、MIT 许可 | Event History + deterministic replay、Activities、Signals/Updates、Workflow IDs、Worker Versioning、成熟运维 | Agent-specific transcript/guardrail/MCP/permission/sandbox 都要自建；Replay/版本兼容严格；History 需 Continue-As-New |
| **DBOS** | PostgreSQL-first、业务 SQL 与 checkpoint 同事务 | SDK + Postgres 系统表；无独立 orchestration server；Transactional DataSource 可原子提交 SQL 与 step output | 强绑定 Postgres；分布式 HA 推荐 Conductor；普通外部 Step 仍 at-least-once；Agent actor/signal/stream 自建 |

**暂定候选顺序，不是最终决策**：
1. 若 Restate BSL 与产品商业模式兼容，优先作为 Agent Turn Runtime POC；其官方 Agent repo 是最接近目标问题域的可运行参考。
2. 若需要 MIT/跨语言/成熟 workflow 平台，Temporal 是稳妥候选，但 Agent controller/session/protocol 需自建。
3. 若确定 PostgreSQL 是主数据与事务边界，DBOS 值得优先评估。
4. license review、真实 HA 和故障测试前，不选定任何一个，不进入开发。

## 2. 共同保证边界

三种引擎都存在同一基本窗口：**外部系统已完成副作用，但执行引擎尚未持久化步骤结果，恢复时可能再次调用外部系统。** 因而 durable replay ≠ 外部 exactly-once；cancel ack ≠ effect rollback；workflow/step ID ≠ Provider idempotency key；checkpoint ≠ billing receipt。

报告 65/66/67 的 Outbox、Host Capability、Operation、ModelCall 与 UNKNOWN ledger，无论选哪种 runtime 都仍然必要。

## 3. Restate 与官方 Agent 源码

### 3.1 Server 机制

Restate 官方架构文章说明：Server 接收 invocation 并持久化事件；SDK handler 可 journal steps、跨 handler 发事件、读写 state、创建 persistent futures/timers。Server 维护 invocation 生命周期、journal、embedded KV、failover、leader election 与 fencing；Server 对 invocation/journal 的视图是 ground truth。集群按 partition 分 leader/follower；RocksDB 保存可从 durable log 重建的 processor state，周期性 snapshot 到 object store 后 trim log；step 的提交点是 replicated log write quorum。

来源：[Building a modern Durable Execution Engine](https://restate.dev/blog/building-a-modern-durable-execution-engine-from-first-principles)。

### 3.2 Identity 与 retention

Restate Server v1.8.0：
- crates/types/src/identifiers.rs blob c892b3104e2f07427d0944ffef737b6b0f15e721 L360–430：Workflow invocation ID 由 service/key 确定性生成；普通 invocation 的 idempotency ID 由 scope/service/object key/handler/key 生成；无 key 则随机。注释明确相同 key 可在旧 invocation purge 后用于新 invocation。
- crates/worker/src/partition/state_machine/mod.rs blob b1282e5f58ce1326d9d647a9c6236502b1f717e0 L1080–1168：重复 key 会 join in-flight 或返回已完成结果。
- release-notes/v1.8.0.md blob d7ce98526946a9c78966555f2c6b5e02d7e096a0 L305–322：默认 completed invocation retention 1 day，可按 service 配置。

**dedup 是 retention-bounded，不是永久幂等**；保留期必须覆盖客户端 retry、webhook redelivery、队列重投和人工恢复窗口。

### 3.3 Restate Agent 的领域分层

固定仓库：[restatedev/agent commit 0d69256f82ccb0e8826dc96dae64bc7952a78f05](https://github.com/restatedev/agent/tree/0d69256f82ccb0e8826dc96dae64bc7952a78f05)。README 明确是 Agent execution/session reference，不包含 user accounts、OAuth、evals。

它使用两个同 key Virtual Objects：
- **Agent/{agentId} controller**：active turn ID、pending input、steering、profile/instructions/guardrails/tool grants、memories、approvals、schedules、child directory、notification watermarks。Exclusive handlers 串行化 controller decisions；controller 不等待完整 turn。
- **AgentSession/{agentId}**：append-only history、summary checkpoint、sandbox ref；一个 doTurn invocation 是一个完整 turn，其 invocation ID 即稳定 turnId。turn 内执行 model/guardrail/tool loop、并发 foreground tools、跨 step pending tools、steering、interrupt/finalization、subagent waits。
- History 以 32 entries/chunk 存 KV；summary 压缩上下文而不改写 canonical transcript。用户可见 transcript 与 Restate execution journal 分开，raw reasoning/tool args/results 不进入 public transcript。

关键源码：agent/service.ts blob caecc76e0037d2f635d01eac614902d81623ec16；session/service.ts blob 68f8bf46c5c674478b331d5483b8e61e1b869276；agent/active-turn.ts blob 025cfd0f3c32b3576d08797cef215097ec9b8d9a；session/history.ts blob 65ac4e37a7f5afbc4fac6fa1a420c2843d0097a9；docs/architecture.md blob 376608e6b0d8f2f7dc2a20df2589a2b0b508b5df；docs/turn-runtime.md blob 5f4082b0361d17239212ea4af687188f32409bc2。

### 3.4 Model/MCP/Shell 实际效果窗口

- model/inference.ts blob 73a3366e8863948b3dc2e8e64d770e070aad8491：model/guardrail calls 包在 restate.run；MODEL_RETRY maxAttempts=4，退避 500ms→5s；output truncation 另有一次 journaled recovery call。
- model/provider.ts blob 92c446e05f7c2d808e34e142c09e59f843d5767e：AI SDK maxRetries=0，由 Restate 统一 retry；OpenAI store=false；ModelResult 仅向 context 暴露 inputTokens，未见 per-request providerRequestId/responseId/usage/billing ledger。
- session/mcp-tools.ts blob 86b8ba06f2aa03cbc2aa3782b7a7551256619ba4 L209–280：MCP maxAttempts=1，因为 MCP 不标准化 idempotency；仍传 Idempotency-Key=turnId:toolCallId，但只有远端实际尊重才有效。注释明确 crash recovery 仍可能重复尚未 journal 的 remote side effect。
- tools/sandbox.ts blob c0f4b1d96d93aeaca8254e4422fccf748f5aad69 L76–166：file read/list/whole-file write 可有限重试；shell maxAttempts=1，因为非幂等；注释仍明确 crash recovery 可能重复未 journal command。
- sandboxes.md blob 7880e3ee037ecee43bc5cdb48f71d320714bf6a9：local provider 以 service user 运行，不是隔离边界；Abort 不保证杀死远端进程；不可重复 job 要求 provider stable operation ID + result query。

**推断**：若 Provider 已完成并计费，但 Restate journal 尚未持久化结果，恢复可能再次请求并重复计费。这正是报告 67/68 的 ModelCall UNKNOWN 窗口。

### 3.5 值得借鉴的 Agent 模式

- turn 开始 pin profile/instructions/guardrails/tool grants/MCP endpoint snapshot；配置变更只影响下一 turn。
- Guardrail 检查精确 proposal/action；PTC 子工具逐个进入同一 dispatcher/policy gate。
- steering 不取消当前 step/已运行工具；interrupt 才停止未完成工作，保留已完成结果后进行一次 tool-free finalization。
- pending tools 以稳定 toolCallId 管理，可跨 model steps；cancelOperation 只停止指定 pending operation。
- child Agent 有独立 history/memory/sandbox；child ID 由 parent/turn/toolCall 派生，清理精确 child turn，避免旧清理误杀 successor。
- canonical transcript 后台 summary 与 turn working-context compaction 分离。
- PTC 使用 QuickJS/WASM guest；guest 无直接 I/O，所有工具调用经同一受控 dispatcher。

### 3.6 生产缺口、版本和许可

- docs/development.md blob f89d3db1ab68bd47f69145e39e457850b22be468 L220–230 明确：operator hard kill 若发生在 onTurnEnd 前，reference 不会自动 reconcile active turn；这是 production gap。
- README 不包含 accounts/OAuth/evals；docs/architecture.md 明确 local UI 无 auth/tenant isolation，ingress 被信任；多用户 backend 必须对 read/write 都做 ownership authorization。
- AgentSession.retire 不等于 history data purge；retained history 需要独立删除合同。
- Restate v1.8.0 release notes blob d7ce98526946a9c78966555f2c6b5e02d7e096a0 L48–65：VQueues 默认启用，升级时 partition leader election 触发迁移；要求先 v1.7.3+；旧 service protocol v3 及更早版本不再支持。
- 同一 release note：pause in-flight invocation 会立即 abort attempt；已启动的 ctx.run closure 仍可能在 SDK 内继续，但结果无法记录，resume 后会重做。pause 不是 effect rollback。
- v1.8.0 L245–260 修复 killed/completed/purged invocation 遗留 pending sleeps 被同 key 新 run 意外唤醒。
- v1.8.1 release notes：排队但尚未开始 invocation 的 signal 可记录，但 experimental-enable-preflight-signal-recording 需显式启用；启用后不能回滚到低于 1.8.1。one-way start 后立即 steer/interrupt 必须测试。
- Agent commit 0d69256 使用 Restate TS SDK 1.17.0，README 仍要求 RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true；截至本研究日 SDK 1.18.0、Server 1.8.1 已发布，但公开 SDK compatibility table 仍只列 Server 1.5–1.7 / SDK 1.11–1.17。1.8.1+1.18.0 兼容矩阵未明确，不应假定兼容。
- Restate Server LICENSE v1.8.0 blob 82a68338267bbde13cf9b0a04682778284ef3f35 为 BSL 1.1。许可允许自有代码/内部平台，但不允许 managed service 让外部第三方直接注册其 Restate service endpoints 并通过 Restate API 调用。若目标是第三方可部署任意服务/插件的 managed platform，需先做法律审查。

## 4. Temporal：Event History 与 deterministic workflow

固定源码：[temporalio/sdk-typescript commit 8f9d0bebc5125719077a6dd863d59a04fcdf6ea8](https://github.com/temporalio/sdk-typescript/tree/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8)，@temporalio/workflow 1.25.0；TypeScript SDK/Server MIT。

- Workflow 恢复时从入口重放，通过 Event History 重建内存状态；Workflow API 产生 Commands，Server 持久化为 Events。已完成 Activity/Timer/Signal 在 replay 时由 history 返回原结果。
- Workflow 代码必须对同一 history 产生相同 Commands；部署变更需要 Worker Versioning/Patching，不能随意重排已有 command。
- Activities 承担 HTTP/DB/LLM/File I/O；Activity timeout/worker failure 可触发重新派发，外部 effect 仍必须幂等或使用 provider key/query。
- WorkflowOptions.workflowId 建议使用 business ID；Update ID 可去重，但作用域是单个 Workflow Execution/Run。Continue-As-New 后若要跨 run 去重，需显式迁移 processed IDs。
- ActivityCancellationType 默认 TRY_CANCEL：发送 cancel request 后立即向 Workflow 返回，不保证 Activity 已停止。WAIT_CANCELLATION_COMPLETED 要等 Activity 完成/取消，但 Activity 必须 heartbeat 才能收到取消通知。
- 长 Activity 用 Start-To-Close + Heartbeat Timeout 发现 worker crash，heartbeat 可保存 progress payload。

源码：client/workflow-options.ts blob 8ee48178fe9ebefce04c3bd801b95a99b6c1b92f L20–115；common/activity-options.ts blob 2aba44c32cd002dd40ed819eea15004459a394d2 L1–165；workflow/cancellation-scope.ts blob fbac3fdcc4c9f8c7b9bd10653a93eb0c15739db8 L20–100。
官方文档：[Workflow replay](https://docs.temporal.io/workflows)、[Activity failures/heartbeats](https://docs.temporal.io/encyclopedia/detecting-activity-failures)、[Entity workflow pattern](https://docs.temporal.io/design-patterns/entity-workflow)。

**Agent 适配**：agentId 可作为 entity Workflow ID；Signal/Update 承载 steer/ask/approval；Child Workflow 映射 subagent；Activities 可按工具拆 Task Queue。Temporal 不提供 transcript、guardrail、PTC、MCP、sandbox、context compaction。每个 Agent history 会持续增长，官方建议控制在数千 events 并用 Continue-As-New；更合理的方案可能是 controller workflow + per-turn child workflow，transcript 留在业务 DB。

## 5. DBOS：Postgres checkpoint + transactional data source

固定 TypeScript 源码：[dbos-inc/dbos-transact-ts commit 627990fc59619d3584ce88511ab546bc7483f4b9](https://github.com/dbos-inc/dbos-transact-ts/tree/627990fc59619d3584ce88511ab546bc7483f4b9)。root package 是 placeholder version，故只 pin commit，不猜测 release version。SDK/repo MIT。

- 每个 runStep 将 step output/error 写入 Postgres system DB operation_outputs；worker restart 后重新调用 workflow，已完成 step 由 workflowID + functionID 读取旧结果。
- callStepFunctionAt 先查询结果，无记录才运行 callback；callback 返回后再单独 recordOperationResult。外部 API 成功、checkpoint 前 crash 会重复执行。
- runStep 默认 maxAttempts=3；timeout race attempt 并触发 timeoutSignal。源码明确 timed-out attempt 被 abandoned，后续 Promise settlement 被丢弃；AbortSignal 不能证明远端 effect 已停止。
- runTransactionalInternalStep 调用 systemDatabase.runTransactionalStep；在一个 Postgres transaction 中先查询既有结果、执行 SQL callback、写 operation_outputs、再 COMMIT。
- packages/postgres-datasource/index.ts 也将 transaction_completion 输出行与用户 SQL 写入同一事务；并发冲突时读取已记录结果。因此同一 PostgreSQL 事务内的业务写入可与 checkpoint 原子化，但不覆盖 HTTP/MCP/Shell/LLM Provider。
- DBOS 官方架构：TypeScript app 需要 Postgres system database，没有独立 orchestration server；多个 executor 连接同一 DB，可用 durable queues。生产分布式部署推荐 Conductor 做故障检测、workflow recovery、admin UI、observability、retention。

源码：src/dbos-executor.ts blob 1688d6c18e7f8562a0a2daa99089c0828fb62dd7 L981–1055、L1135–1195、L1332–1355；src/system_database.ts blob 5b99126cf1ea9dde5beca5232731c2062b5a6981 L2280–2410；src/dbos.ts blob f6ffdd19dc2ea9db29620977190610a367f1d238 L470–535、L1650–1705、L2455–2490；packages/postgres-datasource/index.ts blob 41a781d6d07f79c176ee8c4c49e450a4dc13093f L115–235。
官方文档：[DBOS Architecture](https://docs.dbos.dev/architecture)、[TypeScript Programming Guide](https://docs.dbos.dev/typescript/programming-guide)。

## 6. 对当前 v0.2 架构的建议

### 6.1 保留领域边界

- AgentController：active turn、queue、steering、approval、schedule、subagent ownership；
- TurnExecution：model/tool iteration、step supervisor、pending operations、finalization；
- ConversationLog：append-only transcript、summary/compaction、cursor；
- Operation Journal：intent、attempt、receipt、effect evidence、UNKNOWN；
- ModelCall Ledger：modelCall/requestAttempt/transportAttempt/providerRequestId/responseId/usage/billing；
- Permission Authority：grant、policy revision、approval、revocation；
- Host/Provider Adapters：Capability Manifest、conformance、idempotency/query/cancel。

Durable Runtime 只负责恢复 TurnExecution 控制流，不替代这些领域账本。

### 6.2 采用 Restate 的映射

Agent/{agentId} 为 controller Virtual Object；AgentSession/{agentId} 为 transcript/turn Virtual Object；doTurn 是一个 invocation 管理多轮 model/tool iteration。Model/Tool effect 前先建立 domain ModelCall/Operation intent，拿到 receipt 后补写业务 ledger；Runtime 与业务 DB 分离时使用 Outbox/对账。只有 manifest X2+ 或 provider idempotency/query 通过 conformance 才允许自动 replay。canonical transcript 放 Restate KV 还是 Postgres 必须单独决定，不能维护两份都可写的权威 history。

### 6.3 采用 Temporal 的映射

AgentControllerWorkflow(agentId) 接收 Ask/Steer/Interrupt/Approval Signals/Updates；每 turn 用 Child Workflow；LLM/Tool/Host 都作为 Activities；transcript、ModelCall、Operation、PermissionGrant 放 Postgres/对象存储，Workflow History 只保留小 payload/ID。发布门禁为 Worker Versioning + replay CI + Continue-As-New。

### 6.4 采用 DBOS 的映射

AgentControllerWorkflow 与 TurnWorkflow 使用稳定 workflowID；Postgres 作为业务数据、ConversationLog、Operation/ModelCall、PermissionGrant、DBOS system tables 的主要底座；SQL 状态变更使用 Transactional DataSource。LLM/MCP/Shell/远端 sandbox 仍走普通 step + 外部 idempotency/query。

### 6.5 不做全引擎通用抽象

Temporal、Restate、DBOS 的 replay/signal/state/cancellation 语义不同。不要为了可替换抽象成最低公分母 API。只抽象领域接口（startTurn/sendSteer/requestInterrupt/awaitTurn/recordOperation/queryOutcome），由一个 Runtime Adapter 实现具体语义；第一版不要承诺三个引擎热切换。

## 7. Runtime POC / Conformance 计划（全部未执行）

共同：
- DR-01 Provider 已完成但 journal/checkpoint ACK 丢失：保留 UNKNOWN/usage_unknown。
- DR-02 MCP/HTTP/Shell effect 已完成但 journal 未记录：验证 provider idempotency/query；无能力时禁止盲重试。
- DR-03 effect 已发出后 cancel：cancel request、executor stopped、provider outcome 分开。
- DR-04 worker hard kill 在 onTurnEnd 前：watchdog reconcile orphan active turn。
- DR-05 signal/approval 在 invocation 尚未开始时抵达：可靠记录或由 controller durable queue 承接。
- DR-06 retention 过期后同 key 重放：不能误判永久 exactly-once。
- DR-07 active turn 期间升级：pin version 或 park/migrate。
- DR-08 并发 tool 一完成、一失败、一取消：保留完成 receipt。
- DR-09 1000+ turns/长 timer/subagents：测 journal/history 增长、恢复延迟和成本。
- DR-10 多租户读写取消/观察：每个入口都验证 tenant ownership。

Restate 专项：one-way doTurn 后立即 signal；pause ctx.run 后 resume；MCP/Shell effect 成功但 journal 前 SIGKILL；10min/1h retention 到期；v1.7.3→1.8.0 VQueues migration；hard kill 前 onTurnEnd；三节点 failover/snapshot/object-store outage；BSL 法律 review。

Temporal 专项：active history 中改动 command 顺序并 replay；Activity effect 成功但 completion 丢失；TRY_CANCEL vs WAIT_CANCELLATION_COMPLETED/heartbeat；Continue-As-New 后重复 Update ID；数千 events 的 replay；Worker Versioning/rollback。

DBOS 专项：普通 runStep effect 成功 checkpoint 前 kill；Transactional DataSource SQL commit/checkpoint 同事务；step 插入/重排导致 functionID/name mismatch；timeout 后底层 Promise 是否仍执行；多 executor/Conductor recovery；Postgres failover/migration；长 workflow operation_outputs retention。

**测试状态：均未执行。** Restate Agent test/restart.mjs blob fb75b5ad1f2f66ab53e9fc9b46af8532da5b8ab3 L1–120 有 SIGKILL+restart 测试定义，验证已 checkpoint 的 PTC lookup/score 不重跑；未覆盖“外部 effect 已成功、journal result 尚未写入”的窗口。本轮只阅读测试定义。

## 8. 风险与待决

1. Restate BSL 是否允许目标产品托管/第三方扩展/服务注册方式？
2. HA 目标是单节点、三节点、跨 AZ 还是 multi-region？
3. Agent history/operation/model usage 的唯一权威存储在哪里？
4. 长 turn 跨多次 deployment 时如何 pin handler/worker version？
5. Host/Provider 是否有真实 cancel/query/rollback 能力？
6. ModelCall create ACK 丢失、partial billing、usage/invoice reconciliation 仍需报告 67/68。
7. 多租户 auth 与 tenant ownership 不能照搬 reference Agent 的 trusted ingress。
8. data deletion 需覆盖 Runtime journal、canonical history、sandbox volume、provider stored response 和 backups。
9. 没有目标 workload benchmark；需按 model latency/tool fanout/turn length/signal volume/journal size 实测。
10. 不应为可移植性牺牲 replay correctness；先选一个主引擎。

## 9. 证据索引

Restate Agent：README/docs/architecture.md/docs/turn-runtime.md/docs/development.md 固定于 commit 0d69256f82ccb0e8826dc96dae64bc7952a78f05；关键 blobs：model/inference 73a3366e8863948b3dc2e8e64d770e070aad8491、model/provider 92c446e05f7c2d808e34e142c09e59f843d5767e、session/service 68f8bf46c5c674478b331d5483b8e61e1b869276、session/history 65ac4e37a7f5afbc4fac6fa1a420c2843d0097a9、session/mcp-tools 86b8ba06f2aa03cbc2aa3782b7a7551256619ba4、tools/sandbox c0f4b1d96d93aeaca8254e4422fccf748f5aad69、retention bc00196cc90d3ef7c19559ac14e2597cd2f17b51、test/restart fb75b5ad1f2f66ab53e9fc9b46af8532da5b8ab3。

Restate Server v1.8.0：identifiers.rs c892b3104e2f07427d0944ffef737b6b0f15e721；state_machine/mod.rs b1282e5f58ce1326d9d647a9c6236502b1f717e0；release-notes d7ce98526946a9c78966555f2c6b5e02d7e096a0；LICENSE 82a68338267bbde13cf9b0a04682778284ef3f35。

Temporal TypeScript：workflow-options.ts 8ee48178fe9ebefce04c3bd801b95a99b6c1b92f；activity-options.ts 2aba44c32cd002dd40ed819eea15004459a394d2；cancellation-scope.ts fbac3fdcc4c9f8c7b9bd10653a93eb0c15739db8。

DBOS TypeScript：dbos.ts f6ffdd19dc2ea9db29620977190610a367f1d238；dbos-executor.ts 1688d6c18e7f8562a0a2daa99089c0828fb62dd7；system_database.ts 5b99126cf1ea9dde5beca5232731c2062b5a6981；postgres-datasource/index.ts 41a781d6d07f79c176ee8c4c49e450a4dc13093f。

**本轮仅增加研究文档和研究进度；没有运行测试/benchmark，没有修改业务代码、Kernel 或 runtime，没有提交开发 PR；架构选择仍待用户审阅和明确批准。**
