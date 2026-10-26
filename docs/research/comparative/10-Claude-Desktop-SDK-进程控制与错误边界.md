# 10 · Claude Desktop 3.1623.1 / Agent SDK 的进程与控制错误边界

> 日期：2026-10-25；**直接只读**用户提供的 Desktop 3.1623.1 ZIP 内实际 JS，未运行 Electron/Claude CLI。本文补充 [新版核心复核](01-Claude-Code-2.1.304-新版复核.md)，聚焦 IPC 和 SDK 进程管理，尤其区分已经看到的路径与不能推断的 UI 调用关系。

## 1. 可复核的发行模块

原 ZIP：
`claude-agent-reverse-kit-desktop-3.1623.1-cli-2.1.304.zip`

具体位置为 `extracted-3.1623.1/asar/.vite/build/`。

| 文件 | SHA-256（解压字节） | 看到的作用 |
| --- | --- | --- |
| `index.chunk-J7YnW_mh.js` | `80d308de49d2eacee72a561734b05e32209783de7772881036e5608cfd725a42` | 内置 Agent SDK / ProcessTransport |
| `index.chunk-BRvO7fVg.js` | `1a87853c63ad0e52ffa69e2de27004dc0dfccfb5394f23f3daaf5829da6b7976` | Electron 主进程/本地会话事件与 IPC 封装 |

以下 `@N` 表示 JavaScript UTF-8 解码文本中的 **0 基字符偏移**；不是文件行号或原 TypeScript 名称。

## 2. ProcessTransport 是真实的 OS 子进程管理

`index.chunk-J7YnW_mh.js@1161387` 的 `spawnLocalProcess(e)` 调用 Node `child_process.spawn(command,args,{cwd,stdio:['pipe','pipe','pipe'],signal,env,windowsHide:true})`。

可直接确认：

- stdin、stdout、stderr 分为三个 Pipe；
- spawn 后 `onProcessSpawned(pid)` 回调仅用于发出进程信息，失败被 catch；
- `StringDecoder('utf8')` 解码 stderr，单独维护受限容量的尾部以供排障；
- 子进程 `exit` 与 stderr `close` 两种事件都跟踪，避免无限等待遗留文件描述符；存在退出等待定时器；
- SDK 保存 `pendingWrites`、`spawnReject`、`spawnResolve` 等连接准备阶段状态；
- `updateEnv` 与 `updateResume` 可改变后续进程配置。

**这证明 SDK 创建的 CLI 不是 JS 函数调用，而是独立进程边界**。但没有运行测试，所以不能断言所有 Electron Session 都必须使用该 Transport。

## 3. CLI 参数是直接代码事实，不只是 SDK README

`index.chunk-J7YnW_mh.js@1163372–1164200` 构造数组：`--output-format stream-json --verbose --input-format stream-json`。

按配置可能额外添加：

- `--max-turns`，`--max-budget-usd`，`--task-budget`；
- `--model`、`--agent`、`--effort`、`--betas`；
- Permission callback 存在时采用 `--permission-prompt-tool=stdio`；
- 代码对 `canUseTool` callback 和 `permissionPromptToolName` 同时配置报错，避免双重审批入口语义冲突。

这再次说明 **CLI 接口中可设置预算不等于所有运行模式实际默认启用硬预算**；另外多选项的覆盖优先级需要进一步审阅。

## 4. SDK 控制消息的分流与去重缓存

`index.chunk-J7YnW_mh.js@1176606` 可定位集成 SDK 查询对象的字段：

- `pendingControlResponses = new Map`
- `unmatchedControlResponses = new Map`
- `UNMATCHED_CONTROL_RESPONSES_MAX = 1024`
- `cancelControllers = new Map`
- `hookCallbacks = new Map`
- `inputStream`、`sessionState`、`resultReceived`、`runEnded` 等状态。

`@1181042–1181250` 实际流处理分支：

```text
stdout 解码的结构化消息
  ├─ control_response → 对应未完成请求 / 不匹配响应缓存
  ├─ control_request → handleControlRequest
  ├─ control_cancel_request → handleControlCancelRequest
  ├─ keep_alive → 保活/启动标记
  ├─ transcript_mirror → 复制传输队列
  ├─ system / metadata → 更新 SDK 输入流
  ├─ active_goal / autocompact_state → SDK 状态更新
  └─ 其他模型/工具/结果事件 → SDK 的消息消费者
```

**区别**：`request_id` 是控制消息相关性，不是可自动复用的长期审批授权；不匹配响应缓存也不意味着进程重启后永久去重。我们仍需要持久 `DecisionId` 和状态版本。

## 5. Electron IPC 的确有 senderFrame 校验，但还不是完整会话授权

`index.chunk-BRvO7fVg.js@6649153` 定义类似：

```text
removeHandler(channel)
ipcMain.handle(channel, (event,...args) => {
  if (!fXa(event.senderFrame)) throw Error('Invalid IPC sender')
  return handler(event,...args)
})
```

另有 `@6760504` 附近的相似封装。

可直接确认：

1. Electron 主进程存在绑定 IPC Handler 的统一包装；
2. 它在调用实际 handler 前验证 `senderFrame`；
3. 校验失败时拒绝执行 handler。

**不能直接确认**：

- `fXa` 的完整逻辑足以抵抗所有导航、窗口注入或 session 混淆问题；
- 哪个 Renderer UI 事件/按钮对应具体的 SDK `query()` 或 `spawnLocalProcess()`；
- 本地 Session 生命周期、授权状态与某个 IPC Channel 的关联总是正确；
- SDK 输出中的某项批准会直接更改 ToolHost 的 OS 权限。

上面不能确认的事项不能用“Electron IPC 已有校验”替代安全审计。

## 6. Desktop 还包含独立的错误类型归一化

`index.chunk-BRvO7fVg.js@959000–961000` 周边可见 SDK/进程失败相关的错误分类：

- 进程启动失败、找不到可执行文件、进程被信号杀死或非零退出；
- `EPIPE` / terminated process / stdin 写入失败；
- 控制请求失败；
- 模型响应未到达、部分流断开与网络等待故障；
- 还有 `error_result`、`aborted` 等来源标签。

**重要区别**：这只是存在的错误分类/匹配逻辑，不等于所有故障都可恢复、更不表示可以安全自动重试外部副作用。对于自研 Client 和 Kernel，应将 TransportError、ProviderError、ToolExecutionUnknown、PermissionDenied 分别建模，防止重试错误类别。

## 7. 自研适配协议的候选设计

```text
Renderer Client
   └─ Authenticated IPC Gateway (sender/frame/session/capability)
       └─ Agent Kernel API
           ├─ Session/Turn FSM
           ├─ Model Adapter
           ├─ Approval/Policy Root
           └─ Tool Host / Sandbox

Transport layer: stdio | HTTP+SSE | WebSocket
Protocol layer: version, requestId, sessionId, turnId, eventSequence, authScope
```

- renderer 不直接提交 “OS write allowed” 的未经验证事实；
- IPC 发送源的认证不是“审批批准”的同义词；
- 模型事件、控制消息与宿主执行回执采用不同 Schema；
- 对外 `interrupt` ACK 必须区分“请求已接受”和“工具/Turn 已终止”；
- 每个 Worker/Session 保留事件游标，在重连后可查询持久事实而不重执行工具；
- 启动参数和环境变量中的密钥必须由主进程/Host 管理，不能无审核透传给任意脚本。

## 8. 未完成的证据与下一次验证

1. 从 Renderer 具体入口定位 `ipcRenderer.invoke/send` 的 Channel，并找到它注册的 `ipcMain.handle` 处理器；
2. 从处理器进入 Desktop 本地 Session Manager，再找到调用 SDK `query()` 的逻辑和 Session Owner；
3. 逐条跟踪 `canUseTool`、取消、Resume 在所有层的双向回程；
4. 构建可复现的安全断线/重启实验，证明迟到响应不能复用批准；
5. 对 2.1.304 本地 CLI 子进程崩溃/沙箱失败做隔离条件下的故障测试。

**本轮进度**：SDK→CLI ProcessTransport 与主进程 senderFrame 保护已经在新版文件里直接确认。**UI→具体 IPC→SDK 的完整端到端调用链仍未研究透**，所以不能把此报告当成完成了 Desktop 整个本地 Agent 安全审计。
