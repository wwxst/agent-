# 44 · Claude Remote Agent 云端 Session 生命周期与恢复

> 日期：2026-10-30  
> 样本：Claude Code CLI 2.1.304 发布版 JavaScript（build 2026-10-19，git SHA 17ab70404e5b632fe060207effb0b440788363ba）。  
> 方法：直接复核 Agent Tool remote launch、cloud session create、remote task registry/sidecar、event polling、permission relay、resume 与 TaskStop；**静态源码研究**，未创建真实 cloud session、未执行真实 remote agent、未断网/崩溃注入。  
> 前置：[报告 42：Subagent 生命周期](./42-Claude-Subagent生命周期所有权停止与恢复-2026-10-30.md)、[报告 43：上下文压缩与 Agent Resume](./43-Claude-CLI上下文压缩与Subagent恢复连续性-2026-10-30.md)。

## 0. 核心结论

CLI 2.1.304 中的 Remote Agent 不是 local_agent 的远程执行版本那么简单。它走另一套对象模型：

- Agent Tool remote branch 创建一个独立 Cloud Session，source 为 remote_agent；
- 本地 TaskRegistry 注册的是 type=remote_agent 的 task record，而不是 local_agent / W7 loop；
- 本地 sidecar 保存 cloud session ID 与 task metadata；
- 本地 K3t poller 通过 cloud session events API 观察远端执行，写本地 output file；
- CLI resume 时由 MQt/O8o 读取 sidecar、查询 cloud session status、重建 task record 并重新启动 poller；
- TaskStop 将本地 task 标记 killed，异步请求 archive cloud session，再停止 poller 并删除 sidecar。

因此需要区分三个概念：

1. **Local Subagent resume**：读 Agent JSONL + metadata，创建新 W7 loop（报告 42/43）。
2. **Remote Agent task restore**：读 remote-agent metadata sidecar，重新连接已有 Cloud Session 并恢复 event polling。
3. **Worker adoptedPrefill**：在 worker handoff 中链接/接管 local Agent transcript 与 Shell process；它不是 Remote Agent Cloud Session restore 的同一条路径。

本轮发现两个值得进一步动态验证的恢复风险：
- remote task metadata 不保存 event cursor；恢复后的 poller 从 null cursor 开始，而 output writer 是 append-only，若 events API 从头返回历史事件，output file 可能重复追加；
- restore 遇到 session_status=archived 时直接删除 metadata 并跳过，不拉取 terminal events，也不补发 task notification；如果远端已结束而本地尚未消费结果，可能丢失本地完成通知。远端 archived 的业务语义尚未通过 API contract 或动态测试确认，因此这是源码风险，不是已复现 bug。

## 1. Launch：Agent Tool 创建 Cloud Session

### 1.1 Eligibility gate

Agent Tool 的 remote branch（chunk-461kpb1a.js @29,841）：
1. 根据 Agent definition / isolation policy 得到 isRemoteLaunch；
2. 调用 rPe 做 cloud session eligibility 检查；
3. 不 eligible 时返回具体原因，不进入本地 W7；
4. eligible 后调用 hN 创建 Cloud Session，传入 initialMessage、title/description、cwd/repository、branch、model、permission mode、source=remote_agent 与当前 Agent Tool AbortSignal；
5. session create / first-message handoff 成功后调用 nUe 注册本地 remote_agent task；
6. 返回 remote_launched，附 taskId、Cloud Session URL 与本地 outputFile path。

Eligibility 会检查 first-party cloud session provider、claude.ai OAuth、组织 allow_remote_sessions policy、Git repository、GitHub remote / Claude GitHub app 等。Cloud sessions 不是任意 MCP 或任意第三方远端 worker 的通用代理接口。

### 1.2 Cloud Session create 与初始 prompt

hN（chunk-4b60tdnk.js @2,073,363）：
- 创建独立 cloud code session；
- create request 带 AbortSignal；
- 使用 source=remote_agent 和初始 prompt / branch / model / permission 配置；
- 需要时由 Ntr（@2,061,839）发送 held first message；
- 在创建或初始消息发送阶段检测 signal abort；Ntr 的 abort 路径会尝试 archive 已创建 session。

hN 返回后，Agent Tool 调用 nUe。此后执行控制权不再是本地 Agent W7，而是 remote task manager + cloud session polling。

## 2. Local remote_agent task record 与 sidecar

### 2.1 TaskRegistry record

nUe（chunk-4b60tdnk.js @1,722,676）：
- 生成 remote_agent task ID（ID prefix r）；
- 用通用 yb 创建 task record；
- 设置 type=remote_agent、remoteTaskType、status=running、sessionId、command、title、todoList、toolUseId、pollStartedAt 与 task-specific flags；
- 注册 TaskRegistry；
- 调用 q3t 写 metadata；
- 启动 K3t poller；
- 返回 taskId/sessionId/cleanup。

通用 yb（chunk-1d8rv4vy.js @2,100）创建的基础 record 包含 id/type/status/description/toolUseId/startTime/outputFile/outputOffset/notified；nUe 没有给它添加 local_agent 的 parentAgentId、ownerAgentId、spawnDepth 或 Agent transcript path。

这说明 Remote Agent task 与报告 42 的 local_agent parent/owner/keepalive tree 是不同对象模型。Remote task 可被 TaskStop 单独停止，但不应假设它自动成为 local_agent descendant。

### 2.2 Metadata sidecar

chunk-4b60tdnk.js：
- remote-agent metadata 位于当前 local session 的 remote-agents 目录，按 taskId 保存独立 .meta.json；
- Storage V5 可用时使用 sidecar namespace；文件系统路径作为 fallback；
- vTs（@334,070）写 sidecar，Storage V5 publishDiscipline 为 inPlace；
- kTs（@334,793）列出/读取 sidecar；
- q3t（@1,714,418）捕获写入错误并记录 warning；
- **nUe 不 await q3t**，task registry 与 poller 可以先继续运行。

Metadata 记录 taskId、remoteTaskType、sessionId、title、command、spawnedAt、toolUseId、runId、isUltraplan/isRemoteReview/isLongRunning、review/apply-fixes 参数与 remoteTaskMetadata。未看到 lastEventId / event cursor 字段。

风险：若 sidecar 写入失败，远端 session 与本地 poller 仍可能在当前进程运行，但进程重启后没有 metadata 可用于恢复。该写入不是任务创建的强制提交门槛。

## 3. K3t：远端 event polling、输出与权限中继

### 3.1 Event cursor 与 output file

K3t（chunk-4b60tdnk.js @1,725,911）维护进程内 cursor：
- 初始 lastEventId = null；
- 每次调用 dTe(sessionId,lastEventId,{skipMetadata,credentials})；
- dTe（chunk-ypk19ctb.js @677,947）向 /v1/code/sessions/{id}/events 请求 sort_order=asc，带 cursor 时从 cursor 继续；单轮最多翻 50 页，并以 sequence_num 更新 lastEventId；
- 有事件时将 assistant text 与其他 event serialization 合并，通过 bXe 追加到本地 task output file；
- W3t 更新 task todo/progress；
- K3t 以约 1 秒间隔继续 poll，直到 terminal / blocked / local stop。

Task output writer（chunk-fh15xze1.js）：
- tu(taskId) 解析 session-scoped task output path；
- bXe → ge(taskId).append；
- eKn 最终通过 file handle appendFile 写入；
- writer 有 flush/retry/size cap，但不是 remote session transcript 的镜像，也不是完整 Agent JSONL。

**恢复风险：** lastEventId 只在 K3t closure 的内存变量 nn 中，不写入 remote-agent metadata。O8o 恢复后重新调用 K3t，cursor 再次为 null；dTe 默认 sort_order=asc 且无 cursor 时从 API 默认起点取事件，output file 则继续 append。若 events API 从头返回既有历史，resume 会重复追加旧 event 文本。API 默认 cursor 语义与真实输出重复行为需要动态验证；源码足以确认 cursor 没有被持久化、writer 使用 append。

### 3.2 Terminal state

对普通 remote-agent：
- event type=result 会被记录到 an；
- result subtype=success → completed；其他 subtype → failed；
- session_status=archived 且不是 remote review 时，直接标记 completed、发 task notification、flush output writer、删除 metadata；
- session_status=idle 但没有 result event 时，不会仅因 idle 自动完成；generic remote-agent 仍可保持 running/starting 并继续 poll。

Remote review、Ultraplan、long-running 与 remote-workflow 有额外状态分支，不能把它们全部等同于普通 remote-agent。

### 3.3 Permission relay：远端工具请求如何回到本地权限上下文

普通 remote-agent 的 K3t 会处理 control frames：
- control_cancel_request：abort 对应 pending relay；
- control_response：记录已有本地响应并撤销 relay；
- control_request：检查是否可以安全 relay 到本地 canUseTool。

I8o（@1,724,880）构造 synthetic tool_use，并调用本地 canUseTool，设置 forRemoteExecution=true。只有本地 permission decision 为 allow 才把 updatedInput 回传远端；ask/deny 均转为 deny。

不能 relay 的情况包括：
- local session non-interactive；
- request 没有 request_id；
- requires_user_interaction；
- 命中 ask rule 或决策原因不是允许自动 relay 的类别；
- tool 不在当前 Agent tool pool；
- MCP / skill / workflow / plan 等不支持的工具类别；
- input invalid 或与本地验证后的 input 不一致；
- pending relay 数超过上限。

代码会在一定等待窗口后尝试 relay；如果 cloud session 持续要求本地无法回答的输入（尤其 MCP server question），达到阈值后将 task 标记 blocked，并给出 Cloud Session URL，要求用户在 cloud session 里回答。Remote Agent 并没有任意把远端 permission prompt 弹回本地用户交互层的能力。

## 4. Restore：重连 Cloud Session，不重启远端 Agent Loop

### 4.1 Restore entry

MQt（chunk-4b60tdnk.js @1,723,573）包装 O8o；session startup / resume 路径会调用 MQt（chunk-1vdc3qtt.js @540,865；Workbench/adopted session path 也有调用）。

O8o：
1. 通过 kTs 读取 remote-agent metadata sidecar；
2. 对每个 sessionId 调用 hR 查询 session_status；
3. 404 Session not found：删除 metadata 并跳过；
4. 其他 recoverable error：保留 metadata，跳过本次 restore；
5. session_status=archived：删除 metadata 并跳过；
6. 其他状态：重建 type=remote_agent、status=running、restoredOnResume=true 的 task record；
7. 恢复或生成 runId，注册 task，再启动新的 K3t poller。

因此这是**重新连接已有 cloud session**，不是重新执行 hN 创建新 session，也不是读取本地 Agent JSONL 后启动 W7。

### 4.2 Archived restore 的结果缺口

O8o 在发现 session_status=archived 时只调用 Rie 删除 metadata，然后 continue；没有调用 dTe 拉取最后的 result event，也没有调用 ySe 补发 completion notification。

如果 cloud session archived 表示远端任务已结束，而本地 CLI 在处理 result/notification 前 crash，则这条 restore 分支可能丢失本地完成通知。若 archived 只表示用户主动归档或 server 已保证结果先前已交付，则影响不同；本轮没有可用的 server contract 或动态证据确认 archived 的完整语义。

### 4.3 runId 与 event cursor 是两种不同账本

nUe 创建 runId=XD(taskId)，O8o 在恢复时沿用它或补建。FX/ySe 用 runId claim 任务通知，防止同一 task notification 重复投递。

但 runId 不等于 lastEventId：
- runId 用于 task notification dedupe；
- lastEventId 用于 remote event stream continuation；
- metadata 持久化 runId，却没有持久化 lastEventId。

因此通知幂等不自动解决 event replay / output append 重复问题。

## 5. TaskStop：本地 killed 与远端 archive 不是原子事务

RemoteAgentTask.kill（chunk-4b60tdnk.js @1,698,094）：
1. 若 registry task 仍 running，将其更新为 killed/notified=true，记录 endTime；
2. 发 stopped task notification；
3. 若存在 sessionId，调用 YO(sessionId).catch(...)；
4. Bp(taskId) 停止/flush 本地 output writer 与 poller cleanup；
5. Rie(taskId) 删除 remote-agent metadata sidecar。

YO（chunk-ypk19ctb.js @679,272）：
- 仅 first-party provider 可用；
- POST /v1/code/sessions/{sessionId}/archive；
- 10 秒 timeout；
- 200/409 视为 archive success，其他状态返回 false 并记录日志。

关键点：kill handler 对 YO 只调用 catch，不 await archive 成功确认；本地 task 已先标记 killed，poller/output writer 被停止，metadata 被删除。

**风险推断：** 若 archive 请求失败、超时或网络断开，远端 session 可能继续运行；本地却已丢失 reattach metadata。用户看到的 killed 是本地 task state，不等于远端 worker 已确认停止。这与报告 40 的 SEP-2663 cancel-unconfirmed 风险属于同一类跨系统问题，但 Remote Agent 使用 archive endpoint，而非 MCP tasks/cancel。

## 6. 与 Local Subagent / Worker adoptedPrefill 的关系

| 维度 | Local Subagent | Remote Agent |
|---|---|---|
| task type | local_agent | remote_agent |
| execution | 本地 W7 loop | Cloud Session worker |
| conversation store | 本地 Agent JSONL | Cloud Session event/transcript service |
| local metadata | Agent .meta.json | remote-agents/*.meta.json |
| resume | transcript + metadata → 新 W7 | metadata → hR status → 新 K3t poller |
| completion | W7 result + owner/keepalive notification | remote result event / archived status + task notification |
| stop | abort local controller + TaskStop lineage rules | local killed + best-effort cloud archive |
| parent/owner | parentAgentId / ownerAgentId / keepalive | 通用 remote_agent task record；nUe 未加入 local_agent lineage fields |
| handoff | adoptedPrefill 可链接 Agent transcript/metadata；Shell 可 PID identity reattach | 不走 local Agent W7 adoption；通过 remote metadata restore |

chunk-dgqfhca9.js 的 adoptedPrefill v0e 路径处理 local_agent transcript/metadata 与 Shell PID identity reattach；该模块没有 remote_agent 分支。Remote Agent task restore 由 MQt/O8o 单独负责。

因此不能把“remote Agent 已被 adopted”说成“远端 Agent loop 已恢复”；CLI 侧恢复的是观察/权限中继/通知 poller，执行 Loop 仍在 Cloud Session 一侧。

## 7. 事实 / 推断 / 未知

### 源码事实
- Remote Agent Tool 创建独立 Cloud Session，task type=remote_agent，不是 local_agent W7。
- remote task metadata sidecar 保存 sessionId/runId/task details，但没有 lastEventId。
- nUe 注册 task 后启动 K3t；metadata persistence 被 catch，但没有 await 作为 launch commit gate。
- dTe 按 sort_order=asc、cursor 分页获取事件；K3t 初始 cursor=null，运行中只保存在内存。
- bXe 通过 eKn appendFile 追加本地 task output。
- O8o restore 时 archived / 404 直接删除 metadata；其他可恢复 session 重新注册 task 并启动 poller。
- RemoteAgentTask.kill 先标记本地 killed，异步 archive cloud session，不等待确认，然后停止 poller并删除 metadata。
- remote permission relay 只能把本地 canUseTool 的 allow 回传远端；ask/deny 与不可 relay 工具会被拒绝。

### 推断 / 风险
- metadata 写入失败可能产生当前进程可观察、重启后不可恢复的 cloud session。
- cursor 未持久化 + append-only output writer 可能在 resume 时重复输出历史事件。
- archived restore 不回放 terminal events；如果 crash 发生在远端完成后、本地通知前，可能丢失 completion notification。
- TaskStop archive 未确认即删除 metadata，可能造成远端继续执行但本地失去跟踪。
- remote_agent 不在 local_agent descendant cascade 模型中；若由 Subagent 发起，父子停止/通知语义需要额外验证。

### 未知
1. Cloud Session events API 在无 cursor 时是否总是从最早事件开始；分页最大 50 页是否存在历史截断。
2. Cloud Session 自动归档、用户归档、TaskStop archive 的状态语义是否可区分。
3. archive endpoint 返回 200/409 是否代表远端执行器已停止，还是仅归档会话。
4. remote task output file 在 restore 后是否有其他 offset/cursor reconciliation，或由 API 服务端保证只返回未读事件。
5. Storage V5 sidecar 的 inPlace 写入在 process crash/power loss 下的真实耐久性。
6. remote permission relay 对不同工具类别、ask rules、MCP questions 的端到端动态行为。
7. remote Agent 从 Subagent 发起时，task notification 的最终 owner、parent stop 与 keepalive 是否有其他隐式关联。

## 8. 对新架构的启示（非决策）

- Remote execution 应有独立 RemoteOperation record，显式关联 local caller/owner/parent，但不与 local Agent process identity 混为一谈。
- 远端 operation 的持久化提交应先于返回 launched；metadata write failure 要么阻止启动成功，要么形成可查询的 orphan-reconciliation obligation。
- Event cursor、output byte offset、notification runId 必须是三种独立字段；恢复时分别验证，不能用 runId 代替 cursor。
- TaskStop 必须保留 cancel/archive requested、acknowledged、unconfirmed、outcome unknown 状态；未确认前不能删除唯一的 reattach metadata。
- Archived session 需要 outcome reconciliation：先读取 terminal event / summary，再清理 metadata；不能把 archived 简化成“结果已送达”。
- Local Agent W7 resume、remote cloud task poller restore、worker adoptedPrefill 应是三个独立恢复协议，分别有明确的 ownership、durability 与 idempotency contract。
- Permission relay 应默认 deny；只把本地明确 allow 的 tool call 以带 request ID 的短期授权转发，远端 input 必须在本地重新验证。

**裁决：无。** 本报告只记录静态源码证据与架构启示，不修改旧 Kernel，不开发，不批准任何架构。

## 9. Evidence index

| File | SHA-256 | Key anchors (0-based character offset) |
|---|---|---|
| chunk-461kpb1a.js | 66848b24fcfd081d98e949d1e242dda11a9f244ff3d3b2386b8f751d2419aa6c | Agent Tool remote branch / hN call @29,841; nUe registration @30,457; remote_launched result @30,745 |
| chunk-4b60tdnk.js | c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb | remote kill vUe @1,698,094; metadata write q3t / eligibility rPe @1,714,418/@1,714,533; nUe @1,722,676; MQt/O8o/I8o/K3t @1,723,573/@1,723,708/@1,724,880/@1,725,911; hN/Ntr @2,073,363/@2,061,839; sidecar path/writer/list @333,948–335,482 |
| chunk-ypk19ctb.js | 0b8728db10fddd3f2a922ff1387c4f0118bdf5a62a1f07300e50d2bf3c586960 | events API dTe @677,947; archive endpoint YO @679,272 |
| chunk-fh15xze1.js | 1a02bbc16c59a32f482e031ad6451afc223c28c897cdb3afa47cf75139193570 | task output path tu @3,118; append writer eKn/ge/bXe @3,519–6,338; appendFile @4,500 |
| chunk-1d8rv4vy.js | 265b7661541f5e47a80896ced64e19262d8aa35b3f40fb50f9431e3f176ba07e | task ID prefixes / generic task record yb @2,100; remote_agent type is r |
| chunk-1vdc3qtt.js | b60ef02e1acaaa48ce2cbeb165233924032ce0fd4413f6d1d094043df794f975 | startup restore call MQt @540,865 |
| chunk-dgqfhca9.js | 2248e015f4515613c5aa3647d0050b19d388bcc86ca6ed531eb1e153a35291be | adoptedPrefill local Agent/Shell adoption v0e @310,067; no remote_agent-specific adoption branch found |
| chunk-45j5sbzt.js | 57e2b896076f0f742d1d8ff3f1a6dca55493366bdab46fad942849e91ff4a6b0 | TaskStop resolver / type-specific kill dispatch eAe @23,080 / tAe @26,077 |

