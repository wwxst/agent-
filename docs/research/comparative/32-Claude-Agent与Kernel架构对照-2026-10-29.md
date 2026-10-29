# 32 · Claude Agent 与现有 Kernel 架构对照

> 日期：2026-10-29。范围：静态源码与仓库实现对照；未运行 Claude Desktop/CLI，未调用模型 API。  
> Claude 样本：Desktop 3.1623.1、SDK wrapper 0.3.304、CLI build pin 2.1.304；旧版 TypeScript 参考为 2.1.88。  
> Kernel 对照：`main` 分支现有 `AgentKernel`、SQLite EventStore/Lease、ToolScheduler、ProcessToolHost 与 HostExecutionLedger。  
> 决策：**借鉴架构模式；保留 Kernel 的执行事实与恢复合同；暂不把 Claude CLI 当作可直接替换的 Loop。**

## 0. 执行摘要

本次从资料库解压并检查了以下组件：

- `01-cli-source-only.zip`：CLI 2.1.304 发布版 JavaScript，约 2,705 个文件；
- `02-desktop-source-only.zip`：Desktop 3.1623.1 主进程/SDK wrapper 分块，约 520 个文件；
- `03-source-reference.zip`：旧版 2.1.88 的 TypeScript/source-map 参考；
- `04-analysis.zip`：本地 Agent 启动链、SDK↔CLI 协议与 CLI 核心报告。

关键模块哈希见第 7 节。CLI 发布版是从与 Desktop 内置 manifest pin 匹配的已签名 Windows CLI 样本中提取的；静态证据可复核，但本次没有运行该二进制。旧版 TypeScript 只用于理解模块职责，不能当成 2.1.304 的同版本源码。

**核心结论：**

1. Claude CLI 是一个完整的 Agent runtime，不只是 API SDK；它自己管理消息历史、模型请求、工具调度、权限与多轮循环。
2. Desktop/SDK 是独立的控制面：通过双向 JSONL 连接 CLI，关联 control request、处理取消、权限审批、宿主 MCP 和进程生命周期。
3. 现有 Kernel 的优势在于持久化执行事实、Intent/Receipt 审计、Lease/Fencing、可信 Host 和 fail-closed 恢复。不能为兼容 Claude/Pi 而把这些职责交给模型 transcript 或 UI。
4. Claude 的流式工具调度会让被判定为并发安全的工具在模型流尚未结束时启动。这个性能模式不应直接移植到 Kernel；Kernel 当前的完整消息→持久化 Assistant/Intent→工具启动屏障更容易证明安全。
5. 若目标是继续使用自有 Kernel，优先借鉴 Claude 的控制通道、权限 Broker、会话状态机和上下文压缩策略。若目标是直接使用 Claude CLI 全引擎，则需要独立的 delegated-runtime 集成方案，而不是实现一个伪装成普通 ModelProvider 的薄包装。

## 1. 三层架构对照

| 层 | Claude 的实现 | 现有 Kernel | 判断 |
|---|---|---|---|
| Agent Loop | CLI 中的 `YL → su → iu → callModel → tool_use → tool_result → next_round` 主链 | `AgentKernel.runTurn()` 管理 step、预算、工具和终态 | 两者职责重叠，必须选定唯一 Loop 所有者 |
| 模型请求 | CLI 构造 Messages API 请求并流式消费响应 | `ModelProvider.stream()` 返回 text delta、usage、message_complete | 保留 Kernel Provider 抽象；Claude CLI 不是透明 Provider |
| 工具调度 | `StreamingToolExecutor`，结合 `isConcurrencySafe` 分组；有跨 Host 路由 | `ToolRegistry` snapshot + `executeBatch()`，parallel/exclusive 分组 | 可借鉴调度策略，但不能越过 Intent 持久化屏障 |
| 权限 | CLI allow/deny/ask 策略 + SDK `can_use_tool` + Desktop Permission Broker + CLI 回答校验 | ToolScheduler 的风险分类、Host 白名单和 Lease 校验；UI 审批层仍需明确接入 | 借鉴分层审批；Host 必须独立复验 |
| 会话/传输 | SDK Query、双向 JSONL、control request ID、interrupt/close、warm reuse/resume | EventStore 管理会话事实；ProcessToolHost 通过 IPC/受限 JSONL 调用 Host | 可以借鉴控制协议模式，不应混淆 Turn 与进程生命周期 |
| 持久化与恢复 | CLI 自有 session/history/compact 机制；SDK/Host 管理回调与进程状态 | SQLite EventStore、tool audit、HostExecutionLedger、WriterLease/Fencing | Kernel 的恢复审计合同更适合作为权威执行账本 |
| 上下文压缩 | autocompact、token 阈值、prompt-too-long reactive retry、summary/attachments 重组 | context admission + 仅压缩连续已完成 Turn 前缀 + checkpoint hash | 借鉴触发策略；保留 Kernel 的安全前缀约束 |
| 子代理 | 复用 query loop，建立 agentId、独立上下文、abortController、maxTurns 与工具/权限上下文 | 现有 Kernel 尚未形成等价的正式子代理合同 | 作为独立子任务/子会话设计，不直接照搬内部对象 |

## 2. Claude CLI 的真实 Loop 与 Kernel 的边界

### 2.1 已核对的 CLI 主链

主要证据位于 CLI 2.1.304 提取模块：

- `chunk-smbjjyps.js`：`async function* YL`（字符 offset 135116）、`async function* su`（137532）、`class vs`（52975）；
- `chunk-4b60tdnk.js`：实际 `beta.messages.create(..., stream:true)`（2780615）、工具路由 `async function* wG`（3957580）；
- `chunk-k3djx6vq.js`：`vn/El` 并发/串行分组路径（约 31408 起）；
- `chunk-451m4237.js`：权限 ask 路径、回答 schema 与拒绝处理。

报告中追踪到的正常链路是：

```text
query / turn setup
  → context preparation + autocompact
  → streamed model request
  → assistant tool_use
  → tool routing + input/schema validation + PreToolUse hooks
  → CLI permission decision (allow / deny / ask)
  → local tool or host-routed tool
  → tool_result
  → append/normalize messages
  → next_round
```

这条链是静态源码中可追踪的可达路径，不表示任意 Desktop 会话都会调用所有工具或使用同一个执行 target。

### 2.2 与 Kernel 当前执行屏障的区别

Kernel 的 `AgentKernel.runTurn()` 在拿到完整 `message_complete` 后：

1. 验证 finish reason、ToolCall IDs 和预算；
2. 持久化完整 `assistant.message`；
3. 为全部 ToolCalls 写入 `tool.intent`；
4. 调用 `executeBatch()`；
5. 每个结果经回调将 `tool.receipt` 与 `tool.result` 原子写入；
6. 有 `outcome_unknown` 或 Lease/Fencing 问题时停止 Loop，并让 Turn 保持待审计状态。

Claude 的 `StreamingToolExecutor` 则能让标记为 concurrency-safe 的工具在响应流尚未结束时开始执行。这减少延迟，但意味着工具启动可能早于整个 assistant 消息的最终收束。若要把该模式放进 Kernel，必须证明每个工具调用在 Host 启动前已经拥有不可歧义、可恢复的完整 Intent；否则不应启用 speculative/early execution。

**建议：继续保持 Kernel 的完整消息与 Intent 屏障。** 可以优化并发分组、队列、进度事件与结果排序，但不把“模型已经开始输出工具调用”视为可以执行的充分条件。

### 2.3 Assistant 消息与 Intent 原子性

Kernel 当前主路径把 `assistant.message` 与后续整批 `tool.intent` 分成两次 EventStore append；只有 Intent append 完成后才调用工具，因此 Intent 写入失败时不会启动工具。这个设计是 fail-closed 的，但在两次 append 之间崩溃会留下需要恢复的 Turn。

若引入新 Loop（尤其 Pi）或外部 CLI，推荐提供一个事务型 Journal API，能在同一事务中提交完整 Assistant 消息和整批 Intent。该改进主要减少中间状态并简化恢复；不应误称现有实现会在 Intent 未提交时执行工具。

## 3. Desktop SDK 的控制面：值得借鉴的部分

### 3.1 双向 JSONL，而不是单向 stdout 日志

SDK/CLI 使用 `--output-format stream-json --verbose --input-format stream-json`，stdin/stdout 以换行分帧。除了 user/assistant/stream_event/result，还有：

- `control_request` / `control_response`：双向请求和应答；
- `control_cancel_request`：取消仍在等待的控制请求；
- `keep_alive` 与 system session-state 消息；
- `mcp_message`：把宿主内存 MCP server 的请求路由到 SDK handler。

SDK 以 request ID 关联 pending 控制请求；还保留有限数量的 unmatched response，允许应答先到、等待者后注册。请求取消、连接清理和 pending Promise 拒绝均有明确路径。

**Kernel 可借鉴：** 把控制面消息和普通模型 transcript 分开；为每个请求设置稳定 ID、状态、取消与超时策略；对未匹配/重复/过期响应做有界处理；对协议帧做 schema 校验和大小限制。

**Kernel 不应直接照搬：** Claude 的 control request 是 CLI/SDK 进程协议，不是 Kernel 的 durable Tool Receipt。请求响应成功不能代替 Host ledger 和 EventStore 里的执行事实。

### 3.2 `result` 不等于 Query/进程已经 idle

协议报告确认，收到 `result` 后，若仍有宿主 MCP、hooks、canUseTool、dialog 或 token refresh 请求，SDK 可能继续等待 session idle；`interrupt` 中断当前回合，而 `close` 清理整个 Query/子进程。Query 可以复用并继续接收多轮输入；冷恢复则使用 CLI session ID 和 resume 选项。

这给 Kernel 的重要启发是区分三个生命周期：

- **Turn lifecycle**：模型步骤、工具调用、完成/失败/取消；
- **Session lifecycle**：可继续输入、等待宿主回调、可恢复/需恢复；
- **Process/transport lifecycle**：启动中、ready、idle、关闭、异常退出。

Kernel 不能因一次模型请求结束就认为工具 Host 或外部进程已经安全 idle；也不能把进程退出直接解释成工具未执行。ProcessToolHost 当前把未答复请求转为 `TOOL_OUTCOME_UNKNOWN` 并终止 worker，这个保守方向应保留。

### 3.3 权限是多层判定，不是一个 UI 回调

Claude 的 ask 路径大致是：

```text
CLI policy allow/deny/ask
  → (ask only) SDK can_use_tool request
  → Desktop broker: auto allow / prior rule / user card
  → SDK control_response
  → CLI schema validation + updatedInput / updatedPermissions
  → strict/deny rules recheck
  → tool execution or error tool_result
```

因此，Desktop 卡片只是权限链的一环。Kernel 侧应保持同样的原则：前端可以请求授权，但不能自行授予可信执行权；Host 仍要检查 Lease、持久化 Intent、工具白名单、参数和执行状态。审批后若输入发生变化，应重新做 schema 与路径/风险验证，不能只信任 UI 返回的 `allow`。

## 4. 上下文、恢复与子代理

### 4.1 Context compaction

Claude CLI 的主回路在模型请求前调用 autocompact，并有 prompt-too-long 后的 reactive retry 路径。它会调整 messages、summary、attachments 和 compact boundary，而不只是展示一个提示。

Kernel 当前的策略更保守：`admitContext()` 超限时，只能压缩连续已完成 Turn 的安全前缀；检查该前缀没有 unresolved tool audit 或未消费 steering，并写入带 `throughSeq` 与 `sourceHash` 的 checkpoint。

建议按阶段借鉴：

1. 保留 Kernel 的 checkpoint/hash 和连续完成前缀约束；
2. 先增加可观测的 token/context admission 指标与压缩触发原因；
3. 后续再考虑 provider 返回明确上下文超限时的 reactive retry；
4. reactive retry 只能在尚未启动工具的安全边界执行，并且压缩结果必须进入持久化审计；
5. 不得把含未知工具结果或未完成 Turn 的历史压缩成不可复核的 summary。

### 4.2 Subagent

Claude 的子代理在主 Loop 内建立独立 agentId、消息上下文、abortController、maxTurns 与工具/权限上下文，并复用同一个 query engine。这比“再造一套模型循环”简单，但也意味着父子之间必须传播取消、权限限制、预算和完成状态。

Kernel 若要实现子代理，建议采用显式 parent-child 关系（父 ToolCall/Turn ID、子 Session/Turn ID、预算、权限范围、取消令牌与最终结果 Receipt），不要仅靠 prompt 字符串或模型 transcript 隐式追踪。父 Turn 被 fencing 时，子任务的副作用也必须被阻断或进入待恢复状态。

## 5. 三种集成选择与裁决

| 方案 | Loop 所有者 | 优点 | 主要风险 | 当前建议 |
|---|---|---|---|---|
| A. Claude 模型作为普通 Provider | Kernel | 保留 Kernel 的 Intent/Receipt/Lease/Host；最容易做确定性测试 | 需要自有工具循环与上下文管理，不等于使用 Claude CLI 完整 Agent 功能 | **如果目标是使用 Claude 模型，优先选此方案** |
| B. Claude CLI 作为完整外部 Agent runtime | Claude CLI | 复用其上下文、工具、subagent、CLI session 和模型循环 | 工具可能在完整消息持久化前启动；隐藏/内建工具与 Host 边界难统一；状态与恢复可能双写 | 仅作为独立 delegated-runtime 研究，不作为普通 Provider |
| C. Pi Core 作为可替换 Loop | Pi Core + Kernel adapter | 目前已有 11 项 fake-stream/fake-journal/fake-host 测试，事件屏障易适配 | 真实 SQLite 事务、Host、Lease/Fencing、并行 Unknown drain 仍未验证 | 继续隔离实验，接入真实 Kernel 前设故障注入门槛 |

**不批准 B 直接替换现有 Kernel。** 若将来必须调用 Claude CLI 的完整 Agent runtime，应明确采用“外部执行引擎”模型：所有可执行工具都必须被强制路由到可信 Host；每个工具启动前要有持久化 Intent；事件、权限、取消和进程生命周期必须能被审计；不能让 CLI 自己的 transcript 成为权威账本。当前静态证据不足以证明这些条件已经满足。

## 6. 下一阶段建议

按风险与价值排序：

1. **P0 — 文档与合同：** 固定 Loop/Control/Execution/Durable Journal 四个边界，明确唯一的 Turn 状态所有者。
2. **P1 — Kernel 层：** 为 Assistant + 整批 Intent 增加事务型接口/实现，并增加“写入失败、进程崩溃、恢复时存在 Assistant 但无 Intent”的故障注入测试。
3. **P1 — Host 层：** 继续验证 HostExecutionLedger 的 STARTED/terminal、Lease 复验和未答复 IPC 的 UNKNOWN 收敛；所有未知结果都不得自动重放。
4. **P2 — 控制协议：** 若需要子进程 Agent backend，设计独立的 JSONL control transport，覆盖 request correlation、取消、initialize barrier、pending callbacks、idle 与 close。
5. **P2 — 上下文：** 增加 context admission/compaction 指标；在已验证的安全前缀上逐步研究 reactive retry。
6. **P3 — 子代理：** 以父子 ID、预算、权限继承和取消传播为合同，后做功能而不是先做 UI。
7. **P3 — 性能对比：** 对相同 FakeProvider 轨迹比较 Kernel loop、Pi loop 和任何外部 CLI backend；分别衡量首 token 延迟、工具启动延迟、恢复正确性、依赖/适配代码量和失败语义。

## 7. 关键源码证据与完整性

### Claude CLI 2.1.304

| 文件 | 证据 | SHA-256 |
|---|---|---|
| `chunk-smbjjyps.js` | `YL` @ 135116；`su` @ 137532；`class vs` @ 52975；工具结果回填与 next_round | `1e28512664e9ef8818c84e5c4f6b19ee48c8f0c832e6673f29ad1a7f0872a46d` |
| `chunk-4b60tdnk.js` | `beta.messages.create` @ 2780615；`wG` @ 3957580；schema、权限与工具路由 | `c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb` |
| `chunk-k3djx6vq.js` | `vn/El` 并发安全分组与串行屏障 | `1b4dc9236bf90b77cd9d9d13aa82f67c6a792920e9253d92ef402a2f6dd615fe` |

### Desktop 3.1623.1

| 文件 | 证据 | SHA-256 |
|---|---|---|
| `index.chunk-J7YnW_mh.js` | SDK Query、ProcessTransport、JSONL、控制请求关联、MCP/取消 | `80d308de49d2eacee72a561734b05e32209783de7772881036e5608cfd725a42` |
| `index.chunk-pO0kQf5K.js` | LocalAgentModeSessionManager、会话创建/发送/恢复 | `526e75009808b4ecb3d155a3d5ab62b4b7edbb1f409006bbd0f25b18b48cacd9` |
| `index.chunk-C7nJwi7_.js` | Permission Broker、挂起审批、interrupt | `f69b5dae07191e32fc528591aa741e9e3717127b19d52d3c463a32295d16cbe7` |

### 现有 Kernel（main）

- `packages/kernel-core/src/index.ts`：Turn admission、model step、完整消息验证、Intent 批次、Receipt/Result 提交、取消、steering、checkpoint。
- `packages/contracts/src/index.ts`：ProviderEvent、ModelProvider、ToolExecutionContext、EventStore 和事件类型合同。
- `packages/tool-scheduler/src/index.ts`：只读风险门控、参数 parse、parallel/exclusive 分组、Promise.allSettled drain、Receipt callback。
- `packages/event-store-sqlite/src/index.ts`：WAL + synchronous=FULL、BEGIN IMMEDIATE、expectedSeq CAS 和同事务 Lease fencing。
- `packages/session-leases-sqlite/src/index.ts`：续租、过期检查、严格递增 fence token。
- `packages/tool-host/src/ledger.ts` 与 `worker.ts`：Host STARTED 持久化、Host 内部校验 Assistant+Intent、重复调用拒绝与进程崩溃后的 UNKNOWN 语义。
- `packages/tool-host/src/index.ts`：进程生命周期、请求 ID 关联、超时/取消时关闭 worker 并把未答复调用视为 UNKNOWN。

### 证据限制

- 本文对 Claude 的判断来自静态源码和已有报告；没有启动 CLI/Desktop 或真实模型请求。
- CLI 2.1.304 是发布版 JS 提取物，Bun 虚拟 import、压缩符号与 native addon 仍是其运行时的一部分。
- 2.1.88 TypeScript 来源是固定 commit 的公开仓库 source map 快照；它可辅助解释结构，但不是 2.1.304 的配套原始源码。
- Kernel 的代码检查是仓库静态对照；本报告本身不是新的 CI 结果，也不批准任何生产迁移。

## 8. 最终结论

- **KEEP：** Kernel 的持久化账本、Intent/Receipt、Lease/Fencing、Host 内部复验与 UNKNOWN 恢复。
- **BORROW：** Claude 的双向控制协议、请求关联、权限 Broker 分层、Session/Process 状态分离、上下文压缩触发策略和子代理上下文隔离。
- **DEFER：** Claude 的流式提前启动工具、完整 CLI loop 替换、自动重放、未经 Host 复验的权限决策。
- **NEXT GATE：** 先增强真实 EventStore 与 Host 的原子性/故障注入，再评估 Pi Loop；Claude CLI 全引擎只保留为独立外部 runtime 研究选项。

一句话：**学习 Claude 如何组织 Agent 系统，但让 Kernel 继续拥有执行事实、授权边界和恢复决定权。**
