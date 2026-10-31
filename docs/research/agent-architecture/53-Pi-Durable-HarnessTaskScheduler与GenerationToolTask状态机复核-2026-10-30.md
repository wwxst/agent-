# 53：Pi Durable 1.4.0 Harness、Task Scheduler 与 Generation / ToolTask 执行状态机（2026-10-30）

> 研究阶段：固定 release tag v1.4.0 的发布源码静态追踪；未运行真实 Provider、外部工具副作用、数据库断电或 crash injection。  
> 样本：@earendil-works/pi-durable@1.4.0、@earendil-works/chord@1.4.0、@earendil-works/pi-ai@1.4.0。  
> 上游：earendil-works/pi；release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。  
> 本报告是报告 52 的 Durable 子系统续篇；只新增研究文档，不修改业务代码、Kernel 或实现 PR。

## 1. 最重要的架构事实：pi-durable 是独立执行引擎

报告 52 已确认 pi-durable package 不依赖 pi-agent-core。本轮进一步追踪源码，确认：

- pi-durable 自己定义 Harness、Conversation、Agent、Registry、TaskScheduler、GenerationTask、ToolTask；
- GenerationTask 直接调用 pi-ai Models.streamSimple / fetchDeferred；
- ToolTask 自己完成 tool resolve、argument repair / validation、beforeTool / afterTool hooks、执行意图 checkpoint、ToolResult / nested result settlement；
- 没有把 Core Agent 或 agentLoop 包在 storage transaction 外面，也没有直接调用 pi-agent-core 的 Agent class。

因此 Pi monorepo 至少有两条可独立运行的执行路线：

1. pi-agent-core：小型、内存态、单 activeRun 的通用 Agent Loop；
2. pi-durable：以 Chord + pi-ai 为基础，围绕 Conversation / Submission / GenerationTask / ToolTask / Document 建立的持久化 Agent Runtime。

它们共享 pi-ai 的模型协议与部分工具概念，但执行状态机、消息记录、工具调度、恢复与扩展模型不同。不能把 pi-durable 描述成 Core Agent 的存储插件。

## 2. Durable package 与公开 API 边界

v1.4.0 packages/durable/package.json：

- package：@earendil-works/pi-durable@1.4.0；
- description：Durable conversation, task, and document runtime for Pi；
- Node >=22.19.0；
- dependencies：@earendil-works/chord 1.4.0、@earendil-works/pi-ai 1.4.0、@earendil-works/pi-codemode 1.4.0、@earendil-works/pi-telemetry 1.4.0、typebox 1.3.27 等；
- 不依赖 @earendil-works/pi-agent-core；
- exports 包含 root、env、codemode、tool-search、tools、images、storage/memory、storage/indexeddb、storage/jsonl、storage/sqlite、testing 等；
- README 明确标记 API experimental。

root export 直接暴露 Harness、Conversation / Task types、GenerationTask、ToolTask、CompactionTask、Registry / Extension / Hook APIs、watchEvents、内置 documents 和 createSession。

## 3. 数据模型：Conversation / Entry / Document / Task / Submission

### 3.1 Conversation 是 transcript scope，不是持有内存状态的对象

Conversation handle 只持有 ID 和 Host reference；比较 Conversation 应比较 id。真正状态在 Storage：

- ConversationRecord 保存 id、fork parent + cutoff entry、owner conversation + owner task；
- Entry 是 immutable transcript record；
- Document 是可变 typed JSON state，通过 commit 更新；
- Task 是 versioned durable state machine；
- Submission 是输入 / write 的持久化 admission 和 settlement receipt。

一个普通对话 run 的逻辑结构：

submit(input) → pi.user → pi.generation → pi.assistant(tool calls) → pi.tool × N → pi.tool-result × N → pi.generation → pi.assistant(answer)

Generation task 拥有本轮 ToolTasks，并等待它们完成后再创建下一代 GenerationTask。

### 3.2 Entries 与 Documents 分离

Entries 是 immutable，支持 parent/fork ancestry 与 active head range：

- pi.user / pi.assistant / pi.tool-result / pi.system / pi.reset / pi.compaction 是内置 entries；
- Reset entry 更新 head marker，模型上下文从最新 reset 之后开始，但旧 entries 仍保留；
- Fork 指向 parent conversation 与某个 entry cutoff，继承该 cutoff 之前的历史；
- Compaction append pi.compaction entry，保留旧历史，模型读取 summary + summary 之后的 entries。

Documents 是独立于 transcript 的 typed JSON state。主要内置 conversation documents：

| Document | 用途 | History / fork |
|---|---|---|
| pi.agent | model、thinking、extensions、tools、instructions、cwd | rewindable / asOf |
| pi.provider | provider session identity | latest |
| pi.live | 当前 run、generation partial/retry、tools、nested tools、compaction | latest |
| pi.inbox | steer / follow-up / write queue | latest |
| pi.usage | model / tool usage totals | latest |

AgentDoc 的 fork=asOf，意味着 fork 的 Agent 配置取 fork cutoff 时的状态；新 fork 获得新的 provider session identity。

### 3.3 Conversation view 与 runtime state

pi.live 保存 runtime 可观察状态，但不是唯一事实来源：

- run.taskId / inputs 指向当前 GenerationTask 与输入 submissions；
- generation 保存当前 attempt、partial assistant、retry backoff 或 deferred poll；
- tools / nestedTools 是工具任务状态的 UI-facing projection；
- compactions / compactionFailure 保存 compaction progress。

Task records 才保存调度状态与 checkpoint；entries 保存 transcript 结果；documents 保存 view/config/usage。不要把 live document 当作完整 task journal。

## 4. Session commit line：所有 Durable 状态变更的串行入口

### 4.1 SessionImpl 的执行机制

SessionImpl：

1. 内部维护 #tail Promise；
2. commitWith() / readOnLine() 通过 #enqueue() 追加到同一 mutation line；
3. #runCommit() 创建 Transaction，先执行 callback 并 stage changes；
4. settleSuccess() 生成 StorageWrite batch；
5. 对非空 batch 调用 Storage.commit(writes, withoutAbortSignal(context))；
6. Storage 成功后 tx.adopt(seq)，更新 document tracker；
7. 发布 CommitPublication 给 internal listeners 与 public observers。

因此 admitted commit 一旦进入 Storage settlement，不再响应调用方 AbortSignal；它必须明确提交或失败。回调在提交前 throw 时 rollback staged changes，不产生 commit。

Storage interface 对 commit 的合同是：atomically persist one batch and return its sequence；resolve 后后续 reads 必须观察到该批写入。具体持久性强度由 backend adapter 决定，不能只凭 Session contract 推断断电安全。

### 4.2 Listener 与失败隔离

- Internal listeners（TaskScheduler / Submissions 等）负责让内存索引与 Storage 同步；listener throw 会 fail Session。
- Public commit listeners 的异常只 report，不回滚已提交 commit，也不跳过其他 listener。
- Storage commit / mintId error 会触发 Session failure latch；Session 关闭，pending waits / watches 以 session_failed 终结。
- StorageRequestError 和已取消的 read 只失败该 read；commit/mintId error 不豁免，因为批次是否已写入可能未知。
- Session failure 不自动 retry Storage；README 明确 transient retry 由 Storage adapter 自己负责。

### 4.3 单 Session 单写者边界

SessionImpl 的 #tail 是单实例内的串行 mutation line。README 另明确一个 Storage 同一时刻由一个 process owner 持有，没有跨进程锁。跨进程多写者安全不能由 Session line 推导；需要 backend / host ownership 保证，留待 Chord 与 adapter 源码核验。

## 5. Task Scheduler：持久化状态机，不是 Promise queue

### 5.1 TaskDefinition 与 checkpoint

每个 TaskDefinition 必须声明：

- name / version；
- initial(input)；
- 按 checkpoint.phase 穷尽的 phases map；
- abort handler；
- 可选 migrate(input, checkpoint, fromVersion)；
- 可选 task-specific hooks。

Phase handler 必须通过 runtime.commit() 写出不同 checkpoint 或 terminal outcome；返回时没有 durable progress 会 fault task。一个 phase invocation 是短暂的 in-memory 执行；checkpoint 才是重启后可恢复的权威进度。

TaskRuntime 提供 taskId / conversationId / signal、agent / models / settings / env / registry / hooks、commit / memo / getTask / waitForTask / ownedTasks / conversation / entry / context、sleepUntil 与 document snapshot / watch / read APIs。

TaskRuntime.commit callback 正运行在 Session line 内；callback 内必须只通过 tx 读取，不能再调用排队到同一 line 的 runtime.snapshot / getTask 等 API，否则会形成自等待。

### 5.2 TaskState

| 状态 | 含义 |
|---|---|
| pending | 可调度，保留 checkpoint |
| running | 当前由一个 in-memory invocation 保留 |
| waiting | 无 invocation，等待 on task IDs 终态 |
| sleeping | 无 invocation，等 Harness clock 到 until |
| completing | outcome 已决定，但 owned foreground work 仍存活 |
| terminal | durable receipt，永久结算 |

Task 必须有 owner：Conversation 或 parent Task。Conversation-owned task 可 background；Task-owned child task 不可作为 background escape。Join policy 为 allSettled 或 failFast。

### 5.3 Open / Resume / Restart

Harness.open()：

1. 检查 Registry 含所有 built-in task definitions；
2. 创建 HarnessImpl / SessionImpl / TaskScheduler；
3. TaskScheduler.open() 扫描 live task records；
4. 对存储为 running 的 tasks 改回 pending，并递增 restarts；
5. 恢复 ownership / waiting / failFast indexes；
6. 派生上次 crash 留下但尚未应用的 abort cascade / completing outcome；
7. 不在 open() 中直接运行任意 task phase。

Harness.open() 不自动启用 scheduler。resume() 设置 enabled 并 kick scheduler；submit() / waitForTask() / waitForIdle() 等 API 也会触发 resume。

DEFAULT_RESTART_LIMIT 为 5。连续被进程切断达到限制的 task 会 parked 并报告 task_parked；retryTask() 清除 restart count 后重新启用。

Graceful close 与 crash 不同：

- TaskScheduler.join() abort 所有正在运行的 invocation，等待它们结束；
- 将被 close 中断的 running tasks 写回 pending；
- 因为这是 graceful close，不增加 restart count；
- 进程突然死亡时没有 join 写回，下一次 open 才把 persisted running 改为 pending 并计一次 restart。

### 5.4 Reservation / Invocation / Phase 三段式

- #reserve() 在一个 Session commit 中选择所有 eligible tasks，持久化为 running 并注册 invocation；
- #start() 在 commit 之外执行 task phase，避免任意 extension / tool code 在 storage transaction 内运行；
- 每个 phase 前后通过 #step() 在 Session line 上重新读取 task，判断 abort mark / close / phase progress；
- 只有 checkpoint 改变才算 progress，重复写同一 checkpoint 不会清零 restart count；
- registry definition 更新后，scheduler 在 phase boundary 重新 snapshot；新 definition 可兼容时将 task 退回 pending，由新版本接管；缺失 / 旧版本 / migration 失败会 blocked；
- scheduler maintains live / settled / owner edges / descendants / roots / unloaded 等内存索引，Storage 仍是 durable source of truth。

### 5.5 Wait graph、ownership 与 abort cascade

- wait 只能引用存在的 tasks；
- failFast 只允许等待当前 task 自己拥有的 children；
- scheduler 检查 wait-for graph，禁止 self-wait / owner-waits-child cycles，维持 DAG；
- task 决定 terminal 时，如果仍有普通 owned work，状态先变 completing；最后一个 child 终结后，scheduler 在后续 commit finalize owner；
- abort marks 是 durable intent；scheduler reconcile 在同一 commit 中向下级 foreground tasks 派生 abort marks；
- abort handler 以 bottom-up 顺序执行：先结束 owned children，再运行 parent abort；
- failed / aborted owner 会取消其 owned work；background task 是默认不跨越的边界；
- Conversation.abort 默认 abort foreground subtree；background=true 才跨越 background boundary 并等待。

## 6. Submission / Inbox：幂等 admission 与 steer/follow-up boundary

Submission admission 在一个 commit 内完成：

- requestId 通过 conversation + requestId 查重；同 ID 返回既有 submission，不重复入队；
- input 默认忙时 followUp；可显式 whenBusy=steer；whenBusy=reject 则 ConversationBusy；
- write 可以只 append application entry，不触发模型；
- display-only write（只有 kind/data）即使 conversation busy 也可立即 append；如果前面有 queued reset，则等待 reset 之后，避免写入被 reset 隐藏；
- queued submissions 进入 pi.inbox；在 turn boundary 根据 steeringMode / followUpMode 选择 placement；
- abort 只撤销 queued submission；已经 placed 的 input 返回 already_placed；
- run failure 时 queued items 的处理由 afterFailedRun policy 决定：keep / continue / withdraw。

这是比内存队列更强的 admission model：用户请求本身有 durable submission ID、requestId 去重、queued/placed/done/unanswered 状态和可等待 receipt。

## 7. GenerationTask：Model / retry / deferred / compaction / tool round

GenerationTask version 1 的 checkpoint phases：prepare、request、retry、poll、tools。

### 7.1 prepare

- resolve conversation Agent / model / settings；
- 读取 active transcript context；
- replay 已显示的 extension prompt sections；
- render sections / tools，生成位置型 pi.system entries；
- 根据 contextWindow、reserveTokens、backgroundTokens、keepRecentTokens 判断 compaction；
- blocking compaction 创建 child CompactionTask 并 waiting；完成后重新 prepare；
- background compaction 可启动后继续 request。

### 7.2 request 与 streaming partial persistence

- request checkpoint 保存 model、thinkingLevel、streamOptions、cutoff entry；
- 从 context cutoff 读取模型消息；
- beforeRequest hooks 可替换本次 request messages；
- pi-ai streamSimple 使用 provider sessionId、AbortSignal、telemetry、reasoning；
- partial assistant 每 progress.partialIntervalMs（默认 100ms）节流提交到 pi.live.generation；
- 一次只允许一个 partial commit in-flight；provider 持续 mutate partial object 时，commit 前同步 copyJson；
- stream 结束时 finally 停止 timer 并 await 最后一个 in-flight commit，防止 terminal outcome 之后再落一个 stale partial。

### 7.3 Retry / deferred / overflow

- 默认 retry enabled、maxRetries=3、baseDelayMs=2s、maxAgentDelayMs=60s；
- retry 状态持久化 until 与 error，sleeping 后再进入 prepare；
- context overflow 不走普通 retry；若可选 cut，则创建 blocking CompactionTask 后等待并重试；
- provider deferred response 保存 handle / pollAt，默认 5 秒后 poll；再次 deferred 时 pollAt 必须严格递增；
- abort poll 会调用 pi-ai cancelDeferred，错误只 report。

### 7.4 Tool round handoff

- assistant tool-call entry 与 ToolTask records 在同一 commit append/create；
- parallel mode 一次创建所有 ToolTasks；
- sequential mode只创建第一项，其余 call IDs 写入 generation checkpoint.pending；每个 child 终结后再创建下一个；
- GenerationTask waiting on tool task IDs，policy=allSettled；
- finishToolRound 收集 outcomes / controls，处理 terminate、handoff、addTools，再决定 postTools boundary 或 successor generation；
- run input submissions 最终由 final boundary 结算 done / unanswered。

## 8. ToolTask：effect intent、replay policy 与 nested calls

### 8.1 ToolTask call / execute 两个阶段

ToolTask version 2 的 ToolTaskInput 有两种：

- model call：assistant entry ID + callId；
- nested call：parent task + parentCallId + stable key + ToolCall。

call phase：

1. 从 transcript 或 nested input 读取 ToolCall；
2. resolve tool（model-issued 只能选 model tools；nested call 从 callable tools 选）；
3. prepareArguments；
4. schema validation；
5. 运行 beforeTool hooks，可 block / rewrite args；
6. 再次 validate，strict JSON copy；
7. 在执行前 commit ToolTaskCheckpoint phase=execute、final arguments、replay policy；
8. 进入 execute。

### 8.2 Recovery replay 的双重安全检查

Durable ToolRegistration 自己定义 replay?: safe | unsafe，默认 unsafe。

进程恢复后执行 phase 只有在以下两项同时成立时重跑：

- stored checkpoint.replay === safe；
- 当前重新 resolve 到的 tool.replay === safe。

否则 settle 为 interrupted，并明确提示 may have partially run。重跑 safe tool 前会清除旧 progress slot。

普通 abort 与 restart abort 区分：

- 普通 abort：Tool aborted；
- restart 且还在 call phase：Tool not started；
- restart 且已经进入 execute intent：Tool interrupted and may have partially run。

因此 Durable 不会将所有 pending tool call 当成可以安全重放；execute intent 是 side-effect uncertainty boundary。

### 8.3 Nested tool calls

Nested tool call 是 child ToolTask，由 parent ToolTask ownership 管理：

- NestedCallDoc 是 task-scoped document family，每个 nested call 一个 document；
- stable key 让 parent task rerun 时查到同一个 child，而不是重复创建；
- child terminal commit 把 result 写回 parent NestedCallDoc；
- parent task 等待 child，读取 result 后继续；
- parent abort / failure 会向下取消 foreground owned child；
- background child 可以跨越 parent abort 边界。

这是一套 task graph，不是简单在 tool.execute 内 await 另一个函数。

## 9. Extension / Registry / Agent composition

- 每个 Conversation 的 pi.agent document 存 model、thinking、extension selection、tools filter、modelTools filter、instructions、cwd；
- Registry 是应用级、可变安装集合；每个 phase resolve Agent 时拿 RegistrySnapshot；
- Agent 根据 stored selection 与 settings default extensions 选择扩展；
- Extension 可提供 tools、prompt sections、hooks、wraps；
- wraps 可包装指定 tool / section；若 wrapper throw 或重命名 target，该 target 被移除并 report；
- TaskDefinition 有 version / migrate；运行中的 phase 使用当前 phase snapshot，phase boundary 检查是否有兼容新 definition；
- hooks 按 task name 匹配，并按 extension order 执行；普通 hook throw 会 report 并继续下一个 hook，signal abort 时才传播。

这不是单纯插件注册表：扩展同时参与 Tool / Prompt / Task hooks，Registry 版本还影响恢复时 task definition compatibility。

## 10. Event / View：从 committed state 派生 UI 事件

watchEvents()：

1. 在 Session line 上原子捕获 Conversation snapshot 与后续 commit subscription；
2. snapshot 包含 entries、run、generation partial、tools、nestedTools、compactions、inbox、agent、usage；
3. 每次 CommitPublication 转换为一批有序 AgentEvents；
4. message/tool progress 通过 Chord delta ops 转成 delta event；
5. 一个 commit 内的 event batch 是原子发布单元；
6. CommittedWatch 最多保留 100 个未消费 frame；超过上限丢弃旧 batch，改发最新 snapshot；
7. async listener 按 batch await；listener throw 会终止 watch 并 report；
8. watch acquisition context 的 AbortSignal 控制 stream lifetime。

AgentEvents API 在 README 标记 Experimental。它是从 durable commit 派生的 UI protocol，不是 TaskScheduler 的事实来源；重连时 snapshot 是重新同步入口。

## 11. 错误与故障隔离

README 与 Session / Scheduler 源码定义不同故障域：

| 故障 | 处理 |
|---|---|
| Storage commit / mintId error | Session failure latch；关闭 Harness；pending waits/watches 结束；不由 Harness 自动 retry |
| Invalid read / cancelled read | 只失败该 read |
| Task phase throw | 当前 Task faulted；其他 task / Harness 可继续 |
| Tool execute throw | ToolResult error；Generation 可按控制流继续 |
| Hook throw | report 并跳过；beforeTool hook throw 则 block 当前调用 |
| Listener throw | report；其他 listener 继续 |
| Registry snapshot throw | Scheduler 无法安全调度，可能升级为 Harness failure |
| Model retryable error | 根据 retry policy 持久化 sleeping/backoff |
| Context overflow | compaction path，不做普通 retry |

README 文档还声明：
- SQLite WAL + synchronous=NORMAL：process crash 可恢复；power/host failure 可能丢最新 commit；
- JSONL append-only；fsync=true 才在 commit marker 前 flush，但整个 history 留在内存；
- IndexedDB browser backend 需要单 owner / Web Lock；
- Cloudflare Durable Object SQLite backend 使用 DO storage transaction。

上述 backend tradeoffs 目前只从 README 记录，尚未逐一核验 adapter / Chord 源码；下一报告专门研究。

## 12. 事实 / 推断 / 未知

### 源码事实

- pi-durable 不依赖 pi-agent-core；它有自己的 Harness / GenerationTask / ToolTask。
- SessionImpl 以 #tail 串行 commit/read line；Storage.commit 是 atomic batch contract。
- TaskScheduler.open 将 persisted running task 改为 pending 并计 restart；resume 才启用 scheduler。
- task phase 必须写 durable checkpoint / terminal state；没有 progress 会 fault。
- terminal task 有 live owned children 时先 completing，等 children 终结后 finalize。
- GenerationTask 持久化 request cutoff、partial、retry、deferred poll、tool round checkpoint。
- ToolTask 在执行前写 intent；恢复时只对 stored + current policy 都 safe 的 tool 重放。
- requestId 在 conversation 内去重；Inbox 负责 steer/followUp/write boundary。
- watchEvents 从 commit batch 派生 event，watch overflow 超过 100 frame 后改发 snapshot。

### 推断 / 风险（未动态验证）

- 所有 side-effect task 都必须把可恢复的 intent / operation ID 放在 execute 前 commit；仅仅声明 replay=safe 不足以提供 exactly-once。
- Chord transaction atomicity 是 Session / Harness 安全性关键前提；adapter / backend 若不满足 atomic commit contract，task checkpoint 与 side-effect intent 可能失去一致性。
- TaskScheduler 的 ownership DAG、completing hold、bottom-up abort 是复杂机制，必须重点做 crash / race 动态测试。
- Registry 热更新与 task migration 可能改变恢复行为，需要把 extension/task definition version 纳入部署兼容策略。

### 未知 / 资料缺口

- Chord 1.4.0 replicatedState / delta / transaction / storage adapter 的实际原子性、durability、outbox / publication 顺序。
- SQLite / JSONL / IndexedDB / Cloudflare adapters 的 crash、fsync、multi-owner 与锁语义。
- Scheduler 在同时 abort、close、storage failure、child completion、registry replacement 下的竞态覆盖与真实故障注入结果。
- ToolTask safe replay 对外部副作用是否真正幂等，取决于具体 tool/host；未验证。
- CompactionTask 的完整状态机、summary staleness、retry 与 model context cut 尚未逐行闭环。
- pi-coding-agent 如何将 Durable event stream、MCP、TUI / RPC、permissions、extensions 组合为产品 host。

## 13. 对目标架构的非决策性启示

1. Durable Task 是执行事实，Conversation 是 transcript scope，Document 是可观察配置 / live state，Submission 是用户请求 receipt；不要把四者压成单一 Session JSON。
2. 事务边界必须包住：用户 input admission、Generation creation、Tool intent、Tool result、task state transition、usage ledger / UI projection 等需要原子一致的写入。
3. 任意外部副作用都需要 effect intent + operation identity + replay policy + unknown outcome handling；默认 unsafe，不盲目重试。
4. Task phase 要短、可 checkpoint、可版本迁移；不要把整个 Agent run 存成一个不可中断 Promise。
5. Abort 是 durable intent + ownership cascade；真正 cleanup 由 child-first abort handler 执行。
6. UI event stream 必须从 committed state 派生，并在 overflow / reconnect 时提供 snapshot；event 不能代替 durable state。
7. Registry / Extension 参与任务执行代码版本，恢复协议必须定义旧任务由新代码迁移、兼容运行、park 或 orphan 的明确策略。

以上是研究输入，不是已批准架构决策。

## 14. 下一步

1. 深入研究 Chord 1.4.0：replicatedState、transaction、delta tracking、document history、commit sequence、outbox / publication、storage adapters。
2. 核对 pi-durable SQLite / JSONL / IndexedDB / Cloudflare adapter 实际写入、fsync、WAL、migration、single-owner / lock 语义。
3. 动态验证 TaskScheduler 的 crash/reopen、restart limit、waiting/failFast、completing/ownership、abort cascade、safe/unsafe ToolTask replay。
4. 深入 CompactionTask 与 context range / stale summary 规则。
5. 研究 pi-coding-agent composition：MCP / extension / permission / TUI / RPC 如何调用 Durable Harness。
6. Pi 全部子系统完成后再与 Claude CLI / Desktop 做同场景矩阵对比。明确批准前不进入开发。

## 15. 本轮边界

只新增研究报告与进度记录。没有修改业务代码、Kernel、PR #48 原型或任何运行时实现；没有提交开发 PR。

## 16. Evidence index

| 文件 | Blob SHA | 关键锚点 |
|---|---|---|
| packages/durable/package.json | f5756989cdc757004bffd0b8105f78056a4ee1fc | package/dependencies/exports/storage backends/experimental package boundary |
| packages/durable/src/index.ts | 95d9606ae6331b58969eded5d291faeb3e39bbf2 | public exports: Harness / GenerationTask / ToolTask / events / storage |
| packages/durable/src/harness/harness.ts | e7f19dfeace84d0ce55ff8df424457d0fb267dd0 | HarnessImpl / Session composition / TaskScheduler / Conversation API / open |
| packages/durable/src/session/session.ts | b22e9c56a9f888e007f9697306a0b182092c006a | commitWith / #runCommit / #enqueue / GuardedStorage / failure latch / close |
| packages/durable/src/types.ts | 289b5c4e18b0a36267ef5f5e36d9afda2a649ecf | TaskDefinition / TaskState / TaskRuntime / Storage atomic commit contract |
| packages/durable/src/harness/scheduler.ts | 23951e89934a6214329e7511f3fc8bca2d23f921 | open / resume / reserve / phase / wait graph / abort / reconcile / join |
| packages/durable/src/harness/generation.ts | c8d26791cd5a2e26287f73255b75f65ec21c3f22 | GenerationTask phases / partial commits / retry / deferred / tool rounds |
| packages/durable/src/harness/tool.ts | 52bc4a3ada1892645aca5a35f4d90b875edda4ca | ToolTask call / execute intent / safe replay / nested calls |
| packages/durable/src/harness/submissions.ts | 0cf838a93932cac6d41ec5e209f987eda1546611 | requestId idempotency / admission / queue / settlement |
| packages/durable/src/harness/inbox.ts | ced6977677c2a38ada04d5ad714b4a9e20cedaa8 | durable inbox / boundary / steer / follow-up / reset |
| packages/durable/src/harness/agent.ts | 64a15bb6a3069eb92f6dbad374a51b4f1f1c2a02 | AgentDoc / settings / extension resolution / tool wrapping |
| packages/durable/src/harness/events.ts | 3f19da13530af796c4a3f06cac87d6ce98c73dae | snapshot / commit-to-event translation / watchEvents |
| packages/durable/src/session/observation.ts | 2edfb74652fdfdb8492773c73c0cc606cb66a3f9 | CommittedWatch / max 100 pending frames / overflow snapshot |

**证据等级：** 固定 v1.4.0 release source 静态追踪 + README contract。没有执行真实 provider、SQLite/JSONL crash、外部工具副作用或 TaskScheduler crash injection；backend README tradeoffs 仍待 adapter / Chord 源码复核。
