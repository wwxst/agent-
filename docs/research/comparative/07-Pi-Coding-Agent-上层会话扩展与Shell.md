# 07 · Pi Coding Agent 产品宿主：会话树、压缩、扩展与 Shell

> 研究时间：2026-10-25；**直接读取** [Pi 固定提交 d5b3de22d0e24a3e9c38a9410d3329b099717283](https://github.com/earendil-works/pi/tree/d5b3de22d0e24a3e9c38a9410d3329b099717283) 的 `packages/coding-agent/src/core`；源码静态证据，不宣称实际沙箱测试。补充此前仅研究 `packages/agent` 低层 Loop 的盲点。

## 1. Agent Core 与 Coding Agent 不是同一层

原 [Pi Agent Core 报告](02-Pi-Agent-源码研究.md) 中的 `packages/agent/src/agent-loop.ts` 负责泛化 Loop、模型、ToolCall 和事件。上层 `packages/coding-agent` 才处理会话树、历史落盘、压缩、扩展、多工具与本地 Shell。不能因为低层 Core 只有 transcript 数组，就断言整个 Pi 产品不支持历史保存与分支。

**本轮直接打开的文件和 blob**：

| 文件 | Blob SHA | 主要作用 |
| --- | --- | --- |
| [session-manager.ts](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/session-manager.ts) | `57f9655baa2cfd84a2a0c152d424c62c6c75296d` | JSONL 文件、父子条目树、分支、投影 |
| [agent-session.ts](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/agent-session.ts) | `3a9174cf6ea4cdce791c08a84f6ac25b95b6fb01` | 产品级交互、排队、模型切换、压缩/重试/扩展协调 |
| [compaction/compaction.ts](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/compaction/compaction.ts) | `07a58ac6cf6e2141fc07133677583ab18bb97298` | Context Token 预算、cut point、摘要、保留尾部 |
| [extensions/runner.ts](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/extensions/runner.ts) | `77712e677f91dde65d4d4db906a26b16bbd9de9c` | 扩展事件、修改输入与工具结果、错误隔离 |
| [tools/bash.ts](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/coding-agent/src/core/tools/bash.ts) | `4620e24648b6ba9e8aa4f5083eb99927549ebcaa` | 本地 Shell Provider、spawn/timeout/abort |

## 2. SessionManager：不是线性 ChatHistory，而是树

`session-manager.ts:L987–1095` 定义 `SessionManager`，用 `fileEntries` 保存会话历史、`byId` 索引条目，并用 `leafId` 指向活动分支末端。每条 SessionEntry 有 `id` 与 `parentId`。本地文件格式的 `CURRENT_SESSION_VERSION = 3`（L41）。

`L1529–1589` 的 `getTree` 根据 `parentId` 重建树；无父节点条目也会展示为根节点，避免 UI 丢掉孤儿条目。`branch(branchFromId)` 只移动 `leafId`，**不会篡改/删掉旧历史**；下一次 append 从新的父节点开支。`branchWithSummary` 可将离开的路径作为摘要附着到新分支（L1590–1635）。

`createBranchedSession` / `forkFrom` 则将选定路径或整个历史复制成**新 Session 文件**，这是与同文件内改 Leaf 不同的动作。复制时重新计算父子链与 `firstKeptEntryId` 等压缩边界，避免删掉 LabelEntry 后路径断裂。

**重要区别**：Pi 的分支是“原历史节点不变，新路径投影改变”，这与把所有历史消息原地删改的简化实现本质不同。

### Context Projection 与 Context Edit

`buildSessionProjection` / `buildSessionContext` 根据活动路径生成模型可见消息；`appendContextEdit(targetId,replacement)`（L1390–1465）把对旧消息的“编辑”作为独立 `context_edit` 条目追加，同时要求目标位于**活动分支**、属于可编辑消息类型。

它展示了一个可借鉴思路：用户/扩展可修正模型上下文，但操作以事件表示；原始条目仍在 Session 树中。**我们自己的 EventStore** 不应允许普通 Context Edit 删除真实审批记录和执行收据。

## 3. 持久化：文件写入不是事务型作业日志

`session-manager.ts:L1143–1200`：

- 新建 Session 的 setup entries 先留内存；直到出现 user 或 assistant 消息才创建 JSONL 文件，避免空会话生成文件。
- 第一次创建文件用 `openSync(...,'wx')`，写历史 Header 与此前条目；之后用 `appendFileSync` 添加 JSONL。
- `_appendEntry` 会先更新 `fileEntries/byId/leafId`，然后调用 `_persist`。如果磁盘写入失败，进程内状态与磁盘事实之间的后续协调逻辑**尚未在这条路径证明**。

因此 **“同步写文件”不自动意味着每条 ToolCall 都先持久化意图，并具备外部副作用 exactly-once**。还必须审计 fsync、部分行、恢复和运行中工具收据。这些并非本轮已验证。

## 4. Compaction：考虑分支投影与“切半个 Turn”

`compaction/compaction.ts:L859–945` 的 `prepareCompaction`：

- 基于**投影后的活动路径**找最近有效压缩边界，老压缩节点可能在尾部但不再贡献消息。
- 依据 `keepRecentTokens` 选择保留切点；若切点落在一个 Turn 中间，额外提取 `turnPrefixMessages`。
- 保留 `previousSummary`、`firstKeptEntryId`、`fileOps`、`tokensBefore`。
- `compact`（L952–）在需要时先分别总结“历史”和“被截断 Turn 前半”，再把上下文连接起来；并不简单地删除 N 条最早消息。
- 上层 `AgentSession.compact`（agent-session.ts:L2828）调用对应 Hooks；自动压缩从另一条入口进入，须同时看模型预算。

**取舍**：可以借鉴“基于投影边界的压缩”，尤其保留文件操作上下文；但摘要不是可执行的事实来源，不能把原本的不确定 ToolCall 摘要成已经成功。

## 5. Extension Runner 是宿主可控的变换链

`extensions/runner.ts:L1190–1259`：

- `emitToolResult` 对 Extension Handlers 逐个执行，允许修改 `content`、`details`、`structuredContent`、`isError`、`usage`。
- Handler 抛异常会被 `emitError` 记录并继续后续处理，避免扩展直接使整个工具结果管线崩溃。
- `emitToolCall` 允许扩展返回 `block` 并提前停止执行；此处是宿主暴露的插件准入能力，不代表插件已经取得 OS 层授权。
- `AgentSession.dispose()`、`reload()` 和 Runner Context stale 检查处理扩展生命周期，阻止跨会话热重载后继续使用旧 Context 引用的部分路径。

**自研必须做更严格的区分**：Extension 可修改 **ModelFacingToolResult**，但不允许修改不可变 **HostExecutionReceipt** 或 DurableEvent 中的原始结果、授权与来源。未经区分会让“扩展把 isError 改为 false”被 Kernel 误认成工具真实成功。

## 6. Shell：已追到 OS 进程，但不是通用沙箱证明

`tools/bash.ts:L97–169` 的 `createLocalShellOperations`：

- 检查工作目录实际存在，否则拒绝运行；
- 通过 `child_process.spawn` 执行配置的 Shell，按平台选择 detached 行为；
- stdout/stderr 事件传给 `onData`；Abort/Timeout 尝试 `killProcessTree`；
- 等待子进程结束后若已 Abort 抛 aborted，若超时抛超时；信号退出码不当作成功。
- `Shell` 操作可以被上层注入替换，实现扩展/适配。

**不能据此声称**所有 OS 的进程树都能完全杀净，或任意 Shell 命令处于文件/网络沙箱中。这里只直接确认运行与取消路径，没有完成安全认证。

## 7. 与另外三套的真正差异

| 问题 | Pi 上层的实际回答 | 对自己的设计 |
| --- | --- | --- |
| 会话能分叉吗？ | 是，同文件分支指针 + 新文件 Fork | 基于稳定 ID 的历史 DAG/Tree 是候选功能 |
| 压缩能处理活动路径/切 Turn 吗？ | 有 Projection/CutPoint/Split Turn | ContextCheckpoint 需要包含切点与来源 |
| 扩展会改工具结果吗？ | 会，ModelFacing 字段可被改写 | HostReceipt 与 UI/模型展示结果要分离 |
| Shell 退出时做什么？ | spawn + 进程树 kill 尝试 + 超时检查 | 独立 Tool Host、明确 OutcomeUnknown |
| JSONL 是原子工作日志吗？ | 本轮没有这方面证据 | 必须自行建立事件事务/副作用收据 |

## 8. 未完成的深研与测试

- Session JSONL 在**半行截断、fsync 失败、并发 fork、重启**时的真实行为；
- Extension 权限策略和 Shell/网络完全 OS 隔离；
- AgentSession 并行工具与 Extension Hook 的更多竞态；
- Provider 请求失败、Retry、Compact 与分支切换在任务运行中交错；
- 压缩摘要能否准确保存未完成 ToolCall 和文件操作事实。

候选自研测试：重开有两个分支的 Session 应得到相同当前 Context；旧摘要仍可追溯但不能覆盖新路径；Extension 把结果标为成功不改变 HostReceipt；cwd 丢失不会误切换路径；部分 JSONL 失败必须可检测而非悄悄成功。

**结论**：Pi **产品层**已经有值得认真借鉴的 Session Tree 和 Compaction；早期“Pi 只管内存消息”的认知只适用于低层包。源码静态分析已足以修正对照表，但完成真实恢复性评估仍需测试。
