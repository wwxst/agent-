# OpenAI Codex：Rust Agent 内核源码研究

> 时间：2026-10-25；锁定 [openai/codex @ 970111f6cb62cc02fe36a82ea7d71b37a2889c97](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97)。证据 A2：直接读取固定提交下的 Rust 源码/官方仓库文档。没有运行 Codex、Rust 测试或 OS 沙箱。

## 一、研究范围

Codex 的公开仓库不只是一个 Agent Loop，而是包含 Agent Core、工具 Router、Session、App Server 协议、Sandbox 以及 Thread/Rollout 存储。重点审阅：

| 文件 | 事实 |
| --- | --- |
| [`codex-rs/core/src/session/turn.rs`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/turn.rs) | `run_turn`、逐次模型采样、Context 捕获、输入队列、Compaction、取消和 Hook |
| [`codex-rs/core/src/tools/router.rs`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/router.rs) | ToolRouter、模型工具声明、ToolCall 规范化、分派、并发特性 |
| [`codex-rs/core/src/tools/approvals.rs`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/approvals.rs) | ApprovalAction、命令规范化、审批缓存键、Guardian/Hook/策略 |
| [`codex-rs/thread-store/README.md`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/thread-store/README.md) | LiveThread、Rollout JSONL、SQLite 元数据与持久化职责 |
| [`codex-rs/linux-sandbox/README.md`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/linux-sandbox/README.md) | Linux Namespace/Bubblewrap/安全边界 |
| [`codex-rs/core/README.md`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/README.md) | Core 中的 Shell 与 SandboxPolicy 概念 |
| [`codex-rs/docs/protocol_v1.md`](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/docs/protocol_v1.md) | 一份旧版的协议说明，用于术语历史而非现行唯一事实 |

这里要谨慎：`protocol_v1.md` 把 Task/Turn 定义为旧版协议词汇；当前 `session/turn.rs` 有更多 Step、异步压缩、插件信息和预算分支。**不要把旧版协议文档当成最新实现的完整语义。**

## 二、主执行链：User Turn 与 Sampling Step

`turn.rs L174` 的 `run_turn(sess,turn_context,input,...,cancellation_token)` 是公开源码中的关键入口。

- L182–239：可在正式采样前运行 `run_pre_sampling_compact`；错误依情况记录并处理；
- L276 后处理首个 Step 的 Context、输入与 Hook；
- L469–508 的主 Loop：每次模型采样前检查 `pending_input`（UI 运行中注入的新消息）、运行 Hook，获取窗口/预算状态，并捕获当前 StepContext；
- L508 附近注释强调：**上下文、模型工具声明和实际工具调用应该共享同一份当前请求视图**；这个 snapshot 是生产一致性的关键边界；
- L571 构造 `sampling_request_input`，从 Session 的历史副本构建符合模型输入模态的请求；
- L579 附近进入 `run_sampling_request`；之后返回 `needs_follow_up` 和模型最终消息；
- L608 之后，异步 Hook 结果在采样与工具执行结束后被整理；L625 之后可启动异步 Compaction，符合动态预算策略；
- 通过 `CancellationToken` 子 token 传播模型、工具请求的取消信号，而不把取消当外部 Shell 副作用已撤销。

```text
用户/协议指令
  → Session / active_turn / input_queue
  → run_turn
  → pre-turn compact + hooks
  → 捕获 StepContext（配置、工具、权限、模型）
  → Session 历史构造模型输入
  → run_sampling_request
  → Responses 事件 / 工具调用
  → ToolRouter → 注册 Tool Runtime
  → 结果进入 Session/History
  → 下一采样步骤或 Turn 结束
```

**设计价值**：模型请求使用一个稳定的 `StepContext`，避免对话历史使用旧工具列表、执行器却已热更新为新工具的不一致。我们应采用 `TurnSnapshot` / `StepAdmission` 的明确版本控制。

## 三、工具名称空间和实际运行时分离

`router.rs`：

- `ToolRouter` 持有 `ToolRegistry`、模型可见 Tool Spec、Tool Mode、Namespace 信息；
- L185–218 `exposes_tool()` 仅判断模型能否看到/调用工具，不等于 ToolHost 一定可执行、也不等于已获安全授权；
- L246–250 `tool_supports_parallel` 向 Registry 查询工具的并发特性，缺失时默认 false；
- L257–306 `build_tool_call` 从模型 ResponseItem 解析 FunctionCall、ToolSearchCall（客户端执行路径）、CustomToolCall，保留 `call_id` 和 payload；
- L339–395 `dispatch_tool_call_with_state` 构建 ToolInvocation，绑定 `session`、`turn`、`step_context`、`cancellation_token`、`tracker`、`call_id` 等，随后通过 Registry 运行具体 Tool。

因此 Codex 不把模型返回的 JSON 原样送入 Shell，而是在严格的 ToolCall 类型/上下文中派发；并发能力也由注册运行时声明。

## 四、审批和权限策略不是单层提示

`tools/approvals.rs` 的文件头明确是集中审批策略与 reviewer 路由：

- `ApprovalAction` 覆盖 ExecCommand、WriteStdin、ApplyPatch、MCP ToolCall、网络访问、请求更多权限等不同对象；
- L236–275 形成审批缓存键（例如规范化命令、工作环境、沙箱要求、补丁身份），不能简单等同工具名白名单；
- L408 之后存在 `ApprovalResolutionSource`，用于分辨不同审批路径（Guardian、Hook 等）；
- `tools/sandboxing` 与 `session/mod.rs` 处理执行工具的审批请求与被许可的执行环境。

这说明审批对象并不完全相同：一次 Shell 命令、向运行中进程写入 stdin、应用补丁、MCP 请求和网络访问必须有不同的风险判定。**对自己的内核，审批必须绑定调用 ID、规范输入指纹、宿主/隔离版本、作用域与期限，而不仅是字符串规则。**

**未验证**：并非所有当前 feature flags/模式下 Guardian 或 Hook 的实际顺序都已经走通，本轮没有运行 UI 权限弹窗或实际 Shell。

## 五、Sandbox：实际独立的执行边界

当前仓库的 Linux Sandbox README 直接描述：

- Linux `codex-linux-sandbox` 是独立的可执行宿主，也有内部 dispatch 入口；
- 文件系统隔离默认走 Bubblewrap 路径；部分旧配置兼容 Landlock；
- WSL1 无法提供必要的 user namespaces，使用该沙箱时拒绝执行；
- Split filesystem/network policy 可限制目录与网络，但必须验证相交规则和特殊内核特性；
- 有专门的 sandbox 测试套件 `tests/suite/sandbox.rs`。

`SandboxPolicy` 会表达不同文件系统读写根、网络与外部 sandbox 模式。

**不能直接下结论“Codex 一定最安全”**：看见真正的 Bubblewrap/Seatbelt/Windows 分支不等于完成对所有配置和操作系统的漏洞验证，实际保护还取决于启动参数、用户权限和宿主部署环境。

但作为**自研架构参考**，它比直接在 Agent Loop 里执行 `child_process.exec` 更强调执行环境与审批策略是独立模块。

## 六、会话持久化：ThreadStore 与 Rollout

[ThreadStore README](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/thread-store/README.md) 明确区分：

- `LiveThread`：活跃 Session 的存储句柄，管理元数据同步和存储策略；
- `LocalThreadStore`：历史写入 `codex-rollout` JSONL，查询元数据使用 SQLite（可用时）；
- `RolloutRecorder`：负责规范化的 JSONL 写入，不直接决定所有元数据；
- `core/session`：创建/恢复 Session，通过 LiveThread 抽象，不需要知道实际文件或数据库布局。

这种分离解决“运行时状态 / 可查询元数据 / 历史事实记录”混为一个对象的问题。但它并不自动证明所有外部命令具有 exactly-once；工具执行收据仍需要额外审计。

## 七、Context 压缩与恢复

新版 `run_turn` 可以在采样前、Turn 中/结束时尝试压缩。还涉及本地摘要、远程压缩能力、TokenBudget Feature、Guardian 审阅预算、异步 Compaction 等条件。

要借鉴的是**压缩与采样状态机的显式结合**，不是复制某个固定 Token 阈值或某个模型厂商的摘要请求。压缩失败、压缩中的取消、保留仍待执行工具的事实，必须拥有自己的持久语义。

## 八、与 Pi、Claude、DeepSeek 的差异

- 比 Pi Core 更重视 Session/Step、审批、沙箱和历史记录的真实工程边界。
- 相比 Claude Code 的打包产物，Codex 开放了可直接阅读和测试的 Rust 运行时/工具/Host 逻辑，源码可验证性更高；这**不代表**模型质量或真实任务表现必然更强。
- 相比 DeepSeek Harness 的“全组件插件化”，Codex 的 Core 更倾向集中强制的 Session/Turn/审批/执行语义，插件在受控边界加入。

## 九、对自研 Kernel 的建议

**优先借鉴（P0）**：StepContext 快照、Session/Turn/Step 生命周期、ToolInvocation 明确身份、模型可见工具与真正可执行能力分离、审批/沙箱边界、线程历史持久化抽象和取消 token 传播。

**有条件借鉴（P1）**：异步 Compaction、Guardian 审批、多种工具模式、远程插件能力；这些应建立在基础正确性上。

**不直接照搬**：完整 Rust 代码组织、专属 Responses API 事件形态、产品级 Feature Flag 和巨量工具适配器；我们先用清晰小内核和可验证合同实现相同关键机制。

## 十、未完成与拟议测试

**已确认（A2）**：Turn Loop、StepContext 捕获、ToolRouter、集中 ApprovalAction、沙箱产品分层、ThreadStore/JSONL 元数据职责。

**尚未完成**：全部 EventMsg 到 AppServer 对应关系、所有 Feature Gate 的 Hook 优先级、实际沙箱启动失败路径、断电恢复与重复外部副作用的压力测试、不同 OS 等价性、MCP/Skills/Subagents 全调用链。

拟议测试：并发 Context 变更只影响下一安全 Step；审批输入修改后缓存键失效；ToolCall 使用冻结的工具版本；沙箱依赖缺失时禁止执行；JSONL 已提交历史和 SQLite 元数据一致性；Response stream 中断后不重复危险工具；进程退出/取消响应具备可解释的不确定状态。

**判断：Codex 当前公开 Kernel 的主要生产模块边界可以直接验证，全面运行时故障和跨平台安全能力仍需实测，不能宣布“研究透”。**
