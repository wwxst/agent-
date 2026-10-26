# 08 · Codex App Server → Turn → 工具审批 → Rollout 的执行路径

> 2026-10-25。基于 [openai/codex 固定提交 970111f6cb62cc02fe36a82ea7d71b37a2889c97](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97) 的 Rust 直接源码静态分析。没有运行 App Server、数据库或真实沙箱；不把源码注释误当端到端通过测试。

## 1. 比“Codex 有 Turn/Step”更具体的控制链

上轮研究集中在 Core 的 `run_turn`。本轮从 App Server 的公开 RPC 入口开始，确认**客户端提交、Steer、Interrupt 都不是直接修改当前模型的消息数组**。

[turn_processor.rs](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/turn_processor.rs)：

- L177：`turn_start` 对外开放入口，内部 `turn_start_inner` 在 L525 起实现。
- L530–580：加载 Thread，确认允许直接输入，验证当前模型 Provider，检查 `toolOutput` 不与普通输入混用，限制输入大小。
- L600–660：从请求读取 cwd、环境权限、sandbox policy、approval policy、model 等覆盖项，生成规范化的 `thread_settings`。
- L661–705：通过 `thread.start_or_steer_turn(TurnInputRequest...)` 提交给 Core，返回 Started/Steered/NotSubmitted。**同一个 turn/start API 也可能因为已有活动 Turn 而被解释为 Steering**，实际结果需要看返回类型。
- L710–735：响应包含 `turn_id`、`root_turn_id` 和 `InProgress`；不代表模型生成结束或工具已执行。

```text
Client JSON-RPC turn/start
   → App Server 校验 Input/Thread/Environment
   → 规范化权限和模型设置
   → Thread.start_or_steer_turn
   → Core active turn/input queue
   → run_turn / StepContext 捕获
   → run_sampling_request / tools
   → Session 事件与 Rollout
```

### Steer 有明确的“预期活动 Turn”条件

[turn_processor.rs L1045–1185](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/turn_processor.rs#L1045-L1185)：`turn_steer` 要求非空 `expectedTurnId`，并交给 `thread.steer_turn`。没有活动 Turn、Turn ID 不匹配、Review/Compact 等不可 Steering 的 Turn、输出 Schema 不兼容均可能明确拒绝，不能默默创建另一个任务。

**自研取舍**：Steering 必须带 `expectedTurnId` 或其他 CAS 版本，不能按“当前最新 Session”猜目标；同时把 `start_or_steer` 的隐式模式明确化为协议选项，减少客户端误会。

## 2. Interrupt 是异步状态转换，响应可能等待 TurnAborted

[turn_processor.rs L1622–1690](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/turn_processor.rs#L1622-L1690)：

- 正常 `turn_interrupt` 会检查请求的 `turn_id` 是否与活动 Turn 匹配；
- 在 `pending_interrupts` 保存请求 ID，等待后续 `TurnAborted` 事件来完成 RPC 响应；
- `Op::Interrupt` 提交失败则移除 pending 请求，返回错误；
- 特殊的 startup interrupt 因为还没有 Turn，提交后可立即确认。

因此 **“接到中断命令”不等于“Agent 已中断”**，App Server 的响应生命周期会关联实际 Core 事件。这比简单调用 `AbortController.abort()` 后立即返回 cancelled 更严格。

**但仍不表示已撤销外部文件/Shell 副作用**；还需 ToolHost 收据确认。

## 3. ApprovalAction 的策略顺序与作用域

[tools/approvals.rs L465–580](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/approvals.rs#L465-L580)：

- `Session.request_approval` 在某些高权限 WriteStdin / sandbox override 情况下，先按 approval policy 拒绝不允许的授权请求；
- 然后运行 `run_permission_request_hooks`。结果若明确 Allow/Deny，则形成 Hook 来源的决策；
- 否则进入 `request_reviewer_approval`，其中会考虑 Guardian/StrictAutoReview，再到用户审批；
- `ApprovalResult` 记录决策来源（Hook/Guardian/用户），网络与 MCP 的特殊结果也有独立处理。

**准确描述应是**：这一条 `request_approval` 路径上，先有禁止性策略检查，随后是 Hook，最后是 Reviewer；不能笼统说“Hook 无条件拥有最高权限”，因为更高优先级的沙箱、执行前策略和 Host 能力仍可能拒绝。

[tools/approvals.rs L236–275](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/approvals.rs#L236-L275) 的审批缓存 Key 绑定规范化命令、工具类型和相关 Sandbox 情形。自研不能用 `toolName` 或“用户点过一次”构成全局放行。

## 4. Codex 真正的本地持久化写入与索引投影

> **2026-10-26 更正**：进一步深入到 RolloutRecorder 的底层 Writer，确认上述 `flush()` 是 `File.flush()` 路径，不应将其当作已证明的物理掉电持久性。详见 [12](12-四内核执行与持久化证据审计.md)。

[thread-store/src/local/live_writer.rs L414–472](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/thread-store/src/local/live_writer.rs#L414-L472) 是本轮最大的具体发现：

```text
write_and_project
  → 对同一 Thread 获取 live_writer_locks
  → 确认 Recorder 仍有效
  → 规范化 RolloutWriteOp
  → durable_write
       AppendItems → record_canonical_items → recorder.flush()
       Persist     → recorder.persist()
       Flush       → recorder.flush()
  → 尝试 materialize_to_sqlite
  → 必要时同步已物化路径/元数据
```

源码中对 JSONL 和 SQLite 有很明确的地位划分：**canonical Rollout/JSONL 是事实来源，SQLite 是可重建的查询索引视图**。写操作先推进/flush canonical 路径，然后尝试 SQLite materialization；索引失败时会记录 warning 而不强制回滚前面的 Rollout 历史。

这为我们提供了可以直接落地的设计参考：

- 业务事实必须有一份唯一权威存储，搜索/列表索引可落后但可重建；
- 绝不让 SQLite 搜索索引比权威日志“走在前面”；
- 请求的 RPC ACK、模型可见事件、磁盘 flush 与工具副作用需要各自协议；
- LocalThreadStore 的 `flush()` 是否等同“掉电后物理落盘”的严格定义，仍应追到 Recorder 的 fsync/Flush 实现并做故障实验，而不是仅根据函数名推断。

### 与 DeepSeek append/flush 语义的直接对照

DeepSeek 的进程内 Session Event `append` **可能进入异步缓冲**；但其 JSONL 后端**显式 SessionHandle.append** 在完成后有后端持久写入合同，不能混淆。Codex 当前本地 `durable_write(AppendItems)` **在记录 canonical items 后立即调用 Recorder.flush**。已追到 `writer.file.flush()`，本审计路径**未见 fsync/sync_all，因此不能直接声称掉电持久**。这意味着两套公开实现的写入时机不同，必须比较吞吐与损失窗口，不能只给它们都贴上“Event Sourcing”标签。

## 5. 为什么不是“照搬 Codex Rust”

Codex 的分层对我们有价值，但其 Rust Core、App Server、SQLite Index 及 Guardian 是围绕具体产品构建的庞大工程。我们应吸收四个核心合同：

1. `start_turn/steer_turn/interrupt_turn` 都以**显式 ID 与预期状态**执行，不能产生幽灵任务；
2. 每个模型 Step 捕获一致的运行参数/工具能力快照；
3. 权限审批结果绑定 ToolCall、策略和可信宿主，不被 UI 文本取代；
4. 权威日志与可查询物化视图分离，明确 ACK 与落盘保证。

首版仍可用 TS + 独立 ToolHost 原型验证这些合同，再决定哪些 OS Sandbox 能力需要 Rust/平台原生进程。

## 6. 未完成的关键源链

- `RolloutRecorder::flush` 到文件 fsync、目录同步的真实保证；
- Core `EventMsg` 与 App Server 通知的终态传递顺序；
- 历史投影失败、数据库损坏后的实际索引重建操作；
- 所有特殊的 Guardian/Sandbox/Approval 组合与平台调用链；
- Thread Fork、后台 Goal、MCP 等独立任务的全部持久状态。

可复核测试提议：Core 完成后断开 AppServer 通知可重放终态；中断请求不匹配被拒绝；索引物化出错后 Rollout 仍能重建；强制沙箱失败后不执行；用户批准与进程退出并发不能二次执行。

**阶段结论**：已追清 Codex AppServer 的 `start/steer/interrupt` 关键语义及 LocalThreadStore 一条真实落盘路径；不能由此证明整个 Codex 的跨进程/跨 OS Exactly-Once 行为。
