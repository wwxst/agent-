# 50：Claude Desktop SDK Host Hooks、权限请求重交付与 Renderer 恢复边界（2026-10-30）

> 研究阶段：发布版 bundle 静态源码复核；未执行真实 Electron / SDK / CLI / renderer。  
> 样本：Claude Desktop 3.1623.1、配套 Claude CLI 2.1.304、bundle 内 SDK 0.3.304。  
> 承接报告 47–49：本报告闭环 Desktop 注入 SDK 的 canUseTool / Hooks / UserDialog callback、CLI control request 的取消与迟到响应、CLI reinitialize 时的 pending request redelivery，以及 renderer reload 的 host-side 恢复能力。  
> **本报告只增加研究文档；不修改业务代码、Kernel 或实现 PR。**

## 1. 证据范围与文件定位

本轮使用此前已校验的 source-only 分包。关键 bundle SHA-256：

| 文件 | SHA-256 |
|---|---|
| Desktop index.chunk-C7nJwi7_.js | f69b5dae07191e32fc528591aa741e9e3717127b19d52d3c463a32295d16cbe7 |
| Desktop index.chunk-BRvO7fVg.js | 1a87853c63ad0e52ffa69e2de27004dc0dfccfb5394f23f3daaf5829da6b7976 |
| Desktop mainView.js | 8c14a680d97dad8380e7144e6ebeb7dc5207c6410aefee4fc0759e61405c9d35 |
| CLI chunk-1vdc3qtt.js | b60ef02e1acaaa48ce2cbeb165233924032ce0fd4413f6d1d094043df794f975 |
| CLI chunk-dppj9h63.js | 9faf030683b68e755685df733aa68389157408e9af0aca099f053244f25a180f |
| CLI chunk-g9306b3w.js | 0a7c74ce263af17efda2c96eecd20c23c9119d6d05e2a0bd576eea138e419707 |
| CLI chunk-4b60tdnk.js | c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb |

定位采用 0-based 字符偏移和符号名。Desktop 的 main window index.html 明确写明除标题栏 / error UI 外，其余页面内容从 claude.ai 加载；因此 hosted renderer 的 React 应用源码不在本轮 source-only 包中。我们能核验 Electron main / preload 提供的接口，不能伪称已核验 hosted web client 的 reload 行为。

## 2. Desktop 如何把 Host callbacks 注入 SDK

### 2.1 buildStartSdkOptions 的 callback 面

Desktop 构建 SDK options 时，主要注入：

- canUseTool：由 ToolPermissionBroker.createCanUseTool(sessionId, cwd, ...) 提供；
- onUserDialog：由 UserDialogBroker.createOnUserDialog(sessionId) 提供；
- hooks：由 Session / PermissionBroker 的 createBaseHooks(sessionId) 提供；
- getOAuthToken；
- getHostAuthToken；
- 与 SSH / MCP / remote control 相关的其他 SDK options。

本轮未在 LocalAgentMode 的 buildStartSdkOptions 中找到 onElicitation property。SDK Query.processControlRequest 对 elicitation 的默认行为是没有 onElicitation callback 时返回 action=decline。Desktop main process 的 custom3p-mcp host 有单独的 elicitation IPC 处理，不能与 LocalAgentMode SDK Query 的 onElicitation 混为一谈。

### 2.2 Host callback tracking wrapper ti / ei

Desktop 用 ti(options, tracker) 包装 canUseTool、onUserDialog、getOAuthToken、getHostAuthToken，以及每一个 hook callback。

每次调用时：

1. Qr 在 Session.cliHostRequests Map 中创建一条记录，字段为 subtype / startedAt；
2. ei 从 callback 参数中寻找 AbortSignal；
3. callback 同步抛错、Promise resolve / reject 或 signal abort 时，移除 tracking record；
4. ni 可把仍未结束的 host request 类型和 age 暴露给 Session timeout diagnostics。

**这个 wrapper 是 observability，不是 cancellation。** 它在 signal abort 时移除 host-request tracking；不会强制终止底层 callback。底层 callback 是否停止，仍取决于它是否监听 AbortSignal 或由自己的 broker 结束。

### 2.3 Desktop Base Hooks 类型

createBaseHooks 在本轮 bundle 中注册的 SDK-host hook groups 包括：

- PreToolUse：项目目录 / workspace 写入边界、tool policy、MCP server/tool gate、unattended / side-session 等前置约束；
- PermissionDenied：权限拒绝后的状态清理 / 同意状态处理；
- Stop：将 CLI hook 生命周期与 Desktop Turn completion 状态同步；
- WorktreeCreate / WorktreeRemove：Desktop worktree 生命周期；
- SubagentStop：子 Agent 完成后的宿主收敛。

未在该 Base Hooks 返回对象中发现通用 PostToolUse hook group。CLI 自己的用户 / 项目 hooks 仍由 CLI hook loader 管理；Desktop SDK-host hooks 是另一来源。

SSH path 的部分 PreToolUse project-config-root fence 与 MCP gate hook 显式设置 timeout=30 秒；SSH Stop hook 显式设置 timeout=5 秒。其他未显式设置 timeout 的 callback 使用 CLI hook runner 默认 timeout。

## 3. SDK hook_callback 的注册、分发与取消

### 3.1 Hook callback ID 与 request ID 是不同层级

SDK Query.buildInitializeRequest 遍历 hooks payload，为每个 callback 生成 hook_callback_id（例如 hook_0），并在 Query.hookCallbacks Map 保存 callback 函数。Initialize payload 携带 matcher、hook callback IDs、timeout 等元数据。

CLI 执行 SDK-host hook 时，再发送一条 control_request：

- control request 有独立 request_id；
- request body 有 callback_id；
- 可带 tool_use_id / hook input；
- SDK Query 用 callback_id 查 hookCallbacks Map；
- Query.handleControlRequest 为 request_id 创建 AbortController；
- handleHookCallbacks 将 input、toolUseID 和 signal 交给对应 callback。

因此 Session ID、tool_use_id、CLI control request_id、SDK hook_callback_id、Desktop permission requestId 是不同身份，不应复用为同一个 ID。

### 3.2 CLI reinitialize 会替换 SDK-host hook generation

CLI reinitialize 时：

1. 检查本次是否由 hostOwnsStdin 的 SDK-host hook path 管理；
2. 调用 retireSdkHostHookCallbacks；
3. 增加 sdkHostHookGeneration；
4. 对仍 pending 的 hook_callback 请求发送 control_cancel_request；
5. 使用事件类型对应的 safe fallback resolve 旧 hook；
6. 移除已有 origin=sdkHost 的 hook entries；
7. 将新 initialize payload 中的 SDK-host hooks 重新注册；
8. 保留其他 origin 的 CLI hooks，不做全量覆盖。

CLI telemetry 会记录 host_hooks_resent、host_hooks_applied 和 settled_hook_callbacks 数量。

这说明 SDK-host hooks 是一个可替换的 generation，而不是可以无限叠加的 callback 列表。

### 3.3 Pending hook callback 不重放，而是 fail-safe settle

CLI 传给 retireSdkHostHookCallbacks 的 fallback 按 hook event 分类：

| Hook event | 旧 callback 未完成时的 fallback |
|---|---|
| PreToolUse | deny；说明旧 host reinitialize，工具没有执行，允许用户重试 |
| PreModelSwitch | deny；模型不切换，允许用户重试 |
| UserPromptSubmit | block，并 suppressOriginalPrompt；要求重新提交 prompt |
| UserPromptExpansion | block，并 suppressOriginalPrompt；要求重新提交 prompt |
| 其他 event | 空结果，不额外施加 decision |

因此 pending hook callback 与 pending user permission 的恢复策略不同：旧 hook decision 属于旧 host generation，不能在新宿主环境下继续作为有效判断；CLI 选择取消并按事件类型安全结算，再注册新一代 hooks。

## 4. Hook timeout 与 AbortSignal 的真实语义

CLI hook runner 对 SDK callback hook 读取 per-hook timeout；若存在 timeout，按秒乘 1000 转成 timeoutMs，否则使用 CLI 默认值。它创建与父 AbortSignal 关联的 timeout signal，再将 signal 传给 SDK Query 的 hook_callback request。

不同事件的超时结果并不相同：

- **PreToolUse：** timeout 会记录 tengu_sdk_hook_callback_timeout。若之前已有明确 permission result，保留该结果；否则 defer 当前 deferred hook，或 stop 当前 tool call。该路径不是 fail-open allow。
- **UserPromptSubmit / UserPromptExpansion：** SDK-host callback timeout 会形成 blockingError，并 suppressOriginalPrompt，避免未经宿主 hook 检查的原始 prompt 继续进入。
- **Stop / SubagentStop / SessionStart：** SDK-host callback timeout 可继续执行而不等待旧 answer；对部分主 Session Stop 会追加 hook system message。
- **control stream closed / parent abort：** 作为 cancelled 路径处理，不伪装成普通 hook timeout。
- **其他 hook event：** 由外层 hook event runner 的错误策略处理，不能一概归为 continue 或 deny。

Desktop 为 SSH 的 PreToolUse policy / MCP gate 显式给出 30 秒，为 SSH Stop hook 显式给出 5 秒。CLI timeout signal 会触发 SDK control_cancel_request；SDK Query 收到后 abort 对应 callback signal。

### 4.1 Signal cancellation 不保证任意 callback 代码立即停止

SDK Query.handleControlCancelRequest 会找到 request_id 对应 AbortController，abort 并从 cancelControllers Map 删除。

Desktop 的 ti / ei wrapper 监听 signal 并移除 outstanding-host-request tracking；canUseTool 的 handleToolPermission 与 UserDialogBroker 会进一步监听 signal 并撤销 pending UI request。

但部分 Base Hook callback 是闭包函数，未必显式读取第三个参数中的 signal。对不消费 signal 的 callback，底层异步工作可能继续执行；CLI 已取消该 request，并不会等待它自然结束。其迟到响应走后述 unknown-response 路径。是否还有其他 callback side effect，需要逐类动态验证。

## 5. CLI reinitialize 时，哪些 pending requests 会重交付

### 5.1 Initialize response 的两类 pending arrays

CLI 2.1.304 的 reinitialize 分支从 ControlRequestManager 读取：

- getPendingPermissionRequests：只筛选 subtype=can_use_tool；
- getPendingUserDialogRequests：只筛选 subtype=request_user_dialog。

它们作为 pending_permission_requests 与 pending_user_dialog_requests 放入 initialize control_response。

SDK Query 收到 initialize response 后：

- processPendingPermissionRequests 只处理 can_use_tool，并将 server_policy_ask_only 设为 undefined 后重新进入 handleControlRequest；
- processPendingUserDialogRequests 只处理 request_user_dialog，重新进入 handleControlRequest。

Query.handleControlRequest 会检查 cancelControllers 是否已有同 request_id 的 in-flight request。若同一个 Query 对象仍持有该 request，则记录 duplicate delivery 并跳过，避免同一 host broker 重复创建 UI card；若是新 Query，则建立新的 AbortController 并调用新的 host callback。

### 5.2 Pending request 类型矩阵

| 请求类型 | reinitialize 时的处理 | 证据边界 |
|---|---|---|
| can_use_tool | 重交付给 SDK / Desktop canUseTool | 明确在 pending_permission_requests |
| request_user_dialog | 重交付给 SDK / Desktop onUserDialog | 明确在 pending_user_dialog_requests |
| hook_callback | 不重交付；cancel + safe fallback settle，再注册新 generation | 明确在 retireSdkHostHookCallbacks |
| elicitation | 不在上述两个 pending arrays 中 | LocalAgentMode builder 未发现 onElicitation；SDK 无 handler 时默认 decline。custom3p-mcp 有独立 elicitation IPC |
| mcp_message | 不在上述两个 pending arrays 中 | MCP transport / server lifecycle 另有自己的状态，不应推断为 host callback replay |
| oauth_token_refresh / host_auth_token_refresh | 不在上述两个 pending arrays 中 | 本轮未发现 reinitialize pending replay；按普通 callback cancellation 处理 |

这不是“所有 control request 都可靠重放”。只有 CLI 明确筛选的两类 human-facing requests 会从 initialize response 回到 SDK。

## 6. Pending request、Abort 与迟到响应

### 6.1 SDK Query 侧

handleControlRequest：

- Query 已 cleanup：忽略 request；
- 同 request_id 已在 cancelControllers：忽略 duplicate delivery；
- 否则创建 AbortController 并调用 processControlRequest；
- callback 返回 sentinel null：保持 unanswered；
- 正常结果：发送 control_response success；
- 抛错：发送 control_response error；
- finally：若 Map 中仍是该 controller，移除。

handleControlCancelRequest 只 abort 并删除 controller。单独 cancel 时，handleControlRequest 在 callback Promise 返回后并没有统一的 signal.aborted / Map identity 检查；若 callback 不消费 signal，可能仍尝试写迟到 control_response。

Query cleanup 则不同：cleanupPerformed=true 后，后续 callback completion 不再发送 response；同时 abort 所有 cancelControllers、清空 hookCallbacks、reject pending control responses、关闭 MCP transports。

### 6.2 CLI ControlRequestManager 侧

CLI sendRequest 在 AbortSignal abort 时：

1. enqueue control_cancel_request；
2. 删除 pendingRequests 中对应 request_id；
3. 拒绝原 Promise；
4. 清理 abort listener。

若迟到 control_response 到达，CLI 找不到 pending request，会进入 settleUnknownResponse：

- 已 timeout 的 request_user_dialog late answer 被忽略并记录 telemetry；
- 已 resolved toolUseId 的 duplicate response 被忽略；
- 其他 unmatched response 交给 unclaimedResponseObserver 或 unexpectedResponseCallback，不会重新 settle 原 pending Promise。

因此 host callback 可能在取消后仍有少量异步工作，但迟到响应不能直接恢复已经被 CLI 删除的原 pending request。副作用是否已发生仍由 callback 本身决定，AbortSignal 不是事务回滚。

## 7. ToolPermissionBroker 与 UserDialogBroker 的不同等待策略

### 7.1 ToolPermissionBroker

canUseTool 最终进入 ToolPermissionBroker.handleToolPermission：

- 生成 Desktop 自己的随机 requestId；
- 将 sessionId、toolName、input、suggestions、decisionReason、onlyOnCard、noAllowOnNotification 等放入 pendingPermissions Map；
- 发出 tool_permission_request；
- 监听 SDK AbortSignal；abort 时 dismiss pending card、settle sink prompt、resolve deny；
- 用户响应后校验 requestId 仍 pending、卡片来源限制、输入修改、always / scheduled policy 等，再 resolve SDK callback。

这里的 Desktop requestId 与 CLI control request_id 是两个独立 ID。CLI redelivery 可以保留 CLI request_id，但新 Query / 新 broker callback 会建立新的 Desktop UI requestId。

ToolPermissionBroker 的 5 分钟 timer 是 stall telemetry，不是自动 deny / 自动 settle。另有约 30 分钟的 renotify timer；只有 feature flag 开启、context token 达到约 100k 且 Session 可见等条件满足才尝试重新提示；约 1 小时会被标为 overdue。未发现普通 pending permission 在 5 分钟后自动失效的逻辑。它主要由 user response、AbortSignal 或 clearPendingPermissions 结束。

getPendingRequestsForSession 从内存 Map 构造 pendingToolPermissions，并根据当前 Session permission state 重新计算 suggestions；这不是直接从 Session JSON 读取旧 suggestion。

### 7.2 UserDialogBroker

UserDialogBroker.createOnUserDialog 只接受受支持的 dialog kinds，例如 refusal_fallback_prompt、auto_mode_server_fallback、lanyard consent、violin-bow prompt。

- 每个 prompt 生成独立 promptId；
- malformed / unsupported payload 返回 cancelled；
- AbortSignal abort 会 settle cancelled；
- 用户响应会 settle completed；
- response timeout 约 5 分钟，到期自动 cancelled；
- confirmAnswer 正在异步执行时会暂缓 / 重置 timer；若 prompt 已经 settle，迟到 confirm answer 会被丢弃。

UserDialogBroker 与 ToolPermissionBroker 不能共享同一个 timeout 假设：前者有 5 分钟自动取消，后者的 5 分钟主要是 stall telemetry。

## 8. Renderer reload：Host 有 snapshot 恢复入口，但 hosted UI 行为未知

### 8.1 Session snapshot 包含 pending UI state

LocalSessionManager 的 SessionViewRecord 会在构造 view snapshot 时读取：

- pendingToolPermissions：PermissionBroker.getPendingRequestsForSession；
- pendingRefusalFallbackPrompt；
- pendingAutoModeServerFallbackPrompt；
- pendingLanyardConsent；
- pendingViolinBowPrompt。

因此 pending permission / user dialog 是 Session view 的一部分。它们由当前 in-memory broker map 计算，不是从 Session JSON 直接持久化。

### 8.2 EIPC 暴露 snapshot API 与 event API

LocalAgentModeSessions contract / mainView preload 暴露：

- getAll；
- getSession；
- getTranscript / getTranscriptRead；
- respondToToolPermission；
- onEvent；
- onToolPermissionRequest。

main process 把 onEvent / onToolPermissionRequest 通过 webContents dispatcher 发给 mainView。可见路径没有 event ack、consumer cursor 或断线 replay。

### 8.3 Renderer reload 能力的证据边界

Host 提供 getAll / getSession snapshot，且 snapshot 包含 pendingToolPermissions 与 pending user dialog state，因此具备 reload 后重新 hydrate 的数据接口。

但 main_window/index.html 明确指出主 UI 内容从 claude.ai 加载；该 hosted renderer app 不在 source-only package 中。本轮无法证明 web client 在每次 reload / did-finish-load 后一定调用 getAll / getSession，也无法证明所有 pending card UI 都从 snapshot 重新构建。

ToolPermissionBroker 的 10.25 秒 session update 与约 30 分钟条件性 renotify 只能视为补充通知，不是可靠 event replay。准确结论是：**Host-side snapshot recovery surface exists；hosted renderer 是否正确使用它，当前未知。**

## 9. Local / SSH / Renderer 恢复矩阵

| 场景 | Permission request | User dialog | SDK-host hook |
|---|---|---|---|
| Renderer reload，main process / Query 未变 | Broker Map 保留；getAll / getSession snapshot 可重新取到 | Broker Map 保留；snapshot 可重新取到 | Query callback map 保留；未完成 callback 仍在原 Query |
| SSH Desktop app restart，远端 CLI process 保留 | CLI reinitialize 返回 can_use_tool；新 SDK Query 重建 Broker pending | CLI reinitialize 返回 request_user_dialog；新 UserDialogBroker 重建 prompt | 旧 hook generation cancel + safe fallback；新 hooks 重新注册 |
| SSH transport rebind，原 Query 保留 | 原 cancelControllers / Broker pending 保留；重复 request_id 被 SDK 去重 | 同上 | 原 hook callback Map / Query 仍在；若 CLI reinitialize，则按 generation retirement 处理 |
| Local Desktop app quit | Query cleanup abort pending；本地 CLI process 关闭，不具备跨进程 reinit redelivery | abort / cleanup 取消 pending | Query cleanup abort callback，hookCallbacks 清空 |
| CLI reinitialize，same Query | 同 request_id duplicate delivery 被跳过 | 同 request_id duplicate delivery 被跳过 | 旧 generation pending hook callback 被 CLI 安全结算后重新注册 |

这里的 “SSH app restart redelivery” 依赖报告 48–49 已确认的 SSH process adoption / app quit preserve 路径。若远端 process 不存在或不能 adoption，则不适用。

## 10. 事实 / 推断 / 未知

### 源码事实

- Desktop buildStartSdkOptions 注入 canUseTool、onUserDialog、Hooks、OAuth / Host Auth callbacks，并用 ti / ei 包装 tracking。
- SDK Query 为 Hook callbacks 建立 callback_id Map；CLI hook_callback request 另有 request_id。
- CLI reinitialize 只将 can_use_tool 与 request_user_dialog 放入两个 pending arrays。
- CLI reinitialize 会 retire SDK-host hook generation，向 pending hook_callback 发 control_cancel_request，并使用 PreToolUse / PreModelSwitch deny、UserPromptSubmit / Expansion block 等 fallback。
- SDK Query cancel 会 abort 对应 AbortController；cleanup 会 abort 全部 pending callbacks 并清空 hook callback map。
- CLI sendRequest abort 会发送 control_cancel_request 并删除 pending request；迟到 response 进入 unknown-response handling。
- Desktop ToolPermissionBroker 的 5 分钟 timer 是 stall telemetry；UserDialogBroker 有约 5 分钟 response timeout。
- SessionViewRecord 包含 pendingToolPermissions 与 pending user dialog snapshots；EIPC 提供 getAll / getSession 和 event APIs。
- hosted main UI 从 claude.ai 加载，不在本轮 source-only package 中。

### 推断 / 风险（未动态验证）

- 对不消费 AbortSignal 的 Desktop hook callback，CLI 可能已取消等待，但宿主异步工作仍继续；其迟到响应不会 settle 原 CLI pending request，但回调副作用仍可能发生。
- Renderer reload 的正确恢复依赖 hosted web client 读取 snapshot；Host 侧有接口，不代表 UI 一定实现完整 rehydrate。
- SSH app restart 的 pending permission 重交付是有条件的：远端 CLI process 必须仍存在且 adoption 成功。
- MCP elicitation 不在这两类 pending arrays 中；若存在跨 reinitialize 的 in-flight elicitation，需要另查其 server-side lifecycle。

### 未知 / 资料缺口

- hosted claude.ai renderer 在 reload / reconnect 时调用 getAll / getSession 的具体时序与覆盖率。
- MCP elicitation / custom3p-mcp elicitation 在 Desktop restart / renderer reload 下的完整恢复。
- 所有 Desktop Base Hook callback 是否消费 AbortSignal，以及取消后仍运行的异步副作用。
- CLI default SDK callback hook timeout 常量的来源与所有 event 类型的完整 timeout matrix。
- Native / SSH helper / process job 的实现语义，以及真实 Electron / CLI / MCP 进程重启测试。
- 本轮没有执行真实 UI、用户审批、Hook timeout、transport reconnect 或 crash injection。

## 11. 对目标 Agent 架构的非决策性启示

1. **区分 callback generation 与 request identity：** Hook callback ID、control request ID、permission request ID、prompt ID、toolUseID、Session ID 各自负责不同层级。
2. **重连时按语义分类：** human approval 可重交付；旧 policy hook 不应直接重放，应取消并 fail-safe settle；UI event 仅作唤醒信号，snapshot 才是当前状态读取入口。
3. **超时必须按 callback class 定义：** PreToolUse fail-closed、Prompt submit block、Stop 类 best-effort、human approval 长等待、user dialog bounded timeout，不能统一套一个 timeout。
4. **AbortSignal 不是回滚：** callback 必须声明取消语义；有副作用的 callback 需要 operation ID、可撤销状态或 late-result fencing。
5. **pending UI state 应可查询：** event 无 ack/cursor 时，必须有 session snapshot、request ID、response idempotency 与 reload hydrate 协议。
6. **重交付需要幂等：** 同一个 CLI request_id 重交付不应创建重复审批；UI request ID 与 CLI request ID 应通过显式 correlation record 关联。
7. **安全默认结果要按事件定义：** 旧权限检查不应默认为 allow；旧 prompt hook 不应让未检查 prompt 继续提交。

以上是设计输入，不是已批准架构决策。

## 12. 下一步

1. Desktop / SDK 报告 47–50 已覆盖启动、双向协议、RemoteProcess adoption、MCP / permission、local process、Idle、quit、Session restore、Host callback、Hook generation 与 pending request redelivery。
2. 若能获取 hosted renderer 源码 / 可执行环境，核验 renderer reload 的 getAll / getSession hydrate；否则将其保持为 host-side capability + client behavior unknown。
3. 继续查 MCP elicitation / custom3p-mcp 的独立 request lifecycle 与重连语义；不把它误归类为 request_user_dialog。
4. 固定 Pi Agent Core 上游 commit 与实际发布包，核验包与源码一致性后研究 loop、event、tool、context、session、extension、cancel 和错误恢复。
5. 完成 Claude CLI、Desktop / SDK、Pi 的同场景矩阵后，再独立设计目标架构并交用户审阅。明确批准前不进入开发。

## 13. 本轮边界

本报告只新增研究文档与进度记录。没有新增 Agent loop、adapter、tool executor、Session store 或 Kernel 实现；没有修改业务代码；没有提交开发 PR。

## 14. Evidence index

所有 offset 均为 UTF-8 解码后的 0-based 字符偏移。

| File | SHA-256 | Anchors |
|---|---|---|
| Desktop index.chunk-C7nJwi7_.js | f69b5dae07191e32fc528591aa741e9e3717127b19d52d3c463a32295d16cbe7 | ti / ei tracking wrapper @58,577 / @58,809；createCanUseTool @172,293；createBaseHooks @218,917；handleToolPermission @241,631；getPendingRequestsForSession @167,421；renotifyPendingCard @166,507；createOnUserDialog @1,595,654；SessionViewRecord pending UI snapshot @1,308,577 |
| Desktop index.chunk-BRvO7fVg.js | 1a87853c63ad0e52ffa69e2de27004dc0dfccfb5394f23f3daaf5829da6b7976 | LocalAgentModeSessions EIPC contract @1,964,415；event forwarding @244,368；onToolPermissionRequest dispatch @1,971,211；main window trusted-origin guard @2,012,533 |
| Desktop mainView.js | 8c14a680d97dad8380e7144e6ebeb7dc5207c6410aefee4fc0759e61405c9d35 | getSession @156,316；getAll @156,516；onOnEvent @167,693；onOnToolPermissionRequest @167,833 |
| CLI chunk-1vdc3qtt.js | b60ef02e1acaaa48ce2cbeb165233924032ce0fd4413f6d1d094043df794f975 | hook fail-safe iP @431,742；sdkHost hook replace t_ @432,345；reinitialize q0 @736,684；pending arrays @738,005 / @738,036 |
| CLI chunk-dppj9h63.js | 9faf030683b68e755685df733aa68389157408e9af0aca099f053244f25a180f | handleControlRequest @30,738；handleControlCancelRequest @30,819；processPendingPermissionRequests @52,062；processPendingUserDialogRequests @52,252；handleHookCallbacks @36,954 |
| CLI chunk-g9306b3w.js | 0a7c74ce263af17efda2c96eecd20c23c9119d6d05e2a0bd576eea138e419707 | getPendingPermissionRequests @14,413；getPendingUserDialogRequests @14,561；retireSdkHostHookCallbacks @15,309；settleUnknownResponse @27,383；sendRequest @31,738；createHookCallback @34,825；enqueueCancelRequest @44,302 |
| CLI chunk-4b60tdnk.js | c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb | SDK hook callback runner CFr @3,567,890；SDK host callback timeout @3,575,141；PreToolUse timeout handling @3,935,880 |

**证据等级：** 发布版 JS 静态源码；没有执行 Electron、renderer、用户审批、Hook timeout、MCP elicitation 或 crash injection。所有 callback side-effect / renderer reload 风险均为待验证边界，不是已复现 bug。