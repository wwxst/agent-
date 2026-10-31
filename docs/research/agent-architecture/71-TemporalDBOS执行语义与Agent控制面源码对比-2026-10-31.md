# 71：Temporal 与 DBOS 执行语义、控制面 API 和事务恢复源码对比（2026-10-31）

> 研究阶段补充；没有开发批准。本报告对 Temporal TypeScript SDK 与 DBOS TypeScript SDK 做同粒度的执行路径复核，重点是 Agent Controller/Turn 如何映射到 Workflow、Signal/Update、Activity/Step、事务边界、代码升级与故障恢复。只读固定 commit 源码和测试定义；本轮没有执行测试、benchmark、数据库故障注入或外部 Provider 请求。

## 1. 固定研究基线与结论概览

- Temporal SDK：temporalio/sdk-typescript commit 8f9d0bebc5125719077a6dd863d59a04fcdf6ea8。
- DBOS SDK：dbos-inc/dbos-transact-ts commit 627990fc59619d3584ce88511ab546bc7483f4b9。
- Restate/Agent 对照：报告 69、70 的 restatedev/agent commit 0d69256f82ccb0e8826dc96dae64bc7952a78f05 与 restatedev/sdk-typescript commit e39fcc3b3d64c5b931d8f9edf58b13833fc61369。
- 本报告证据类型：源码事实、测试定义、架构推断、未知；所有测试均未在本轮执行。

### 结论摘要

1. **Temporal 是三者中控制面 API 最完整的通用 Workflow Runtime**：Workflow ID conflict/reuse、Signal、Update、Signal-With-Start、Update-With-Start、Continue-As-New、Cancellation Scope、Activity heartbeat/retry 和 patch-based code compatibility 均有清晰接口。
2. **DBOS 的差异化优势是 PostgreSQL 原子事务检查点**：PostgresDataSource 可以在同一数据库事务内提交业务写入和 transaction_completion；DBOS.send 在 Workflow 上下文中也能把消息插入与父 Workflow operation result 原子提交。
3. **Temporal/DBOS 都没有把任意外部副作用变成 exactly-once**：Temporal Activity completion 与外部 API commit 不原子；DBOS 普通 Step callback 与 operation_outputs checkpoint 不原子；只有 DBOS 同一 PostgreSQL transaction 中的业务 SQL 才能获得原子边界。
4. DBOS Step timeout 不会强制终止不合作的 Promise。上游测试明确覆盖 zombie attempt：第一次 attempt 超时后仍在后台运行，第二次 attempt 已返回 fresh；旧 attempt 最终完成但结果被丢弃。对 Shell/HTTP/MCP 等副作用，这意味着可能出现并发重复执行。
5. 两者的代码升级都需要显式兼容策略：Temporal patched/deprecatePatch；DBOS workflow source hash/applicationVersion + patch，autoUpgrade 需 Enterprise。不能把普通 rolling deployment 当作 replay-safe。

## 2. Temporal：Workflow History、Update API 与 Activity 执行语义

### 2.1 Workflow replay 不是内存快照

固定源码：
- packages/worker/src/worker.ts blob ed9e5f9288b6528522eed25d14ceeafbf52fc397。
- packages/worker/src/workflow/workflow-worker-thread.ts blob dd15ac95021a627e937055866382196925649d39。
- packages/workflow/src/worker-interface.ts blob 57a8f5e778625173823992e461793d4d8386ffcf。

Worker 收到 workflow activation 后，通过 runId 查找本地 cached workflow；若不存在，则从 initializeWorkflow job 创建 workflow VM。每个 activation 调用 workflow.activate，Workflow isolate 内的 activator 按 History jobs 更新 Signal/Update/Timer/Activity 状态并执行 queued microtasks，再产出 completion commands。Worker 进程内 VM cache 是性能优化，不是持久化事实来源；持久化 History 驱动重新执行。

因此 Temporal Workflow 必须遵守确定性约束：外部 I/O、随机数、当前时间等应使用 SDK durable APIs 或 Activity，而不能在 Workflow 代码里直接访问非确定性系统状态。

### 2.2 Workflow ID、Run ID、Conflict Policy 与 Reuse Policy 是不同层次

packages/common/src/workflow-options.ts 将两个维度分开：

- WorkflowIdConflictPolicy：同 ID 的 Workflow 正在运行时，FAIL、USE_EXISTING、TERMINATE_EXISTING。
- WorkflowIdReusePolicy：同 ID 的前一 Workflow 已关闭时，ALLOW_DUPLICATE、ALLOW_DUPLICATE_FAILED_ONLY、REJECT_DUPLICATE。
- SDK 文档明确不允许同一个 Workflow ID 同时存在两个 active executions。
- WorkflowIdReusePolicy 默认 ALLOW_DUPLICATE；WorkflowIdConflictPolicy 默认 unspecified。当前 pinned SDK 的 integration test 证明普通 start 的默认 running-conflict 行为是 fail，显式 USE_EXISTING 返回同一个 running run，TERMINATE_EXISTING 终止旧 run 并启动新 run。

start() 返回的 handle 不固定 runId，以便跟随 Continue-As-New chain；firstExecutionRunId 记录链起点。业务系统应把 Workflow ID 当作业务实体/协调器身份，把 Run ID 当作一次具体执行版本，不应混为一谈。

**设计影响**：若同一个 request ID 在 Workflow 已完成后也必须永久去重，不能只设置 Workflow ID；要配置 REJECT_DUPLICATE，或使用独立 Submission/Idempotency 表。ALLOW_DUPLICATE 默认会允许关闭后再次启动同 ID 的新 execution。

### 2.3 Signal、Update、Signal-With-Start、Update-With-Start

源码入口：packages/client/src/workflow-client.ts 与 packages/client/src/workflow-options.ts。

- Signal 是异步消息，不提供 handler return result。Workflow 通过 setHandler 注册；在 handler 注册之前到达的 Signal 会先 buffered，随后 dispatch。
- Signal-With-Start 调用一个 signalWithStartWorkflowExecution 服务操作。已存在同 ID running Workflow 时，默认 USE_EXISTING；显式 TERMINATE_EXISTING 可以替换旧 run。
- Signal-With-Start requestId 在 SDK 中默认 randomUUID；这不是调用方传入的稳定业务 idempotency key。应用层若在 ACK 不确定后重新发起一次新的 signalWithStart，可能再次投递业务 Signal；应在 Workflow state 或独立业务表按 requestId/messageId 去重。
- Update 是 request-response API。WorkflowUpdateOptions.updateId 是 unique-per-Workflow-Execution ID；SDK 建议传入上游业务 ID/idempotency key。若 Server 收到同一个 Workflow Execution、同一个 Run ID、相同 updateId 的重复 Update，会返回第一次 Update 的 handle。
- Update handler 可配置同步 validator；validator 通过后 Update 到达 ACCEPTED，之后 handler 完成进入 COMPLETED。handler 注册后 dispatch buffered updates。
- startUpdateWithStart 使用 ExecuteMultiOperation，把 startWorkflow + updateWorkflow 放在一个 MultiOperation 请求里；SDK 在 Update 达到 ACCEPTED 前重复发送请求，重复 updateId 会关联既有 Update；若调用方要求 COMPLETED，则之后 poll outcome。
- Update ID 去重范围是 Workflow Execution/Run ID，不应假设跨 Continue-As-New run chain 自动去重；跨 run 业务幂等仍需上层 identity。

这是 Temporal 对 Agent API 的一个重要优势：用户提交、审批、改变执行策略等需要受理确认的控制命令，可以使用 Update + stable updateId；只需要异步通知的状态变化再使用 Signal。

### 2.4 Long-lived Workflow、Continue-As-New 与代码升级

- continueAsNew 结束当前 run 并启动同一 Workflow ID 的新 run，传入新的参数/compact state；适合长寿命 Agent Controller 定期压缩 history，而不是无限累积 Signal/Activity events。
- patched(patchId) 在 replay 旧 History 时，根据历史是否包含该 patch marker 返回 true/false；新执行总是走新分支。deprecatePatch 的文档要求所有旧分支历史/worker 已退出后再移除旧兼容逻辑。
- 这不是自动 schema migration；Workflow arguments、search attributes、external payload、domain DB schema 仍需独立版本管理。

### 2.5 Activity retry、timeout、heartbeat 与 cancellation

固定源码：
- packages/common/src/activity-options.ts blob 2aba44c32cd002dd40ed819eea15004459a394d2。
- packages/common/src/retry-policy.ts blob fbd293a207790034f0726db5114758d4d7c02eef。
- packages/workflow/src/cancellation-scope.ts blob fbac3fdcc4c9f8c7b9bd10653a93eb0c15739db8。

ActivityOptions 的关键语义：

- startToCloseTimeout 限制单次 attempt；Server 不直接检测 Worker process failure，而依靠 timeout 发现 Activity 未按时完成。
- scheduleToCloseTimeout 限制包含所有 retries 的总时间。
- heartbeatTimeout 需要 Activity 周期 heartbeat；长任务要 heartbeat 才能及时检测 Worker 故障并接收 cancellation。
- RetryPolicy.maximumAttempts 默认 Infinity；0 或 Infinity 表示无限重试。maximumAttempts=1 才是单次 attempt。
- Workflow Retry 默认关闭；Activity Retry 默认使用 Server-defined policy。

ActivityCancellationType：
- ABANDON：不向 Activity 传播取消，立即向 Workflow 报告取消。
- TRY_CANCEL：发出取消请求，但立即向 Workflow 报告取消；Workflow 退出前请求可能尚未送达，Activity 也可能成功完成。
- WAIT_CANCELLATION_COMPLETED：等待 Activity 最终成功/失败/取消；Activity 必须 heartbeat 才能接收 cancellation，忽略取消会让 Workflow cancel 长时间阻塞。
- Workflow Termination 会取消所有 outstanding Activity，不受上述 Activity cancellationType 选择影响。

CancellationScope 是树状结构；nonCancellable scope 可在取消后执行 rollback/cleanup。这个机制可以帮助 graceful cleanup，但不能撤销已经提交的外部副作用。

**设计影响**：Temporal Activity 仍然是 at-least-once effect boundary。Activity timeout 后 Server 可重新调度；若旧 worker/远端系统仍在执行，外部副作用可能已成功或仍在进行。必须用 operationId + external idempotency/query/reconciliation，不可只靠 maximumAttempts=1。

## 3. DBOS：PostgreSQL-backed Workflow、Step ID 与事务原子性

### 3.1 Workflow ID 与 recovery admission

固定源码：
- src/workflow.ts blob 28673d194b80a2c1ebb32b8f641a5f2994774474。
- src/dbos.ts blob f6ffdd19dc2ea9db29620977190610a367f1d238。
- src/dbos-executor.ts blob 1688d6c18e7f8562a0a2daa99089c0828fb62dd7。
- src/system_database.ts blob 5b99126cf1ea9dde5beca5232731c2062b5a6981。

DBOS Workflow 是普通 TypeScript async function + sequential functionID/checkpoint，不是内存快照。Workflow 每次恢复会重新执行函数体，按 functionID 查找 operation_outputs；已记录的 Step/operation 返回 stored result/error，未记录的 operation 执行 callback 后写结果。

- WorkflowIDReusePolicy 默认 return-existing；reject 可让同 ID 已存在时抛 WorkflowIDInUse。
- startWorkflow 从外部启动 Workflow 并返回 handle；在父 Workflow 中启动 child 时，child ID 可由 parent workflowID + parent functionID 确定性派生。
- initChildWorkflowStatus 在同一 PostgreSQL transaction 内插入 child workflow status 并记录 parent operation result，避免 crash 后只创建 child 或只记录 parent 的半状态。
- functionIDGetIncrement 在 workflow context 中同步递增；并发操作应在 await 前预留 functionID。DBOS.reserveStep 可先分配 Step ID，再由其他 task 在固定位置运行，避免 timing-dependent call order。
- DBOS.runStep 若在 Workflow 中调用，会通过 callStepFunctionAt 先查 operation_outputs，再执行并记录；默认 retriesAllowed=false，若开启 retry 则按 maxAttempts/backoff/shouldRetry 执行。

### 3.2 普通 Step 与 Transactional Step 的恢复保证不同

普通 DBOS.runStep / runInternalStep：
1. 查询 operation_outputs 是否已有该 functionID 结果。
2. 没有则执行 callback。
3. callback 返回后再独立调用 recordOperationResult 写 operation_outputs。
4. replay 若结果已记录则直接返回；若 callback 的外部副作用成功但 checkpoint 未提交，恢复仍会再次执行 callback。

因此普通 Step 对外部效果仍是 at-least-once。

Transactional internal step：
- runTransactionalInternalStep 同步预留 functionID。
- SystemDatabase.runTransactionalStep 开启 PostgreSQL transaction。
- 同事务内查询旧 operation result、执行 callback(client)、写 operation_outputs、COMMIT。
- callback 必须使用传入的 PoolClient/同一 transaction；不能把任意 HTTP/MCP/Provider call 变成 PostgreSQL 原子事务。

### 3.3 PostgresDataSource：业务 SQL 与 transaction checkpoint 同事务

固定源码：
- src/datasource.ts blob 1ec4698c8691a880ffe965f9974762e229afce0b。
- packages/postgres-datasource/index.ts blob 41a781d6d07f79c176ee8c4c49e450a4dc13093f。
- packages/postgres-datasource/tests/datasource.test.ts blob a73f8858d294b8f3c50aba0aff474e73e607737f。

PostgresDataSource 的事务 handler：

1. Workflow 中先分配 functionID/stepID。
2. 在同一个 Postgres transaction 中执行用户 transaction function。
3. 用户通过 PostgresDataSource.client 使用该 transaction client 执行业务 SQL。
4. 在相同 transaction 中向 transaction_completion 写 output/error checkpoint。
5. assertStillOwnsWorkflow 检查 owner token；提交时 row/transaction lock 防止旧 owner 的 checkpoint 覆盖新 owner。
6. 若 transaction serialization failure，data source retry transaction；若另一 owner 已记录同 step，读取 winner checkpoint 并 replay winner output/error。

这比“执行外部 callback 后另写 checkpoint”强得多：业务 DB 写入和 checkpoint 要么一起提交，要么一起回滚。

测试定义：
- duplicate execution replays the winner result：两个竞争 execution 可能都进入 callback，但 loser 的 SQL writes 被 rollback，返回 winner 的 durable result/error。
- an execution that loses the workflow mid-transaction rolls back：旧 owner 失去 ownership 后不能应用业务 SQL，也不能写 operation_outputs。
- transactions record their outcomes as checkpoints：transaction output/error 可在 Workflow 运行期间读取，Workflow 完成后 checkpoint 被清理。
- 本轮未执行这些测试。

**适用边界**：这只覆盖通过同一个 Postgres transaction client 执行的 SQL/transactional resource。若 callback 同时发 HTTP/MCP/Shell，再 rollback 数据库也无法 rollback 已发生的远端效果。

### 3.4 Owner fencing 与恢复队列

- Workflow status 有 owner_xid；dispatch claim 通过 SQL UPDATE 原子认领 workflow，增加 recovery_attempts 并分配新的 owner_xid/executor_id。
- recordOperationResultInternal 在提交前 checkOwner；checkOwner 用 SELECT ... FOR NO KEY UPDATE，row lock 持有到 transaction commit。旧 owner 若已失去 ownership，不能提交 checkpoint。
- recoverPendingWorkflows 在 executor init 时把上一个 executor 未完成的 PENDING workflows 重新 enqueue 到内部 queue；queue atomic dequeue 决定唯一 runner。
- Workflow status 的 recoveryAttempts 默认上限 100，超过后进入 MAX_RECOVERY_ATTEMPTS_EXCEEDED/dead-letter 状态。
- SystemDatabase 注释明确：Postgres LISTEN/NOTIFY 不是完全可靠；连接丢失可通过重启和扫描恢复，通知还需 polling 作为补充。

这是一套明确的数据库 ownership/fencing 协议；它保护数据库 checkpoint 和事务，不会自动 fence 一个已发出的远端 HTTP 请求。

### 3.5 DBOS.send：Postgres 内部 durable messaging

固定源码：src/dbos.ts 1750–1825；src/system_database.ts 3544–3720。

- Workflow context 中 DBOS.send 先同步分配 functionID，然后调用 SystemDatabase.send。
- SystemDatabase.send 在一个 transaction 内通过 #runAndRecordResult 检查/记录 sender operation，并 insert destination notification。
- messageUUID = idempotencyKey + destinationID；notifications 表以 message_uuid 唯一冲突 DO NOTHING，key 按 destination scope。
- 因此 Workflow 中的 DBOS.send 可以将 sender checkpoint 和 durable message row 原子提交；显式 idempotencyKey 还可在不同调用入口间去重。
- 但在 Step context 内，DBOS.send 走 sendFromStep，源码注释明确 “not recorded, but fenced on the enclosing workflow's ownership”；若 Step body 可能重试，必须显式提供稳定 idempotencyKey。
- Workflow 外部调用 sendDirect 时也要显式提供 key，未提供会生成 randomUUID。

对 Agent Controller 而言，这能提供 PostgreSQL 内部的 durable mailbox/command bus；它不是面向任意外部系统的通用 exactly-once bus。

### 3.6 Step timeout 的 Zombie Attempt 是明确的外部副作用风险

DBOS StepConfig.timeoutMS 会触发 timeoutSignal，并通过 Promise.race 让 Workflow 观察到超时。但源码文档明确：attempt code 不会被强制终止；若不观察 signal，它仍会在后台运行，最终结果被丢弃。

上游 tests/step_timeout.test.ts 的两个测试明确覆盖：
- uncooperative-zombie-resolution-is-discarded：第一次 attempt 忽略 100ms timeout，继续 sleep 1s；第二次 attempt 返回 fresh；旧 attempt 仍在后台运行，之后才设置 zombieDone；DBOS 只保存 fresh 结果。
- uncooperative-zombie-rejection-is-swallowed：旧 attempt 超时后继续运行并 reject，拒绝被吞掉，不影响已成功的新 attempt。

这对 Agent Host 极其重要：Step timeout 不是 kill process、不是 cancel remote command、不是 rollback；旧 attempt 可能继续产生 effect，而新 attempt 已经开始。对不合作工具，应将 timeout 视为 UNKNOWN/需要 reconciliation，而不是安全重试。

### 3.7 Workflow code versioning

- computeAppVersion 对注册 Workflow 函数源码排序后计算 MD5，并混入 DBOS version/app name；源码变更会改变 appVersion，避免新代码无条件恢复旧 workflow history。
- recoverPendingWorkflows 只把匹配当前 appVersion 的 workflow 重新 enqueue；改变 Workflow 逻辑需要 DBOS.patch/deprecatePatch 或版本升级策略。
- autoUpgrade 相关配置在源码中标注需要 Transact Enterprise；不能把 Enterprise 自动升级能力当作开源基础能力。

## 4. 上游测试定义审计

本轮只读测试定义，没有执行：

| Runtime / 测试 | 覆盖 | 不能据此声称 |
|---|---|---|
| Temporal test-integration-workflow-start.ts | 默认 running ID conflict fail；显式 FAIL/USE_EXISTING/TERMINATE_EXISTING；Signal-With-Start 默认复用现有 running run | 不证明 Signal 本身有稳定业务去重 key；不证明外部 Activity effect exactly-once |
| Temporal test-signals-are-always-delivered.ts | Signal 在 Workflow Task 处理期间到达，Task 失败后 worker 获取包含 Signal 的新 Task，Signal 在 Workflow body 开始前被处理 | 不证明所有应用层 handler 都成功或 Signal payload 已执行业务效果 |
| Temporal test-signal-query-patch.ts | pre-patch worker 产生 History，post-patch worker replay 不产生 nondeterminism | 不证明任意 schema/code change 自动兼容 |
| Temporal test-integration-cancellation-scopes.ts / test-workflow-cancellation.ts | cancellation propagation、nonCancellable cleanup、scope tree、Activity cancellation scenarios | 不证明远端外部副作用 rollback |
| DBOS chaos-tests/workflows.test.ts + chaos-tests/helpers.ts | PostgresChaosMonkey 每 5–10 秒 restart Docker Postgres，停机 0–2 秒；覆盖 5,000 workflow、5,000 send/recv、events、schedule 等 | 本轮未执行；也不覆盖 Provider/MCP/Shell external effect |
| DBOS postgres-datasource/tests/datasource.test.ts | duplicate execution winner replay、transaction checkpoint、stale owner rollback、transaction ownership handoff | 不证明非 Postgres external API 原子性 |
| DBOS tests/step_timeout.test.ts | cooperative timeout、retry、non-cooperative zombie resolution/rejection | 不证明被 timeout 的外部 process 被终止；相反源码/测试表明它可能继续运行 |

## 5. Temporal / DBOS / Restate 对 Agent 的映射

| 维度 | Temporal | DBOS | Restate |
|---|---|---|---|
| Durable source of truth | Server Event History | PostgreSQL workflow_status + operation_outputs + transactional data source checkpoints | Invocation Journal + Virtual Object state |
| Workflow execution | Workflow code deterministic replay | Workflow function replay + sequential functionID | Invocation replay + journaled commands |
| Controller API | Signal / Update / Signal-With-Start / Update-With-Start | DBOS.send/recv, events, child workflow | Virtual Object RPC + durable Signal |
| 请求去重 | Update ID per execution/run；Workflow ID policies | Workflow ID reuse；send idempotencyKey；step functionID | invocation id / RPC idempotency key；handler retention |
| Long-lived Controller | continueAsNew | workflow recovery + app version/patch | long invocation or separate VO |
| Side-effect boundary | Activity | Step / Transaction | ctx.run / service call |
| DB atomic checkpoint | 用户自行构建 transaction/outbox | PostgresDataSource 可原子写业务 SQL + checkpoint | 需通过 DB integration/idempotency；Journal 与业务 DB 不自动原子 |
| Cancellation | CancellationScope + Activity heartbeat/type | workflow cancelSignal + Step timeoutSignal，cooperative only | cancellation signal + run/task cancellation |
| Code versioning | patched / deprecatePatch / worker versioning | source hash + patch；autoUpgrade Enterprise | workflow/service version compatibility + server journal compatibility |
| External exactly-once | 不提供；Activity idempotency/ledger | 不提供；仅同一 DB transaction 内可原子 | 不提供；需要 external idempotency/receipt |
| License/ops | MIT SDK；需运行 Temporal Server/Cloud | OSS Postgres-centric + Enterprise features | BSL 1.1 Server + SDK/reference version matrix |

## 6. 对独立目标架构的更新建议

### 6.1 保留 runtime-independent domain contract

不应把 Submission、Turn、Operation、ModelCall、Permission、Receipt、Event Stream 的业务身份绑定到 Temporal Workflow ID、DBOS functionID 或 Restate invocation ID。

- Submission ID：一次外部请求的稳定业务身份。
- Turn ID：一次 Agent 执行回合的稳定身份。
- Operation ID：一次工具/Host 语义副作用的稳定身份，跨 retry/replay 保持。
- ModelCall ID：一次逻辑模型请求；requestAttemptId 与 transportAttemptId 分开。
- Runtime Execution ID：Temporal Run ID / DBOS workflowID+functionID / Restate invocation ID，仅作为执行证据映射。

### 6.2 若选 Temporal

- AgentControllerWorkflow(agentId) 管理 active turn、queue、approval、steer/interrupt 和用户交互。
- 每个 Turn 使用 child workflow 或独立 Workflow ID；turnId 由业务层生成，不直接使用 Run ID。
- 用户 submit/approval 等要求受理 ACK 的命令用 Workflow Update，传稳定 updateId；只需通知的事件用 Signal。
- 长期 Controller 用 Continue-As-New 压缩 Workflow History；代码变更通过 patch/versioning 管理。
- 模型/Host 工具通过 Activities 执行；Activity heartbeat/cancellation 用于长操作进度，但每个副作用仍先创建 Operation intent 并使用 Host idempotency/receipt。
- cleanup 采用 nonCancellable scope；Activity cancel 语义必须明确 TRY_CANCEL vs WAIT_CANCELLATION_COMPLETED。
- 保留领域 DB 的 Operation/ModelCall/Receipt ledger，不把 Temporal Activity History 当作业务效果审计表。

### 6.3 若选 DBOS

- AgentController 与 Turn 可用独立 DBOS Workflow；控制命令通过 DBOS.send/recv 和 durable event。
- 同一 Postgres 中的业务状态变更优先放入 PostgresDataSource transaction，使业务 SQL + transaction_completion 原子提交。
- child Workflow start 与 parent functionID 由 DBOS runtime 原子记录，适合层级任务。
- 并发 Workflow fan-out 要同步 reserveStep/functionID，避免 timing-dependent step ordering。
- 普通 Step 只承诺 replay/checkpoint，不承诺外部 exactly-once；不合作的 timeout attempt 可能继续执行，必须由 OperationCoordinator/Host 做幂等和 UNKNOWN reconciliation。
- 数据库不可用期间执行会暂停；部署、备份、恢复、migration、Postgres pool 和锁争用将成为系统核心运维能力。

### 6.4 选型判断（仍是研究判断，不是最终批准）

- 如果首发是多节点、多 Provider、多种工具、需要强控制面 API 和丰富 Workflow observability，Temporal 是当前更稳健的默认候选；代价是独立维护 Operation/ModelCall/Permission/Host 领域账本。
- 如果首发产品高度 Postgres-centric，业务效果大多能纳入同一 Postgres transaction，DBOS 值得优先 POC；它能把数据库业务效果与执行 checkpoint 结合，但非数据库工具仍要走独立 Host ledger。
- 如果首发偏低延迟、按 Agent key 串行状态、服务化 invocation，Restate 的 Virtual Object + Journal 模型仍是最贴近的参考；但 BSL、hard-kill gap 和外部效果窗口需先解决。
- 不建议为了抽象出“一个 runtime interface”而抹平三者差异；抽象 domain contract 与 runtime adapter 即可，不承诺热切换底层 Durable Runtime。

## 7. 未决问题与下一步

1. 结合报告 64–70 的目标架构 v0.2，做一次逐模块映射：Controller、TurnEngine、OperationCoordinator、ModelCall Ledger、Permission Authority、Host Gateway、EventHub、History/Memory、Sandbox。
2. 明确首发部署形态、Postgres 是否已是权威业务 DB、是否允许托管 Temporal/Restate、Restate BSL 适用范围、DBOS Enterprise 能力预算。
3. 建立一张跨 runtime guarantee matrix：workflow replay、DB transaction、external effect、cancel delivery、timeout kill、owner fencing、history/code migration、data retention。
4. 继续研究 Agent 专属执行模式和 host capability/permission 方案；在用户明确批准前不执行 POC、benchmark、chaos test，不修改业务代码或 Kernel。

## 8. 来源索引

### Temporal SDK

- [Workflow ID conflict/reuse policies](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/common/src/workflow-options.ts)
- [Workflow Client start / signalWithStart / updateWithStart](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/client/src/workflow-client.ts)
- [Workflow Update ID options](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/client/src/workflow-options.ts)
- [Workflow patched / continueAsNew / setHandler](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/workflow/src/workflow.ts)
- [Activity timeout / heartbeat / cancellation types](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/common/src/activity-options.ts)
- [RetryPolicy](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/common/src/retry-policy.ts)
- [CancellationScope](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/workflow/src/cancellation-scope.ts)
- [Workflow activation](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/workflow/src/worker-interface.ts)
- [Worker replay/activation](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/worker/src/worker.ts)
- [Signal delivery test](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/test/src/test-signals-are-always-delivered.ts)
- [Workflow start conflict tests](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/test/src/test-integration-workflow-start.ts)
- [Signal/query/patch replay test](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/test/src/test-signal-query-patch.ts)
- [Cancellation scope tests](https://github.com/temporalio/sdk-typescript/blob/8f9d0bebc5125719077a6dd863d59a04fcdf6ea8/packages/test/src/test-integration-cancellation-scopes.ts)

### DBOS SDK

- [Workflow ID policy and recovery model](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/workflow.ts)
- [DBOS runInternalStep / transactional step / startWorkflow / send / runStep / patch](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/dbos.ts)
- [DBOS executor recovery / step retry / owner context / app version](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/dbos-executor.ts)
- [SystemDatabase workflow status / transactional step / messaging / owner fence](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/system_database.ts)
- [Transactional data source interface](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/datasource.ts)
- [PostgresDataSource atomic transaction checkpoint](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/packages/postgres-datasource/index.ts)
- [PostgresDataSource transaction/recovery tests](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/packages/postgres-datasource/tests/datasource.test.ts)
- [Postgres chaos tests](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/chaos-tests/workflows.test.ts)
- [Postgres chaos monkey](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/chaos-tests/helpers.ts)
- [Step timeout and zombie attempt tests](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/tests/step_timeout.test.ts)

