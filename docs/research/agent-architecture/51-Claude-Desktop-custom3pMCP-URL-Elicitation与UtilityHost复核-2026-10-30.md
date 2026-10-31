# 51：Claude Desktop custom3p-mcp URL Elicitation 与 Utility Host 生命周期复核（2026-10-30）

> 研究阶段：发布版 bundle + utility process source 静态复核；未运行真实 MCP server 或用户 consent 流程。  
> 样本：Claude Desktop 3.1623.1。  
> 承接报告 50：单独核验 custom3p-mcp 的 MCP elicitation，避免将它与 LocalAgentMode SDK 的 onUserDialog / request_user_dialog / canUseTool 混为一谈。  
> **本报告只增加研究文档；不修改业务代码、Kernel 或实现 PR。**

## 1. 证据范围

关键文件：

| 文件 | SHA-256 |
|---|---|
| index.chunk-BRvO7fVg.js | 1a87853c63ad0e52ffa69e2de27004dc0dfccfb5394f23f3daaf5829da6b7976 |
| mcp-runtime/directMcpHost.js | b91b8dcc94c6083feeebc1d084b1ea4374c0643d4379431e1fea9e0f0dcc5148 |

BRvO bundle 中 custom3p-mcp manager 与 elicitation handler 使用字符偏移；directMcpHost.js 是 utility process 中的 source file，但打包后仍为单行压缩代码。本轮未运行 MCP server、native dialog、browser launch、utility process crash 或 app restart。

## 2. 这不是 LocalAgentMode SDK 的 onElicitation

报告 50 已确认 LocalAgentMode buildStartSdkOptions 未提供 onElicitation callback；SDK Query 在没有 callback 时对 elicitation 返回 decline。

custom3p-mcp 是另一条独立路径：

- HTTP / SSE remote MCP server 由独立 utility process directMcpHost.js 承载；
- stdio custom3p-mcp server 在 Desktop main process 内直接建立 MCP Client；
- 两条路径都声明 MCP client capability 为 elicitation.url；
- 两条路径都把 elicitation/create 映射到同一个 main-process OJt consent handler；
- 两条路径都监听 notifications/elicitation/complete，并通过 serverName + elicitationId 查找 completion waiter。

因此这不是 Agent tool permission card，也不是 SDK request_user_dialog。它是 custom third-party MCP server 请求 Desktop 帮用户打开一个 URL 的 server-level consent。

## 3. URL Elicitation 的授权规则

main process 的 OJt(serverName, params, serverEnabled) 有明确拒绝条件：

1. 当前已有其他 elicitation / consent dialog 打开；
2. server 当前已被 policy 禁用；
3. params.mode 不是 url；form mode 直接 decline；
4. URL 解析失败；
5. URL scheme 不是 HTTPS；
6. hostname 长度超过 255；
7. URL 命中 Claude auth URL withholding 规则。

通过检查后：

- 生成 120 秒 timeout Promise；
- 调用 Electron dialog.showMessageBox；
- dialog 显示 server name、目标 host 和 server message；
- 按钮为 Open / Cancel，默认按钮为 Cancel；
- 用户选择 Open 后调用外部 browser open URL，返回 action=accept；
- 用户选择 Cancel 返回 action=decline；
- 120 秒内未完成选择返回 action=cancel。

全局 TJt Set 与 vx Map 用于限制同时打开的 dialog / error-retry flow，避免多个 server 并发弹出 consent。

这个流程没有将任意表单数据交给 renderer，也没有直接批准 MCP tool call。它只允许 / 拒绝打开一个经过 HTTPS / host / policy 检查的 URL。

## 4. HTTP / SSE custom3p-mcp utility host 协议

### 4.1 Main process 启动与连接管理

BRvO bundle 的 fYt 创建 utility process：

- path 指向 asar/.vite/build/mcp-runtime/directMcpHost.js；
- utility process 使用独立 partition custom3p-mcp-host，cache=false；
- spawn timeout 约 5 秒；
- 每个 server addServer 的 ready timeout 约 90 秒；
- 通过 MessageChannelMain 为每个 MCP server 创建独立 MessagePort；
- 主进程保留 active connection Set 与 utility process singleton bx。

unexpected utility process exit 时：

- 记录退出 code 和 active connection 数；
- 对 active connections 调用 fireClose；
- 清空连接集合；
- 将 singleton bx 清空，使下一次 pYt 可以重新 spawn host。

这是一种可重建的 shared utility host，不是每个 Session 一个 utility process。

### 4.2 Utility process 内的 MCP client

directMcpHost.js 的 pE(config, port)：

- 创建 remote MCP client；
- 创建 RequestManager，fallback 固定为 action=cancel；
- 监听 port message；
- 接收 elicitationResult 时按 seq settle；
- 接收 authRejectedResult 时 settle auth retry；
- 监听 port close；
- 对 MCP server 设置 elicitation/create request handler；
- 对 notifications/elicitation/complete 设置 notification handler；
- 连接成功后把 tools list 返回 main process；
- 在 port close / remote client close 时 drain pending requests 并关闭另一端。

MCP server 发出 elicitation/create 时：

1. directMcpHost RequestManager.request 分配递增 seq；
2. 向 main process MessagePort 发送 {type:"elicitation", seq, params}；
3. main process OJt 执行 native dialog / URL consent；
4. main process发送 {type:"elicitationResult", seq, result}；
5. utility process RequestManager.settle(seq, result)；
6. MCP server 收到对应 elicitation/create response。

seq 是 request-response correlation；elicitationId 则用于后续 completion notification，两者不是同一个 ID。

### 4.3 Port close 的 fail-safe

RequestManager 的默认 fallback 是 {action:"cancel"}。它支持 AbortSignal；signal 已 abort 或 manager 已 drained 时，request 直接 resolve fallback。

port close、remote client close 时调用 drain()：

- manager 标记 drained；
- 所有 waiters 以 action=cancel 结算；
- 后续新 request 也直接返回 cancel。

因此 utility host / MessagePort 关闭时，pending elicitation 不会无限悬挂在 directMcpHost 内；它以 cancel 结果结束。这里是内存 Promise drain，不是持久化恢复。

## 5. Elicitation completion notification

directMcpHost 和 main-process stdio path 都注册 notifications/elicitation/complete handler：

- utility host 转发 elicitationComplete + elicitationId；
- main process mJt 用 JSON.stringify([serverName, elicitationId]) 查找 waiter；
- 找到 waiter 时 resolve completion Promise 并删除 map entry。

bundle 还存在 hJt / kJt completion-wait helper：它可等待用户打开 URL 后的 server completion，或显示第二个 Done / Cancel dialog，最长 120 秒。

但本轮在该 bundle 中没有找到 kJt 的直接调用点。因此可以确认 notification forwarding 与 waiter helper 存在，不能确认所有正常 URL elicitation 都会等待 completion notification。普通 OJt 路径在用户点 Open 后即返回 action=accept；complete notification 是另一个异步信号。

custom3p-mcp tool call 遇到 UrlElicitationRequired 时，directMcpHost 会将错误转换并抛给上层；该错误的完整 retry / completion UI 路径仍需单独确认，不能只凭未引用的 kJt helper 声称已经闭环。

## 6. stdio custom3p-mcp 路径

stdio custom3p-mcp 不走 directMcpHost utility process：

- main process 通过 sJt spawn stdio command；
- 直接创建 MCP Client；
- capabilities 同样声明 elicitation.url；
- setRequestHandler("elicitation/create") 直接调用 OJt；
- setNotificationHandler("notifications/elicitation/complete") 调用 mJt；
- connect / tools/list 有 startupTimeoutSec 与 AbortController；
- dispose 时关闭 MCP client。

因此 URL consent policy 在 HTTP/SSE utility-host path 与 stdio path 是共享的，但进程隔离和请求 transport 不同。

## 7. Host shutdown 与 pending elicitation

main process 注册 direct-mcp-host-shutdown handler，标记 stopsChildProcesses=true，并调用 disposeDirectMcpHost：

1. 对 active connections fireClose；
2. 清空 connection Set；
3. 发送 utility process kill；
4. 最多等待约 5 秒；
5. 超时则再次 n.kill() 并完成 shutdown。

connection dispose 会关闭 MessagePort；utility process 的 port close handler drain pending requests 为 action=cancel，并关闭 remote MCP client。

因此 app shutdown 时，custom3p-mcp URL elicitation 没有跨 app restart 的 durable request record，也没有 pending elicitation replay。它按 cancel 结算并随 MCP connection 关闭。重新启动后需重新连接 MCP server；是否由 server 再发一次 elicitation 取决于 server 自身状态，Desktop 没有在本轮可见路径中保存该请求以便重放。

## 8. 与 Agent 权限体系的边界

| 机制 | 处理对象 | UI / 响应路径 | 重新初始化 |
|---|---|---|---|
| SDK canUseTool | Agent tool invocation | ToolPermissionBroker / permission card | CLI pending can_use_tool 可重交付 |
| SDK request_user_dialog | Desktop 内建用户对话 prompt | UserDialogBroker / Session snapshot | CLI pending request_user_dialog 可重交付 |
| SDK hook_callback | SDK-host policy / lifecycle hook | Hook callback function | 旧 generation cancel + safe fallback |
| custom3p-mcp elicitation | MCP server 请求打开 URL | Electron native dialog + external browser | 无 durable replay；port / host close 时 cancel |
| MCP tools/call | MCP tool execution | MCP Coordinator / transport gate / canUseTool | 按 server / transport 状态处理，不等于 elicitation |

这几个机制即使都涉及“等待用户”，也有不同 authority、ID、timeout、transport 和恢复语义。

## 9. 事实 / 推断 / 未知

### 源码事实

- custom3p-mcp HTTP / SSE path 使用 utility process directMcpHost.js 与每 server MessagePort。
- stdio custom3p-mcp path 在 main process 内直接创建 MCP Client。
- 两条路径都只 advertise elicitation.url，并使用 OJt native consent handler。
- OJt 只接受 HTTPS URL，host 长度最多 255，拒绝 form mode、Claude auth URL、disabled server 与并发 dialog。
- URL consent timeout 120 秒，默认 Cancel；用户 Open 才调用外部 browser。
- utility host RequestManager 使用 seq correlation，fallback action=cancel；port close / remote close 时 drain。
- main process shutdown 会 disposeDirectMcpHost，关闭 active connections，最多等待约 5 秒后 kill utility process。
- notifications/elicitation/complete 在 utility-host 与 stdio path 都有 handler。

### 推断 / 风险（未动态验证）

- utility host restart 后没有 Desktop-side pending elicitation replay；server 需要自行重新发起或恢复其业务状态。
- app shutdown / port close 时 cancel 是保守终止，不是对 MCP server 外部状态的回滚。
- native dialog 与 external browser 已离开 Electron renderer 的权限 UI 边界；用户可能在 renderer 不可见时仍看到 native dialog。

### 未知 / 资料缺口

- URL elicitation error retry / completion waiter kJt 的实际调用路径；本轮未找到直接 callsite。
- MCP server 是否在 client reconnect 后自动重新发起 elicitation，以及 server-side elicitationId 是否持久化。
- utility process 意外崩溃时 remote MCP server 的 session / SSE state 是否可恢复。
- native dialog 在 app quit / window close / account switch 下的动态行为。
- 没有运行真实 HTTP MCP、stdio MCP、URL consent、elicitationComplete 或 utility process crash。

## 10. 对目标 Agent 架构的非决策性启示

1. **MCP elicitation 与 Agent tool permission 分层：** server 要求用户打开 URL，不等于用户批准 Agent 执行工具。
2. **为外部 consent 设计专门 policy：** scheme、host、server identity、是否并发、default action、timeout 都必须明确；默认拒绝比默认打开安全。
3. **请求与完成分离：** elicitation/create 的 request seq 与 elicitationId completion 是不同生命周期；不能以 accept response 推断外部流程已完成。
4. **host crash 要有明确终态：** utility host close 将 pending request 统一 cancel；若业务需要跨重启恢复，应有 server-owned durable operation ID，而非仅靠内存 Promise。
5. **工具调用错误可触发外部 consent，但不能隐式批准：** UrlElicitationRequired 应进入可审计的用户授权流程，并在完成后重新校验 tool/server/policy。
6. **不要把所有用户交互塞入同一个 PermissionBroker：** Tool permission、UserDialog、Hook decision、MCP URL consent 的 authority 与恢复策略不同。

以上是设计输入，不是已批准架构决策。

## 11. 下一步

1. Desktop / SDK 的可读发布版源码研究已覆盖报告 47–51 的启动、双向协议、进程、Session、MCP 拓扑、权限、Hooks、pending request redelivery、URL elicitation 与 utility host lifecycle。
2. Hosted renderer 实际 reload hydrate、native binding / SSH helper server-side 和动态 crash / side-effect 仍然是资料或运行环境缺口，继续明确标记未知。
3. **下一阶段转入 Pi Agent Core：** 固定 upstream repository、commit SHA、package version 与 npm tarball；核验源码与发布包一致后，研究 Agent loop、event stream、tool execution、context transform / compaction、session tree、extension hooks、cancel、error handling 和 persistence / resume。
4. Claude CLI、Desktop / SDK、Pi 完成同场景对照后，再提出独立目标架构并交用户审阅。明确批准前不进入开发。

## 12. 本轮边界

本报告只新增研究文档和进度记录。没有新增 Agent loop、adapter、tool executor、Session store 或 Kernel 实现；没有修改业务代码；没有提交开发 PR。

## 13. Evidence index

| File | SHA-256 | Anchors |
|---|---|---|
| index.chunk-BRvO7fVg.js | 1a87853c63ad0e52ffa69e2de27004dc0dfccfb5394f23f3daaf5829da6b7976 | URL validation yJt @2,148,928；OJt @2,149,865；kJt @2,150,953；completion waiter hJt / mJt @2,148,306 / @2,148,222；utility host fYt @2,160,737；addServer pYt @2,164,769；disposeHost mYt @2,164,832；stdio custom3p path $Qt @2,224,155；direct-mcp-host-shutdown registration @6,774,508 |
| mcp-runtime/directMcpHost.js | b91b8dcc94c6083feeebc1d084b1ea4374c0643d4379431e1fea9e0f0dcc5148 | RequestManager tE @606,185；pE @608,736；elicitation/create @110,746；notifications/elicitation/complete @110,837；drain @608,865；port close handling @609,618 |

**证据等级：** Desktop 3.1623.1 发布版 JS / utility process source 静态分析；没有真实 MCP server、native dialog、browser open、utility process crash 或 app restart 测试。