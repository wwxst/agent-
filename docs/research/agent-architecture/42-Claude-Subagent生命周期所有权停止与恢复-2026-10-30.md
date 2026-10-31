# 42 · Claude Subagent 生命周期、所有权、停止与恢复

> 日期：2026-10-30  
> 样本：Claude Code CLI 2.1.304 发布版 JavaScript（build 2026-10-19，git SHA 17ab70404e5b632fe060207effb0b440788363ba）。  
> 方法：直接检查 source-only 发布包中的 Agent Tool、task registry、agent loop、metadata sidecar、resume 与 worker-adoption 路径；**静态源码研究**，未运行 CLI、模型或 worker handoff。  
> 前置：[报告 40](./40-Claude-CLI后台Bash与MCP任务恢复边界-2026-10-30.md)、[报告 41](./41-Claude-CLI取消时序矩阵与结果回收边界-2026-10-30.md)。

## 0. 本轮结论

Claude Subagent 不是简单的“主循环递归调用”。它有独立的 Agent Tool、task record、agent transcript、metadata sidecar、owner/parent 关系、keepalive、task notification、resume 与 worker-adoption 机制。

本轮确认的关键设计：

1. Agent Tool 会根据 agent definition、caller mode、run_in_background、remote/worktree isolation 和 backgroundTasksDisabled 决定同步或异步启动。
2. **同步 Agent**通过 parent AbortSignal 建立取消关联；自动后台化时解除关联。**异步 Agent**直接拥有独立 AbortController，不依赖原 parent tool-use signal。
3. agentId 同时是 local_agent task ID；parentAgentId 表示 lineage/祖先关系，ownerAgentId 表示结果通知和 keepalive 的接收者。两者职责不同。
4. Agent transcript 是独立 JSONL；agent metadata 是配套 .meta.json / Storage V5 sidecar。恢复不是恢复原 Node loop，而是读取 transcript + metadata，以同一 agentId 启动一个新 W7 loop。
5. parent-child keepalive 与 task notification 使父 Agent 可在自己的 loop 完成后继续 parked，等待后台子 Agent；子 Agent 完成后再解除 parent keepalive 并通知 owner。
6. TaskStop 有 ownership check、用户停止 marker 和条件性 descendant cascade；parent 处于 completed-but-parked 与仍 running 时，停止行为不同。
7. Remote worker handoff 的 adoptedPrefill 路径会验证 agent launch lineage，并重建 carried agent task record；但该 agent 被重建为 completed，不是恢复原执行 loop。相同 handoff 路径另有基于 PID identity 的 Shell process reattach。

## 1. Agent Tool：启动模式不是单一 run_in_background 开关

### 1.1 Tool contract

\`chunk-vq6nmh2z.js\` 定义：
- 工具名 \`Agent\`，旧别名 \`Task\`；
- 可命名 Agent，命名后可通过 SendMessage({to:name}) 寻址；
- 支持 SubagentHandback；
- 输出最大结果字符数 100,000；
- 文案明确 Agent 可以在停止后通过 SendMessage + task ID 继续。

\`chunk-461kpb1a.js\` 的 \`ho\` @5,677 计算 \`shouldRunAsync\`，综合：
- run_in_background 输入；
- agent definition 的 background；
- caller 是否 in-process teammate / headless subagent；
- coordinator / forceAsync；
- remote/worktree isolation；
- backgroundTasksDisabled。

因此，run_in_background 未提供并不必然等于同步；具体模式由策略函数决定。remote launch 本身会走 async path。Teammate 有单独限制，不能随意 spawn background agent。

### 1.2 Sync 与 async 的控制器区别

Agent Tool 主入口 \`xo\`（\`chunk-461kpb1a.js\` @16,151）：
- 先校验 spawn depth、agent type/permission、budget、required MCP servers；
- 经 agent.spawn hook 允许改写 prompt、description、agent definition、model、background/cwd；
- hook 改写后会重新计算 effectiveIsolation / isRemoteLaunch / shouldRunAsync；
- 通过 taskRegistry.takeConcurrencySlot 限制并发；
- 组装 agent 专属 system prompt、tool pool、permission context 与 parent prompt copies；
- 根据 shouldRunAsync 分流。

| 模式 | 注册/启动函数 | AbortSignal | 后台化 |
|---|---|---|---|
| async Agent | \`mie\` | 创建独立 controller；只有显式传 parentAbortController 才链接 parent | 启动即 isBackgrounded；原 Agent Tool 可尽快返回 async_launched |
| sync Agent | \`Rvs\` | 创建自己的 controller，并通过 L0e(parentAbortController, childController) 链接 parent | autoBackgroundMs 到期后，T3e 解除 parent abort relay 并向 caller 发 backgroundSignal；Agent loop 继续 |

本次 Agent Tool 的普通 async 分支调用 mie 时没有传 parentAbortController；sync 分支调用 Rvs 时传入当前 toolUseContext.abortController。故 parent tool-use abort 对 sync Agent 生效，除非 Agent 已自动后台化并解除 relay；async Agent 不因原 parent tool-use abort 自动停止。

Rvs 的自动后台化还受 exclusive tool queue 约束：若有必须独占运行且排在 Agent Tool 后面的 tool call，Agent 保持 foreground，timer 会重试而不是提前 detach。

### 1.3 Parent context 与隔离

- 普通 subagent 的初始 prompt 由 agent 专属 system prompt + 精选 parent message copies + 当前任务 prompt 组成，不是无条件复制完整主 transcript。
- fork Agent 使用更严格的 fork context / exact tool pool；handback 行为与普通 Agent 不同。
- worktree isolation 会创建独立 worktree；resume 路径明确拒绝恢复某些 cwd/worktree Agent，要求新建 Agent。
- remote isolation 会进入 remote launch path，本轮没有完成 remote Agent Host 的协议级审查。

## 2. Parent、owner、lineage 与 keepalive

### 2.1 两个不同的关系字段

\`xo\` 构造：
- \`parentAgentId = 当前 toolUseContext.agentId\`；
- \`ownerAgentId = N6(currentAgentId, taskRegistry) ?? mainSessionId\`，即普通嵌套 Agent 的直接 parent；主线程 spawn 的 Agent 由 main session 拥有。

二者初始常常相同，但不是同一概念：

| 字段 | 作用 |
|---|---|
| parentAgentId | 结构性 lineage；用于祖先查找、descendant cascade、resume provenance |
| ownerAgentId | 当前结果通知接收者；用于 keepalive、task notification 和交接 |

Resume 时 parentAgentId 从 metadata 保留；ownerAgentId 初始可设为 main session，若由另一个 subagent 恢复则会转移给当前 resumer。旧 owner 会收到“Agent 已由另一个 Agent 恢复，完成通知将不再投递给旧 owner”的消息。

### 2.2 Keepalive 与 parked parent

- \`SD(owner, "agent:<childId>")\` 为 owner 增加 child keepalive reason。
- child 通知交付后 \`_M(owner, reason)\` 移除 keepalive。
- \`H9\` 会检查 owner 的 keepaliveReasons；若 child 不存在、已 notified 或 owner 已变化，会清理过期 reason。
- \`ngo\` 在 Agent loop 完成时将 status 设为 completed，但如果 keepaliveReasons 仍包含 agent:/workflow:/某些 background work，会保留 task record，形成 completed-but-parked。
- \`iO(task)\` 明确判断 local_agent 且 status=completed 且 keepaliveReasons 非空。
- Agent 自身若仍有后台工作，notification 会说明“waiting on its own background work”；同一 task ID 可以在多个阶段再次通知。

### 2.3 通知如何处理 owner 已停止

- \`eIt\` 通过 claim/notification ledger 避免重复投递，并根据 owner 状态决定向 owner agent 或 main session 发送。
- \`tIt\` 判断 owner 是否仍有效；owner 不再运行/接收时会释放 keepalive 并回退到 main session。
- \`aDe\` 会把已排队、原本发给已停止 owner 的 child task notification 重写到 main session。
- 因此，owner 停止不必然导致 child 完成结果永久丢失；已有 notification 和未来 notification 有各自的 rehome/fallback 路径。

## 3. Agent loop 与结果持久化

### 3.1 W7 是独立 Agent Loop

\`W7\`（\`chunk-k3djx6vq.js\` @149,927）执行独立 stream/query loop：
- 用 agentId 绑定 taskRegistry transcript；
- 跟踪 toolUseIds、in-flight tools、progress、token/tool counts；
- 有 async-agent stall watchdog；in-flight tools 存在时会延后 watchdog；
- stream stalled 时 abort controller、写 failed summary 并通知 owner；
- 完成时将结果、usage、terminal 状态写入 taskRegistry，并调用 Do / agent metadata update；
- 如果还有 child/background keepalive，可能先 parked，不立即认为 owner handback 完成。

Agent task record 包含 agentId/taskId、ownerAgentId、parentAgentId、spawnDepth、agentType、model/effort、cwd、toolUseId、abortController、isBackgrounded、keepaliveReasons、pendingMessages、notified、result 等字段。

### 3.2 Transcript 与 metadata 是两份记录

\`chunk-4b60tdnk.js\`：
- \`Ff(agentId)\` 解析 Agent JSONL transcript 路径；
- \`kMt(agentId)\` 将 JSONL 路径映射到 .meta.json；
- \`GZt\` @330,185 读取 metadata sidecar；
- \`iCt\` @330,584 写 metadata；Storage V5 可写 sidecar namespace，否则写本地文件，并 fireMirror 到 agent transcript；
- \`Y6\` @332,614 做带 lock 的 metadata patch；
- \`GE\` @333,452 读取 agent metadata；
- \`Tct\` @332,977 / \`i_o\` 用于持久化 stoppedByUser 等 marker。

metadata 会记录 agentType、parentAgentId、spawnDepth、description、model/effort/permissionMode、worktree、finished、stoppedByUser、revivedAt、forked-skill provenance 等。JSONL 保存 Agent 对话与工具事件；sidecar 保存恢复/权限/生命周期元数据。

这两份记录的物理耐久性受实际 storage backend 影响；本轮没有验证 Storage V5 backend 的 fsync/atomic/crash guarantee。

## 4. TaskStop：ownership、停止 marker 与条件性 cascade

### 4.1 Ownership check

\`TaskStop\` 的 \`eAe\`（\`chunk-45j5sbzt.js\` @23,080）调用 \`Dut(callerAgentId,targetAgentId)\`：
- callerAgentId 未提供（main session/user）时允许；
- caller 是 subagent 时，只允许 target agentId 与 callerAgentId 相同。
因此，subagent 不能任意 stop 兄弟 Agent/其他 Agent；主线程可以停止任意可见 task。

### 4.2 Stop marker 与 resume gate

用户停止 local_agent 时，\`eAe\` 调用 \`uue/Tct\` 写入 stoppedByUser sidecar marker，再调用 local_agent kill handler \`HT\`：
- abort agent loop controller；
- 将 task 标记 killed、记录 killedBy/endTime、清理 keepalive；
- 调用 spawnedSubagent lifecycle callback；
- 重新路由已排队 task notifications；
- 对符合条件的 orphaned shell task 做清理。

Resume \`Gn\` 会同时检查 sidecar stoppedByUser 与 taskRegistry userStopCount。若被用户停止，默认拒绝 resume；只有 userInitiated resume 才能清 marker 并继续。此机制防止普通后台消息意外复活用户明确停止的 Agent。

### 4.3 Descendant cascade 的条件

\`eAe\` 在停止一个 local_agent 前记录 \`iO(task)\`：
- 若 parent 已是 completed-but-parked（completed 且仍有 keepaliveReasons），会遍历 taskRegistry 中的 local_agent descendants，按 parentAgentId lineage 判断；除 cascade exemptions 外，递归 stop 子 Agent。
- 若 parent 仍是 running，eAe 不进入这段 completed-but-parked descendant loop。它会 abort parent 自己的 controller；sync child 若仍连接 parent signal 会被取消，async child 有独立 controller，不因原 parent tool-use signal 自动停止。
- parent 被停止后，aDe/tIt 会把 queued/future child notification rehome 到 main session。

这是源码控制流事实。它表示“停止运行中的 parent”与“停止已完成但等待后台 child 的 parent”不是相同的级联策略；async child 可能作为独立后台工作继续。是否符合所有产品场景的预期，需要动态场景验证，不能仅凭 TaskStop 名称推断为整棵树原子取消。

## 5. Resume：重建 loop，不是恢复原执行栈

\`Gn\`（\`chunk-xqhs6qqf.js\` @10,327）执行 Agent resume：
1. 使用 per-agent in-flight/resuming guard，防止同一 agentId 并发恢复；
2. 读取 stoppedByUser marker、metadata sidecar 和 Agent JSONL transcript；等待 transcript append queue flush；
3. 检查 transcript 是否缺行/过大/时间戳损坏；
4. 检查 forked-skill permission scoping sidecar；缺失/损坏时拒绝恢复；
5. 拒绝不支持恢复的 cwd/worktree 场景；
6. 从 transcript 恢复 Agent 对话；按 parentPromptId / lineage 追加自上次 delivery 后的新 parent turns；
7. 更新 revivedAt，必要时清 finished marker；
8. 创建新的 AbortController 和 local_agent task record，再启动新的 W7 loop。

因此 resume 是“从持久化对话与 metadata 重建 Agent 上下文并开启新 loop”，不是恢复旧 Promise、旧 stream、旧 Node stack 或旧 AbortController。

若 Agent 由另一个 subagent 恢复，ownerAgentId 会转给新 resumer；parentAgentId 保留原 lineage。旧 owner 会被通知交接，避免完成消息投递到已失效 owner。

## 6. Parent context lineage：避免重复投递与错误归因

\`chunk-ypk19ctb.js\`：
- \`y4s\` @512,651 为新 Agent 选择可转发的 parent turns，并记录 keys/transcriptLineages；
- \`v4s\` @514,302 在 resume 时根据已交付 keys、deliveringLoop、lineage、rewind 状态选择新鲜 parent turns；
- \`Ek\` @514,787 处理 freshness、source attribution、rewind 与 held turns；
- \`k4s/E4s\` 负责 live delivery mint/commit，避免并发或状态变化后重复提交。

Agent 不会在每次 resume 时无差别重放整个 parent transcript。系统跟踪哪些 turns 已转发、由哪个 owner/loop 消费、是否被 rewind；对无法确认来源的 turns 会标为 unattributed，避免把它们伪装成 owner 指令。

## 7. Worker handoff adoption：Agent 与 Shell 的恢复方式不同

\`chunk-dgqfhca9.js\` 的 \`v0e\` @310,067 处理 adoptedPrefill 中的 carried agents：
- 按 spawnDepth 排序；
- 读取 parent transcript 中的 asyncAgents/launch record；
- 验证 owner transcript 确实 launch 了 agent，且 metadata.parentAgentId 与 owner lineage 一致；
- 若 metadata.finished 已存在或 owner transcript 已停止/结束该 task，则视为 handedBack，不重复通知；
- 若 link/metadata 可信，调用 \`Cvs\` 重建 taskRegistry record。Cvs（\`chunk-4b60tdnk.js\` @4,753,231）把 adopted agent 注册为 status=completed，而不是恢复 running W7 loop；
- 若无法证明 owner launch/link，则 leftToReconcile 或通知 owner carried agent 未恢复。

同一 adoptedPrefill 路径可通过 \`Zre\`（\`chunk-dgqfhca9.js\` @328,807）使用 pid、procStart、startTimeTicks 对 Shell process 做 identity-checked reattach。它能恢复 Shell task 的 process observation/control handle；Agent loop 本身仍需 transcript/metadata + resume 重新启动。

这说明 Claude 有 worker handoff adoption，但不能把它等同于普通 \`--resume\`，也不能认为所有 subagent 都在新 worker 上自动继续执行。

## 8. 事实 / 推断 / 未知

### 源码事实
- Agent Tool 的 async/sync 启动路径不同；sync 通过 parent AbortSignal，async 默认独立 controller。
- Agent task 有 agentId、ownerAgentId、parentAgentId、spawnDepth 和 keepaliveReasons。
- Agent transcript 与 metadata sidecar 分离；resume 读取两者并启动新的 W7 loop。
- TaskStop 有 owner check、stoppedByUser marker、completed-but-parked descendant cascade。
- Parent notification 可在 owner 不再有效时回退到 main session。
- Worker handoff adoption 会验证 agent launch lineage；carried Agent task 被重建为 completed，而 Shell 可通过 PID identity reattach。

### 推断 / 风险
- Parent running 时 stop 与 parent completed-but-parked 时 stop 的 descendant cascade 不对称，async child 可能继续；这是设计行为/风险边界，需动态验证用户预期。
- Agent metadata sidecar 写入失败、transcript flush 未完成或 worker handoff lineage 不可验证时，resume/adoption 可能失败或要求新建 Agent。
- ownerAgentId 可转移但 parentAgentId 不变，意味着通知/控制所有权与结构性 ancestry 必须分开建模。

### 未知
1. Remote Agent launch 的 Host protocol、worker crash/reconnect、result reconciliation。
2. Agent metadata sidecar 的物理耐久性和跨进程并发锁保证。
3. Parent running 时 async child 继续运行是否覆盖所有 TaskStop/turn abort/shutdown 场景。
4. Agent tool/Agent loop 在 context compaction 前后保留哪些 tool results、attachments 和 parent lineage。
5. Worker handoff adoption prefill 的生成、签名/可信来源和进程身份校验完整链路。

## 9. Evidence index

| File | SHA-256 | Key anchors (0-based character offset) |
|---|---|---|
| chunk-vq6nmh2z.js | ef4c8149c6970e107602c9884994e5f8eec0a19bb19a7eac79c10f4d3e5b21b9 | Agent/Task names and SendMessage/handback contract @662 |
| chunk-461kpb1a.js | 66848b24fcfd081d98e949d1e242dda11a9f244ff3d3b2386b8f751d2419aa6c | async decision ho @5,677; Agent Tool xo @16,151; parentAgentId @33,222; ownerAgentId @37,077 |
| chunk-4b60tdnk.js | c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb | agent kill HT @238,323; agent metadata GZt/iCt/Y6/GE @330,185/@330,584/@332,614/@333,452; Aft @4,733,556; eIt @4,742,094; mie/Cvs/Rvs @4,752,217/@4,753,231/@4,753,822 |
| chunk-era3wpv6.js | 019e22af02dda02c65742a2c5ce0296ab6c544559597564078c79a800115f459 | TaskRegistry wh @44,270; descendant lineage _Dt @24,242; keepalive SD/_M @25,919/@51,992 |
| chunk-k3djx6vq.js | 1b4dc9236bf90b77cd9d9d13aa82f67c6a792920e9253d92ef402a2f6dd615fe | Agent execution loop W7 @149,927 |
| chunk-xqhs6qqf.js | 2a164dbfa5570beb2e0c7af0b386ed519d0c74a51e98fe2d896819cb82ad60cf | Agent resume Gn @10,327; owner transfer @32,448 |
| chunk-dgqfhca9.js | 2248e015f4515613c5aa3647d0050b19d388bcc86ca6ed531eb1e153a35291be | adoptedPrefill agent adoption v0e @310,067; verify launch qEt @311,276; register JEt @312,952; Shell reattach Zre @328,807 |
| chunk-45j5sbzt.js | 57e2b896076f0f742d1d8ff3f1a6dca55493366bdab46fad942849e91ff4a6b0 | TaskStop eAe @23,080; tAe @26,077 |
| chunk-ns649tzz.js | 237bd2a46506c6abae41ec86d98c0c4153c8955e11a737044f771b3b1a44729c | owner check Dut @655,906 |
| chunk-ypk19ctb.js | 0b8728db10fddd3f2a922ff1387c4f0118bdf5a62a1f07300e50d2bf3c586960 | parent turn forwarding y4s/v4s/Ek @512,651/@514,302/@514,787 |
| chunk-a0qhh8j0.js | 710f64577b3df57c647d23f66612f318f4d2117d9d61e18d988bc4323e9200e8 | agent transcript adopt/link P3r @21,535 |

## 10. 下一步

1. 深入 Subagent × context compaction：Agent transcript 被 compact 后，resume 如何保留 parent lineage、tool_use/tool_result 配对、附件和 handback。
2. 追 Remote Agent launch / worker lifecycle 与 adoptedPrefill 的完整来源，明确 local/remote agent 的 crash/reconnect 差异。
3. 继续 Desktop / Agent SDK Host session 生命周期，再对照 Pi Agent Core 的 subagent/extension 模型。
4. 完成所有成熟实现研究后，统一横向比较，再提出独立架构方案。

**裁决：无。** 本报告只记录静态源码证据，不修改旧 Kernel，不开发，不批准任何架构。
