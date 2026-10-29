# 35 · Claude CLI 远程工具 Host 与恢复状态机复核

> 日期：2026-10-29  
> 样本：Claude Code CLI 2.1.304 发布版 JavaScript。  
> 证据类型：静态源码复核；未连接真实远程 Host/MCP server，未注入断连或重启故障。  
> 本文研究的是 CLI 内部的 remote ToolHost 路由，不将其等同于 Desktop SDK 的全部 IPC 协议。

## 0. 本轮结论

Claude CLI 的远程工具路径不只是把工具名和参数转发到另一台机器。源码可见一个分层执行协议：

- Host 发现与在线状态；
- host/tool 能力匹配和协议兼容性判断；
- 输入 schema/coercion 校验；
- 调用级状态登记（call ID、host、dispatch epoch、request ID、instance ID）；
- Host 侧 allow/ask/deny 决策与执行；
- 执行结果规范化为 tool_result；
- 连接中断时的状态检查、重新连接、late result 收敛和 delivery-unknown 记录。

这说明 Claude 把“工具是否已发出、远端是否已收到、是否正在运行、是否已有迟到结果”作为独立问题处理。具体的运行时行为仍需要动态验证；本报告不推断其在所有 Host 类型上具有相同的持久化保证。

## 1. 调用链与关键源码

| 文件 | SHA-256 | 关键锚点（0 基字符 offset） |
|---|---|---|
| `chunk-4b60tdnk.js` | `c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb` | `wG` @3,957,580；`uVt` @1,347,132；`Nqo` @1,347,666 |
| `chunk-nejdcwfh.js` | `aa59f014d1dff527f4b070c47cc719d9f5ea1b95608af8ec88b31b135bd4b48a` | runtime `route/runToolUse` 暴露对象 @86,571；route `po` @77,531；host executor `Ai` @103,556；远端调用 `Ro` @87,390；状态机 `no` @41,235；reconcile `Hr` @约43k |
| `chunk-77n97phr.js` | `4a2fdfc394f5c250d5d6a97618d2001ada1aee70d0cff79a8a2adf2324bd3b0f` | route post-validation `gLs` @16,123 |
| `chunk-ns649tzz.js` | `237bd2a46506c6abae41ec86d98c0c4153c8955e11a737044f771b3b1a44729c` | remote host registry `IH` @501,301；runtime `DBe()` @501,147 |

## 2. 从工具路由到 Host 执行

### 2.1 路由阶段

`wG`（`chunk-4b60tdnk.js`）在工具执行前会处理工具别名、pending MCP/tool discovery、工具是否已加载、isolation latch 与相关连接信息。随后：

1. `uVt` 调用 `Nqo` 生成 dispatch；
2. `Nqo` 检查当前 session 是否把同名工具服务权交给另一个 Host、既有 remoteCall、预先决策和 remote runtime 是否适用；
3. remote runtime 适用时调用 `remote.route(tool,input,context,signal)`；
4. `gLs` 对 route 结果再次检查 refusal、route target 和输入 schema/coercion/额外策略；
5. `where:"here"` 走 CLI 本地工具实现，`where:"elsewhere"` 走 `hosts.runToolUse`，refused 则生成 tool_result 错误。

在 `chunk-nejdcwfh.js` 的 runtime 暴露对象中，`route`、`runToolUse:Ai`、`runInnerCall:Ci` 是不同的入口。这是一个明确的 Host adapter 边界，而不是所有工具共用一个通用的 local function call。

### 2.2 Host 解析与等待

`po` 负责判断工具是否需要转发；`go` 根据 Host registry 解析请求目标，处理 remote gate、Host announcement、在线/离线状态、工具是否被该 Host 服务，以及协议是否兼容。

当目标 Host 尚未公告时，代码可以在当前工具调用的 deadline 约束下等待 announcement，然后重新读取 Host 状态。若目标未知、离线、未服务该工具或协议不兼容，会返回明确的路由错误，而不是无条件转成本地执行。

MCP passthrough 也有单独的 `ei` 路径，会根据工具的 machine/host 绑定、MCP wire name、Host 在线状态与工具可见性判断本地/远程/拒绝；因此不能把所有 MCP 工具都视为 CLI 本地执行。

## 3. Remote executor 与 permission gate

### 3.1 `Ai`：结果规范化与错误回填

`Ai`（`chunk-nejdcwfh.js` @103,556）收到 `{tool, toolUse, route, assistantMessage, toolUseContext, canUseTool, now}`：

- 若 route 已经是 error，会构造带原 tool_use_id 的错误结果；
- 若存在被接管/恢复中的 call，会更新对应的 adopted 状态；
- 对非 parked 的 adopted call，某些无法继续路由的情形会记录 `gaveUp(... toldAs:"delivery_unknown")`，以便后续 correction；
- 正常路径标记 tool call started 和 in-progress 状态，调用 `Ro`，并把进度/通知作为异步事件转发；
- 完成后将 remote origin 转为 `tool_result`，并额外产生 `tool_host_result_lines`，包含 Host 名称、执行位置/working directory、disposition 以及是否 unverified 等信息；
- 对 `RemoteToolCallEnded` 等预期结束错误，映射为 cancelled/interrupted/permission-denied/其他 tool_result，而不是把异常原样丢到模型 transcript。

### 3.2 `Ro`：Host 调用前的权限与输入处理

`Ro`（@87,390）在实际执行前会：

- 校验部分 background task ID 是否确实属于当前 Host 和 Agent；
- 在 `requireCanUseTool === true` 且存在 `agentId` 的条件下，执行 Host-aware 的 `mi` permission check；
- `mi` 将目标 Host 名称加入 permission input，调用 `canUseTool`；若 decision 是 ask/deny，或 allow 但 `updatedInput` 被修改，则转成拒绝 outcome，不把修改后的参数默默转发；
- 计算 Host allow rules 与 tool-specific approval callback；
- 将真实转发交给 `no(...)`。

这表明远端路由并不意味着跳过权限。需要注意的是，`requireCanUseTool` 有条件门控；本轮没有逐个验证每类工具/Agent/Host 的具体配置值，因此不声称每个 remote call 都经过完全相同的审批 UI。

## 4. 调用状态登记、断连与 UNKNOWN 收敛

### 4.1 `no` 与 `Br`：一条远程调用的生命周期

`no`（@41,235）在调用开始时通过 Host call-state store 的 `begin({callId, toolName, hostName, dispatchEpoch,...})` 建立调用状态，执行后在 finally 中 `settle` 并执行相关收尾。

内部 `Br`（@约45k）：

- 读取是否有之前被 adopt 的 call；
- 若有，调用 `Hr` 先 reconcile；否则进入新调用 `qt`；
- 首次发送/寻址时登记 `callId`、tool、host、host epoch、request ID、instance ID 和 dispatched timestamp；
- 根据 transport/outcome 更新 in-flight 状态；
- 对完成结果做方向同步/注记；结束后清理本次 call 的暂存状态。

### 4.2 `Lr`：显式记录“调用结果未知”

对 session transport，如果远端调用结果仍是 open 状态，`Lr` 会调用工具状态 ledger 的 `gaveUp`，记录：

- callId、agentId、hostName、toolName/wireToolName；
- 已发送的参数摘要；
- `toldAs`（例如 `delivery_unknown`）；
- `machineHadCall`、transport、dispatch epoch、standing 状态与时间；
- 如果有 late promise，迟到的结果会转给 `answeredLate`。

这不是简单地把网络错误当成“工具失败”。代码保留了“本地不知道远端是否执行”的状态，等待后续校正。**但 ledger 的确切持久化后端和跨进程重启保证仍未证实**，不能把 runtime state 直接说成 durable database journal。

### 4.3 `Hr`：恢复时区分不同的远端状态

已有调用在恢复时会执行状态探测/reconcile。源码区分：

- `late` / `answer`：远端已有结果，可以收敛为已回答；
- `not_received`：Host 确认没有收到调用；
- `ask_lost`：审批请求丢失但调用可能仍在等待；
- `host_restarted` / `gone`：Host 实例/epoch 已变化；
- `host_unresponsive` / `host_asleep` / `unbound`：连接或绑定状态不足以证明终态；
- `cancelled`：本地中断，并更新 adopted/withdrawn 状态；
- `unknown` / `unreachable`：无法证明结果时保留错误/开放状态。

在 Host 已重启、调用已发出、结果未知等路径中，代码不会普遍把同一个 ToolCall 直接再执行一次；它尝试查询原调用、处理 late answer、记录 given-up/adopted 状态，或将不确定性返回给上层。

## 5. 与本轮主 Loop 的连接

将报告 33/34 与本轮合起来，当前可证实的 CLI 结构是：

```text
stream parser emits complete tool_use block
  → StreamingToolExecutor
  → wG (tool discovery / schema / isolation / route)
      → local vYr / AYr
      → remote hosts.runToolUse → Ai → Ro → no/Br/qt
          → Host call state + transport + reconcile
  → normalize to tool_result with original tool_use_id
  → Query Loop drains results and builds next-turn messages
```

这是源码可追踪的控制流。它还不证明所有本地工具都有和 remote Host 相同的 call-state ledger，也不证明远端状态 store 在进程重启后必然持久。

## 6. 证据等级与未决问题

### 源码已证实

- remote route 有独立的 route 和 runToolUse 入口；
- Host 发现/announcement/在线状态/能力和协议兼容性参与路由；
- remote executor 有 call begin/settle、request/instance/epoch 记录与 reconnect reconcile；
- 不确定的远端调用可以进入 `delivery_unknown` / `gaveUp` / `answeredLate` 处理，而不是一律盲目重放；
- remote Host 调用有 Host-aware permission check 和 approval callback 路径。

### 仍未知

1. call-state store 与 `gaveUp` ledger 在哪些 session/host 配置下会持久化，是否跨 CLI/Host 进程崩溃保留。
2. 各 Host transport 的协议、超时、取消、withdraw 和 late response 的实际动态行为。
3. 本地工具的执行事实记录是否提供与 remote Host 等价的 UNKNOWN/late correction 机制。
4. remote/MCP route 与 stream fallback/tombstone 交互时，正在运行的工具何时取消、何时保留结果。
5. 这些分支在不同 feature flags/SDK/desktop host 运行模式下的可达性差异。

## 7. 下一步

1. 追踪 CLI 主 Loop 的 streaming fallback、refusal fallback、abort 和 tombstone，确认它们怎样与 remote Host call state 协作。
2. 研究本地工具执行与 remote Host 的失败语义是否一致。
3. 再研究 subagent 的父子上下文、预算、权限、后台任务和恢复。
4. 最后再把 Claude、Pi 与其他成熟实现按统一维度比较；本报告不提出最终架构选型，不批准开发。
