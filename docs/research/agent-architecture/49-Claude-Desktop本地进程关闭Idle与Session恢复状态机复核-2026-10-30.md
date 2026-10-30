# 49：Claude Desktop 本地进程关闭、Idle 与 Session 冷恢复状态机复核（2026-10-30）

> 研究阶段：发布版 bundle 静态源码复核；未执行 Electron / SDK / CLI 动态验证。  
> 样本：Claude Desktop 3.1623.1、配套 Claude CLI 2.1.304、bundle 内 SDK 0.3.304。  
> 承接报告 47–48：本报告补齐 local process spawn 与 SSH custom spawn 的边界、Turn interrupt / Session stop / Process close、Idle pause、app quit、Session metadata 与 Waiting Input 恢复。  
> **本报告只增加研究文档；不修改业务代码、Kernel 或实现 PR。**

## 1. 证据范围与可复核性

本轮重新读取 Library 中的 source-only 分包：

- 02-desktop-source-only.zip，SHA-256：8dff064d68a1f3b8ba871b05d9a7cb40a7f520ffe98fd6addddbb272fc937d44
- 01-cli-source-only.zip，SHA-256：c23f47981015f874c6b2a06834334f6e0ee302f1df4d85ddfe24fe9de0f094eb

关键文件：

| 文件 | SHA-256 |
|---|---|
| Desktop index.chunk-C7nJwi7_.js | f69b5dae07191e32fc528591aa741e9e3717127b19d52d3c463a32295d16cbe7 |
| Desktop index.chunk-BT1aFaVF.js | 50bc49b37e9b978180f3a1640210fdd9c25c629d15c8df8e067f6a05faa729b8 |
| Desktop index.chunk-J7YnW_mh.js | 80d308de49d2eacee72a561734b05e32209783de7772881036e5608cfd725a42 |
| CLI chunk-3s96qz8g.js | 6728e5e954398456230c593523d4d391cee0decbeb3c2b9fe7b28e63ffb4fe5f |
| CLI chunk-g9306b3w.js | 0a7c74ce263af17efda2c96eecd20c23c9119d6d05e2a0bd576eea138e419707 |

Desktop bundle 无 source map。本报告使用文件 hash + 0-based 字符偏移 + 符号名作为复核定位，不将 minified offset 伪装成源码行号。

本轮未运行真实 Electron、SDK query、CLI 子进程、SSH host、MCP server、模型请求或 crash injection。Native binding 的实际实现不在本轮可读 JS 内。

## 2. Local spawn 与 SSH custom spawn 是两条不同的进程路径

### 2.1 SDK ProcessTransport 的默认 Local spawn

Desktop 调用 SDK query 时，SDK ProcessTransport 的 initialize 会选择：

- options 提供 spawnClaudeCodeProcess：调用宿主注入的 custom spawn；
- 未提供：调用 SDK 自己的 spawnLocalProcess。

默认 local path 使用 Node child_process.spawn，参数包含 command、args、cwd、env、AbortSignal，stdio 为 stdin/stdout/stderr 三个 pipe，并设置 windowsHide。该 spawn options 没有 detached:true。

CLI 参数由 SDK 统一构造，基础协议是 stream-json input / output。resume/session options 会转换成 CLI 参数，例如 --resume、--session-id、--resume-session-at。SDK 同时将 CLAUDE_CODE_ENTRYPOINT 设为 sdk-ts，并维护 stdout JSONL reader 与 stderr tail。

Desktop 提供 onProcessSpawned callback，因此 local spawn 成功后，PID 会回到宿主。Desktop 后续从 initializationResult 读取 PID，并将 cliPid / cliPidAtMs 记录到 Session runtime state。

### 2.2 SSH path 注入 RemoteProcess，而不是第二套 Agent loop

SSH Session 仍复用 SDK Query / ProcessTransport 的协议和 stream interface，但 Desktop 注入 spawnClaudeCodeProcess。该 callback 来自 RemoteServerController.createSpawnFunction，返回 ChildProcess-like RemoteProcess。

所以两条路径的边界是：

| 维度 | Local | SSH |
|---|---|---|
| OS process 创建者 | SDK ProcessTransport 默认 spawn | Desktop RemoteServerController / SSH helper |
| Process identity | 本地 PID，另有 creationTime / native job tracking | 远端 processId + hostKey + daemon identity |
| 断线恢复 | 通常创建新 CLI process，使用 --resume 恢复 CLI Session | 可 reattach 同一个远端 process，sequence replay |
| SDK Query | 同一个 SDK Query 类型 | 同一个 SDK Query 类型 |
| stream | 本地 stdio pipe | RemoteProcess RPC stream |
| 进程终止 | ProcessTransport.close + Desktop native process tracking | RemoteProcess kill / orphan reaper / helper protocol |

这与报告 48 的结论一致：本地 transcript resume 是 cold process resume；SSH RemoteProcess adoption 是 hot process adoption。两者不能合并成一个“resume=true”布尔值。

### 2.3 Local PID 的 native process job 接管

Desktop 的 buildStartSdkOptions 为 local SDK spawn 注入 onProcessSpawned。回调会尝试通过 native binding 的 createProcessJob(pid) 建立 process job；前提是 native method 存在且 feature gate 未禁用。

CLI initialize 完成后，Desktop 把 job handle 关联到 Session。teardown 时调用 native endProcessJob：

- 普通 stop / pause / app_quit 等路径传入 false；
- archive / delete / account_switch 在 job path 可用时，延迟后传入 true；
- 若 feature gate 禁用或 native method 不可用，则不会建立该 job。

这是源码能证明的调用形态。native binding 未在本轮可读源码中，因此不能仅凭 true / false 参数推断 Windows Job Object 的确切 kill-on-close、子进程继承、wait 或 detach 语义。

## 3. Turn interrupt、Session stop 与 Process close 必须分层

### 3.1 SDK Query.interrupt 是控制协议，不是 Query.close

SDK Query.interrupt 调用 request({subtype:"interrupt"})。可选 cancelQueued 会附带 cancel_queued:true；返回值可包含 still_queued 与 cancelled UUID 列表，Desktop 据此处理仍在本地排队的输入。

这是 SDK → CLI 的 control request。它不等同于关闭 Query、关闭 stdio 或杀死 OS process。

CLI 2.1.304 的 Agent engine 另有 interrupt intent handler：它 abort 当前 turn controller；当 scope 不是 turn-cancel 时，还会处理非 durable task registry 与 artifact-room cleanup。此处证明 CLI engine 有 turn-level interrupt 语义；本轮没有把每一种 Desktop request option 到 CLI engine scope 的所有中间 adapter 都单独还原。

### 3.2 Desktop interruptSession 的决策流程

LocalSessionManager.interruptSession 并不一律关闭 Session：

1. 先处理 held / kept / queued input。若当前 turn 仍被本地 input gate hold，可直接 withdraw，不向 CLI 发 interrupt。
2. 对存在 Query 的 Session，记录 stop intent、cut-turn state，并将部分 deferred sends 暂存。
3. 若 SSH host 已断开、仍有 detached process 或处于 replay 状态，则发送/保留 queued interrupt，不因没有立即 ack 就升级为 kill。
4. 正常链路下调用 query.interrupt()，并与一个有界 ack timeout 竞争。
5. 若 interrupt ack 成功，Desktop 发送 turn-complete / withdrawn 等状态信号，保留 Query / Session process，允许后续输入继续。
6. 若 interrupt 抛错或超时，才走 stopSession(interrupt_failed / interrupt_timeout) fallback。
7. 对 SSH，即使 timeout，也会先判断 host down、replaying、stream busy、ping failure 等情况；若链路结果仍不确定，则保持 queued stop intent，不贸然终止远端进程。

因此“用户按下停止”在 Desktop 里可能只是 Turn interruption；只有特定失败或显式 teardown 路径才升级为 Session stop / Process termination。

### 3.3 stopSession 与 teardownSession

stopSession 将操作映射为 teardownSession(sessionId, "stop", {stopTrigger,...})；app_quit 则映射为 teardownSession(sessionId, "app_quit", ...)。

teardownSession 会停止 page-scoped work、撤销 pending clear / move、处理 in-flight start、结束 cut-turn 状态、清理权限和 user-dialog pending requests，并最终调用 teardownQuery。

是否 retire SSH RemoteProcess 由 stop trigger 与 teardown reason 决定。源码中的 retireRemoteProcess 条件包含 archive / delete、stop trigger 为 user / interrupt_timeout / interrupt_failed / clear / rewind / discard / agent 等，以及 pauseTrigger 为 credential_revoked。app_quit 不在这个 retire 条件内。

teardownQuery 对 SSH 的主要分支：

- retireRemoteProcess：记录远端 process cleanup obligation，并对 live RemoteProcess 发 SIGTERM / kill；
- 不 retire：调用 parkSshLiveProcess，让远端进程保留在可重新接管状态。

teardownQuery 还会清理 permission broker、user dialog broker、SDK MCP server state、input stream、deferred sends、turn state 和 process tracking。Session metadata 本身不会因为普通 stop 自动变成 archived。

## 4. Query.close 与 OS process exit 之间存在异步边界

### 4.1 SDK Query cleanup

SDK Query.close 的实现是调用 cleanup()，但 close 本身不返回 cleanup Promise。

performCleanup 的顺序包括：

1. 执行 cleanup callbacks；
2. flush transcript mirror batcher；
3. abort SDK 内部 cancel controllers；
4. 调用 transport.close()；
5. reject pending control / MCP responses；
6. close SDK MCP transports；
7. 结束 input stream；
8. 如果 transport 支持 waitForExit，最多等待约 2 秒。

Desktop teardownQuery 调用 query.close() 时没有 await 其 cleanup Promise。因此，Desktop 的 Query 对象被清空、Session runtime state 被重置，与 SDK cleanup Promise 完成、OS child process exit 是不同时间点。

### 4.2 ProcessTransport.close

ProcessTransport.close 的静态代码行为：

- 尝试取消尚未完成的 spawn；
- end stdin；
- 清除 AbortSignal listener；
- 若进程仍活着，安排约 2 秒后的终止动作；
- POSIX：先 SIGTERM，再约 5 秒后仍未退出则 SIGKILL；
- Windows：在该延迟路径上再安排约 5 秒后的 SIGKILL；
- exit listener 最终移除 process registry tracking。

ProcessTransport.close 本身立即返回，不等待这些 timer 完成。Query.performCleanup 的 waitForExit 有约 2 秒上限，且 Desktop 并不 await Query.close cleanup。

SDK 另有 process registry：在父 Node 进程 exit 时，遍历 tracked children；POSIX 尝试 SIGTERM，Windows 结束 child stdin。该 exit hook 也不是一个可 await 的进程树回收协议。

### 4.3 Desktop teardown watcher 是观测，不是 kill acknowledgement

Desktop watchLocalCliTeardown 在部分 local teardown reason 下登记异步 watcher：

- 使用 PID + process creationTime，避免 PID reuse 混淆；
- 每约 250ms 检查 root PID；
- 约 6.75 秒记录 root 是否仍活着，并尝试读取 hard-kill 前的 descendants；
- 最晚约 10 秒汇总 root exit time、hard-kill 前存活状态、close 时 descendants 与最终 descendants alive count；
- 结果通过 desktop_ccd_cli_teardown_outcome telemetry 发送。

这个 watcher 只观察并上报，不负责 kill，也不阻塞 teardown。它跳过 app_quit、account_switch 和 appQuitting 阶段。因此它不能证明普通 app quit 后所有 CLI 子孙进程都已退出。

**重要边界：** 源码证明 SDK/宿主有多层进程清理尝试；但 Query.close settled 不等于 child exit，native process job 的真实语义也尚未获得。当前只能记录为一个需要动态验证的 cleanup / orphan 风险窗口，不能宣称已复现泄漏 bug。

## 5. WarmLifecycle 与 Idle Pause

### 5.1 WarmLifecycle 状态

WarmLifecycle 为每个 Session 维护：

- isTabVisible / visibilityKnown；
- hasPendingResult；
- lastMessageSentTime / lastResultTime / lastHiddenTime；
- idleTimeoutId / idleArmedAt / idleArmedTimeoutMs；
- idleUnarmedSince / idleRecheckId；
- isWarmingUp；
- consecutiveDeclinedPauses。

Turn complete 时，如果 armOnTurnComplete=always 或 Session 当前不可见，启动 idle timer。Query installed 且 Session 不可见时也可启动。Session 从 hidden 变 visible 时清除 idle timer；若没有 active Query，则按 warm-up slot 调用 onWarmUp，重新 warm Session。Session 再次 hidden 时，在 hasPendingResult 或 timeoutOnHidden 条件满足时重新 arm。

### 5.2 不要把 WarmLifecycle 类默认值误当成 Desktop 的普通 Session 默认值

WarmLifecycle 类自身的默认 idleTimeoutMs 是 15 分钟；但 LocalSessionManager 实际传入了 Xf 函数覆盖默认值：

- unattended Session：固定 15 分钟；
- 普通 Session：读取 setting key 4041267332；
- setting 缺失、非数字、NaN 或小于等于 0 时返回 0，即不 arm 普通 idle timeout；
- 正数会 round 并 clamp 到至少 60 秒、至多 2^31-1 ms。

所以不能简单写成“Claude Desktop 所有 Session 默认 15 分钟自动关闭”。15 分钟在这里明确适用于 unattended path；普通 Session 取决于 setting。

当 timeout 为 0，WarmLifecycle 会记录 idleUnarmedSince 并定期重检，而不是直接销毁 Session。这个 idle state 仍可被 CliGovernor 用作 LRU idle candidate。

### 5.3 Idle timeout 触发的是 pause，不是 archive

WarmLifecycle 的 onDisconnect 调用 LocalSessionManager.pauseSession。

普通 pause 会检查：

- Query 是否存在；
- Session 是否正在运行；
- Agent run 是否可能仍在飞行中；
- active Cron jobs；
- pending loop wakeup；
- background tasks / workflows；
- Remote Control 是否活跃；
- lanyard 是否 connected；
- violinBow 等其他 active guard。

任何 guard 不允许暂停，pauseSession 就返回；WarmLifecycle 看到 Query 仍 active，会增加 consecutiveDeclinedPauses。阈值为 8 时记录“连续拒绝 idle pause，process 未被 reap”的 telemetry。

### 5.4 Backend 对 idle pause 的不同策略

Backend 明确实现 shouldKillOnIdlePause：

| Backend | shouldKillOnIdlePause | 普通 idle timeout |
|---|---:|---|
| local | true | 可以 pause 并关闭本地 Query/process |
| SSH | false | 跳过 idle pause，进程跨 detach 保留 |
| WSL | false | 跳过 idle pause，进程跨 detach 保留 |

因此 SSH / WSL 的 idle 策略不是“超时后 kill 远端 CLI”，而是允许宿主 UI / Query detach，保留远端执行进程。

Credential revoked 是不同的强制路径：pauseSession 对 credential_revoked 绕过普通 active guards；teardownSession 的 retireRemoteProcess 条件也将 credential_revoked pause 纳入，因此不能把它与普通 idle pause 等同。

### 5.5 Memory pressure 与 idle timeout 是两个机制

CliGovernor 可选取 LRU idle Session 并调用 pauseSession(governor_evict)。它要求 idle 时间至少约 60 秒，并使用 WarmLifecycle 的 lastResult / lastHidden / idleUnarmed 时间计算 idle age。

所以普通 Session 的 idle timeout 关闭，不代表它永远不会被 memory-pressure governor pause；这是独立的资源回收策略。

## 6. App quit：Local 停进程，SSH 保留进程

stopAllOnQuit 在 Desktop quit handler 中注册。它的关键顺序：

1. 记录 pending session-end events，释放 spares，设置 appQuitting。
2. 遍历 SSH sessions：调用 markSshSessionAtExit；按 waiting input 情况保存 across-loss input、withdraw held turn、持久化 cleanShutdown=true waiting-input snapshot；不会把 SSH session 放入 local stop list。
3. 遍历 local sessions：记录 open turns；符合 quit auto-resume 条件的 Session 写入 interruptedByQuitAt、interruptedUnseenResume、interruptedAwaitingPerson；保存 armed work marker 与 local waiting input。
4. 对 local stop list 调用 stopSession(sessionId, "app_quit")。
5. flush SessionPersistence。
6. flush WaitingInput persistence。
7. 若 waiting-input 写入失败，对对应 SSH reattach handle 设置 inputPending 并再次 flush SessionPersistence。

这证实 app quit 的策略有意区分：

- Local：关闭当前 CLI process，但保留 CLI Session / transcript identity，之后 cold resume；
- SSH：保存 process adoption handle，尽量保留远端 CLI process，之后 hot reattach；
- Waiting Input：独立于 Session metadata 和 transcript 保存，并通过 cleanShutdown / inputPending 控制恢复。

### 6.1 App quit 不等于所有本地进程已确认退出

stopAllOnQuit 会 await stopSession 和 persistence flush，但 stopSession → teardownQuery 对 Query.close 是 fire-and-forget。SDK cleanup 自己最多 waitForExit 约 2 秒，而 ProcessTransport 的 SIGTERM / SIGKILL timer 更长。

因此普通 app quit handler 没有在该路径中建立“所有 local CLI OS process 已 exit”的强确认。SDK process registry 在父进程 exit 时还会尝试 SIGTERM；Desktop 的 local teardown watcher 又跳过 app_quit / appQuitting。实际 OS process 最终状态必须动态验证。

## 7. Session metadata 与 Waiting Input 恢复

### 7.1 Session record load

loadSessionRecords 的可见行为：

- 从 account / org storage directory 读取 local_*.json；
- active Session 优先，archived Session 延迟加载；
- active records 以每批 8 个并发读取；
- 单个 Session JSON 超过 10 MiB 会跳过；
- 解析后通过 Session serializer / migration 重建 runtime record；
- 将旧进程状态标记为 processGoneReason=app_relaunch；
- 单独读取 Waiting Input record；
- 恢复 context recovery、worktree、crash-loop guard 等 state；
- 远端 Session 的 SSH waiting input 与本地 queue 走不同恢复函数；
- 完成 active load 后执行 localQueueRestore.settleOwed、SSH preconnect、cold-hold rearm 和 resumeQuitInterruptedSessionsAtLaunch；
- archived records 可继续在后台分批加载。

这不是“把 JSON 反序列化就恢复 Agent”。Runtime Query、inputStream、OS process 不从 Session JSON 直接还原。

### 7.2 Local Waiting Input：用 Transcript 对账，而非盲目重发

LocalQueueRestore 只对启用相应 local queue policy 的 local Session 生效。

它把等待消息分成两类：

- 可以安全恢复的 held queue；
- 仍需 transcript 确认的 unverified queue，cause 包括 awaits_transcript / waited_a_launch。

settleOwed 会读取对应 CLI transcript，最长等待约 60 秒。匹配依据包括：

1. user row UUID；
2. mergedSendUuids；
3. 若 UUID 无法确认，则比较 prompt text，并允许跨连续 transcript user rows 做 prefix / concatenation 匹配。

如果 transcript 已包含该消息，则不重新发送；若确认缺失，则将消息恢复为 held input。若 transcript 暂时不可读，代码会把 unverified record 标记为 waited_a_launch 再等一次 launch；连续不可读后才把它恢复为 held queue，而不是第一时间盲目重发。

这是一个 dedup-oriented reconciliation heuristic，不是严格 exactly-once。UUID / merged UUID 是强证据；文本 prefix fallback 可能在重复 prompt 场景产生歧义，需动态测试。

### 7.3 SSH Waiting Input：非正常退出时偏向不重复执行

SSH restoreWaitingInput 的策略不同：

- cleanShutdown=false：不恢复上次 app instance 留下的 waiting messages，因为无法判断它们是否已经送达 host；记录 warning，清除 waiting-input record，设置 sshReattach.inputPending，并提示 turn interrupted / words lost。
- cleanShutdown=true：按 entry 重新构建消息；部分可验证 prompt 放入 heldAcrossLoss；无法确定的 prompt 通过 announceUnverifiedPromptLost 标记，而不是假定安全可重发。

这是一个明确的 tradeoff：SSH 非正常退出时偏向避免重复执行远端副作用，代价是部分输入可能被丢弃。它不是 exactly-once，也不是 at-least-once。

### 7.4 Waiting Input 写入失败的保护

WaitingInputRecorder 的 persist 使用 queueMicrotask，按 now 标志选择 saveNow / save。写入失败时设置 writeFailed，并记录“仅 memory-only，直到下次写成功”。

app quit / restart flush 后，markInputPendingWhereExitWriteFailed 会检查 SSH reattach handle 是否仍匹配当前 remote process；若 waiting-input write 失败，则在 Session metadata 写 inputPending=true。该 marker 让下一次恢复知道存在无法可靠还原的输入，不应默默当成空队列。

## 8. Quit auto-resume 是两阶段，而不是自动重放旧 prompt

loadSessionRecords 完成后，resumeQuitInterruptedSessionsAtLaunch 串行进入 runLaunchPass。

Launch pass 会检查：

- feature flags 是否已刷新；
- org / managed policy；
- workspace overlay 是否应用；
- 是否有 pending user input；
- Session 是否已归档 / 被替换 / 已有 Query；
- worktree probe；
- CliGovernor headroom；
- 本轮最多 warm 4 个 Session，并限制失败次数。

它先 warm CLI process / Session。warm 完成后，maybeRunQuitAutoResume 另行检查：

- interruptedByQuitAt 是否仍存在；
- automatedContinueContext；
- unattended / person attending；
- pending user input；
- CLI crash-loop guard；
- SSH transcript 是否结束在 mid-turn；
- feature / org policy gate。

只有决策结果 fire=true 才向 Session sendMessage 一条 auto-continuation。若需要 person attention，interrupt marker 会保留，等有人打开 / 关注 Session 后再评估。

因此恢复分成两件事：

1. **Process / CLI Session resume**：创建新 local CLI process 并 resume transcript，或 SSH hot reattach 原 process。
2. **Turn continuation**：判断是否需要补发自动继续消息。

不能把“session warmed”解释成“之前被中断的 prompt 一定会自动重放”。

## 9. 事实 / 推断 / 未知

### 源码事实

- SDK ProcessTransport 默认通过 child_process.spawn 创建 local CLI；Desktop SSH path 注入 spawnClaudeCodeProcess。
- Local process PID 会回传 Desktop；Desktop 可尝试 native createProcessJob 并在 Session initialize 后关联。
- SDK Query.interrupt 是 control request；Query.close 调用异步 cleanup，不返回 cleanup Promise。
- ProcessTransport.close 结束 stdin 后走延迟 TERM / KILL 路径；SDK process registry 在 parent exit 尝试清理 tracked child。
- Desktop interruptSession 优先 soft interrupt；ack timeout / error 才可能升级 stop；SSH link down / replaying / busy 时保留 queued interrupt。
- Idle timeout 调用 pauseSession；local、SSH、WSL 的 shouldKillOnIdlePause 不同。
- Credential revoked pause 是强制 teardown 路径，区别于普通 idle pause。
- stopAllOnQuit 不把 SSH sessions 放进 local stop list；Local sessions stop(app_quit)，随后 flush metadata 与 waiting input。
- Session load active-first、有限并发、单文件 10 MiB cap，并将旧 process 标记 app_relaunch。
- Local waiting input 通过 transcript UUID / merged UUID / text matching 对账；SSH unclean shutdown 则丢弃无法判定是否已送达的 waiting input。
- Launch auto-resume 先 warm，再独立判断是否 send auto-continuation。

### 推断 / 设计风险（未动态验证）

- Query.close 不 await cleanup，加上 process exit timer，说明 Query lifecycle 与 OS process lifecycle 可能存在短暂重叠；是否产生可观察 orphan 取决于 native job / CLI / OS 行为。
- Local queue 的 text-prefix fallback 在重复内容下可能歧义；UUID / merged UUID 可降低但不能消除所有风险。
- SSH unclean shutdown discard 是避免 duplicate side effect 的 at-most-once 倾向策略，存在用户输入丢失风险。
- 普通 app quit 的 local process exit 缺少 SessionManager 级强确认；应在隔离环境中测量 Query.close、process exit、descendant exit 的真实时间线。
- Native process job 可能补充子进程清理，但 JS 侧不能证明其确切语义。

### 未知 / 资料缺口

- Native createProcessJob / endProcessJob 的实现、平台差异、process tree/job object 语义。
- SDK close path 与 Desktop quit handler 在真实 Electron exit 时的精确时序。
- ProcessTransport SIGTERM / SIGKILL timer 与 CLI shutdown hooks、Bash/MCP child process 的交互。
- SSH helper 在 app quit / credential revoke / forced stop 下的真实 process kill ack。
- Waiting Input record 写入失败、损坏、附件缺失、重复 prompt、transcript 读取超时的动态结果。
- auto-resume feature/org policy 在真实账号、无人值守和 crash-loop 下的完整决策覆盖。
- 所有上述结论均为静态源码分析，没有执行 fault injection。

## 10. 对目标 Agent 架构的非决策性启示

1. **拆分四种生命周期：** Turn（interrupt / complete）、Query（open / close）、Process（spawn / detach / terminate / exit）、Session（warm / pause / archive / delete）。不要把一个 stop flag 传播成所有层级的强制 kill。
2. **中断需要明确 ack 语义：** interrupted / queued / unacknowledged / process-terminated 是不同结果；网络不确定时不能把“没有 ack”直接当成“远端未执行”。
3. **Process close 必须暴露 awaitable exit receipt：** close request、stdin closed、SIGTERM sent、process exited、descendants reaped 分开记录；Session teardown 不应假设 Query.close 已完成。
4. **持久化 delivery state：** queued、persisted、sent、remote-accepted、transcript-confirmed、uncertain、withdrawn 分开建模；local / remote 可以有不同恢复策略，但必须向用户暴露丢失 / 不确定。
5. **不要以文本内容作为主要 exactly-once dedupe key：** UUID / operation ID / delivery sequence 应是权威身份；内容匹配只能作为显式降级恢复证据。
6. **Idle pause 与 memory pressure eviction 分开：** 可见性、后台工作、远端 process persistence、credential revocation、资源压力分别触发不同策略。
7. **Shutdown 要有 deadline + reaper：** app quit 的持久化 flush 和 process termination 是两个独立任务；应有可观察的 bounded wait、进程树确认、orphan ledger 和重启 reconciliation。
8. **自动恢复与自动续跑分离：** 先恢复 Session / Process，再基于 pending input、transcript boundary、policy 和 person attention 决定是否继续 Turn。

以上是设计输入，不是已批准架构决策。

## 11. 下一步

1. Desktop / SDK 生命周期第一轮（报告 47）、SSH adoption / MCP / permission / event（报告 48）、Local spawn / interrupt / idle / quit / cold restore（本报告 49）已经形成可对照的静态源码链。
2. 仍需补齐 Desktop canUseTool / Hooks / hook_callback 从 buildStartSdkOptions 到 CLI control request 的完整 callback 生命周期，以及 renderer reload / pending request replay 的边界；报告 47 已确认入口，但尚未把所有 hook 类型与 abort / timeout / cleanup 逐一闭环。
3. 若 native helper / SSH helper server-side source 无法取得，继续把其 process-job / reattach 语义保留为未知，不用客户端推断填空。
4. 随后固定 Pi Agent Core 的上游 commit 与发布包，核验 Agent loop、event stream、tool execution、context transform / compaction、session tree、extension hooks、cancel 和 error handling。
5. Claude CLI、Desktop / SDK、Pi 同场景对照完成后，再做独立目标架构设计并交用户审阅。明确批准前不进入开发。

## 12. 本轮边界

本报告只新增研究文档和进度记录。没有新增 Agent loop、adapter、tool executor、Session store 或 Kernel 实现；没有修改业务代码；没有提交开发 PR。

## 13. Evidence index

所有 offset 均为 UTF-8 解码后的 0-based 字符偏移。

| File | SHA-256 | Anchors |
|---|---|---|
| Desktop index.chunk-C7nJwi7_.js | f69b5dae07191e32fc528591aa741e9e3717127b19d52d3c463a32295d16cbe7 | process job helpers Ny / Py / Fy / Iy @501,945；pauseSession @1,979,360；stopSession @1,951,864；interruptSession @1,952,113；teardownQuery @1,866,824；watchLocalCliTeardown @1,866,119；teardownSession @1,875,252；stopAllOnQuit @1,709,738；loadSessionRecords @1,769,645；runLaunchPass @1,782,241；maybeRunQuitAutoResume @1,747,491；restoreWaitingInput @1,992,324；markInputPendingWhereExitWriteFailed @1,864,452；localQueueRestore @825,165 / settle @826,503；normal idle timeout function Xf @325,813 |
| Desktop index.chunk-BT1aFaVF.js | 50bc49b37e9b978180f3a1640210fdd9c25c629d15c8df8e067f6a05faa729b8 | WarmLifecycle class @512,607；onTurnComplete @515,167；startIdleTimeout @515,397；onVisibilityChange @516,036；local / SSH / WSL backend shouldKillOnIdlePause @531,685 / @532,160；teardown descendant watcher gw @520,800-range |
| Desktop index.chunk-J7YnW_mh.js | 80d308de49d2eacee72a561734b05e32209783de7772881036e5608cfd725a42 | ProcessTransport.spawnLocalProcess @1,161,387；ProcessTransport.close @1,170,126；Query.performCleanup @1,179,307；Query.interrupt @1,195,696 |
| CLI chunk-3s96qz8g.js | 6728e5e954398456230c593523d4d391cee0decbeb3c2b9fe7b28e63ffb4fe5f | engine interrupt intent handler @76,698；engine interrupt API @78,082 |
| CLI chunk-g9306b3w.js | 0a7c74ce263af17efda2c96eecd20c23c9119d6d05e2a0bd576eea138e419707 | control request send / abort bookkeeping @31,692 / @37,732 |

**证据等级：** Desktop / SDK / CLI 发布版 JS 静态源码；没有真实进程、Electron、SSH host、MCP server 或故障注入。报告列出的 orphan / duplicate / loss 均为待验证风险，不是已复现 bug。