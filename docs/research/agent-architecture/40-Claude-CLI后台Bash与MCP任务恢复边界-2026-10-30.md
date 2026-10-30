# 40 · Claude CLI 后台 Bash 与 MCP Task 的恢复边界

> 日期：2026-10-30  
> 样本：Claude Code CLI 2.1.304 发布版 JavaScript（build 2026-10-19，git SHA 17ab70404e5b632fe060207effb0b440788363ba）。  
> 方法：直接检查 01-cli-source-only.zip 中的发布版 JS；**静态源码研究**，未运行 CLI、未启动真实 Shell/MCP Server、未注入进程退出/断连故障。  
> 前置：[报告 38](./38-Claude-CLI远程工具取消与执行账本收敛-2026-10-30.md)、[报告 39](./39-Claude-Bash与MCP工具取消语义-2026-10-30.md)。

## 0. 本轮结论

Claude 2.1.304 至少存在三种不同的后台任务生命周期，不能统称为一个 Background Task：

1. **Local Bash background**：任务记录保存在当前 Engine State 的 \`tasks\` map；stdout/stderr 另写入按 session/task ID 命名的 output file。后台化会移除原 per-tool AbortSignal listener，但不会在 \`background()\` 中调用 child.unref()。task state、process handle、output file 是三份不同的东西。
2. **普通 MCP call auto-background**：等待约 120 秒（可由环境变量配置）或被消息到达提前触发后，解除 parent AbortSignal 与 MCP request controller 的关联，登记一个进程内任务并异步通知结果。源码明确提示它**不 survive exiting this session**；没有本轮发现的 MCP task sidecar。
3. **MCP Protocol Task（SEP-2663）**：在 MCP Server 已返回 task handle 后，CLI 写入独立 metadata sidecar；Session 恢复时读取 metadata、重建 task registry entry、重新连接 MCP Server 并继续轮询；完成时另写 outcome sidecar，若结束通知尚未出现在 transcript，则恢复时补发。

这三种任务的状态、输出、取消、恢复能力明显不同。

## 1. Local Bash：内存 task registry 与磁盘 output file 分离

### 1.1 TaskRegistry 实际是 Engine State wrapper

\`wh(engineState,setEngineState)\`（\`chunk-era3wpv6.js\` @44,270）返回的 registry 方法：
- \`get/all\` 从 \`engineState().tasks\` 读取；
- \`register/update/remove\` 通过 \`setEngineState\` 修改 \`tasks\` map；
- \`register\` 调用 \`Rn\`，在 Engine State 写入 task record，并通过 \`Ii\` 发出 \`system/task_started\`；
- \`update\` 调用 \`yn\`，更新 task record，并通过 \`Ii\` 发出 \`system/task_updated\`；进入 terminal 状态时另发 \`task_notification\`。

该 wrapper 没有对 local_bash task record 写独立 sidecar/JSONL 的逻辑。它管理的是当前进程的 Engine State；task_started/task_updated 是单独的消息/事件，不包含可恢复的 ChildProcess handle。

### 1.2 Bash task registration / backgrounding

关键路径（\`chunk-4b60tdnk.js\`）：

- \`ETr\` @4,774,576：为 Bash 创建 \`type:"local_bash"\` task record，包含 \`shellCommand\` 对象、task ID、outputFile、command、cwd、agentId、toolUseId、\`isBackgrounded:false\`，注册到 TaskRegistry。
- \`e1n\` @4,775,997：调用 \`shellCommand.background(taskId)\`，再把 registry record 更新为 \`isBackgrounded:true\`，建立 stall watchdog / keepalive，并交给 \`z6n\` 等待结果。
- \`LFe.background\` @256,916：把内部状态从 running 改为 backgrounded；调用 \`#C()\` 清理原 AbortSignal listener；若 stdout 原本写文件则启动轮询，否则 spill to disk。
- \`z6n\` @4,777,403：等待 child result，flush task output，更新 task registry 的 terminal 状态与 \`terminal.output_file\`，发完成通知，最后清理 writer。

因此，fallback abort 发生时：
- 若 Bash 仍是 foreground，原 AbortSignal listener 还在；\`sNn\`（@190,594）只把 scope=turn 且 reason 为 \`turn-abort\` / \`permission-stop\` 视作 turn-abort 豁免，\`streaming_fallback\` 不在其中，故进入 LFe kill 路径（SIGTERM，约 1.5 秒后尝试 SIGKILL，见报告 39）。
- 若它已先被 background()，listener 已移除；同一个 per-tool AbortSignal 后续 abort 不再能停止它。它仍可通过独立的 \`TaskStop\` 找到 task record 并调用 \`Kq\` / \`shellCommand.kill()\`。

### 1.3 output file 是独立的可读取 artifact

\`chunk-fh15xze1.js\`：
- \`_Ft\` @2,415：输出根目录按当前 session ID 组织；默认 outputDir 形如 \`<shell-output-root>/<sessionId>/tasks\`。
- \`bFt\` @2,891：输出文件名为 \`<taskId>.output\`。
- \`tu\` @3,118：通过 task ID 解析当前 session 的 output file。
- \`SXe\` @15,646：读取输出文件尾部（默认最多 8 KiB）。

Control request 的 \`get_task_output\`（\`chunk-11w8qpsz.js\` @39,996）有一个重要分支：若 TaskRegistry 中没有该 ID，但 \`hK("local_bash", task_id)\` 验证它是合法 local_bash task ID，仍可尝试读取对应 output file。也就是说，**output file 可以在 registry record 缺失时按 ID 读取**；这不等于恢复了 live process handle 或任务状态。

相反，\`stop_task\`（@38,996）调用 \`tAe → eAe\`；\`eAe\`（\`chunk-45j5sbzt.js\` @23,080）先从 TaskRegistry / named-agent aliases 查找 task，再按 task type 调用 \`Eot(type).kill\`。本轮检查未发现 local_bash 可以仅凭 output file 重建 task record 或 ChildProcess handle 的路径。因此，读取 output 与控制仍在运行的进程不是同一能力。

### 1.4 background 不等于 detach，也不等于保证跨进程存活

- \`LFe.background()\` 只设置状态、移除 AbortSignal listener、启动 output handling；没有调用 \`child.unref()\`。
- \`LFe.detach()\` @257,147 才会调用 \`child.unref()\` 并把 command 从 \`liveShellCommands\` 移除；在 source-only JS 中没有找到该 LFe.detach 的直接调用点。
- \`ShellCommandManager.ENn()\` @251,208 只对 \`status==="running"\` 的 live shell commands 调用 kill；backgrounded 状态不匹配该条件。
- Bash result schema 的 \`backgroundEndsWithFinalResponse\` 说明某些场景（例如 synchronous subagent 或不再接收后续输入的 headless session）会在 caller final response 时终止后台命令；未设置时，后台任务可在 final response 后继续并等待通知（\`chunk-rsdk23r9.js\` @96,791；Bash tool mapping 在 \`chunk-4b60tdnk.js\` @4,845,598）。

这些静态路径不足以证明 local background Bash 能在 CLI 进程退出/崩溃后继续运行或被新进程接管。**跨进程 survival 与 reattachment 仍未知**；不能把 background、detach、session resume 当成同义词。

## 2. 普通 MCP call auto-background：不具备 SEP-2663 的持久恢复

\`callMcpToolWithAutoBackground\`（\`chunk-0h73ch0n.js\` @15,686）：
- 默认 auto-background threshold 为 120,000 ms；\`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS\` 可配置，且有 feature/transport/session 条件。
- 初始 MCP request 使用独立 AbortController \`M\`，通过 \`L0e(parent,M)\` 关联 parent signal。
- 当请求超过阈值，或收到可提前让用户消息通过的触发时，代码调用解除关联函数 \`B()\`，随后创建 task registry record、挂 progress writer、让原 MCP Promise 继续运行。
- 完成后将状态更新为 completed/failed，并排入 \`task-notification\`。
- 返回给模型的文字明确说明：任务不因本次工具调用被中断，但 **“it does not survive exiting this session”**。

该路径没有调用 \`kLn/writeMcpTaskMetadata\`，也没有本轮发现的 outcome sidecar；它依赖当前 session 的进程内 registry 和 Promise。TaskStop 对该任务走 MCP_TASK 的普通 abortController，进而通过 MCP request cancellation 通知 server；没有 SEP-2663 \`tasks/cancel\` 的保证。

## 3. MCP Protocol Task（SEP-2663）：metadata 与 outcome 分开持久化

### 3.1 metadata schema 与路径

\`chunk-0apzc5fh.js\`：
- metadata schema \`vco\` @约 1,000：记录 registry task ID、session ID、run ID、toolUseId、server/tool 名、server task ID、poll interval、spawn time、protocol、TTL、transportFingerprint、workerWakeId、cancelReason。
- \`P/A/h\` @约 2,000：使用 session scoped \`mcp-tasks/mcp-task-<taskId>.meta.json\`。
- \`kLn\` @3,111：通过本地文件系统写 metadata；有 Storage V5 sidecar backend 时写 \`namespace:"sidecar"\`，\`relPath:["mcp-tasks",...]\`，\`publishDiscipline:"inPlace"\`。
- \`dhs\` @3,510：写 outcome sidecar；Storage V5 使用 \`publishDiscipline:"atomic"\`，文件系统使用 \`atomicWrite\`。
- \`ELn/chs\` @4,424/@4,491：分别列出 metadata 与 outcome sidecar。
- \`E6/OXt\`：删除 metadata/outcome sidecar。

这里的 publishDiscipline 是 consumer 请求的写入语义；Storage V5 backend 的 crash/power-loss 保证仍受报告 37 的未知边界约束。

### 3.2 创建、轮询与恢复

- \`registerOrAdoptSep2663Task\`（\`chunk-5j07wvhc.js\` @16,617）创建 \`mcp_task\` record，生成 \`protocol:"sep2663"\` metadata，并启动 \`kLn\`；metadata 写失败被 catch 后只记录 telemetry/warning，task registry 仍可继续运行，但重启后可能没有 metadata 可恢复。
- \`He\` @约 21,000 把 \`sep2663Cancel\` 绑定到 task record，然后启动 background drive。
- \`Ue\` @22,252 负责 reconnect + task status polling；它按 server/task ID 查询，不重新执行原 tool call；对 transport fingerprint 不匹配、server 不可用、TTL 到期等有不同处理。
- \`restoreSep2663Tasks\`（@36,089）从 metadata 重建 \`mcp_task\` record，并重新调用 He；若 registry 中已有 parked task，则重新 drive；已有 live/settled task 不重复启动。
- \`restoreMcpTasks\`（\`chunk-8j0kr2rr.js\` @19,147）读取 metadata，只对 \`protocol==="sep2663"\` 的任务进入 v2 restore 分支（受 \`!FV()\` guard）；未知 protocol 会 parked。旧的无 protocol metadata 路径会删除 resume record，并明确记录“旧任务没有在 server 侧取消”。
- Session resume helper \`k2t\`（\`chunk-4mfa1a2n.js\` @78,208）先处理已保存的 outcome notifications，再调用 \`restoreMcpTasks\`。本轮未动态验证所有 runtime/module guard 下是否都会走同一恢复分支。

### 3.3 outcome sidecar 防止“已完成但通知未读”丢失

\`Pe\`（\`chunk-5j07wvhc.js\` @31,343）在 SEP-2663 task 结束时：
1. 生成结束 summary/result；
2. 在合适条件下写 \`mcp-task-<taskId>.outcome.json\`，并等待有限时间；
3. 更新 registry 为 completed/failed；
4. 删除 metadata；
5. 排入 task notification；通知被对话接收后再删除 outcome sidecar。

若 outcome sidecar 写失败，源码 warning 明确指出：若在 Claude 读取 notification 前发生 restart，该 task ending 会丢失。

Resume helper \`ss\`（\`chunk-4mfa1a2n.js\` @78,396）按 session ID 读取 outcomes：
- 若 transcript 已包含相同 registryId/runId，则删除重复 outcome sidecar；
- 若 conversation 没有该 ending，则以 passive/unlogged task-notification 补入；
- 每次 resume 最多排入 8 条，剩余记录可留待后续 resume。

这是一套比普通 MCP auto-background 更完整的恢复机制，但它保存的是 task handle/summary/result，不代表 MCP Server 的实际任务实现一定遵守取消或持久化契约。

### 3.4 TaskStop 的 SEP-2663 取消仍是 best-effort

\`MCP_TASK.kill\`（\`chunk-xvm7tpd7.js\` @1,775）：
- abort 本地 request controller 与 drive controller；
- 调用 \`sep2663Cancel\`；
- 将 registry task 标为 killed/notified；
- 异步等待 metadata write 后删除 metadata sidecar。

\`sep2663Cancel\` 的实现 \`be\`（\`chunk-5j07wvhc.js\` @约 21,000）只有在 MCP Server 当前 connected 且 transportFingerprint 与创建任务时一致时，才发送 \`tasks/cancel\`；server 不在线或 transport 已变化时只记日志并返回。MCP_TASK.kill 不等待 server 的取消确认，仍会把本地任务标为 killed 并删除 metadata。

**风险推断：** 如果 TaskStop 时 server 离线/身份不匹配，server task 可能仍在运行；本地恢复责任却可能随 metadata 删除而消失。用户看到的说明也明确提醒：server 可能已经完成部分工作或仍会继续，但不会再有结果通知。这不是动态复现的缺陷，而是源码可见的 best-effort 边界。

## 4. 三种任务生命周期对照

| 维度 | Bash background | MCP ordinary auto-background | MCP SEP-2663 Task |
|---|---|---|---|
| 执行状态 | Engine State task registry | Engine State task registry | Engine State + metadata sidecar |
| 输出/结果 | session-scoped output file | 进程内 Promise + notification | Server task handle + outcome sidecar |
| 原工具 signal | background 后 listener 移除 | auto-background 后解除 parent signal link | task handle 后转为 task drive；取消另走 tasks/cancel |
| TaskStop | 本地 shellCommand.kill | abort MCP request controller | abort drive + best-effort tasks/cancel |
| Session restart | 没有找到 local_bash task rehydrate；output file 可按 ID 读取 | 明确不 survive exiting session | 有 metadata restore/reconnect/poll |
| 结果通知补偿 | task notification / output file；进程重启后的补偿未知 | 进程内通知 | outcome sidecar + resume replay |
| 主要未知/风险 | process survive/re-attach；registry 丢失后的 live stop | session exit 时远端 server 是否仍继续、结果无法恢复 | cancel 未确认时仍删除本地恢复记录；sidecar backend durability |

## 5. 事实 / 推断 / 未知

**源码事实：**
- local Bash registry 由 Engine State 管理；输出文件另存，且 get_task_output 可在 registry entry 缺失时按合法 task ID 尝试读文件。
- Bash background() 清理 AbortSignal listener；TaskStop 仍可经 registry 调用 shellCommand.kill。
- 普通 MCP auto-background 解除 parent signal link、用进程内 task registry 和 Promise 跑完，并明确不 survive session exit。
- SEP-2663 使用 metadata 与 outcome 两类 sidecar；恢复路径重建 task record 并 reconnect/poll；outcome 可在 resume 时补通知。
- SEP-2663 TaskStop 只有在 server connected 且 fingerprint 匹配时才发送 tasks/cancel；本地 killed 和 metadata delete 不等待 server acknowledgement。

**推断 / 风险：**
- local Bash process handle 与 registry 若在 CLI process restart 后丢失，即使 output file 还在，也不能仅凭该文件控制 live process。
- MCP SEP-2663 的 stop 在 server 离线时可能留下 server-side work，却清除本地 reattach metadata。
- metadata 写失败可能让正在运行的 SEP-2663 task 无法在 restart 时恢复；outcome 写失败可能让未读结束通知在 restart 时丢失。

**未知：**
1. Local Bash background child 在真实 CLI exit/crash 下的 OS 进程存活情况；background() 不 unref，detach() 有 unref 但未找到直接调用点。
2. 是否存在未被当前 source-only JS 路径覆盖的 local_bash task rehydration。
3. MCP SEP-2663 restore 分支在不同 runtime/feature guard 下的确切启用条件。
4. Storage V5 sidecar 的物理原子性/耐久性与故障恢复。
5. 第三方 MCP Server 是否真正执行 tasks/cancel、以及 cancelled 状态是否意味着底层工作停止。

## 6. 对新架构研究的启示（非架构决策）

- Task registry、process handle、output artifact、remote operation ledger、notification delivery 应分别建模。
- 不应把“后台化”定义为一个状态：至少区分 detach-from-attempt、detach-from-process-parent、persist-for-session-resume、remote-server-task。
- 取消任务必须保留 cancel-requested / cancel-unconfirmed / outcome-unknown 的 reconciliation obligation；不能因本地 UI 标记 killed 就删除远端恢复凭据。
- 恢复应区分“恢复结果可读”与“恢复执行控制权”；读取 output file 不等于接管 process。
- sidecar metadata 与 terminal outcome 应有不同写入纪律和故障策略；写失败必须显式影响恢复状态，不能仅 telemetry 后继续宣称可恢复。

## 7. 下一步

1. 完成取消 timing matrix：Bash foreground/background/TaskStop、MCP ordinary auto-background、SEP-2663 create/handle/cancel/reconnect/restore。
2. 继续研究 Subagent 的 task registry、parent-child ownership、stop propagation、resume 与 context isolation。
3. 继续研究 context compaction 的消息选择、摘要、tool result/attachment 保留和失败回滚。
4. 完成 Desktop/SDK Host session 生命周期与 Pi Core 后，再统一比较并提出独立架构备选方案。

**裁决：无。** 本报告只记录源码证据，不修改旧 Kernel，不开发，不批准任何架构。
