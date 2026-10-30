# 62：Operation 执行协议、UNKNOWN 对账与多 Owner 恢复合同（2026-10-30）

> **阶段：独立架构设计细化，非代码、非开发批准。** 承接 [60：目标架构草案](./60-独立Agent执行内核目标架构草案-2026-10-30.md) 与 [61：验收门槛](./61-目标Agent架构验收矩阵风险与实施路线-2026-10-30.md)。对照源证据为 Claude CLI 2.1.304 报告 35/38/39/41、Desktop 3.1623.1 报告 47–50、Pi Durable/Chord v1.4.0 报告 53/54/55/56。
> 所有协议字段/状态机/决策为**目标架构提案**，不宣称任何上游系统已经实现。已检查固定 v1.4.0 上游 tool.ts 和 scheduler.ts 的具体执行/恢复路径；本轮未运行动态实验。

## 1. 需要纠正 v0.1 的四个过强断言

1. **Intent-before-effect 是必要条件，不是 exactly-once 充分条件。** 控制面已经提交 Intent，不等于 Host 已收到或只执行一次。数据库 outbox 重投只能提供 at-least-once delivery，不会自动使外部效果去重。
2. **Owner epoch 是执行者代际防护，不等于外部操作的提交屏障。** 旧 Worker 已经向 HTTP/数据库/文件系统发出不可逆操作时，新 epoch 不能撤回它；应区分阻止新的执行与接受旧执行已经产生的事实。
3. **queryOutcome 不自动赋予 at-most-once。** 查询得到 not-found 并不排除另一个实例正在异步执行或结果尚未写账本；只有提供与同一执行路径原子一致的 durable dedup/receipt 保证，或第三方原生 idempotency，才能安全重新请求。
4. **权限撤销与任务 Intent 不同。** Intent 是不可修改的审计事实，但其授权在执行前可以失效；不能把已提交 Intent 解释成永久授权。执行端 fail-closed 不能保证撤销已经发生的外部副作用。

本轮将“宿主 effect-at-most-once”拆成 Control Plane 与 Effect Authority 两个独立的可证明合同。

## 2. 权威实体与两种所有权

| ID / Version | 定义 | 稳定性 / 唯一性 |
|---|---|---|
| conversationId, submissionId | 用户会话与幂等受理 | submission 按 tenant+conversation+clientRequestId 唯一 |
| taskId, taskVersion | 可恢复 Task/phase checkpoint | version 用于 migration/park |
| operationId | **同一个语义外部效果** 的稳定身份 | 多次投递、断线、恢复不变；不可复用作不同 args |
| attemptId | 一次对 Host 发起投递 / 恢复查询 | 每次投递不同；不是新的业务效果 |
| ownerEpoch | Control Task 的唯一活跃执行者代际 | CAS 单调递增，旧 worker 禁止推进新控制状态 |
| hostInstanceId | Host 实际进程/实例身份 | 重启改变，不是 operation 的身份 |
| effectKey | 外部幂等键或 Host durable dedup key | 只有对外部 effect 路径生效才有强语义 |
| permissionDecisionId, policyRevision, expiry | 授权与准入范围 | 必须绑定 principal/tenant/tool version/args hash/host/scope |
| intentSeq, receiptSeq | 控制面提交事实 | 单调 commit sequence，不能代表外部效果时钟 |
| receiptEvidence | Host/Provider 对 effect 的可核验证据 | 保留来源、版本、结果哈希和是否为已完成事实 |

Control ownership：谁有权提交 Task/Run 的状态转移。Effect ownership：哪个系统可以去重、证明、查询该 operation 的真实副作用。两者可以在同一进程，但**绝不能被一个 ownerEpoch 字段隐式等同**。

Host capability 必须明确声明：local-only / external-idempotency / durable-host-ledger / reliable-outcome-query / cooperative-cancel / resumable-process / authorization-revalidation 等。能力不存在时，协议仍可运行，但必须向调用方暴露更弱保证和 UNKNOWN。

## 3. 不应把所有维度塞进一条线性状态机

v0.1 的 PROPOSED→AUTHORIZED→INTENT_COMMITTED→DISPATCHING→RUNNING→COMPLETED/UNKNOWN 模型遗漏 cancel 与 late correction；应分解为四个轴：

### 3.1 Control task state（控制事务）

admitted / runnable / waiting-permission / waiting-effect / completing / terminal / parked。

### 3.2 Operation admission & dispatch state（控制面已知事实）

draft / denied / intent-committed / queued / dispatch-attempted / awaiting-evidence / reconciled。

- dispatch-attempted 仅代表 Dispatcher 尝试发送；
- 不将 send success / transport ack 定义为 effect started；
- 当无法判断已发送与未发送时，重发同 operationId 必须先验证 dedup capability，不能因 outbox row 仍 pending 就盲目执行。

### 3.3 Effect evidence state（执行端可证事实）

none / definitely-not-started / started-or-possibly-started / completed-with-evidence / failed-with-evidence / outcome-unknown。

- “completed with evidence” 包含成功或由可信 Host 观察的实际异常完成；一次 HTTP 超时不等于任务失败。
- definitely-not-started 必须有执行端未触发 side-effect path 的可证明证据；单纯连接失败只有在执行前本地未发送的可核实时点才能推断。
- outcome-unknown 可以在晚到 Result / queryOutcome 之后修正；校正是 append-only fact，不是把原异常日志抹掉。

### 3.4 Cancellation / Permission（正交状态）

cancelRequested / cancelAcknowledged / effectStopObserved / policyRevoked / approvalExpired；它们不替换 effect evidence。

某个 operation 可以同时是 cancelRequested + completed-with-evidence，或 policyRevoked + outcome-unknown。这是正确的客观事实，不是数据库状态矛盾。

## 4. Host 最小执行协议（设计，不是现有 API）

### 4.1 Capability handshake

Host 注册 identity、tool capability、tool schema hash、isolation profile、effect mode、cancel/outcome query support、dedup record durability tier、endpoint policy revision。

Gateway 不应因为模型工具曝光列表存在某个名字就认为 Host 已实现这些能力。Session/Run pinned tool capability version，热更新不得悄悄改正在排队的危险 operation。

### 4.2 Prepare / Execute：两段不是分布式两阶段提交

1. Control Plane 先 commit OperationIntent + permission decision ref + ownership + outbox。
2. Gateway 只在确认 durable intent 后发送 prepare(operationId, argsHash, ownerEpoch, permission scope, toolVersion)。
3. Host 检查身份、当前 policy revision、schema/capability、sandbox profile、epoch；能力支持时在自己的持久 Ledger 原子登记 operationId 与 argsHash，并回一个**仅表示已受理的准备票据**。
4. Host 收到 execute(operationId, prepareTicket)，在执行前再次验证权限/owner；对具备 durable dedup 的 Host，重复 execute 同 operationId/argsHash 只能 join existing execution 或读取既存 receipt。
5. 如果是无 Host 持久账本的普通 CLI/MCP/HTTP adapter，不得冒充 durable prepare：应显式标注 best-effort dispatch，丢响应后可能 UNKNOWN。
6. Host 执行后保存或返回 operation receipt，Control Plane 通过 Receipt + ToolResult + Task transition 在同一事务写入。
7. 中断后先 queryOutcome(operationId)；检查 result provenance、effect state 和 operation schema hash，再做 safe reconciliation。

**重点**：prepare/execute 不产生跨 Host 与外部业务系统的数据库原子事务。若 Host ledger 先记 started 再调用外部 API，外部 API 成功而 Host crash 于 receipt 之前时仍会 UNKNOWN。只有外部系统同样支持 effectKey/atomic receipt 才可能提供更强 effect guarantee。

### 4.3 Backpressure / deadline

- Ack deadline 与 execution deadline 分离；stream progress 可丢弃/重放，Receipt 不可丢弃。
- Gateway 按 host+tenant+tool 设置并发配额、队列 TTL；授权已过期的 pending effect 重新审批而非执行。
- Transport cancel 仅请求合作式终止；已经开始的外部操作保留 effect evidence。
- 每个 RPC response 关联 operationId+attemptId+hostInstanceId，消除“同名 tool”或复用 requestId 的误匹配。

## 5. 断线恢复与 late receipt 收敛决策表

| 本地事实与 Host 证据 | 允许的动作 | 禁止的动作 |
|---|---|---|
| Intent 尚未提交 | 丢弃 draft；不调用 Tool Host | 执行任何 effect |
| 已提交 Intent，Dispatch 明确尚未产生 side-effect path；Host 没看到操作 | 重新准备；执行前仍查授权和 owner | 假定它已完成 |
| 发送有可能已发生，Host 无 durable dedup/查询 | 标记 OUTCOME_UNKNOWN，等待人工或外部业务查询/补偿 | 盲重放 unsafe operation |
| Host durable ledger 表示已 started，未 terminal | join/poll 原 operationId，或按 contract 进入 unknown 等待 | 用新 operationId 启动相同 effect |
| Host 返回完成 Receipt，Control Plane 未存 | 验证 provenance/argsHash/owner/相同 operation，幂等补写 terminal result | 将上次成功变成失败并重做副作用 |
| 旧 epoch Worker 返回迟到 Receipt，operationId 匹配且可信 | **仍作为历史 effect evidence 接受**，若未发生冲突则对账；当前 owner 的 task transition 必须 CAS | 一概丢掉旧 Receipt；或让旧 epoch 改写新 Task |
| 旧 epoch Worker 尝试执行新的 effect | Host enforce epoch fence，拒绝新执行 | 仅在控制面日志标记 stale 而实际放行 |
| 已经 requested cancel，但 effect completed | 记录 cancel 与 completion 的真实先后，可标记 completed-after-cancel | 虚构 no-effect cancellation |
| 当前授权撤销 | 在 Host 可阻止的尚未执行边界 fail-closed，标记 revoke/cancel | 声称已向外部 API 发出的 effect 被撤回 |

**对文档 61 不变量 4 的修正**：旧 epoch 的 late callback 不能修改新 Task owner，但可信 late completion 仍应进入 Operation ledger 和 reconciliation，否则错误丢失唯一可知的外部效果结果。

## 6. Provider 调用、Tool 调用与 CLI 本地执行的不同保证

- Model Gateway 也需要 requestId、attemptId、stream sequence、usage ledger；Provider 不支持 idempotency 时，summarization/Generation 在中断后 replay 可能重复计费。不能仿照 Tool state 误认为永远能 queryOutcome。
- 本地纯计算/只读且外部无副作用的工具可声明 replay-safe，但需 schema version/policy evaluation 和防止查询权限变化。
- 有幂等 effectKey 的业务 API：可以尝试 retry *same operationId / effectKey*，但前提是服务端确实为该操作全路径提供 dedup，并验证 TTL/retention 与结果查询覆盖 crash 窗口。
- 无 idempotency 的 shell/script/MCP tool：即使 Host 进程已被 SIGKILL，也不能据此证明远端 HTTP/文件更新未发生；完成结果缺失时标记 unknown。
- 用户自主重复提交新请求，应生成新 semantic operationId，并显式呈现上一个 unknown outcome 风险；不能复用同一个 clientRequestId 来消解真实用户的新意图。

## 7. 已有源码证据与它们不能证明什么

### Claude CLI / Desktop 静态证据

- [报告 35：Host dispatch/reconcile](./35-Claude-CLI远程工具Host与恢复状态机复核-2026-10-29.md)：Host/tool routing、call/request/epoch 身份与 delivery unknown。
- [报告 38：Host ledger/cancel/late correction](./38-Claude-CLI远程工具取消与执行账本收敛-2026-10-30.md)：ranNothing、served call summary、disowned tombstone，部分 direct cancelled caller queue 风险。
- [报告 39/41：Bash/MCP/cancel 不等于 effect rollback](./41-Claude-CLI取消时序矩阵与结果回收边界-2026-10-30.md)。
- [报告 48：Desktop SSH adoption](./48-Claude-Desktop-SSH进程接管与MCP权限事件链复核-2026-10-30.md)：stream seq/stdin offset/permission revalidate，SSH helper 服务器真实语义仍未知。
- [报告 50：SDK hook pending redelivery](./50-Claude-Desktop-SDKHooks与Pending请求重交付复核-2026-10-30.md)。

### 固定 Pi v1.4.0 具体源码

- packages/durable/src/harness/tool.ts（blob SHA 52bc4a3ada1892645aca5a35f4d90b875edda4ca）L103–213：ToolTask call phase 在 beforeTool/validation 后把 execute checkpoint（最终 args、stored replay policy）**先 commit 再调用 run()**。L179–190：reopen 遇 execute phase，仅 stored+current replay=safe 再跑，否则 settle interrupted/may-have-partially-run。L637–704：Task outcome、ToolResult Entry / nested result 在一个 commit 结算。
- packages/durable/src/harness/scheduler.ts（blob SHA 23951e89934a6214329e7511f3fc8bca2d23f921）L374–423：reopen running→pending 并计 restart；L545–624：abortRequested 与 wait/owner scope 分离。
- packages/chord/src/connection.ts（blob SHA 0d1efa974a4f6e5463408a3ea84d7f4d891825a3）Connection/RelayCall 管取消/结果和 in-memory RPC 关联，但 v1.4.0 Link **无持久 resume**。详见 [报告 54](./54-Chord-1.4.0HostObjectRPC与ReplicatedState热更新协议复核-2026-10-30.md)。
- packages/chord/src/manager.ts（blob SHA 149f5e454094543cfab662af7fa198a81b419778）OS processLock/Host lifecycle，**不等于外部 effect dedup**。详见 [报告 56](./56-Chord-HostManager进程锁重启与子Host生命周期-2026-10-30.md)。

**只静态审查；未运行这些源码、未注入 Host/network/DB crash。**

## 8. 必须添加的验证与审核点（未执行）

1. crash 在 Control Intent、Host prepare ledger、Host execute、外部 effect、Host receipt、Control receipt commit 六个位置逐一断开；同 operationId 恢复对账。
2. 旧 epoch 已向外部发出 effect，而新 worker claim：验证新 worker 不会独立重做；旧 Worker late receipt 可安全关联但不能跨 epoch 越权推进新 Task。
3. Host queryOutcome 的 not-found 与并发 executing、ledger GC/TTL、网络分区交错；严禁将它误作 definitely-not-started。
4. Permission revoke 在 Host prepare 与 execute 之间，或实际外部 effect 已开始之后；前者拒绝执行，后者保留 UNKNOWN/partial-effect。
5. MCP adapter 与任意 bash/script 无 Host ledger 能力：中断后必须出现可审阅 UNKNOWN，不能因为 ToolTask 标注 replay=safe 就绕过真实 effect capability。
6. Provider in-flight summary 断线及 usage uncertainty，用户能查询非零/未确认费用风险。

## 9. 评审结论（暂不批准开发）

候选协议比报告 60 的单线性 ToolOperation 状态更准确，建议后续设计把 ControlTask、Operation Dispatch、EffectEvidence 与 Cancellation/Policy 分离，并以 capability-driven reconciliation 代替“safe replay metadata 直接重试”。**仍是设计建议，等待用户审阅，不作实现。**
