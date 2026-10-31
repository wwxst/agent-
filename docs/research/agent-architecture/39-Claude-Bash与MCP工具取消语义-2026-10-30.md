# 39 · Claude CLI Bash 与 MCP 工具取消语义

> 日期：2026-10-30  
> 样本：Claude Code CLI 2.1.304 发布版 JavaScript。  
> 方法：直接检查 01-cli-source-only.zip 中的 Bash runner、MCP SDK、Claude MCP adapter；**静态源码研究**，未运行真实 Shell/MCP server，未注入进程/网络故障。  
> 前置：[报告 36](./36-Claude-CLI写入失败与流式Fallback收敛-2026-10-29.md)、[报告 38](./38-Claude-CLI远程工具取消与执行账本收敛-2026-10-30.md)。

## 0. 本轮结论

本轮继续报告 38 的下一项，追踪 abort signal 到具体工具 executor：

1. **前台 Bash**：signal 到达 Bash runner 后，默认进入进程终止流程；先尝试 SIGTERM，约 1.5 秒后仍未退出则尝试 SIGKILL 进程组。Windows 路径使用 taskkill 的进程树强制终止。
2. **Bash 后台任务**：background() 会移除原 AbortSignal listener；后台化后该次工具调用的取消不再终止它。这是明确的生命周期分离，不应当作取消失败。
3. **MCP 普通工具调用**：MCP Client 的 Protocol.request 在 AbortSignal 触发时发送 notifications/cancelled；使用同一 SDK 的 MCP Server 会按 requestId abort handler signal。它是协作式取消，不是客户端强制杀掉服务器进程。
4. **MCP Task 工具**：取得 task handle 后若原 signal 已 abort，Claude 会 best-effort 发送 tasks/cancel；SDK 的默认 task handler 更新 task status 并清空 task message queue，但这本身不证明底层任务进程已经终止。
5. Claude MCP adapter 对未知 timeout/connection/protocol failure 明确提示工具可能已运行并产生副作用；只有认证/consent 等明确拒绝路径才报告 did not run。

与报告 38 合并后，当前证据支持一个重要区分：**Bash foreground 是进程级终止尝试；MCP 是协议级协作取消；background task 是独立生命周期。三者都不提供外部副作用回滚。**

## 1. Bash runner：从 AbortSignal 到进程树

关键模块：01-cli-engine/cli-2.1.304/modules/chunk-4b60tdnk.js。

### 1.1 启动前与启动后是不同路径

- Bash runner 在 spawn 前检查 signal.aborted；若已经取消，返回特殊的 tEt 结果，状态 killed、exit code 145、stderr 为 “Command aborted before execution”，不会创建子进程。
- 正常路径使用 spawn（别名 RRr），传入 detached: nn.detached，并把本次工具的 AbortSignal 交给 LFe。
- LFe 构造时注册一次性 abort listener；若 signal 在构造时已经 aborted，也立即处理。

因此，spawn 前取消可以明确判定没有启动 Shell 进程；spawn 后取消则进入实际 kill 流程。

### 1.2 前台进程终止

LFe 的 abort handler：

- 读取 AbortSignal.reason；
- 对少数特定 reason/scope 组合保留进程；其他 reason 调用 kill()；
- streaming_fallback 和 remote-cancel 不属于源码中的 turn-abort / permission-stop 豁免条件，也不是 interrupt 的 feature-gated 特例，因此走正常 kill 路径。

LFe.kill() / #E：

1. 将 command 状态改为 killed；
2. 调用 bS(pid, "SIGTERM")；
3. 等待 iao = 1,500 ms；
4. 若进程仍未退出，在非 Windows 路径尝试 process.kill(-pid, "SIGKILL")，即向进程组发送强制终止；
5. 另行运行清理/等待流程，并将 kill backstop Promise 放入 ShellCommandManager.pendingKillBackstops。

Windows helper bS 使用 taskkill.exe /PID pid /T /F；taskkill 启动失败时回退到 process.kill(pid)。因此 Windows 的进程树终止方式与 POSIX 进程组方式不同。

ShellCommandManager 的 CPt() 会等待 pendingKillBackstops；ENn() 在退出收束时对 status === "running" 的 live shell commands 调用 kill()。这些机制是进程清理，不是副作用事务回滚。

### 1.3 完成、后台化与 detach

- 子进程 exit/error 使 LFe 完成结果；#M 会移除 AbortSignal listener，并从 liveShellCommands 删除该命令。命令已完成后，之后的 abort 不会撤销它。
- background(taskId) 会把状态改为 backgrounded，调用 #C() 清理 abort listener，并按需把输出 spill 到磁盘。后台任务此后不再受原 per-tool AbortSignal 控制。
- timeout handler 若配置了 background callback，可以选择 background()，而不是 kill()。
- detach() 会将进程 unref 并从 liveShellCommands 移除。
- 结果可以带 backgroundTaskId；如果命令 leader 退出但进程组仍存在，还可能带 leftRunningPgid。

因此，报告 38 的 fallback abort 对**仍在 running 的前台 Bash**通常能触发进程终止；对已 backgrounded/detached 的命令，原工具调用 signal 不再是控制它的生命周期入口。若模型 attempt 已收到 backgroundTaskId 后被 tombstone，后台任务仍可能继续，而 task ID 可能随该 attempt 的结果一起从模型上下文撤回。

### 1.4 副作用边界

即使 SIGTERM/SIGKILL 成功，也只能说明相应进程收到终止信号或已退出，不能回滚：
- 终止前已经写入的文件；
- 已发送的 HTTP/API 请求；
- 已提交的数据库事务；
- 子进程已完成的外部操作。

另外，Bash runner 发现进程 leader 退出但 process group 仍存在时会返回 leftRunningPgid；这是一项残留进程提示，不等于自动确认所有 descendant 均已结束。

## 2. MCP 普通工具：协议级协作取消

### 2.1 Client 发送 notifications/cancelled

MCP SDK 的 Protocol.request（chunk-65j2vryd.js @21,675）接收 AbortSignal。signal abort 时：

- 删除本地 response handler；
- 向 transport 发送 notifications/cancelled；
- notification params 带 requestId 和 reason；
- 本地 request Promise 以 RequestCancelled 拒绝。

Client.callTool（chunk-9028y7x6.js @29,357）经 Protocol.request 发送 tools/call，因此 Claude adapter 传入的 signal 会走这条取消协议。

### 2.2 Server 将取消转成 handler AbortSignal

同一 SDK 的 Server Protocol：

- 为每个 requestId 创建 AbortController，并存入 _requestHandlerAbortControllers；
- 将 signal 放入 RequestHandlerExtra，交给 request handler；
- _oncancel（chunk-65j2vryd.js @14,795）收到 notifications/cancelled 后，根据 requestId abort 对应 controller；
- 如果 handler 在 signal aborted 后才完成，SDK 不再发送正常 response。

这是明确的 request-level cancellation propagation。但 SDK 不会替任意第三方 server 杀掉 OS process；handler 和底层工具必须检查/响应 signal。外部 MCP Server 不使用该 SDK或忽略 signal 时，客户端无法保证其停止。

### 2.3 Claude adapter 的错误分类

- MCP Client callTool（chunk-9028y7x6.js @29,357）和主工具包装 Ht（@144,275）都传递 signal、timeout 和 progress callback。
- Claude 的 MCP passthrough J9o（chunk-es22j4tw.js @11,426）把 per-tool AbortSignal 与 timeout 传给 connected client。
- We（@12,143）区分：
  - 明确的 URL consent/auth refusal：作为 refused/not_served，说明调用没有运行；
  - MCP server 返回的工具错误：说明请求已经到达 server，可能已经产生副作用；
  - timeout、连接丢失或 protocol error 等无法确认结果：说明工具可能已经运行并产生副作用。

这与报告 38 的 Host 侧 ranNothing / delivery_unknown 语义相吻合：MCP 客户端取消通知不等于服务器确认“未运行”。

## 3. MCP Task：task cancellation 与 request cancellation 分开

现代 MCP task 路径（chunk-je35d7v1.js）有两层：

- 在 callTool 尚未返回 task handle 时，原 request signal 仍走普通 notifications/cancelled。
- 若 callTool 返回 task handle 后发现原 signal 已 aborted，Claude 会 best-effort 发 tasks/cancel(taskId)，使用单独的短 timeout signal；取消请求失败会被 catch，原 task handle 仍可能存在。
- 若返回 malformed task handle，Claude 会在 taskId 可解析时尝试 tasks/cancel，并明确提示 server 可能仍在运行，重复调用可能再启动一个 task。
- 若 task 被纳入后台 task registry，则由独立的 driveAbort / background driver 管理，不再等同于原 tool-use leg 的生命周期。

MCP SDK 的默认 tasks/cancel handler（chunk-65j2vryd.js @约14,042）会检查 task 是否存在/是否已处于 terminal status，更新状态为 cancelled，并清空 task message queue；它不等同于向底层外部程序发送 SIGTERM。具体 task executor 是否响应、如何停止，取决于 server task implementation。

## 4. 与报告 38 的结合

| 工具形态 | 取消信号最终到达 | 停止机制 | 仍然存在的风险 |
|---|---|---|---|
| Bash foreground | LFe AbortSignal listener | SIGTERM → 约 1.5 秒后尝试 SIGKILL process group；Windows taskkill /T /F | 已提交副作用不可回滚；进程组外/已脱离子进程需单独核验 |
| Bash background/detached | 原 listener 被移除 | 独立 background task lifecycle | 原 attempt 被 tombstone 后任务仍可继续，task ID 可能不再在模型上下文中 |
| MCP 普通 call | notifications/cancelled → Server handler signal | server handler 协作式取消 | 第三方 server 可能忽略 signal；客户端没有执行终止确认 |
| MCP Task | tasks/cancel(taskId) 或 task driver signal | task status/queue 与 executor 自身取消逻辑 | task status cancelled 不证明实际 work 已停 |

报告 38 的 caller-accounting 风险仍然成立：直接 cancelled transport outcome 没有进入 m_e given-up queue，而 Host wrapper 在 signal aborted 时 suppress response。现在可以更具体地说明其后果：
- Bash foreground 可能收到 kill，但 kill 前副作用仍可能存在；
- Bash background 可能完全脱离该 signal；
- MCP server 可能收到 cancellation notification，却不一定停止工作；
- task cancellation 可能只更新 task 状态，实际执行停止依赖 task executor。

## 5. 证据索引

| 文件 | SHA-256 | 关键锚点（0 基字符 offset） |
|---|---|---|
| chunk-4b60tdnk.js | c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb | LFe @253,035；abort handler #b @253,733；result cleanup #M @254,864；kill #E @256,121；background @256,916；timeout escalation 1,500 ms @250,983；Bash spawn @3,164,397；Shell manager CPt/ENn @251,128/251,208；reason scope helper sNn @190,594 |
| chunk-pp4ckfw0.js | ec68aebe632643fff5ca3515f0aa3adf7a3d32d62fa740d188544615c62c4074 | Windows process-tree helper bS @1,064 |
| chunk-65j2vryd.js | 2f24dd657f389ff5ea103da1ab84ab1d32b07b023cd2c81b0370e7f9aea1af64 | Server _oncancel @14,795；handler AbortController + RequestHandlerExtra.signal @17,576；Protocol.request @21,675；notifications/cancelled @22,500；tasks/cancel handler @约14,042 |
| chunk-9028y7x6.js | 2dbac4f6e895171c7e0963ef686791a9d48c64dff6970191c3fccd6788d22dc3 | Client.callTool @29,357；main MCP tool wrapper Ht @144,275 |
| chunk-es22j4tw.js | df1c3d3a3e3b53e2afca0a15d317364ecbea3147b20c72853b58cf22e451551f | MCP passthrough J9o @11,426；error classification We @12,143 |
| chunk-je35d7v1.js | 4bc1488c39df4dcf511282cf71830789f4fe8fa9a182aa40b27c24f08aeec4c8 | MCP task driver co @181,105；tasks/cancel after task handle @184,666 |

## 6. 事实 / 推断 / 未知

**事实：**
- Bash foreground runner has a signal listener and explicit process termination escalation; background() removes that listener.
- MCP Protocol.request sends notifications/cancelled; SDK server maps it to request-handler AbortController.
- Claude MCP adapters pass AbortSignal and timeout, and classify ambiguous downstream failures as possibly having side effects.
- MCP task cancellation is a separate taskId-level operation.

**推断 / 风险：**
- A tombstoned model attempt may leave a background Bash task or uncooperative MCP task running without its task ID/outcome in the active model context.
- Even for foreground Bash, kill success does not make partial external side effects safe to repeat.
- Therefore caller-side direct-cancel accounting is especially important for background and MCP tasks.

**未知：**
1. Bash backgroundTaskId and MCP task registry survive exactly which process/session restart boundaries, and how the model re-discovers them after attempt tombstone.
2. Third-party MCP servers actually honor RequestHandlerExtra.signal; no real server was tested.
3. For task status cancelled, whether the task implementation stopped the actual process or merely stopped polling/queue delivery.
4. Whether another CLI notice/recovery path surfaces background task IDs after fallback tombstones.

## 7. 下一步

1. Trace background Bash task registry, output retrieval and task IDs across fallback/turn abort/session restart.
2. Trace MCP task registry persistence, driveAbort, polling and cancellation after model attempt abandonment.
3. Build the cancellation timing matrix from report 38 and report 39: before spawn, after spawn, backgrounded, MCP request sent, server handler started, task handle returned, task completed but response lost.
4. Then move to Subagent lifecycle, context compaction, Desktop/SDK protocol and Pi source review.

**裁决：无。** 本报告仅记录源码证据，不提出最终架构，不修改旧 Kernel，不开发。
