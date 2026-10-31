# 66：Host Capability Manifest 与 Tool Execution 一致性验收合同（2026-10-31）

> **研究/设计补充；没有开发批准。** 本文把报告 62 的 Host Operation 协议和报告 65 的 X0–X4 effectEvidence 维度，细化为可机器检查的 capability manifest、状态查询语义和 conformance suite。对照证据：Claude CLI 2.1.304 报告 35/38/41、Desktop SDK 3.1623.1 报告 50，以及 Pi Durable v1.4.0 的 ToolRegistration/ToolTask/Scheduler 源码与既有测试。
> **边界**：Claude CLI/Desktop 仅有固定发布 JS 静态分析；Pi 仅有固定 release 源码和测试定义，本轮没有执行任何真实 Host/provider crash test。以下 manifest、协议字段和测试是目标架构提案，不是声称 Claude/Pi 已实现完整合同。

## 1. 从源码抽取的事实与设计缺口

### 1.1 Claude CLI Remote Host：三类 identity，分开 dedup 与 result recovery

报告 38 对固定 Claude CLI 2.1.304 bundle 的静态追踪表明：
- call_id 等于模型 ToolUse ID，是 Host serving side 跨 approval legs、redelivery 和 outcome query 的 run-at-most-once key；
- request_id 是每次 Session control request/leg 的 ID，负责该 leg 去重和 control_cancel_request；
- worker_epoch 用来区分跨 Cloud Worker 生命周期的同一逻辑请求；Host retry-join 用它处理 worker epoch 变化下的同一请求。
- 同一 worker epoch 内，模型若重新生成新的 tool_use_id/call_id，不能仅凭 retryKey 自动合并旧 operation；新的 call_id 可能重新执行。
- Host 端内存 call ledger 保存状态与有限期结果；独立 JSONL summary log 持久化 started / disowned / leg 等摘要。重启后可恢复部分 summary，但不一定恢复完整 result，也不恢复所有 retryKey/workerEpoch 信息。
- outcome_of 可返回 answer / still_running / not_received / host_restarted / unknown / unreachable / cancelled 等不同结果；“not_received”与“unknown/unreachable”不是同义词。
- approval 尚未允许时的 cancelled/timed_out 可以带 ranNothing:true；已经允许执行后取消，可能部分运行且不带 ranNothing。cancel transport 本身不包含 Host 最终 effect outcome。
- disowned tombstone 用于在 late delivery 到达时阻止旧 call 被执行，即使查询方已经认为该 call 未收到。

这组证据说明：**请求腿去重、逻辑 ToolCall 去重、跨 Worker 迟到请求 tombstone、完整 result 恢复是四个不同合同**。持久化 summary 可以防止重复执行，但若完整 result 已淘汰，系统仍可能只能展示 UNKNOWN/需人工核对。

### 1.2 Pi Durable：replay safe 是注册策略，不是 Host 外部效果证明

固定 Pi v1.4.0：
- packages/durable/src/harness/types.ts blob 289b5c4e18b0a36267ef5f5e36d9afda2a649ecf L300–308：ToolRegistration 声明 replay?: "safe" | "unsafe"，注释定义为“中断执行后是否可在恢复时重新运行”，默认 unsafe。
- packages/durable/src/harness/tool.ts blob 52bc4a3ada1892645aca5a35f4d90b875edda4ca L103–213：ToolTask 在执行前 commit 最终 arguments 和 stored replay policy；恢复时 stored policy 与当前 resolved tool policy 都为 safe 才重跑，否则 interrupted/may-have-partially-run。
- packages/durable/test/harness-tools-recovery.test.ts blob 226bade8155d791e76ab355a17d39e77ccae99ed：上游测试定义验证 safe/safe 才重跑，stored safe/current unsafe 与 stored unsafe/current safe 都不重跑；本轮未运行。
- nested caller 的 replay/abandonOnRestart 还影响其 child ToolTask 是否重新接管，见 harness-nested-tools-restart.test.ts blob 342e103c08cb9b06da76a2621e3f2e7e43f8a789。

因此 Pi 的 replay 字段是**可信工具作者对恢复策略的声明**，不是从 effect provider 取得的事实；它本身不证明第三方 HTTP/MCP/shell 在 crash 窗口没有发生副作用。目标架构需要独立校验 Host/provider 的 effect capabilities。

### 1.3 Claude Desktop SDK：AbortSignal 不是强制回滚

报告 50 证明 SDK host hook callback wrapper 可移除 tracking / 发送 cancel，但不会强制终止不消费 AbortSignal 的任意 callback。CLI reinitialize 会 retire 旧 hook generation；旧 hook decision 不能作为新宿主 generation 的永久授权。此证据进一步支持将 permission decision、callback lifecycle、operation result 分开。

## 2. Identity contract：不得复用不同语义的 ID

| 字段 | 创建方 | 稳定范围 | 作用 | 不应承担 |
|---|---|---|---|---|
| submissionId | Coordinator | 一次用户提交 | 查询用户请求是否已受理 | 外部 Tool 去重 |
| clientRequestId | Client | 客户端重投窗口内稳定 | Submit API 幂等受理 | Provider 请求去重 |
| modelRequestId | Model Gateway | 一次逻辑模型调用 | Provider request/usage reconciliation | Tool effect 去重 |
| toolUseId | Model | 一次模型输出中的 ToolCall | transcript correlation | 跨 model retry 的语义操作 ID |
| operationId | Coordinator | 一个语义外部效果永远稳定 | Host dedup / status / receipt key | 每次传输请求身份 |
| attemptId | Dispatcher / Coordinator | 一次发送/恢复尝试 | telemetry、retry、网络诊断 | effect idempotency key |
| requestId | Host RPC adapter | 一次 Host protocol leg | 取消、传输去重、pending response correlation | 跨所有 legs 的 effect key |
| ownerEpoch | Task Coordinator | 一代执行所有权 | 拒绝旧 owner 的新 effect 命令与 Task transition | 识别外部效果已完成 |
| hostInstanceId | Host | 一次 Host 进程/实例生命周期 | provenance、process restart correlation | operation identity |
| effectKey | Provider adapter / Coordinator | 一个 provider 业务效果 | provider-native idempotency | 通用 Host request ID |
| grantId / policyRevision | Permission Authority | 一次审批与策略版本 | 授权、撤销、审计 | operation result |

**关键不变量**：
- 同 operationId + 相同 canonical argsHash：重复 dispatch 必须 join/read existing state，不能创建第二个语义 operation。
- 同 operationId + 不同 argsHash/toolVersion/schemaHash：hard conflict，不得静默覆盖。
- 新 operationId 表示新的用户/模型语义意图；即使 args 完全相同也不能自动当作同一业务效果。只有明确复用同 effectKey 才能调用 provider 去重。
- operationId 必须由可信 Coordinator 生成，不得直接使用模型可任意重建的 toolUseId 作为唯一业务幂等键。
- ownerEpoch 只 fence 新的执行命令和控制面写入；可信旧 Host 的 late receipt 可作为 effect fact 被收录。

## 3. Host Capability Manifest（目标合同）

Host 启动/注册 ToolProvider 时发布版本化 manifest；Coordinator 在 OperationIntent 中 pin 该版本和 schema hash。Manifest 至少包含：

### 3.1 Identity / version / scope
- hostId、hostProtocolVersion、hostInstanceId；
- toolId、toolVersion、implementationDigest、inputSchemaHash、outputSchemaHash；
- supportedExecutionModes（local process / container / remote process / MCP server / provider API）；
- supportedPrincipal/tenant scope、resource namespace、credential audience；
- sandboxProfileId、filesystem/network/process/secret exposure scope；
- permissionEnforcement（coordinator-only / host-pre-execute / OS-enforced）。

### 3.2 Dedup / receipt / outcome query
- dedupScope：none / process-instance / persistent-host-ledger / provider-effect-key / shared-transaction；
- dedupKeyDefinition：operationId / operationId+argsHash / effectKey；
- dedupRetentionMs 与 tombstoneRetentionMs；
- fullResultRetentionMs 与 summaryRetentionMs；
- outcomeQueryConsistency：none / best-effort / read-after-write / linearizable；
- notFoundSemantics：not-in-this-cache / definitive-never-accepted / unknown；
- canJoinInProgress、canRecoverAfterHostRestart、canReturnStoredReceipt；
- receiptDurability：volatile / process-recoverable / local-fsync / sync-replicated；
- receiptProvenance：Host signature / authenticated channel identity / provider receipt reference / result hash。

### 3.3 Cancellation / resume / execution boundary
- cancelMode：unsupported / request-only / cooperative-stop / process-terminate / provider-cancel-confirmed / transactional-rollback；
- cancelAckMeaning：request-recorded / signal-delivered / executor-stopped / effect-rolled-back；
- resumeMode：none / join-existing / reattach-process / provider-query / replay-with-idempotency；
- effectBoundary：pure-compute / read-only / single-provider-operation / arbitrary-process / multi-effect-script；
- maySpawnChildren、mayAccessNetwork、mayWriteFilesystem、mayUseExternalCredentials；
- deadline / heartbeat / lease behavior and clock authority；
- resourceConcurrencyKey / serialization scope；
- provider idempotency TTL and query availability.

### 3.4 Policy constraints
- host 是否每次 execute 都检查 grant/policy revision；
- grant 是否绑定 argsHash/toolVersion/resource scope/tenant；
- approval 是否能在 prepare 与 execute 之间撤销；
- extension/nested tool 是否要求单独 child grant；
- policy authority 不可达时的 fail-closed 行为；
- Host/Tool capability 变更时如何 retire/park 已 admission operation。

Manifest 是 capability claim，不是自我证明。每个 capability 字段必须绑定 contract test result、adapter version、known limitations；未验证项默认 downgrade。

## 4. QueryOutcome 的状态语义

不能只返回 nullable result 或一个 404。建议 Host 对 operationId 返回以下 union：

| outcome | 语义 | Coordinator 可做什么 |
|---|---|---|
| not_seen_definitive | 权威 durable dedup ledger 在线、线性一致查询，覆盖所有 in-flight/accepted 请求；operationId 不存在且 retention/tombstone 保证完整 | 可按原 operationId 尝试 prepare/dispatch，但必须重新校验 grant/epoch |
| not_in_local_cache | 仅本进程内存缓存未找到 | 不可推断未收到；转 durable query 或 UNKNOWN |
| approval_pending | 已收到，尚未获准执行 | 继续等待/撤销/超时；不得执行 |
| accepted | durable Host ledger 已受理 | join/poll 同 operationId |
| running | 已启动，尚无 terminal evidence | join/poll；不可发新 operation |
| cancel_requested | 已记录取消请求，尚未证明停止 | 等待 terminal evidence；不能写 aborted-as-no-effect |
| stopped_before_effect | Host 能证明 side-effect boundary 尚未进入 | 可根据 policy 重试/终止 |
| completed | 有可信 receipt，含 effectKey/provider ref/result hash | 幂等补写 Control Receipt/ToolResult |
| failed_before_effect | Host 能证明在 effect boundary 前失败 | 可按 policy 重试 |
| failed_after_partial_effect | 有部分 effect evidence 或明确 partial result | 人工/业务 reconcile；禁止盲重试 |
| already_seen_result_expired | durable tombstone 证明 operation 已受理/执行过，但完整 result 已被 retention 清理 | 禁止重执行；进入人工/外部 query |
| host_restarted_summary_only | 旧 Host summary 可证明曾启动/结束，但没有完整 result | 按 summary 分类；不伪造成功/失败 |
| outcome_unknown | 证据不足以判断 effect 是否发生 | 保持 UNKNOWN |
| unreachable | 权威 Host/ledger 不可达 | 保持 UNKNOWN；不能把网络错误转成 not-seen |

**not_found 只有在 manifest 明确保证它是线性一致的 definitive absence 时，才可映射为 not_seen_definitive。** 普通数据库读副本延迟、内存缓存 miss、TTL 已过、Host 重启未恢复 ledger，都只能是 unknown / not-in-cache。

## 5. Cancellation 与 Permission 的独立状态

### 5.1 Cancel status

cancelRequested、cancelAccepted、executionStopped、effectRolledBack 是不同事实：
- cancelRequested：Coordinator 发送停止意图；
- cancelAccepted：Host 已登记取消请求；
- executionStopped：执行进程/handler 已停止，但外部 API 可能已成功；
- effectRolledBack：effect provider 有明确 rollback/compensation receipt。

只有最后一项能声明业务效果回滚。进程退出、AbortSignal aborted、MCP cancelled notification 都不是 effect rollback 证明。

ranNothing=true 必须来自执行端对 effect boundary 的可靠观察，例如 permission/approval 之前尚未调用 executor；不能因 transport cancelled、Host timeout 或进程重启自动设置。

### 5.2 Permission status

- Grant 必须绑定 operationId、canonical argsHash、tool/schema version、resource scope、principal/tenant、policyRevision 和 expiry。
- Host prepare 时检查身份与工具 capability；Host execute 前再检查 grant 与最新 policy revision。
- permission approval 返回修改后的 args 时，必须重新 canonicalize/hash/re-evaluate；不得默默将“批准前参数”映射成“修改后参数”。
- grant revoke 只阻止尚未进入 effect boundary 的新执行；已经发出的外部 effect 不能被授权系统宣称撤回。
- 子任务/nested Tool 必须继承受限 delegation scope 或单独申请 grant；不能因 parent tool 获批而获得无限制子工具权限。

## 6. Replay 决策：三方证据取最严格者

恢复是否可以 replay 由三个独立事实共同决定：

1. **Stored intent policy**：创建 Intent 时记录的 replay class 与参数/版本 hash；
2. **Current code policy**：恢复时 ToolProvider 当前版本是否仍然允许该 replay class；
3. **Effect capability**：Host/provider 是否提供与该操作匹配的 durable dedup/idempotency/outcome contract，且 retention TTL 覆盖恢复窗口。

建议 policy：
- never：永不自动重放；
- pure：确定性纯计算/只读；可重新运行，但仍要重新授权；
- host-deduplicated：仅同 operationId 发送，Host durable ledger 负责 join；
- provider-idempotent：同 effectKey 重试，且 provider idempotency TTL 仍有效；
- transactional：effect 与 receipt 同 DB 事务，按同一事务状态恢复。

实际执行决策：
- stored policy 与 current policy 不一致：park/UNKNOWN，不降级绕过；
- Host manifest/schema/tool implementation digest 变化：旧 operation 不能偷偷路由到新实现；必须迁移/人工确认；
- provider idempotency TTL 过期：禁止自动用旧 effectKey 重试，转 UNKNOWN；
- host ledger only + provider effect outside its DB：Host ledger 的 started-but-no-receipt 窗口仍可能 UNKNOWN；
- tool author 标记 replay=safe 不能覆盖 Host 的 effectBoundary=arbitrary-process / dedupScope=none。

## 7. Host Conformance Test Suite（设计计划，未执行）

每个 ToolProvider adapter 必须提供可自动化的 capability conformance suite，至少包括：

| Test ID | 故障/竞争场景 | 必须满足的结果 |
|---|---|---|
| HC-01 | 相同 operationId + argsHash 并发两次 execute | 具备 X2+ 时只创建一个逻辑 Host operation；另一个 join/read |
| HC-02 | 相同 operationId、不同 argsHash/schemaHash | hard conflict；不能替换已存 intent |
| HC-03 | attemptId/requestId 变化但 operationId 不变 | 仍 join 原 operation，不产生第二个 effect |
| HC-04 | Host 收到 operation 后、effect 前 crash | restart/query 能区分 accepted/never-started/unknown |
| HC-05 | effect 成功后、receipt 持久化前 crash | 若 provider 无幂等/查询，必须 UNKNOWN；不能声称失败并重做 |
| HC-06 | Host receipt 已持久化、Coordinator 未提交 ToolResult 时 crash | 重启 query 得到同 receipt；Control DB 幂等补写 |
| HC-07 | Host full result 过期但 tombstone 尚存 | 返回 already_seen_result_expired；禁止重执行 |
| HC-08 | tombstone retention 早于最大 dispatcher retry horizon | capability validation fail；不能声明 X2/X3 |
| HC-09 | queryOutcome not-found 与并发 execute/网络分区交错 | 不把普通 not-found 误判为 definitive never-seen |
| HC-10 | cancel 在 permission pending / executor started / provider completed 三阶段发生 | 三阶段返回不同证据；不能一律表示无 effect |
| HC-11 | permission revoke 在 prepare 与 execute 之间 | Host execute 前 fail-closed；未开始的 effect 不得发生 |
| HC-12 | 旧 ownerEpoch 发新 execute，之后回传可信旧 receipt | 新执行被拒绝；旧 receipt 可进入 Operation evidence，旧 worker 不可推进新 Task |
| HC-13 | tool schema/implementation digest 更新后恢复旧 operation | 不自动调用新实现；park/migrate/重新授权 |
| HC-14 | provider effectKey 超出 retention TTL 后重试 | 不自动重放；转 UNKNOWN/人工核对 |
| HC-15 | shell/multi-effect script 访问外部网络、多个文件、spawn child | manifest 明示任意 effect boundary；sandbox enforcement 可观测，不能把一个 tool call 伪装成单一原子效果 |
| HC-16 | nested/subagent tool 从父任务派生 | child operation 有独立 ID/授权 scope/ownership/cancel policy |
| HC-17 | Host manifest capability 在运行中下调/撤销 | 新 operation 不再 admission；旧 operation 根据其 pinned capability reconcile，不可静默升级 |
| HC-18 | Host restart 仅恢复 summary，不恢复 full result | 返回 summary-only evidence；不伪造完整 ToolResult |

测试必须同时观察 Host 实际副作用计数、Host ledger、Control DB Operation/Receipt/Task、PermissionGrant 和 UI 状态。Fake Host 只能验证 Coordinator 单元逻辑，不能验证 provider effect contract。

## 8. 对比结论与目标架构选择

| 来源 | 可借鉴 | 明确缺口/不能照搬 |
|---|---|---|
| Claude CLI Remote Host | call_id 与 request_id 分层；worker_epoch；跨 epoch retry-join；ranNothing；started/disowned/leg summary；outcome_of 与 late-delivery tombstone | full result 可能过期；summary 不能恢复原结果；新的模型 tool_use_id 不自动映射为同一语义 operation；direct cancel caller 可能未主动 query 最终 outcome |
| Claude Desktop SDK | request/callback/permission IDs 分离；hook generation retire；pending permission 与 hook callback 用不同恢复策略 | AbortSignal 不强制终止不合作的 callback；UI approval 不是 OS sandbox；旧 generation decision 不能永久复用 |
| Pi Durable | Intent-before-run checkpoint；stored/current replay policy 双重检查；default unsafe；nested child ownership/abandonOnRestart | replay policy 仍是工具声明；不证明外部 provider effect 幂等；Storage adapter 与 Host effect 不是同一事务 |
| 目标架构 | stable operationId + attempt/request IDs + ownerEpoch + hostInstanceId + effectKey；manifest pin；effectEvidence query；UNKNOWN first-class；conformance suite | 需要按真实 provider/Host 逐个认证；manifest 自述不能代替测试和运行时证据 |

**推荐**：Operation Journal 保存 stable operationId 与 capability manifest version；Host Gateway 对每次 execute 进行 last-mile policy/epoch/version 检查；Host receipt 与 effect evidence 分开；没有可证明 dedup/query 的工具始终保留 X0/UNKNOWN。不要试图通过统一一个 retry flag 解决所有工具恢复。

## 9. 证据索引与未知

### 固定源码/已有研究
- Claude CLI 2.1.304 Remote Host：报告 [35](./35-Claude-CLI远程工具Host与恢复状态机复核-2026-10-29.md)、[38](./38-Claude-CLI远程工具取消与执行账本收敛-2026-10-30.md)、[41](./41-Claude-CLI取消时序矩阵与结果回收边界-2026-10-30.md)；bundle 静态分析，不是实际 Host crash test。
- Claude Desktop SDK 3.1623.1 hooks / pending redelivery：报告 [50](./50-Claude-Desktop-SDKHooks与Pending请求重交付复核-2026-10-30.md)；静态分析，不能证明 callback 代码一定停止。
- Pi Durable v1.4.0 ToolRegistration：packages/durable/src/harness/types.ts blob 289b5c4e18b0a36267ef5f5e36d9afda2a649ecf，L300–308。
- Pi Durable ToolTask：packages/durable/src/harness/tool.ts blob 52bc4a3ada1892645aca5a35f4d90b875edda4ca，L103–213；报告 62 已记录。
- Pi recovery tests：packages/durable/test/harness-tools-recovery.test.ts blob 226bade8155d791e76ab355a17d39e77ccae99ed；packages/durable/test/harness-nested-tools-restart.test.ts blob 342e103c08cb9b06da76a2621e3f2e7e43f8a789。只静态阅读测试定义，本轮未运行。

### 尚未证实
- Claude Host summary JSONL 的 fsync/atomic append/跨机器复制/保留策略。
- Claude Host call ledger 是否在所有 Host 类型/版本一致，及真实服务端线性一致 query。
- SSH/MCP/provider 各自对 cancel、idempotency key、queryOutcome、receipt retention 的真实语义。
- Provider effect 与 Host receipt 是否能共享事务；绝大多数 HTTP/MCP/shell 场景预期不能，但需按 provider 验证。
- Tool implementation digest、schema version pin 和 permission grant 与 Host manifest 的具体 wire protocol 尚未实现。

**本轮仅提交研究文档，不修改 Kernel/业务代码，不新增运行时或测试实现；HC-01–18 均未执行，开发批准仍未获得。**
