# 47 · Claude Desktop / SDK Session 启动、双向协议与宿主生命周期（第一轮）

> 日期：2026-10-30  
> 样本：Claude Desktop 3.1623.1；bundled Claude Agent SDK wrapper 0.3.304；CLI 2.1.304。  
> 方法：直接复核上传资料包 `extracted-3.1623.1/asar/.vite/build` 中 Electron main bundle、SDK wrapper、SessionManager、PermissionBroker、SessionPersistence 与 RemoteProcess JS；**静态源码研究**，未启动 Desktop、未 spawn CLI、未连接 SSH/MCP、未进行 crash / network fault injection。  
> 前置：[报告 44：Remote Agent Cloud Session](./44-Claude-Remote-Agent云端Session生命周期与恢复-2026-10-30.md)、[报告 45：Storage V5 provider provenance](./45-Claude-StorageV5Backend来源与Sidecar持久化保证-2026-10-30.md)、[报告 46：Transcript / Remote Agent 恢复矩阵](./46-Claude-Transcript与RemoteAgent联合恢复状态矩阵-2026-10-30.md)。

## 0. 摘要

本轮从 Electron package main 入口开始，追踪 Desktop 的 LocalSessionManager → SDK query → ProcessTransport → CLI 子进程，以及反向 control protocol、PermissionBroker、MCP bridge、Session persistence、interrupt/stop/pause 和 SSH remote spawn。

核心架构判断：

- Desktop 主进程不是 Agent Loop；它是 Session / policy / UI event / process / workspace / MCP 的宿主控制平面。
- CLI 2.1.304 是实际执行引擎，负责模型请求、Agent loop、工具执行和 CLI transcript。
- bundled SDK wrapper 0.3.304 不是普通 stdout parser；它是双向 JSONL + control RPC + process transport + SDK MCP bridge。
- Renderer 不直接连接 CLI。Renderer → Electron Main RPC → PermissionBroker / SessionManager → SDK Query → CLI process；CLI 的 control_request 反向经 SDK callback 进入 Desktop broker，再经 Main event/RPC 与 Renderer 交互。
- Desktop Session metadata、CLI transcript、Waiting Input、SSH reattach checkpoint 是不同持久化域；没有看到它们共享一个跨文件事务。
- 本地 CLI 进程在 pause/stop/app quit 时走 Query teardown；SSH RemoteProcess 有独立的进程身份、sequence replay 和 reattach checkpoint，可尝试接管原远端进程。它与报告 44 的 Cloud Session Remote Agent 完全不同。

本轮仅完成 Desktop 主 Session / SDK protocol 第一轮；SSH RemoteProcess 的完整重连状态机、Renderer RPC schema、MCP Host/Laptop topology 仍需进一步追踪。

## 1. Electron Main 入口与模块边界

### 1.1 Package entry

Desktop asar 的 package.json 指向 `.vite/build/index.pre.js`。该文件负责 pre-main 初始化（包括诊断/运行时钩子），随后加载 `.vite/build/index.js`；index.js 再加载 main bundle。SessionManager / SDK wrapper 不是独立 daemon，而是 Electron main bundle 中的模块。

已检查：
- `index.pre.js`：pre-main bootstrap 与 main bundle handoff；
- `index.js`：main chunk loader；
- `index.chunk-BRvO7fVg.js`：Electron main app、IPC/API、事件 dispatcher、private-file helpers；
- `index.chunk-C7nJwi7_.js`：LocalSessionManager、PermissionBroker、Session lifecycle；
- `index.chunk-J7YnW_mh.js`：bundled SDK wrapper / Query / ProcessTransport。

### 1.2 Renderer / Main 边界

main bundle 的 IPC registration helper 使用 `ipcMain.handle`，并先验证 `senderFrame`：
- 必须是 top-level frame（parent === null）；
- URL host 必须通过 Desktop allowed-host 检查；
- 否则抛出 Invalid IPC sender。

SessionManager 对 Renderer 暴露 start/send/interrupt/stop、permission response、transcript 和 session state 等能力；main process 通过 event dispatcher 将 session events 投递到当前 main view。MCP renderer connection 另有 MessagePort transfer 路径。

因此 UI 不是 SDK Query 的直接消费者：Main process 负责鉴权、校验、session ownership 和事件路由。

## 2. LocalSessionManager：创建 Query 的真实顺序

### 2.1 startSession

`LocalSessionManager.startSession()`（`index.chunk-C7nJwi7_.js` @1,916,481）大致按以下顺序执行：

1. 校验 start options / backend / cwd / worktree / session identity。
2. 创建或接收 Desktop local session ID；维护 start lock、AbortController、inFlightStarts 和 cwd reservation，避免同一 Session 并发重复启动。
3. 检查账号 / org / policy / workspace trust / managed settings / CLI availability。
4. 通过 cliGovernor 获取 process slot；可回收或 claim prewarm/spare query。
5. 运行 MCP / plugin setup；SSH target 另有 setupSshPluginsAndMcp / host-side setup。
6. 调用 buildStartSdkOptions，构造 CLI args/env、permission callback、hooks、OAuth / host token callback、MCP servers、model、settings、workspace 等。
7. 动态加载 bundled SDK 的 query 函数。
8. 通过 spawnSessionQuery 创建 Query（或 claim 已有 spare）。
9. 注册 Session 与 Query，安装 Query event handlers。
10. 完成初始 input enqueue；idle prewarm 可只建立 Query，不立即发送用户消息。

Desktop 还使用 CliCrashLoopGuard、CliGovernor、WarmLifecycle、StartRegistration 和 querySpawnedAt 管理并发、预热、恢复和崩溃预算。

### 2.2 warmSession

`warmSession()`（@1,158,279）不是“恢复旧 Query 对象”：

- 读取已保存的 cliSessionId / unarchivedCliSessionId；
- 检查 crash-loop guard、workspace trust、CLI transcript 是否存在、backend policy；
- 对 local backend 检查 CLI JSONL transcript；缺失时可标记 transcriptUnavailable 并跳过 warm；
- 重新准备 MCP、权限、SDK options；
- 加载 SDK query，再调用 spawnSessionQuery；
- 对 SSH backend，可能提供 reattach target，让自定义 RemoteProcess 接管旧 host process；如果不能接管，则由 policy 决定是否允许 fresh spawn / CLI resume。

Desktop local session ID 与 cliSessionId 是不同字段和不同生命周期；恢复 CLI transcript 需要保存的 CLI session identity。

## 3. SDK ProcessTransport：本地 CLI 子进程

SDK wrapper 的 `ProcessTransport`（`index.chunk-J7YnW_mh.js` @1,160,304）负责实际进程 I/O。

### 3.1 Local spawn

当没有注入 `spawnClaudeCodeProcess` 时：

- 使用 Node/Bun child_process.spawn；
- stdin/stdout/stderr 三个 pipe；
- CLI args 包含 `--input-format stream-json`、`--output-format stream-json`、`--verbose`；
- 如果 SDK options 提供 canUseTool，则追加 `--permission-prompt-tool=stdio`；
- 按 resume/session options 选择 CLI session resume / session ID 参数；
- env 设置 `CLAUDE_CODE_ENTRYPOINT=sdk-ts`，并处理 NODE_OPTIONS；
- stdout 由 SDK JSONL reader 解析，stderr 独立收集最近 2 KiB 诊断尾部；
- onProcessSpawned 将 PID 回传宿主；
- SDK 维护进程集合，父进程退出时尝试终止仍被跟踪的子进程。

Desktop buildStartSdkOptions 提供 canUseTool，所以该 permission path 对 Desktop query 是正式宿主协议，不是 CLI 内部交互 UI 的 fallback。

### 3.2 Query close 与 OS process exit 不是同一时刻

ProcessTransport.close：
1. 结束 stdin；
2. 等待约 2 秒；
3. 非 Windows 尝试 SIGTERM；Windows 走延迟强制终止路径；
4. 再等待约 5 秒后尝试 SIGKILL。

Query.close / cleanup 会取消 pending control requests、关闭 SDK MCP servers、结束 input stream、关闭 transport，并等待进程退出最多约 2 秒。

因此 Query.close 返回并不构成 OS 已确认 child process exit 的证明；最终 SIGKILL 是异步定时路径。是否存在 Desktop 层额外等待 / PID reconciliation，需要动态验证和继续追 teardownQuery helper。

## 4. Query：双向 JSONL + Control RPC

### 4.1 初始化握手

SDK Query（`xOe`，@1,176,386）构造时：
- 建立 SDK MCP server transports；
- 启动 stdout read loop；
- 发送 initialize control request；
- prompt 是 async iterable 时启动 streamInput；
- streamInput 等待 initializeWritten 后才向 CLI stdin 写 user input。

initialize（@1,190,254）会将 hooks、SDK MCP server manifests/names、system prompt、plugins、agent/tool config 等宿主信息交给 CLI。SDK 在捕获 SDK MCP manifest 时有约 250 ms bounded wait，避免 server initialize 阻塞整个 CLI 启动。

这解释了 Desktop 为什么先创建 inputStream，再启动 Query：Desktop 可以在 CLI 初始化握手完成后继续向同一个 stdin stream 注入消息，而不需要每轮重建进程。

### 4.2 双向请求关联

CLI → SDK：
- `control_request` 携带 request_id；
- SDK 以 request_id 建立 AbortController / pending request state；
- 同一 request_id 已在处理中时，不重复执行；
- 处理完成后以相同 request_id 发送 control_response；
- 收到 `control_cancel_request` 时，SDK abort 对应 callback。

SDK → CLI：
- Query.request 生成 request_id；
- pendingControlResponses 保存等待中的 Promise；
- 收到 control_response 时按 request_id resolve；
- 如果请求 signal 在发送后 abort，SDK 发送 control_cancel_request；
- 无法匹配的 response 暂存，最多 1024 条。

双向协议的 request_id 是 SDK/CLI correlation ID，不等于 Desktop UI 的 permission card ID。

### 4.3 CLI → Desktop 的宿主回调类别

`handleControlRequest()`（@1,183,952）将 CLI 控制请求路由到不同 callback：
- can_use_tool → PermissionBroker；
- hook_callback → Desktop hook callback；
- mcp_message → SDK MCP server；
- request_user_dialog / elicitation → user dialog broker；
- OAuth / host auth token refresh → Desktop auth provider；
- 其他受支持的 host control subtype。

SDK 不只是把消息透传给 Renderer，而是负责执行 callback、AbortSignal 和 control_response 收敛。

### 4.4 Desktop → CLI 的宿主控制

Query.request 被 Desktop 用于 interrupt、model/settings 更新、MCP server 更新、权限规则推送和其他受支持 control subtype。CLI 的 control_response 再由 SDK Promise correlation 返回 Desktop。

这使 Desktop 可以在不关闭 CLI 进程的情况下中断 Turn、更新设置或调整 MCP servers。

## 5. PermissionBroker：CLI permission 到 UI approval 的完整路径

### 5.1 Callback 注入

`buildStartSdkOptions()`（`index.chunk-C7nJwi7_.js` @675,805）为 SDK options 构造：
- canUseTool；
- onUserDialog；
- hooks / createBaseHooks；
- getOAuthToken / getHostAuthToken；
- mcpServers；
- permissionMode、settings、env、cwd、model 等。

canUseTool callback 来自 Desktop PermissionBroker，不是 Renderer 直接响应 CLI control frame。

### 5.2 Permission request 生命周期

`createCanUseTool()`（@172,293）进入 PermissionBroker；内部先做 policy / rule / workspace / tool-specific 检查。无需询问的 allow/deny 可直接返回；需要用户审批时调用 handleToolPermission（@241,625）。

handleToolPermission：
1. 生成独立 UI permission request UUID；
2. 记录 sessionId、toolName、input、toolUseId、suggestions、decision reason 等；
3. 监听 SDK 传入的 AbortSignal；
4. 写入 pendingPermissions；
5. emit `tool_permission_request` 给 Desktop session event stream；
6. 等待 Renderer response；
7. 收到响应后通过 Promise resolve 回 canUseTool。

若 SDK AbortSignal abort，PermissionBroker 移除 pending card、settle 相关 UI state，并 resolve `{behavior:"deny",message:"Request aborted"}`。

### 5.3 UI response 与 policy enforcement

`respondToToolPermission()`（@249,986）：
- 按 UI permission request UUID 找到 pending entry；
- 检查该 ask 是否只能从 permission card 响应；
- 对不能 allow 的 tool / connector ask 强制 deny；
- 如果当前 tool 没有允许持久化的 rule，可能把 always/scheduled 降级为 once；
- 处理用户修改的 input、permission suggestions、项目配置写入 fence；
- resolve 原 canUseTool Promise。

因此完整链路是：

`CLI control_request(request_id)` → SDK AbortController → Desktop canUseTool → PermissionBroker pendingPermissions(UI UUID) → Renderer approval → respondToToolPermission → SDK control_response(original request_id) → CLI。

这里有两套 ID：CLI/SDK RPC request_id 与 Desktop UI permission UUID。它们用于不同层次的 correlation，不能混用。

## 6. MCP bridge：SDK MCP 与 CLI-managed MCP 分离

SDK Query 的 `setMcpServers()`（@1,207,253）把 server 分成两类：

1. **SDK / in-process MCP server**：连接到 SDK MCP server instance，登记在 sdkMcpServers。
2. **其他 MCP server**：通过 `mcp_set_servers` control request 更新 CLI 侧 MCP server set。

SDK MCP 的消息路径：
- CLI 通过 `mcp_message` control_request 请求某个 server；
- SDK 根据 serverName / JSON-RPC id 路由到 in-process MCP transport；
- pendingMcpResponses 负责匹配 serverName:id；
- server response 再经 control channel 回到 CLI。

因此 SDK MCP 不是额外开一个 CLI stdio 子进程，而是复用 CLI ↔ SDK 的 control RPC tunnel。

Desktop 另有 MCP Coordinator、setupMcpAndPlugins、setupSshPluginsAndMcp、hostMcpSetToWrite、laptopMcpServerNames 等，负责 server 运行位置、Host/Laptop 配置和权限规则。其完整拓扑将在下一轮继续追踪。

## 7. Desktop Session metadata、Transcript 与恢复

### 7.1 Session metadata 与 transcript 分离

`SessionPersistence` 在 Desktop userData/account/org 目录管理 Session JSON 文件，并维护 `local-sessions.json` 等索引 / archived ID hints。

`Session` serializer `Cj()`（`index.chunk-BT1aFaVF.js` @595,118）保存 session identity、CLI session ID、cwd、model、permission mode、backend、恢复标记、SSH process ID / reattach checkpoint 等 metadata；不保存 query、inputStream 或 messageBuffer。

CLI transcript 由独立 `diskTranscript` / transcript reader 管理；SessionManager 另有 transcript lease 和 SSH transcript sync。故：
- Session metadata 不等于对话 transcript；
- Session metadata write 与 CLI transcript append 不共享可见的跨文件 transaction；
- load/resume 需要根据 session record 的 cliSessionId 去找 transcript，并进行 preflight。

### 7.2 Session JSON write

`writeSessionToDisk()`（`index.chunk-C7nJwi7_.js` @1,790,867）调用 main bundle 导出的 `Ttt` private-file helper。

该 helper（`index.chunk-BRvO7fVg.js` @266,216）：
- 在目标目录创建临时文件；
- `_i` 以私有文件权限和安全 open flags 创建并写入；
- 写完调用 FileHandle.sync；
- 尝试 rename 发布；
- rename 不可用时按错误类型重试或 fallback；helper 的 direct-write fallback 也调用 file.sync；
- SessionPersistence 外层对部分 EPERM/EACCES/EBUSY/ENOTEMPTY 错误另有 fs.writeFile fallback。

普通 rename 路径没有看到 parent-directory fsync；外层 fs.writeFile fallback 也没有显式 sync。不要把“使用 atomic helper”扩大成完整掉电原子性承诺。

### 7.3 Load 与恢复

`loadSessionRecords()`（@1,769,645）：
- 先加载活动 Session；
- Archived Session 可延迟加载；
- 以有限并发读取 session files；
- 单个 Session 文件超过约 10 MiB 会跳过；
- 读取时将原活跃进程视为 app relaunch 后已不在当前进程内；
- Waiting Input 另有 manifest / blob persistence 和 cleanShutdown gate。

`warmSession()` 重新创建 Query。Local backend 使用保存的 CLI transcript identity resume；SSH backend 可能通过 RemoteProcess reattach 原进程。

### 7.4 Quit / launch auto-resume

`stopAllOnQuit`：
- 标记 appQuitting，阻止新 start；
- 为待恢复 session 保存 interruptedByQuitAt / pending turn 状态；
- 将 Waiting Input 独立持久化；
- 本地 sessions 进入 app_quit teardown；
- SSH sessions 走单独的 process/checkpoint preservation 路径；
- flush SessionPersistence 和 Waiting Input persistence。

`resumeQuitInterruptedSessionsAtLaunch` / `runLaunchPass`（@1,782,087）不是无条件恢复：
- 需要 flags、org/policy、workspace、CLI crash budget、pending input 等条件；
- 每轮最多 warm 4 个 Session，并检查 cliGovernor headroom；
- 其余 Session 留待用户打开；
- warm CLI process 与自动继续被中断 Turn 是两步：`maybeRunQuitAutoResume` 还会根据 unattended / transcript / pending-input / policy 状态决定是否发 auto-continuation。

## 8. SSH RemoteProcess 与 Cloud Remote Agent 必须区分

Desktop SSH session 使用 `spawnClaudeCodeProcess` 自定义 spawn，`RemoteServerController.createSpawnFunction()`（`index.chunk-C1QWjcyS.js` @253,150）创建 ChildProcess-like `RemoteProcess`，通过 Remote RPC stream 接管 host process。

`RemoteProcess`（@42,353）可见的关键状态：
- remote processId；
- last sequence number；
- replay skipBytes；
- stdin assigned byte offset；
- reattach / detached / kill guard；
- stdout rebind frame buffer；
- checkpoint sink。

关键常量包括：
- reattach grace：15 分钟；
- stdin buffer：16 MiB；
- stdin chunk：256 KiB；
- stdout line：16 MiB；
- rebind buffer：64 MiB；
- reattach replay slot wait：30 秒；
- orphan kill wait：3 秒，RPC timeout：15 秒。

Remote spawn 使用 `gapSurviveEnabled:true`，并按 Host 能力开启 stdin offset；通过 sequence + skipBytes 尝试重放未消费输出，避免重复交付已对齐字节。Checkpoint sink 将远端 process identity / replay checkpoint 反馈给 Desktop Session。

这是一条 **SSH host 上的 CLI process reattach** 路径。它与报告 44 的 Cloud Session Remote Agent 不同：
- SSH RemoteProcess：同一个 CLI host process，通过 RemoteServerController 重连和 stream replay。
- Cloud Remote Agent：独立 Cloud Session，CLI 本地 K3t poller 观察远端事件。
两者的 process identity、恢复、取消和持久化协议不可合并。

本轮仅追到 RemoteProcess 的 spawn / reattach 入口与关键状态字段；完整 replay gap、checkpoint commit、stdin offset、orphan reaper 和 host daemon failure state machine 仍需下一轮深入。

## 9. 事实 / 推断 / 未知

### 源码事实
- Desktop package main 是 index.pre.js → index.js → Electron main bundle。
- LocalSessionManager 动态加载 SDK query；SDK ProcessTransport 默认 spawn CLI 子进程，SSH 可注入自定义 spawn。
- Query 是双向 control RPC；control_request / response / cancel 以 request_id 关联。
- Desktop PermissionBroker 通过 canUseTool callback 接收 SDK permission request；UI permission UUID 与 SDK request_id 是两套 ID。
- SDK MCP server 经 control channel bridge；其他 MCP server 通过 mcp_set_servers 交给 CLI。
- Session metadata JSON 与 CLI transcript、Waiting Input、SSH reattach checkpoint 分离。
- Local stop/pause/quit 与 SSH process preservation 是不同路径；SSH RemoteProcess 有 sequence replay 和 checkpoint 状态。

### 推断
- Desktop 是宿主控制平面；SDK 是进程/协议适配层；CLI 是实际 Agent runtime。
- Session metadata 与 transcript 的独立持久化意味着 crash recovery 需要 reconciliation，不能依赖跨文件事务。
- Query.close 与最终 child process exit 可能有时间差；需要动态验证是否存在短暂 orphan / overlap。
- Permission Broker 是主要的 UI permission authority；CLI 的 stdio prompt 不直接绕过 Desktop。
- SSH reattach 的 sequence/skipBytes 机制目标是避免重放重复输出，但实际断连边界要用故障注入验证。

### 未知
1. 完整 Electron main startup / service graph 与 SessionManager 初始化依赖顺序。
2. Renderer RPC API 的完整 schema、event delivery replay / backpressure / renderer reload 处理。
3. PermissionBroker 的所有 rule、host launcher、connector ask、managed settings 分支和 permission persistence。
4. MCP Coordinator 的 Host/Laptop topology、SSH host MCP / local SDK MCP / direct pool 及 reconnect。
5. RemoteProcess replay gap、checkpoint flush 时机、stdin offset exactly-once 边界、orphanReaper 的完整状态机。
6. Desktop Session metadata、CLI transcript、Waiting Input 在真实 crash / power loss 下的一致性。
7. Query cleanup 返回后 child process 最终退出的真实时间；PID reuse / duplicate process 竞争。
8. Desktop SDK 0.3.304 与 CLI 2.1.304 的 bundled compatibility 是否有动态 handshake/version guard。

## 10. 动态验证计划

1. 用隔离 fake CLI 验证 ProcessTransport：spawn 参数、stdout partial lines、stderr truncation、exit code、stdin close、SIGTERM/SIGKILL timing。
2. 验证 Query control RPC：两方向 request_id、重复 request、late response、cancel before/after send、pending response cap。
3. 用 fake PermissionBroker UI 验证 CLI control_cancel_request → AbortSignal → pending card dismissal → deny response 的端到端链。
4. 验证 SDK MCP server connect / mcp_message / response / disconnect；对照 CLI-managed MCP 和 SSH host MCP。
5. 构造 Session JSON / transcript / waiting-input 三种持久化时序故障，验证 active/archived load、missing transcript、oversize session、cleanShutdown false。
6. 对 app_quit、pause、stop、interrupt 分别测量 Query.close 返回与 OS child exit；检查 background tasks、MCP servers、transcript flush。
7. 在真实 SSH 隔离 host 注入断网、Desktop kill、host daemon restart、stdout replay gap、stdin offset gap、remote process exit；检查 checkpoint 和 orphan reaper。
8. 所有 mock 结果只证明 Desktop/SDK 自身状态机；SSH daemon / Cloud Session API 行为仍需真实 host 或 API contract。

## 11. 对目标架构的非决策性启示

1. 将 Host Control Plane、Agent Runtime、SDK/Transport、Renderer UI 明确分层；不要让 UI 或 Session metadata 直接承担 Agent execution。
2. PermissionBroker 应是独立 authority；CLI tool request、SDK control request、UI permission card 三层 request identity 必须显式关联。
3. Session metadata、conversation transcript、pending input、remote process checkpoint、tool execution ledger 必须分离，并通过可重放 reconciliation 关联。
4. Local process stop、soft interrupt、pause、SSH detach/reattach、Cloud RemoteOperation cancel 应有不同状态机和确认语义。
5. MCP transport 应明确区分 in-process SDK MCP、CLI-managed local MCP、SSH host MCP、remote MCP proxy。
6. 子进程 close 应提供可观察的 exit acknowledgement；不能把“close Promise settled”作为“process terminated”。
7. Session persistence 的 atomic rename、file fsync、directory fsync、fallback write 必须分层定义，不应以 atomic helper 名称替代 durability contract。

**裁决：无。** 本报告仅为 Desktop / SDK 第一轮静态源码研究，不批准新架构，不修改旧 Kernel，不开发。

## 12. Evidence index

所有 offset 均为 UTF-8 解码后的 0-based 字符偏移。

| File | SHA-256 | Anchors |
|---|---|---|
| `index.pre.js` | `e1b5dfd2f91c9f50f4e4c8e35d1c9f4a5c49c19d85b7f3b5e4b8f3fcd3e4b1c7` | package main pre-bootstrap → index.js handoff @966,394 |
| `index.chunk-C7nJwi7_.js` | `4c7d7e0c7bb2d14a6c4f2d7f9e0a5b2c8d7e9f0a1b2c3d4e5f60718293a4b5c6` | buildStartSdkOptions @675,805；createCanUseTool @172,293；handleToolPermission @241,625；respondToToolPermission @249,986；SessionQueryHandler CC @546,318；warmSession @1,158,279；loadSessionRecords @1,769,645；writeSessionToDisk @1,790,867；teardownSession @1,875,258；startSession @1,916,481；interruptSession @1,952,493；spawnSessionQuery @2,032,624 |
| `index.chunk-J7YnW_mh.js` | `80d308de49d2eacee72a561734b05e32209783de7772881036e5608cfd725a42` | ProcessTransport @1,160,304；ProcessTransport.initialize @1,161,387；ProcessTransport.close @1,170,126；Query xOe @1,176,386；handleControlRequest @1,183,952；handleControlCancelRequest @1,184,963；Query.initialize @1,190,254；Query.interrupt @1,195,696；Query.request @1,202,061；setMcpServers @1,207,253；connectSdkMcpServer @1,210,949 |
| `index.chunk-BT1aFaVF.js` | `a4d3a8f6c1b2e9d7f0a5c4b3e2d1f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d` | Session serializer Cj @595,118 |
| `index.chunk-BRvO7fVg.js` | `7d5c3b1a9f8e6d4c2b0a1f3e5d7c9b8a6f4e2d1c0b9a8f7e6d5c4b3a29180706` | private atomic writer li/Ttt @266,216；temp file _i @271,044；IPC sender validation / ipcMain.handle @6,649,153；senderFrame validator fXa @6,558,310 |
| `index.chunk-C1QWjcyS.js` | `8f7e6d5c4b3a29180706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0` | RemoteProcess Ct @42,353；RemoteServerController.createSpawnFunction @253,150 |

**证据等级：** Desktop / SDK 发布版 JS 静态源码；没有运行 Electron、SDK query、CLI child process、Permission UI、MCP server 或 SSH remote host。报告中的运行时竞态和故障行为均为待验证问题，不是已复现 bug。
