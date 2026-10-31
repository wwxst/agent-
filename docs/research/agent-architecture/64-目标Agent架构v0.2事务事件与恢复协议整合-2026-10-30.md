# 64：独立 Agent 内核 v0.2——事务、Event Stream、Task/Operation 恢复协议整合（2026-10-30）

> **状态：研究阶段设计修订，待用户审阅；不是实现批准。** 本文更新/细化 [60：v0.1 草案](./60-独立Agent执行内核目标架构草案-2026-10-30.md)，接受 [62：Operation UNKNOWN 对账](./62-Operation执行协议未知结果对账与多Owner恢复合同-2026-10-30.md) 和 [63：权限/隔离/架构备选](./63-权限沙箱上下文脱敏与独立架构选型评审-2026-10-30.md) 的审查结果。
> 源码证据链：[59：Claude/Pi 同场景矩阵](./59-Claude与Pi同场景执行权限恢复矩阵-2026-10-30.md) → 报告 33–58 的固定源码 SHA/offset。本文设计合同并非上游软件的现成实现；所有状态转换与动态验收均**尚未执行**。

## 1. v0.2 设计基线与选型状态

**当前默认推荐继续评审 C：Hybrid Control/Data Plane**：

- Turn Engine：轻量 LLM streaming 和模型 ToolCalls 解析；绝不能直接执行 effect，也不能在非 await 流事件中偷偷派发工具。
- Durable Coordinator：Task/Run/Submission/Tool Operation/Context Revision 的唯一权威协调者；所有真实 Task phase/control state 都可事务记录。
- Host Gateway + Mandatory Permission Authority + Sandbox/Tool Host：执行端自己再做认证、范围/版本/fencing 校验，能力不足时 downgrade guarantee。
- Storage / Journal + Event Projection：原子提交 Task/Operation/Transcript/Outbox；UI 只把提交后 snapshot+cursor 视为权威，token 流可预览。
- Context Projector + Compaction Tasks：从固定历史/安全修订构建模型上下文，输出摘要必须附 source validity fence。

为什么暂选 C：Pi Core 显示小型 Loop 易扩展；Pi Durable 证明持久 Task/Tool phases 值得独立化；Claude Desktop/Remote Host 显示进程生命周期、权限回调和 effect ledger 必须与模型 Loop 分离。**但这只是设计取舍**，不是对现成框架的性能/稳定性比较实验。

替代 B：全部模型/工具/审批/摘要都是一个 Durable Task Engine 的原生 phase；当 Core Loop 不能在 side-effect 前提供 awaitable admission 屏障、或要求精确跨进程恢复每个模型/工具 phase 时应优先切换 B。替代 A：Core + 事件监听/JSONL 可用于 ephemeral / best-effort profile，但不能声称有 A1+ durable admission 或 X2+ effect guarantee。

## 2. 控制面与数据面逻辑拓扑

建议逻辑层次（**可先同进程部署，不等于每个盒子必须独立 OS process**）：

用户 CLI / TUI / Desktop / HTTP API
  → Session API / command idempotency / event subscription
  → Durable Coordinator (Run/Turn/Task graph + Submission Inbox)
  → Model Gateway + Turn Engine (model attempts / provisional stream)
  → Tool Operation Journal (approval/intent/dispatch/effect evidence)
  → Host Gateway (local/remote/MCP provider adapters)
  → Sandbox / Tool Host (OS policy enforcement + effect capability)
  → external filesystem/process/network/business APIs

同级服务：
- Permission Authority/Approval Service 是所有 Host Tool effect 的强制 gate；
- Conversation Store + Context Projector + CompactionTask 提供历史与模型可见视图；
- Database Tx + Outbox + Snapshot/Event Hub 是本地权威记录/订阅；
- Supervisor 管进程存活/自恢复、健康/OS lock，不替代 DB owner epoch 或 Effect Ledger。

禁止的耦合：
1. UI/extension 直接写 Journal Task status；
2. Tool Host 在未取得可核验 Intent/Grant 的情况下执行危险操作；
3. Model plugin 在请求体中偷偷派发 tools 绕过 Coordinator；
4. Session file/GUI event 被用作 effect Receipt；
5. 外部 MCP/SSH Connection close 被解释为 tool not-started。

## 3. 基础数据概念（不是 SQL Schema 实现）

| 实体 | 标识/并发令牌 | 最小持久内容 | 更新约束 |
|---|---|---|---|
| Conversation | conversationId, branchId, contextRevision, securityRevision | owner/tenant/branch/head/retention | 对某 branch 的 revision 单调 |
| Entry | entryId, conversationId, branch position | immutable canonical transcript metadata/content refs/visibility label | 只 append；敏感 raw data 的物理删除另走 retention/erasure |
| Submission | submissionId, tenant+conversation+clientRequestId | input、queue mode、status、accepted seq、terminal reason | 复投同 key 必须返回相同受理或冲突错误 |
| Run / Turn | runId/turnId, generationEpoch | model context revision、current phase、ToolCall order、errors | 一个 conversation 同时至多一个 writer Run，background Task 需单独 owner |
| Task | taskId, typeVersion, owner, claimEpoch | checkpoint/phase/wait graph/restart count/abort intent | CAS claim、version migrate/park |
| Operation | operationId, operationVersion | canonical args hash/tool/host/effect capability, Intent, dispatch attempts | 同 operationId+different args 必须 hard reject |
| PermissionGrant | decisionId, policyRevision, grantHash | principal, scope, tool schema, sandbox, expiry, approver | 撤销追加新 revision，原 grant 留审计但不可再授权新执行 |
| EffectEvidence | operationId, originHost, attempt, evidenceKind | accepted/started/completed/unknown、result hash、receipt/owner epoch | 事实 append-only；可信旧 epoch late receipt 可进入对账 |
| OutboxEvent | conversationId, eventSeq, commitId, itemIndex | event type, ref IDs, audience, security scope | 同一事务提交、按 stream 顺序消费 |
| ProviderRequest | modelRequestId, attemptId, contextRevision | payload hash/model/options、send/outcome/usage evidence | crash duplicate billing risk 明示 |
| Artifact | artifactId, contentHash, securityLabel | blob refs, encryption/retention, owner, disposal | 不把大 Tool output 无限放进消息/事件 |

**重要区分**：Operation Intent 是不可撤销的“曾批准并计划执行”审计事实，不是一直有效的 permission。grant/policy 失效时 Host 必须拒绝尚未开始的执行。

## 4. 事务与 EventHub：如何避免虚假的 commit order

### 4.1 单一事务原子边界

一次提交只能原子修改**同一个权威数据库**中的 Task/Submission/Operation/Entry/Outbox/metadata。不能将外部 Host effect/Provider billing/远程 OAuth service 纳入该事务。

核心事务类型：
- submit/admit：dedup command + persist input + runnable Task + outbox event；
- model finalization：AssistantEntry/ToolCall plan + Task checkpoint；如果需要 tools，再通过权限与 Intent 的事务进入 Host；
- tool pre-execute：Permission decision ref + canonical args/version + Intent + dispatch record；
- tool settlement：validated Receipt + ToolResultEntry + owner Task transition + outbox；
- compaction placement：ContextRevision/SecurityRevision compare + new SummaryEntry + branch/head marker + outbox；
- cancellation：CancelIntent + affected Task mark + outbox，而非把外部效果伪装完成；
- owner claim：CAS current claimEpoch/lease expiry，注册新的 owner/worker。

如果 DB commit 返回失败或无法判断是否已提交，调用者必须通过提交时稳定 command/operation ID 查询结果，不能无条件重新执行副作用。

### 4.2 Commit ID、Event Seq 与 UI Cursor 不必相同

报告 60 的“EventSeq 从 CommitSeq 派生”表达需收紧：

- SQLite 单 DB、单 active writer 可以提供全局可排序 commitId，但它与事务内多个 outbox event 并非一对一；
- 迁移 Postgres / 多 shard 时，提前分配 DB sequence 不一定与 transaction commit 顺序一致，不能只用自增 ID 承诺全局一致事件排序；
- **建议 UI cursor 使用 conversation/stream 局部连续 eventSeq + itemIndex，且在修改 conversation 的事务中经同一 sequencer/row lock 分配**；
- snapshot 与 cursor 必须来自同一个数据库一致性快照，否则“先读最新状态、后查最新 cursor”可能丢中间事件；
- 跨 tenant/跨 Conversation 总时序如果产品需要，需要独立全局事件序列服务/一致性读取协议，不能用本地 branch cursor 冒充；
- watch clients cursor 过旧、事件已保留期淘汰或缓冲 overflow 时，返回 reset/snapshot-required，不能静默跳过事件。

### 4.3 Provisional token streams

- 模型的 token delta 和工具 stdout 可以低延迟直接发布，但标记 provisional(runId, modelAttemptId, chunkIndex)，它们不是权威 Event Seq；
- 当 retry/fallback/abort 时要发 invalidate/supersede；最终权威 message 来自 committed AssistantEntry/ToolResultEntry；
- UI 断开后不保证临时 token delta replay；必须可从 committed snapshot 重建最终 transcript；
- payload 应进行 audience/tenant/secret filtering，不能因为 debug stream 就绕过敏感资源授权。

### 4.4 Storage ACK、Outbox 与 Event Cursor

[报告 65](./65-可靠性保证向量存储ACK与事件游标合同-2026-10-31.md) 将旧 R0–R4 改为独立 capability vector：A0–A3 commitAck、W0–W2 writerAuthority、E0–E2 eventDelivery、X0–X4 effectEvidence。A3 不蕴含 W2/E2/X3；外部 Shell 即使运行在 A3/W2 环境，仍可能是 X0 UNKNOWN。

- SQLite WAL NORMAL 对应 A1 候选；WAL FULL 可作为 A2 候选，但需要 OS/FS/device flush 实测。Pi v1.4.0 Node adapter 的 WAL/NORMAL 不可宣称 A2。
- PostgreSQL 以 per-stream transactional cursor row lock 分配 eventSeq；不要使用非事务 sequence 作为 gapless/commit-order cursor。
- Snapshot 与 cursor 必须同一一致性快照读取；Read Committed 多条 SELECT 可能看到不同快照。
- Outbox 只保证业务 commit 与 event row 原子；dispatcher/transport 至少一次，允许 duplicate。按 stream head-of-line 保序，客户端 eventId 幂等与 cursor replay。
- Submit ACK 返回实际 ackProfile；网络断开导致 ACK 未收到时，用稳定 clientRequestId 查重，不重新创建 Run。

## 5. 一个 Run 的精确 admission / execution 边界

1. Session API 收到 command，按 principal/tenant/session 校验；在事务中 dedup clientRequestId，提交 Submission+Run/Task，返回 accepted+submissionId。
2. Coordinator claim (TaskId, workerEpoch)。固定 contextRevision、安全修订和 model/tool declaration versions；Build ContextProjection。
3. Model Gateway 创建 ModelRequest attempt，在流式请求前记录可恢复的 request intent/evidence metadata；stream tokens 为 provisional。
4. Model final response 可产生 ToolCalls；Coordinator 在 DB 中保存 canonical ToolCalls/ordering，不允许 Tool Runtime 直接从 LLM callback 启动。
5. Tool preflight 校验 schema、实际最终 args、resource scope、available tool version；Permission evaluate allow/ask/deny。ask 写持久 ApprovalTask。
6. 对通过的每个 operation：事务提交 OperationIntent + grant ref + effect capability + outbox。**await commit 成功**之后才能向 Host 发 prepare/execute；失败不得执行。
7. Host 执行前验证 grant、owner epoch、sandbox、tool schema/args hash。受理/运行/实际 effect 的进度分别返回 Evidence，不把 transport send success 当作 effect result。
8. Coordinator reconcile all child tools：工具结果最终按 model ToolCall 源序补入 transcript；某个 outcome unknown 时不能构造虚假的已成功结果继续不安全下游工具。
9. Receipt/ToolResult/Task outcome 在事务结算；下一 Turn 在明确完成条件后 admission。
10. Run terminal 后 Submission terminal；UI 的 terminal notice 包含 committed event cursor。

**需要被强制验证的门禁**：如果选用已有 Core Loop 的自动 tool dispatch，必须证明其 beforeToolCall 能 await 强制 journal/permission，且所有 nested/tool paths 都无法绕过。否则改为由 Coordinator 原生管理工具调度，而不是对 Loop 事件做 best-effort async sidecar。

## 6. 进程/网络故障后的可恢复流程

重启顺序建议：

1. 打开 Store，校验 schema/migration/physical integrity；如果 durability tier 不满足，则拒绝对外宣称已持久运行。
2. 扫描未 terminal tasks，CAS claim ownerEpoch，恢复 checkpoints、wait graph、abort marks；未兼容版本 park/orphan。
3. 对每个 OperationIntent 对比 outbound attempts、Host capabilities 和已存 Evidence：
   - 已提交 terminal Receipt：不得重新运行，补最终 UI snapshot即可；
   - 明确 never-started：可按权限+schema/version 重新计划；
   - 已发送且 Host durable ledger 可查询：**按相同 operationId** query/join；
   - Host 没有 ledger 或 query 不能排除并发执行：OUTCOME_UNKNOWN；
   - 原生 idempotency 合同有效且仍在 retention TTL 内：可以使用同 effectKey 重试；仍需批准策略；
   - 旧 Worker late evidence：验证真实来源后附加 Operation evidence；不能使旧 owner 随意覆盖新 Task。
4. 恢复 UI/outbox delivery 与是否已发送给 Client 无关：Client 用 command key/cursor 自行去重。
5. 网络分区期间 Host 权限/owner authority 不可达时，新的危险 effect **fail-closed**；已启动不可逆 effect 的真实完成情况仍按 UNKNOWN/late receipt 处理。

这种恢复提供诚实的“已知、未知、需人工决策”语义，不承诺未经验证的 exactly-once。

## 7. 权限、脱敏与外部效果的约束

- Mandatory Permission Authority 不能由可选 Tool Hook 取代；最后真实执行前检查最终 args hash、resource scope、version、principal、policy epoch。
- 即使批准执行某个 shell，子进程仍可进行多个系统调用；需要 OS/container/VM network+filesystem sandbox，单个 ToolCall 级审批无法逐效果管理。
- Trusted in-process extension 与 Untrusted isolated plugin 分开；不能允许无限制 extension 代码直接访问宿主凭证/数据库。
- Context summary append 前使用 input revision + SecurityRevision/redaction epoch CAS；相容的 append 允许规则需要单独明示，安全敏感 edit 必须 invalidate 历史摘要。
- 物理 erasure、备份/索引清理、外发 Provider copy 不属于简单 ContextProjection omit；数据保留/删除合同需产品确定。
- Background subagent/tool continuation 必须有独立明确 owner、permission delegation scope 和 cancel policy，不因 UI/parent Turn 结束而获得额外权限。

详见 [62](./62-Operation执行协议未知结果对账与多Owner恢复合同-2026-10-30.md)、[63](./63-权限沙箱上下文脱敏与独立架构选型评审-2026-10-30.md)。

## 8. 架构不变量的修正版

| 原 v0.1 不变量 | v0.2 修订 |
|---|---|
| Intent-before-effect | 必须有 committed Intent + 宿主执行端强制 gate；Intent 不是永久授权，不保证 effect exactly-once |
| Receipt atomic ToolResult | 仅保证**控制面** DB 对 Receipt/ToolResult/Task 原子提交，不等于外部效果事务 |
| Unknown preserving | QueryOutcome not-found 也不必证明 never-started；由 Host Effect Authority 的真正保证判定 |
| Fencing | 旧 owner 不能新执行/改新 Task；**可信旧 owner 的 late result 仍可接受进入 effect evidence** |
| Cancel independent | cancelRequested、completed、unknown、revoke 可以并存 |
| Context provenance | Summary 除 head/tail 还必须有 SecurityRevision/redaction lineage；物理删除另有协议 |
| Permission last mile | Tool-level authority + OS sandbox 并用；不能承诺内部 shell 每次写入都经过上层许可 |
| UI event truth | Event cursor 是 stream-local、snapshot consistency 保证；provisional delta 不占权威序列 |
| Task ownership closure | owner/resultReceiver/lineage/background/cancelScope 不混同 |
| Versioned recovery | 过期/缺失 tool schema 或 task checkpoint park/orphan，不能自行选择其它工具重放 |

## 9. 未来验证的必要最小集（只列设计；未运行）

报告 61 的 FI-01–16 保留；本轮补强调：

- FI-02b：outbox 发送后 dispatcher crash、状态仍 pending，只有同 operationId dedup 才可重发。
- FI-04b：Host ledger 显示 not-found 但原 effect 仍并发执行；不得错误启动第二次。
- FI-05b：Control 收到旧 epoch 的可信晚到 Receipt，新 owner 已 claim；保持 effect evidence，禁止旧 worker 越权更新 Task。
- FI-07b：批准的任意 shell 在执行中访问未授权 path/network，验证 sandbox enforcement。
- FI-10b：异步 compaction 与 redaction 的跨 branch/backup/derived artifact invalidation。
- FI-13b：DB snapshot 与 event cursor 在并发 commit 下的一致性；验证 stream-local seq 和 overflow reset。
- FI-16b：真正外部 API 执行时旧 Host 网络分区/租约过期，新 worker 不可单靠 DB CAS 宣称 effect-at-most-once。

只验 agent 最终文本不够，必须观察实际 effect count、DB task/operation/receipt、Host ledger、权限与 user-visible state。

## 10. 风险与待批准决策

1. 第一版部署本地单用户、局域网多进程、还是跨主机多租户？决定存储与隔离。
2. 首发采用怎样的 A/W/E/X capability profile？若要求断电后 ACK 不丢，必须达到 A2；不能默认使用 SQLite WAL NORMAL 却承诺 A2。
3. 是否允许 UNKNOWN 状态阻塞危险后继操作，人工或业务 API reconcile 后继续？
4. 哪些 Tools/Providers 支持真实 effectKey 和可靠 outcome query？无对应保证就将该 operation 保持 X0/UNKNOWN，与 Store 的 A/W profile 分开声明。
5. 是否要求针对历史消息做物理脱敏/删除？与不可变原始审计数据冲突，需要 data governance 方案。
6. 是否允许 trusted in-process plugins 使用完整用户 OS 权限？若不允许则必须 sandbox。
7. 现有 Kernel 是否有必须保留的数据协议/会话文件/迁移目标？目前只明确“不受旧设计约束”，不能推测实际数据兼容成本。

**建议审阅路径**：先评估报告 59 的横向事实，再看 60/62/63/64 的递进设计及 61 的未来故障验收；提出审阅修改或明确批准前只迭代报告。**没有任何业务/Kernel 代码变更，未批准开发。**
