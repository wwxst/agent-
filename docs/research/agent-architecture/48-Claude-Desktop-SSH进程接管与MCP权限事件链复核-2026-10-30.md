# 48：Claude Desktop SSH 进程接管、MCP 拓扑与权限事件链复核（2026-10-30）

> 研究阶段：源码静态复核；不含运行时验证。  
> 样本版本：Claude Desktop 3.1623.1、配套 Claude CLI 2.1.304。  
> 本报告承接报告 47 的 host startup / SDK session 双向协议第一轮追踪，进一步核验 SSH 远程进程重连、持久化接管、MCP 部署拓扑、权限 broker 和 renderer event IPC。  
> **没有修改业务代码、Kernel 或实现 PR；没有执行真实 Claude Desktop、SSH helper、CLI、模型请求或外部工具。**

## 1. 证据范围与可复核性

本轮读取 Library 中已整理的 Desktop source-only 分包并解压到临时研究目录。实际读取的归档为 02-desktop-source-only.zip，SHA-256：8dff064d68a1f3b8ba871b05d9a7cb40a7f520ffe98fd6addddbb272fc937d44。解压树包含 520 个文件；Vite build 目录包含 407 个文件，未发现 .map source map。因此，下文对 minified bundle 的证据采用**文件 SHA-256 + 字符偏移 + 可检索符号**，而不是虚构 TypeScript 源文件行号。

关键 bundle 的 SHA-256：

| 文件 | SHA-256 |
|---|---|
| index.chunk-C1QWjcyS.js | 90c801e3100671c06bc7711b142b937762a00b17a62282ca98b028e5104792b3 |
| index.chunk-C7nJwi7_.js | f69b5dae07191e32fc528591aa741e9e3717127b19d52d3c463a32295d16cbe7 |
| index.chunk-Down-gfq.js | 4599007d451203b49fc0760bb43fc12d2e36346e4e0d3ebe86839bfb9a528340 |
| index.chunk-BT1aFaVF.js | 50bc49b37e9b978180f3a1640210fdd9c25c629d15c8df8e067f6a05faa729b8 |
| index.chunk-Ca-EeaV6.js | e07b95784555a5bf787a900da0e18fdc0cc71232aee085c2a8d95e3eb7b7ab1e |
| index.chunk-QB4E341u.js | 03d48f5b628c5e459c9af48d07650477815232569346cd23d889d6b64b7e352f |
| index.chunk-BRvO7fVg.js | 1a87853c63ad0e52ffa69e2de27004dc0dfccfb5394f23f3daaf5829da6b7976 |

本轮关键符号索引：

| Bundle | 字符偏移 | 符号 / 证据点 |
|---|---:|---|
| C1QWjcyS | 42,353 | RemoteProcess 类 Ct |
| C1QWjcyS | 48,050 | replayCheckpoint / outputCaughtUp |
| C1QWjcyS | 60,205 | reapOrphans |
| C1QWjcyS | 61,899 | reattachOrSpawn |
| C1QWjcyS | 62,370 | adoptOrSpawn |
| C1QWjcyS | 63,576 | adoptOrSpawnHoldingSlot |
| C1QWjcyS | 69,039 | spawnFreshAs |
| C1QWjcyS | 74,443 | checkpointBarrierBeforeStdin |
| C1QWjcyS | 77,816 | RemoteProcess.handleStreamFrame |
| C1QWjcyS | 30,976 | RemoteRPCClient.handleStreamFrame |
| C1QWjcyS | 99,364 | RemoteServerController 类 |
| C1QWjcyS | 194,390 | supportsProcessAdoption |
| C1QWjcyS | 253,150 | createSpawnFunction |
| C7nJwi7_ | 1,302,496 | session_updated coalescer NG |
| C7nJwi7_ | 160,692 | ToolPermissionBroker 类 Yd |
| C7nJwi7_ | 249,986 | respondToToolPermission |
| C7nJwi7_ | 517,856 | SSH reattach checkpoint sink qb |
| C7nJwi7_ | 1,830,137 | handleSshReattachOutcome |
| C7nJwi7_ | 1,841,319 | completeSshReattach |
| C7nJwi7_ | 1,860,645 | setupSshPluginsAndMcp |
| Down-gfq | 2,491 | reattach eligibility predicate m |
| BT1aFaVF | 475,918 | McpProxyCoordinator 类 QC |
| BT1aFaVF | 482,664 | createAllServers |
| BT1aFaVF | 483,511 | createStdioProxyServers |
| BT1aFaVF | 488,987 | planHostRunServers |
| BT1aFaVF | 492,977 | guardAndSealForSdk |
| BT1aFaVF | 498,868 | callRemoteTool |
| Ca-EeaV6 | 6,087 | host-run MCP config planner U |
| Ca-EeaV6 | 7,144 | host-side disabled-tool planner K |
| QB4E341u | 14,945 | SshMcpServerManager 类 |
| QB4E341u | 15,239 | createProxyServers |
| QB4E341u | 16,882 | SSH MCP connection creation |
| BRvO7fVg | 539,598 | typed EIPC contract factory uo |
| BRvO7fVg | 1,880,593 | LocalAgentModeSessions event validator LMt |
| BRvO7fVg | 1,964,415 | LocalAgentModeSessions EIPC contract wv |
| BRvO7fVg | 2,012,533 | trusted-origin / top-frame guard Ov |
| BRvO7fVg | 6,649,574 | main-view event forwarding L2a |

## 2. 核心结论

1. Desktop 的 SSH “恢复”不是简单地从 transcript 冷启动，而是**尝试接管一个仍在远端运行的 CLI 进程**。接管需要同时证明 host、process、CLI policy、launcher、person、hooks、permission mode 和 MCP 运行方式仍兼容。
2. Desktop 把远程进程重连设计成带 sequence replay 的流恢复协议：stdout checkpoint 对齐到行边界，stdin 通过 byte offset 处理重发，replay slot 控制恢复流量；若 replay gap 无法安全对齐，则放弃接管或从下一行恢复。
3. persisted adoption 比同一进程存活期间的 transport rebind 更严格。canReattach 只要求 process.reattach；supportsProcessAdoption 还要求 process.killAndWait 与 process.stdin.offset 能力。
4. SSH MCP 并非单一桥接。代码同时存在 host-run stdio、SSH-spawn stdio proxy、remote connector proxy、direct connector pool 和 in-process/internal server。它们有不同的生命周期、信任边界和权限入口。
5. Desktop 权限控制不是只靠 UI 卡片：ToolPermissionBroker 创建和等待权限请求，SDK hooks / canUseTool 承接决策，MCP transport gate 再对实际工具调用做二次授权和 schema / advertisement 检查。
6. renderer event 是经过 schema 和 origin 检查的 IPC 通知流；session snapshot / transcript query 是独立的恢复入口。源码未见该 event 通道的 ack / cursor / replay，因此不能把它视为可靠事件日志。
7. SSH helper / daemon 的服务端实现未包含在本轮可读 JS 中。客户端传入的 offset、replay、killAndWait 参数只能证明协议调用形态，不能单凭客户端证明服务端 ring buffer、stdin 去重或 kill-and-wait 的物理语义。

## 3. RemoteProcess：SSH 进程接管与流恢复

### 3.1 对象与启动流程

RemoteProcess（C1QWjcyS 中 Ct）持有独立的远端 process ID、RPC client、stdin / stdout / stderr PassThrough、sequence 游标、stdin buffer、detach / rebind timer、replay buffer 和 checkpoint sink。

- 新建时生成随机 process ID，并注册 stream:<id> 事件监听器。
- 接管时使用持久化 process ID；初始化为 reattachPending=true、killGuarded=true、ignoreFrames=true，避免尚未确认所有权时把新连接上的帧直接交给调用方。
- spawn() 的顺序是先 reapOrphans()，再走 reattachOrSpawn() 或 spawnFresh()。
- reattachOrSpawn() 用 _adoptInFlight 防止同一个对象并发执行两次 adoption。
- adoptOrSpawn() 为 replay 申请共享 slot；如果已有其他 reattach 在恢复输出，则等待 slot。slot 最多等待 30 秒、持有最多 60 秒；释放前还会等待 replay 输出 drain，最长约 20 秒、按 50ms 轮询。

这说明远端 process supervision 是独立于 Session metadata 和 transcript 的一层。Session 负责记住 process handle 与策略指纹；RemoteProcess 负责实际连接、帧序列、stdin 和退出。

### 3.2 reattach 协议和 fallback

客户端调用 process.reattach({id, fromSeq})，并校验返回对象至少具有 boolean found、boolean running；当 found 为 true 时要求 lastSeq 是安全整数。服务端回复中还可能带 firstSeq、stdinApplied。

分支如下：

- found=false 或 running=false，或者 replay buffer 已经看到 exit：若是 adopt-only 背景恢复，则结束本地 adoption，不启动新进程；若 owner 已要求结束，也不 fresh-spawn；普通前台恢复则转为 fresh process。
- fresh-spawn 前先生成新 ID、重新绑定 stream listener，并发出 reattach-outcome（携带 freshId）。只有该事件 listener 成功后才真正调用 spawn；listener 抛错会阻止新进程启动，避免“远端已启动但 Session 没记下新 ID”。
- replay window 与 checkpoint 不匹配、缺少 firstSeq、checkpoint malformed 或发现 ring gap 时，不会盲目把字节流接到一起；代码会判断能否安全恢复，否则报告 unadoptable。
- replay 确认后，客户端处理 reattach 期间提前到达的帧、丢弃 replay 会重新发送的重复帧、设置 announcedHighSeq / replayHighSeq，seed stdin offset，然后 flush 缓存 stdin。

adoptOnly 是一个重要区分：后台 session 的“检查远端进程是否还活着”不应因为找不到进程就自动创建一个新 CLI；前台恢复才允许按状态 fallback 到 fresh process。

### 3.3 stdout sequence 与 line-aligned checkpoint

stdout checkpoint 不简单等于“最后收到的 frame sequence”。代码同时跟踪：

- _lastSeq：已处理的最大 stream sequence；
- _alignedSeq：最后一个可以安全恢复的行边界 sequence；
- _deliveredSinceAligned：当前 frame 中已经交付、但尚未跨过完整换行边界的字节数；
- _replaySkipBytes：重新 replay 时应跳过的已交付前缀；
- _announcedHighSeq / _replayHighSeq：远端声明的输出高水位。

当 stdout 行缓冲区清空时，checkpoint 可以前进到当前 sequence；如果 frame 尾部留下未完成行，则 checkpoint 保持在前一条完整行，并记录已交付的字节偏移。重新接管时从上一条完整行之后 replay，再跳过已交付前缀，避免重复向上层输出半行。

超过 16 MiB 的单行会进入 raw-until-newline 路径；在回到换行边界前，不提供可用 replay checkpoint。replayCheckpoint 在以下情形返回 null：gap-survive 未启用、仍处于 reattach、存在 replay skip、或正在 newline resync。

outputCaughtUp 也不只检查 lastSeq：还要求 reattach / rebind buffer 清空、lastSeq 达到 announcedHighSeq、stdout 行缓冲为空、非 raw 模式且 PassThrough readableLength 为零。这是一个有价值的“恢复已追平”判据。

### 3.4 gap 的处理不是一律丢弃，也不是一律接受

若 helper 返回 firstSeq 大于 checkpoint seq + 1，客户端发现 replay gap。代码根据进程是否退出、是否已经请求 kill、gap-survive feature、是否有 reattach-gap consumer、是否处于 raw mode 等判断：

- process 已退出、owner 已请求 kill、gap-survive gate 关闭、没有 gap consumer 或 raw mode：放弃接管。
- 允许 survive 的情形：把 stdout partial-line buffer 清空，将游标移到 firstSeq 前，开启 resync-to-newline，丢弃不完整行直到下一个换行，再继续接管，并发出 reattach-gap 事件。

这是一种“宁可明确丢弃不完整行，也不把断裂字节拼成伪造 JSONL / 文本行”的保守策略。它并不保证 gap 内的信息可恢复；只是把损坏范围限制在一个可观察的 gap 和行边界。

### 3.5 stdin offset 与 checkpoint write barrier

stdin 每个待发 chunk 带单调递增 byte offset。远端回复 stdinApplied 后，客户端会把缓冲区中已被远端确认的前缀移除，并从确认位置重新编号剩余 buffer。客户端因此具备“按 offset 重发”的协议基础；**服务端是否严格去重仍需要 helper 源码或动态测试证明**。

更重要的是，sendStdin 之前会执行 checkpointBarrierBeforeStdin：

1. 读取当前 stdout replay checkpoint。
2. 调用 Session checkpoint sink。
3. checkpoint sink 写回 sshReattach.checkpoint、inputSent、remoteControl 等状态。
4. 等待该次 sink 及前一次 barrier 的 Promise 后再发 stdin。

Session 侧 qb 只有在当前 Session 仍对应同一个 process ID 时才写入 checkpoint，并触发 persistence flush。这样设计的目标是：先持久化恢复点，再发送可能引起新输出的输入，降低 app crash 后 Session checkpoint 落后于远端执行的窗口。

但这个 barrier **不是严格 fail-closed**：checkpoint sink reject 会被捕获并记录，随后 stdin 仍可继续发送。因此“正常路径先持久化后发送”是源码事实；“任何故障下都保证输入与 checkpoint 原子一致”不是事实。若要达到强一致，需要重新设计失败时禁止发送、事务化 checkpoint+input、或由远端持久化 input sequence 的协议。

关键 buffer 上限包括：stdin buffer 16 MiB、单次 stdin chunk 256 KiB、stdout 行上限 16 MiB、rebind frame buffer 64 MiB。达到限制时进入 backpressure、分块或 raw / resync 路径；不能把它们理解成无限缓冲。

### 3.6 detach、keep-live 和 orphan reaper

Transport close 不等于远端进程退出。RemoteProcess 进入 detached 状态并按策略安排 rebind：

- 普通进程有 15 分钟 reattach grace，超时后 abandon。
- keep-live-remote 情况下不会按普通 grace 自动 abandon，而是按 1 分钟起、指数增长到 30 分钟的间隔发出 rebind-wanted。
- app exit 时 keep-live-remote 的 kill 请求可被忽略，远端进程被有意保留，以便之后重新接管。

新 spawn 前会执行 orphan reaper。Session 持久化的 sshOrphanProcesses 是有界账本，最多保留 4 个不同 process ID；添加新记录时优先淘汰未确认 spawn 的旧项，否则淘汰最旧项。记录携带 hostKey、abandonedAt、spawnConfirmed 和可选 daemonInstanceId。

reaper 只处理当前 hostKey 的 orphan，并调用：

- helper 支持 killAndWait 时：process.killAndWait，默认等待约 3 秒，RPC timeout 约 15 秒，可能携带 farewell grace；
- helper 明确不支持时：退回 process.kill(SIGTERM)；
- capability 为 unknown 时：尝试 killAndWait，只有遇到 method-not-found 类错误才退回 legacy kill；其他 RPC error 保留记录。

settle 逻辑区分同一 daemon / foreign daemon：RPC error 不删除；found 且仍存活不删除；legacy kill 或确认 died 后删除；not-found 若来自同一 / 未知 daemon 可清理，若来自 foreign daemon 则暂留，超过约 1 小时才允许清理。这样可避免因 helper 实例切换，在错误 daemon 上“查无此进程”就误删 orphan 账本。

### 3.7 capability 的两级门槛

RemoteServerController 有 capability handshake。源码可见：

- canReattach()：只看 process.reattach method 是否可用，用于已有 RemoteProcess 的 transport rebind。
- supportsProcessAdoption()：要求 process.reattach、process.killAndWait，并且 process.stdin.offset feature 可用，用于持久化 Session 的跨连接 / 跨启动 adoption。
- legacy capability fallback 只声明 process.reattach，features 为空。

因此“当前连接断了还能重新接回同一进程”与“应用重启后可以安全接管并清理该进程”是两个不同能力等级。新系统应把这两个能力分开建模，而不是一个 boolean supportsResume。

**未知：** helper 服务端如何维护 sequence ring buffer、何时回放、stdinApplied 的 durable / volatile 边界、killAndWait 对 process tree / job object 的保证、daemonInstanceId 生命周期。当前 bundle 只提供客户端调用和能力协商证据。

## 4. Session 持久化 adoption：策略指纹和接管后安全收敛

### 4.1 persisted handle 不是单纯 PID

Session 的 sshReattach 记录包含版本、processId、hostKey、checkpoint、midTurn、remoteControl、CLI 是否会重应用 hooks、policySig / policyInputsSig、managed launcher signature、person identity、hookSig、MCP-on-host 状态、MCP env blanked 信息、project config root、host checks、named CLI session ID、off-tools pinned 状态、recordedAt 和 adoption state 等。

process ID 必须与 Session 当前 sshRemoteProcessId 一致；hostKey 必须一致。旧记录还可能被标成 blocked 或 reap_only，或带 stopOwedAt，分别阻止 adoption / 表示只允许清理。

### 4.2 adoption eligibility 是多维安全比较

Down-gfq 的 predicate m 逐项检查：

1. adoption feature flag 开启；
2. 不是 fork session；
3. backend kind 是 SSH；
4. 存在 handle；
5. handle processId 与当前 session process ID 匹配；
6. handle 不是 reap_only，且没有 stopOwedAt；
7. 当前 person identity 与记录一致；
8. policyInputsSig 与当前策略输入一致；
9. remote managed launcher signature 一致；
10. handle 未被标记 blocked；
11. hostKey 一致；
12. helper 具备完整 process-adoption capabilities；
13. remote cwd 不缺失；
14. 不存在未解决的 remote-control binding；
15. remote-control 若曾启用，必须满足 relatch / coverage 条件；
16. 在需要重启 MCP-on-host 的策略下，MCP-on-host 模式不能变化；
17. 若 CLI 不会自行 reapply hooks，则 hookSig 必须匹配；
18. policySig 必须匹配，或命中明确兼容的前一 build 规则。

policyInputsSig 不是单一 permission mode：它包含 managed settings、managed additional directories、managed tool policy（disallowed / allowed tools、tool aliases、settings）、auto mode policy、bypass permission availability、projectConfigRootOff、reserved admin server names 和相关 MCP hook 规则。policySig 另对 raw managed config 做摘要。两者共同防止“旧进程在新策略下被静默接管”。

### 4.3 接管成功不代表可以立即释放消息

handleSshReattachOutcome 收到 reattached 后会进入 adoption settling。completeSshReattach 继续做收敛：

- 检查 CLI initialize / session state。
- 确认 hooks 已应用，或确认当前 hook signature 与记录兼容；不安全时阻止 adoption。
- 比较远端当前 permission mode 与 Desktop 当前模式，尝试把远端收紧到 Desktop 要求的级别；若 CLI 不接受安全的收紧，不继续把它当成已接管 session。
- reconcile remote-control 状态。
- 刷新 host MCP server list 和 tool permission / disabled-tool rules。
- 恢复 model、effort、auto-mode 等由 Desktop 控制的 session 设置。
- 处理 held messages / queued input，并在安全检查通过后才释放。

这是非常重要的架构分层：process 连接成功只代表 transport / process continuity；**Session adoption 还必须通过 policy、hooks、permission、remote control 和 MCP reconciliation**。

### 4.4 adoption 失败与 fresh process

not_found / exited 与 unadoptable 不是同一状态。前两者意味着旧进程不存在或已结束；前台 Session 可以创建 fresh process，并先持久化 replacement ID。unadoptable 意味着旧进程仍可能存在但不能安全接管，后续路径会阻止继续沿用旧执行上下文，并按 foreground / background 状态安排 stop/restart 或保留清理义务。

背景 adopt-only 路径尤其保守：不能把“旧进程没找到”解释成“应该自动重新执行之前的 prompt”。

## 5. MCP 拓扑：部署位置、调用路径与权限面分离

### 5.1 McpProxyCoordinator 的组成

McpProxyCoordinator（BT1aFaVF 中 QC）不是一个简单 MCP client。它协调：

- local stdio servers；
- SSH stdio proxy servers；
- remote connector / proxy servers；
- direct connector pool；
- in-process / internal servers；
- host-configured MCP server state；
- 每 Session 的 tool gate 和 server reconciliation。

createAllServers 会并发构建 local stdio 与 internal servers，并用 per-session build token 防止较早的异步构建结果覆盖较新的配置。reconcileServers 对 server set 做 diff，按类型复用、替换或关闭，不是每次全量重启。

### 5.2 SSH stdio 的两条路径

**路径 A：host-run laptop servers**

当 SSH host / Windows OpenSSH 等能力与 feature 配置允许 laptopServersRunOnHost 时，planHostRunServers 将一部分 laptop MCP config 发送给远端 CLI 直接启动。

host-run planner 会排除：
- Desktop extension MCP；
- 指向 laptop 本地绝对路径、不能在 host 解释的 command；
- 已经在 host 配置的同名 server；
- host admin-only 策略不允许用户注入的 server。

环境变量经过 secret filtering；被 withholding 的环境 key 会以空值覆盖，避免从 laptop 把不应透传的认证信息泄露到 host。host MCP tool rules 会根据 host server list、laptop server names、approved tools、enabled tools 和 permission mode 计算 disabled-tool set，尽量保持 Desktop 和 host CLI 的工具授权一致。

**路径 B：SSH-spawn proxy**

当不走 host-run 路径时，SshMcpServerManager 会通过 RemoteServerController.spawnAuxProcess 在 SSH host 上启动 stdio MCP command，再以 MCP Client / StdioClientTransport 建立 JSON-RPC 连接，并包装成 SDK 可消费的 proxy server。

连接按 hostKey + serverName 管理，pending connect 去重；断开后标记 disconnected，后续 tool call 可重新连接。它会过滤不能在远端运行的 extension / local-path server，也尊重 host admin-only 限制。该路径与“把 MCP config 交给 CLI 自己启动”不同：前者由 Desktop 管理远端 MCP 子进程并代理调用，后者由 host CLI 管理进程。

### 5.3 其他 MCP 面

- remote connector proxy：通过 ProxyMcpServerManager 把远程 connector tool 映射为 SDK MCP server。
- direct connector pool：对直接授权的 connector 维护独立连接池和工具调用路径。
- internal server manager：注册 Desktop 内部能力；不等同于用户配置的 stdio server。
- name collision / reserved names：Coordinator 对 reserved/admin server names、direct pool collisions、ambiguous names 做筛选，避免同名 server 的 tool call 落到不确定目标。

### 5.4 MCP 工具调用的双重 gate

guardAndSealForSdk 不只是给 SDK 填 canUseTool。它会对 in-process server 做 wrapper，并在 transport 层拦截 tools/list 与 tools/call：

- 先收集该 server 实际 advertise 的 tool names；
- tool call 必须匹配已 advertise 且无歧义的工具；
- 调用 per-session gate 做授权；
- abort / cancel notification 能传递到受控调用路径；
- 同一底层 MCP server instance 不允许被多个 Session 无隔离共享。

callRemoteTool 对不同类型再分流。直接 connector 调用会重新检查 tool 是否 disabled、是否需要 ask，并在用户批准后重新 resolve server / tool，降低等待期间配置变化造成的 TOCTOU；local MCP 还会检查 transcript rows 是否来自其他机器，避免不可信历史记录触发本地 MCP 工具。

设计含义：**server transport、tool identity、permission decision 和 session ownership 必须分层**。只在 UI 层显示 approval card，而不在调用入口再次校验，不足以形成完整安全边界。

## 6. ToolPermissionBroker：权限请求与授权结果

ToolPermissionBroker（C7nJwi7_ 中 Yd）持有 pendingPermissions map。一次 ask 会生成 requestId，保存 sessionId、toolName、input、suggestions、decisionReason、agentID、connectorAsk、是否仅允许在 card 上批准、是否禁止通知面批准等上下文，并向 Session event emitter 发出 tool_permission_request。

请求会监听 AbortSignal；signal abort 时从 pending map 移除并 resolve deny。还会建立 stall telemetry timer（约 5 分钟）和 pending card re-notify timer。session 关闭时 clearPendingPermissions 会撤销未完成请求并对相关调用返回 deny。

respondToToolPermission 不会无条件接受 UI 的 allow：

- requestId 必须仍在 pending map；
- onlyOnCard 的请求不能从 notification / 其他 surface 允许；
- 禁止 allow 的工具即使用户选择 allow 也会转成 deny；
- suppressAlwaysAllowRule / defaultToNo / connectorAsk 等条件会把 always/scheduled 降级为 once；
- card 修改后的 input 会经过格式 / 长度 / 内容约束校验，不能安全应用时拒绝本次调用；
- 只有存在可持久化 suggestion 时才记录长期规则；
- 权限更新会经 project-config-root fence 处理，必要时补充 deny rule，防止一次权限批准意外开放项目配置目录写入。

另有 SessionPromptAnswers 层负责在 permission response 可能扩大 project config 写入范围时先检查 fence 是否已建立；若检查期间 session/query 发生变化，则不把旧答案套到新 query 上。

这证明 Desktop 的权限 broker 是有状态、带 request correlation、可取消、能区分一次批准与持久授权的服务，不是单纯的 modal UI。

## 7. Session event IPC：通知流与状态恢复分离

### 7.1 EIPC contract

BRvO7fVg 的 uo 工厂声明 IPC methods、stores 和 events，集中做参数 / 返回值 schema validation，并按 webContents 建立 dispatcher。LocalAgentModeSessions contract 暴露 start、sendMessage、stop、setModel、setPermissionMode、getSession、getAll、getTranscript、getTranscriptRead、setMcpServers、mcpCallTool、respondToToolPermission 等方法；事件包括 onEvent、onToolPermissionRequest 等。

Ov 检查 senderFrame 必须是 main frame，且 origin 位于受信任的 claude.ai / claude.com / app://localhost 等范围（开发 override 另有条件）。因此不是任意 iframe 都能调用该 contract。

### 7.2 LocalSessionManager 的 event ordering

LocalSessionManager extends EventEmitter，并覆盖 emit：每次 event emit 前先调用 sessionUpdates.aheadOf。NG coalescer 对 session_updated 做 microtask 合并：

- 同一 session 在一个 microtask 周期内只保留最新 formatted snapshot；
- 使用 fingerprint 判断是否与上次发送重复；
- 非 session_updated event 到来前 flush 已持有的 session update，尽量维持事件顺序；
- flush 可发 sessionSettled 标志；
- 对 parked / hidden prewarm session，部分 event 会被 swallow 或暂存，恢复可见时再按专门路径处理。

main process 的 event listener 再通过 LocalAgentModeSessions dispatcher 将 onEvent 发给 mainView webContents。L2a 捕获 dispatch 异常并记录日志。

### 7.3 event 不是 durable event log

EIPC 的 onEvent 使用 LMt 做结构校验，要求 event object、type、sessionId 等基本字段，并对部分可选字段检查形状；但它不是按每个 event type 定义的严格 discriminated union，某些数组元素也没有深入 schema 校验。

更关键的是，本轮可见的 onEvent dispatch 是 webContents send 通知；没有看到 ack、consumer cursor 或断线 replay。与此同时 contract 提供 getAll / getSession / getTranscript / getTranscriptRead 等 snapshot/read APIs。最稳妥的解释是：

- event 用于让 renderer 及时更新 UI；
- session snapshot / transcript query 用于启动或失联后的重新 hydrate；
- 不能把 renderer 是否收到每个 event 当成 transcript / session 的 durable commit；
- 也不能仅凭 event dispatch 成功推断 renderer 已消费。

这是对新架构很重要的边界：持久化事实和 UI notification 不应共享一个可靠性假设。

## 8. 设计评价：可借鉴之处与代价

### 可借鉴

1. **Process identity 独立于 Session identity。** 远端进程有独立 ID、host key、daemon identity、sequence cursor；Session 只持有可验证的 adoption handle。
2. **Cold resume 与 hot adoption 分离。** 从 transcript 启动新 Agent 和接管仍在运行的进程是两个完全不同的恢复操作。
3. **Replay checkpoint 要考虑 framing。** 对行协议而言，完整行边界比最后收到的字节更适合作为持久化恢复点。
4. **stdin 和 stdout 使用不同的确认模型。** stdout 是 sequence replay + skipBytes；stdin 是 byte offset + remote applied watermark。
5. **Adoption 需要安全指纹。** host、person、policy、launcher、hooks、permission mode、MCP mode 都参与兼容性检查。
6. **连接成功后仍有 settle phase。** 恢复 hooks、permission、remote control、MCP 和模型配置后才释放 held input。
7. **Orphan cleanup 必须识别 daemon 身份。** 不应在错误 host / daemon 上用一次 not-found 就清理远端 process ledger。
8. **MCP gate 应位于 transport / call boundary。** UI ask 不是最终授权点；每个 server / tool call 仍需核对 advertise、identity、session 和 policy。
9. **Renderer events 与 durable state 分离。** 通知可以丢失，恢复依靠可查询的 session / transcript snapshot。

### 代价与风险

1. RemoteProcess、Session、SSH helper、MCP Coordinator、PermissionBroker 和 renderer EIPC 形成多层状态机，跨层 failure mode 很多；维护成本显著。
2. checkpoint barrier 当前 fail-open：持久化失败后仍可能发送 stdin。若系统要求强 crash consistency，这一语义不足。
3. replay gap resync 可能丢失不完整行；它是损失可见化与边界保护，不是无损恢复。
4. orphan ledger 只有 4 个不同 process ID 的容量；若超出容量，旧 orphan 可能被淘汰且不再由该 Session ledger 清理。
5. helper 服务端不在可读材料中，无法证明 replay ring buffer、stdin dedupe、process tree kill、job object 和 daemon identity 的真实语义。
6. MCP 多拓扑让配置同步、工具名冲突、host/laptop policy 对齐和 server lifecycle 变复杂。新系统若采用类似设计，必须明确每个 server 的执行位置和 authority source。
7. renderer event validator 的结构检查比 event-specific schema 弱；未来若把它作为跨进程公共协议，应收紧为 discriminated union，并加入版本协商。
8. 当前 event channel 无 ack / cursor；若将来需要 UI consumer 可靠追赶，应新增 sequence / cursor 或明确使用 snapshot reconciliation，而不是假设 Electron IPC 发送即消费。

## 9. 事实 / 推断 / 未知分级

### 源码已证实

- Desktop 客户端存在 process.reattach、process.killAndWait、process.stdin.offset capability 检查。
- RemoteProcess 具有 sequence replay、line-aligned checkpoint、stdin offset buffer、gap resync、replay slot、orphan reaper 和 fresh ID handover。
- Session 持久化 sshReattach handle，并在 checkpoint sink 中保存恢复点。
- adoption eligibility 比普通 rebind 更严格，包含 host / person / policy / launcher / hooks / permission / MCP 等兼容性条件。
- reattach 成功后有 hooks、permission mode、remote control、MCP 和 Session config settling。
- MCP 存在 host-run、SSH stdio proxy、remote connector proxy、direct pool、internal server 等不同路径。
- ToolPermissionBroker 持有 pending request 并将用户决策转成 SDK permission result / persisted rule。
- EIPC 有 origin guard、schema validation、per-webContents dispatcher；LocalSessionManager coalesce session_updated；renderer 可通过 snapshot API 重新读取状态。

### 推断（尚未动态验证）

- line-aligned checkpoint 是为了避免恢复时把 partial JSONL / text frame 交给上层；源码行为支持这一解释，但没有运行时 crash test。
- checkpoint barrier 的意图是降低远端输入已执行而本地 checkpoint 未保存的窗口；由于失败 fail-open，它不是完整原子提交。
- renderer event 丢失后主要依赖 getAll / getSession / getTranscript hydrate；这是由接口和 dispatch 形态推导，不等于已验证所有 UI 页面都执行完整恢复。
- host-run MCP 的 disabled-tool set 是为了保持 Desktop / host policy 一致；需结合 CLI host-side 消费路径继续核验最终执行效果。

### 未知 / 资料缺口

- SSH helper / daemon 的 server-side source、sequence ring buffer 实现、stdin offset dedupe 与 killAndWait 保证。
- daemonInstanceId 如何生成、持久化和跨 helper upgrade 变化。
- app crash / OS crash / network partition 下 checkpoint + input 的真实时序。
- 远端 MCP server process 是否在 Windows job object、SSH host restart、Desktop app exit 后被可靠清理。
- permission broker / MCP gate 在真实用户交互、工具副作用和并发请求下的行为。
- event 发送失败、renderer reload、账户切换、parked session 的全量恢复行为。
- 上述任何路径都没有在本轮运行真实 Desktop / SSH / CLI 或故障注入。

## 10. 下一步

1. **完成 Desktop / SDK 剩余生命周期：** local process spawn 与 SSH process path 对照；SDK query options / hooks / canUseTool 与 Desktop broker 的完整注入关系；stop / cancel / idle / exit / restart 的状态矩阵；Session metadata / transcript 的本地恢复路径。
2. 获取或定位 SSH helper / daemon 的服务端源码或可验证协议规范；若不可获得，明确把 replay / offset / kill semantics 留为未知，不用客户端推测填补。
3. **随后固定 Pi Agent Core 的上游 commit 与发布包**，从真实源码追 Agent loop、event stream、tool execution、context transform / compaction、session tree、extension hooks、cancel 和 error handling。历史报告 30–31 的隔离 fake tests 不能代替本轮源码核对。
4. 完成 Claude CLI、Desktop / SDK、Pi 的同场景对照矩阵后，才进入独立目标架构设计；设计交用户审阅，明确批准前不进入开发。

## 11. 本轮边界

本报告只新增研究文档与进度记录。没有创建 Agent loop、适配器、工具执行、Session store 或 Kernel 实现；没有修改任何业务代码；没有提交开发 PR。