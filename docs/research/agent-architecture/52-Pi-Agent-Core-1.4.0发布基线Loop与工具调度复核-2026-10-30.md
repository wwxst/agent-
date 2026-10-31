# 52：Pi Agent Core 1.4.0 发布基线、Loop 与事件/工具调度机制复核（2026-10-30）

> 研究阶段：上游 release tag 源码静态复核 + 既有 npm 发布包隔离动态实验复核。  
> 固定样本：@earendil-works/pi-agent-core@1.4.0、@earendil-works/pi-ai@1.4.0、@earendil-works/pi-durable@1.4.0。  
> 上游：earendil-works/pi；release tag v1.4.0；release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。  
> 本报告承接 PR #48 报告 30–31 的 Pi 动态实验；只增加研究证据，不修改业务代码、Kernel 或实现 PR。

## 1. 固定版本与来源核验

### 1.1 正确仓库与包名

Pi 已从早期 badlogic/pi-mono / @mariozechner scope 迁移到：

- Repository：github.com/earendil-works/pi
- Core package：@earendil-works/pi-agent-core
- LLM/provider package：@earendil-works/pi-ai
- Durable runtime：@earendil-works/pi-durable

旧 scope @mariozechner/pi-agent-core@0.73.1 是最后一个旧 scope release；新 scope 从 0.74.0 开始。历史报告必须明确版本，不能把旧 scope、早期 package 或当前 package 混为一谈。

### 1.2 Release tag / package manifest

v1.4.0 解析为 release commit：

4a080252f06caf63a525d7873c5d94d3c23887e0（commit title：Release v1.4.0）。

该 tag 下 packages/agent/package.json：

- name：@earendil-works/pi-agent-core
- version：1.4.0
- dependencies：@earendil-works/pi-ai 1.4.0、typebox 1.3.27
- engines：Node >=22.19.0
- exports：仅 . 与 ./package.json
- publish files：dist、README.md
- build：tsc -p tsconfig.build.json
- test：vitest --run

npm 页面当前显示发布版本 1.4.0；上游 package manifest 与 packages/agent/CHANGELOG.md 的 1.4.0 release entry 相符。CHANGELOG 记录 1.4.0 在 2026-10-21 增加 AgentOptions.identity / Agent.identity。

### 1.3 对旧动态实验 source pin 的纠偏

PR #48 报告 30–31 使用：

- 动态发布包：@earendil-works/pi-agent-core@1.4.0、@earendil-works/pi-ai@1.4.0；
- 静态 source ref：d5b3de22d0e24a3e9c38a9410d3329b099717283。

该 source ref 位于 v1.4.0 release tag 之后（GitHub compare 显示 release tag 相对该 ref 落后 67 commits）。此前不能声称二者完全等价。

本轮逐个比较 v1.4.0 tag 与旧报告 source ref 的 Git blob SHA：

| 文件 | v1.4.0 tag blob | d5b3 source blob | 结果 |
|---|---|---|---|
| packages/agent/src/agent.ts | c0a482d3a499b6baabd61cd1c4eed3f93cb2a9a6 | 同左 | 完全相同 |
| packages/agent/src/agent-loop.ts | cfc9401e5581847f6d5a9bb1815ab0f0e663f2e5 | 同左 | 完全相同 |
| packages/agent/src/types.ts | dbfba74a084f71951e48285869730b70a405ba3a | 同左 | 完全相同 |
| packages/agent/README.md | 38625ce1191941544f1883d46a1782a120d5d4a4 | 同左 | 完全相同 |
| packages/agent/package.json | ec1838680fda5465aacf490378c31e76b4ed767b | d1231d95df683a382b5abb32a51fee02d1f08d03 | 仅 devDependency vitest 4.1.11 vs 4.1.12 |

因此，报告 30–31 动态实验所覆盖的 Agent runtime TypeScript 源码与 v1.4.0 release tag 完全一致；旧 source ref 的 package manifest 只多了后续 Vitest devDependency 更新。该核验显著收敛了原先的版本不确定性。

仍需保留一个边界：本轮没有下载 npm tarball 并逐文件比较 dist，也没有核验 npm provenance / SLSA attestation。因此这是核心源文件与 release tag 的等价证据，不是发布二进制字节级复现证明。

## 2. 关键架构边界：Agent Core 与 Durable 已分包

### 2.1 v1.0.0 明确拆除旧实验性 Harness

packages/agent/CHANGELOG.md 的 v1.0.0 Breaking Changes 明确列出从 pi-agent-core 移除：

- AgentHarness；
- sessions 与 session storage；
- durable runtime；
- pico3、harness tools；
- compaction；
- skills、prompt templates、system prompt helpers；
- telemetry schemas、search service types；
- ./node、./harness/*、./experimental/pico3 subpath exports。

同一条 changelog 指示 durable sessions 使用 @earendil-works/pi-durable。

因此 1.4.0 的 pi-agent-core 不能被描述为自带完整 Session / Persistence / Recovery 的 Agent Kernel。

### 2.2 当前 package 分工

| 包 | 当前职责（从 manifest / source / README 确认） |
|---|---|
| pi-agent-core | Agent、低层 agentLoop / agentLoopContinue、工具调用与事件流、proxy stream、类型 |
| pi-ai | Provider / Model API、协议消息、AssistantMessageEventStream、模型上下文转换与请求 |
| pi-durable | Durable conversation、task、document runtime；storage adapters、Harness、task scheduler、tool task、compaction 等 |
| chord | Durable README 明确依赖的 document / replicated-state / RPC runtime；需独立审查其事务与存储合同 |
| pi-coding-agent | 将 Agent Core、pi-ai、MCP、TUI、extensions、session UI / CLI 组装为产品运行时；后续再研究 |

@earendil-works/pi-durable@1.4.0 README 明确标注 API experimental；不能因为 package 已发布就视为稳定 API。

**进一步核验：pi-durable 并不是包在 pi-agent-core 外面的持久化 adapter。** packages/durable/package.json 的 dependencies 包含 chord、pi-ai、pi-codemode、pi-telemetry 等，但不依赖 pi-agent-core；packages/durable/src/harness/generation.ts 直接使用 pi-ai 的 Model / Message / ToolCall / retry / overflow API，并实现自己的 GenerationTask。packages/durable/src/harness/agent.ts 定义自己的 Agent state / registry / prompt / extension contract。它是同一 monorepo 内独立的 Durable Agent runtime / generation engine，不是 Core Agent class 的 storage plugin。后续必须将两套执行引擎并列研究，而不能假设 Durable 只负责持久化。

### 2.3 Agent Core 的 source/export 边界

packages/agent/src/index.ts 只 re-export：

- agent.ts
- agent-loop.ts
- proxy.ts
- stream-fn.ts 的 setDefaultStreamFn
- types.ts

packages/agent/package.json 没有 storage、SQLite、session manager、task scheduler 或 host runtime 依赖。Core 的 AgentState 是内存状态；AgentContext 只有 transcript messages 与 executable tools。它本身不负责持久化、跨进程恢复或工具执行账本。

## 3. Agent 高层对象：单运行所有者、内存 Transcript、双队列

### 3.1 Agent state

createMutableAgentState()：

- initialState.messages / tools 复制顶层数组；
- 若 transcript 首条不是 system message，会将 systemPrompt 与 tool declarations 形成 leading system message；
- systemPrompt 从 transcript system messages replay 计算；
- tools / messages 是 getter/setter，setter 复制顶层数组；
- isStreaming、streamingMessage、pendingToolCalls、errorMessage 是 runtime-only state。

这是一层可观察的内存状态 reducer，不是持久化 store。

### 3.2 Agent 是单活动 Run

Agent 内部只有一个 activeRun，包含 Promise、resolve 和 AbortController：

- prompt() / continue() 在 activeRun 存在时拒绝新的直接运行；
- steer() 将输入排队，等待当前 assistant turn 与该批工具执行完成后再注入；
- followUp() 将输入排队，等 Agent 本来要停止时才注入；
- 两个 queue 支持 one-at-a-time（默认）与 all；
- abort() abort 当前 Run signal；
- waitForIdle() 等待 Run 和 awaited listeners 完成；
- reset() 仅在 idle 时可用，保留 replay 后的 system/tool baseline，清空 conversation 与 queue。

Steering 不会跳过当前 assistant message 已发出的 ToolCalls；它是在该轮工具处理后才进入下一次模型请求。

### 3.3 高层 Agent 与低层 agentLoop 的关键区别

高层 Agent 的 processEvents()：

1. 先 reduce 内部状态（message_end append transcript、tool start/end 更新 pendingToolCalls、turn_end 更新 errorMessage）；
2. 再按订阅顺序逐个 await listener(event, signal)；
3. 因此 message_end listener 可作为下一阶段工具 preflight 前的异步屏障；
4. agent_end 发出后，listener 仍属于 Run settlement；isStreaming 直到所有 listener 完成才变 false。

agentLoop() / agentLoopContinue() 低层函数则将 runAgentLoop 的事件 sink 连接到 EventStream.push()。push() 是同步入队，不等待 async iterator consumer 的业务处理。官方 README 明确说明低层 stream 是 observational：事件顺序有保证，但 async consumer 不会成为工具 preflight 的 barrier。

这解释了报告 30 的动态结论：Intent commit 屏障必须挂在高层 Agent 的 awaited subscriber，或由宿主另行构造同步/显式 await 的事件 sink；不能仅消费低层 async iterator 就假设数据库提交已完成。

## 4. Agent Loop 主流程

### 4.1 Loop 的两层调度

runLoop() 有两层循环：

- 内层处理工具调用批次与 steering messages；
- 外层在 Agent 自然停止后轮询 follow-up messages，决定是否开启下一轮。

主流程：

1. 首次 poll steering；
2. 如有上轮，调用 prepareNextTurn，可替换 context / model / thinking level 或追加消息；
3. 将 prepared / steering messages append 到 context 并发 message events；
4. 调用 prepareRequest（每次模型请求前，包括第一次）；
5. streamAssistantResponse；
6. 若 response stopReason 为 error / aborted：调用 finishTurn 但不采纳 continuation decision，发 turn_end / agent_end 并退出；
7. 对 assistant ToolCalls 执行工具批次；
8. 将 ToolResult messages append 到当前 context；
9. 调用 finishTurn，再发 turn_end；
10. poll steering；没有工具/steering 时 poll follow-up；
11. 需要继续时启动下一 turn，否则发 agent_end。

finishTurn 可返回 { action: end } 或 { action: continue }。continue 保证下一次 provider request，但如果 tool results / steering / follow-up 已经自然触发下一请求，不会多发一次；若没有自然输入则发 context-only request。无条件返回 continue 会形成无限请求循环。

### 4.2 上下文转换边界

每次模型请求：

AgentMessage[] → transformContext() → convertToLlm() → normalizeContext() → StreamFn

- AgentMessage 允许应用通过 declaration merging 增加 custom message role；
- transformContext 适合做 pruning / 注入外部上下文；
- convertToLlm 必须把保留的消息转换成模型支持的 System / User / Assistant / ToolResult；
- 默认 converter 过滤 custom roles，只传 system/user/assistant/toolResult；
- system messages 是 system prompt 与 tool declarations 的权威 transcript representation；
- context.tools 是 runtime 可执行工具集合，Loop 每次 request 前通过 declareToolChanges 与 transcript 已声明 tools 做 diff，以 toolsAdded / toolsRemoved system message patch 通知模型。

transformContext 的返回只用于本次 LLM request conversion，不等于自动替换 Agent 内存 transcript；持久化和 transcript canonicalization 应由宿主明确负责。

### 4.3 StreamFn 合同

StreamFn 接收 Model、normalized TranscriptContext、SimpleStreamOptions，返回 AssistantMessageEventStream（或 Promise）。

类型注释明确要求：

- 请求 / 模型 / runtime failure 不得通过 throw / rejected Promise 表示；
- 必须返回 AssistantMessageEventStream；
- 失败通过 stream protocol event 与最终 AssistantMessage.stopReason = error | aborted 表达。

因此 Provider setup / auth / network 错误需要在 StreamFn adapter 内转换成流终态，而不能把异常直接抛出并假设 Loop 会统一处理。

## 5. Tool execution：preflight 顺序、并行执行、双重结果顺序

### 5.1 Tool call pipeline

每个 ToolCall：

1. 根据 tool name 在当前 executable tools 中 resolve；
2. prepareArguments 可先修复 raw arguments；
3. validateToolArguments 按 schema 校验；
4. beforeToolCall 在验证后、执行前调用，可 block；
5. 执行 tool.execute(toolCallId, args, signal, onUpdate)；
6. afterToolCall 在执行后、tool_execution_end / ToolResult message 之前运行，可改写 content / details / usage / isError / terminate；
7. 发 tool_execution_end；
8. 构造 ToolResult message 并 append transcript。

beforeToolCall / validation / tool exception 会转为 error ToolResult；afterToolCall 自身抛错也会转为 error ToolResult。工具执行时间使用 monotonic performance.now()。

### 5.2 Parallel 的准确语义

默认 toolExecution = parallel：

- tool calls 按 assistant source order 逐个 emit start、prepareArguments、schema validation、beforeToolCall；
- 所有通过 preflight 的工具随后并发执行；
- tool_execution_end 按真实 finalize/completion order 发出；
- ToolResult message events 与 turn_end.toolResults 按 assistant source order 发出；
- 若本批任一 ToolCall 对应 tool 的 executionMode === sequential，整个批次转为 sequential，而不是只把该工具局部串行化。

agent-loop.test.ts 用一个慢工具等待另一个快工具的结束事件，实际断言：

| 观测 | 顺序 |
|---|---|
| tool_execution_end | tool-2 → tool-1 |
| ToolResult message | tool-1 → tool-2 |
| turn_end.toolResults | tool-1 → tool-2 |

这是动态测试，不只是 README 声明。

### 5.3 Abort 与 late tool update

- tool.execute 收到 AbortSignal，但 Core 不会强制终止工具 Promise；工具实现必须合作取消。
- parallel path 在启动下一 deferred tool 前检查 signal；已经启动的 Promise 会被 Promise.all 等待。
- onUpdate callback 在 execute Promise settle 后停止接收；已排队的 update event sink Promise 会被 await。
- 如果工具忽略 AbortSignal，Run 可能继续等待工具结束；Core 没有通用的强制 kill / process containment。

### 5.4 Truncated tool call

assistant response 的 stopReason === length 且 content 仍有 ToolCalls 时：

- Loop 不执行其中任何 ToolCall；
- 每个 ToolCall 产生 error ToolResult，说明参数可能被截断，要求模型重发完整调用；
- 后续可正常继续下一次模型请求。

这与旧 Kernel 对 TRUNCATED_MODEL_OUTPUT 的硬失败合同不同。旧动态实验只证明 Pi 1.4.0 的这一行为，不决定新 Agent 应采用哪一种策略。

## 6. 错误与终态：prompt resolve 不代表成功

高层 Agent.runWithLifecycle()：

- 捕获 executor 抛出的异常；
- 调用 handleRunFailure() 合成 assistant error / aborted message；
- 发 message_start、message_end、turn_end、agent_end；
- finally 调用 finishRun 清理 streaming state 并 resolve activeRun。

因此正常的 Loop / provider 终态错误一般通过事件与 state.errorMessage 表示，Agent.prompt() 可能 resolve 而不是 reject。调用者不能将 await prompt() 正常返回等同于任务成功，必须检查终态事件 / state。

低层 agentLoop() 的包装不同：它调用 void runAgentLoop(...).then(stream.end)，没有在该 wrapper 内将 rejected run 映射为 stream error/end。类型契约要求许多 callbacks / StreamFn 不 throw，但不应假设所有自定义 hook 或 event sink failure 都会被统一转换。后续应增加低层 reject path 的隔离动态验证。

## 7. Replay policy 的职责边界

AgentTool 类型含 replay?: never | safe 字段，但 packages/agent/src/agent-loop.ts 的执行路径不读取该字段；Core Loop 本身没有持久化 Intent，也不决定 crash 后重放。

pi-durable 使用自己的 ToolRegistration 类型，字段为 replay?: safe | unsafe，不是 Core AgentTool 类型或相同枚举。其 ToolTask 消费 Durable 自己的 replay policy：

- 在进入 execute 前 commit ToolTaskCheckpoint { phase: execute, arguments, replay }；
- 默认 replay 为 unsafe；
- crash recovery 只有当 stored replay 与当前 resolve 到的 tool replay 都为 safe 时才重跑；
- 其他未完成 effect 以 interrupted / may have partially run 结算，而不是盲目重放。

这不是一个可直接共享的类型级跨包契约，而是两套 runtime 各自声明 replay policy：Core 的 replay 字段当前不由 Loop 执行；Durable 的 ToolRegistration + ToolTask 才形成自己的持久化执行语义。两者不能混为一个“Core 已实现安全重放”的结论。

## 8. 既有动态实验的复核结论

PR #48 报告 30–31：

- 报告 30：发布包 1.4.0 的 4 项确定性 Loop 实验全部通过；
- 报告 31：7 项 Journal / Host adapter 边界实验通过；
- 合计 11/11，Node 22.19.0，使用 Fake Stream、Fake Host、in-memory Journal；
- 已覆盖异步 message_end barrier、parallel completion vs transcript order、truncated ToolCall 不执行、Intent commit failure fail-closed、Receipt write failure -> OUTCOME_UNKNOWN、并行批次 late call fence 等。

本轮新增了 v1.4.0 tag 与旧 source ref 的核心文件 blob equality，因此这些动态实验的核心 Agent runtime 源码 pin 已对齐。

仍未证明：

- 真实 Provider / network retry；
- 真实数据库事务、fsync、断电恢复；
- 真实 Host side effect、幂等、权限撤销、跨进程 fencing；
- 并行批次中已经启动的其他外部工具在一个 sibling unknown 后如何收敛；
- npm tarball dist 与 source build 的字节级等价；
- 完整 pi-durable / Chord 的 crash recovery 与生产数据保证。

## 9. 事实 / 推断 / 未知

### 源码事实

- pi-agent-core@1.4.0 的 root export 只暴露 Agent、Loop、Proxy、StreamFn setter 和 types。
- Agent 内存 state / 单 activeRun / steering 与 follow-up queues / abort / waitForIdle / reset 在 agent.ts 实现。
- 高层 Agent await listeners；低层 EventStream 只排队事件，不提供异步 consumer barrier。
- Loop 通过 transformContext / convertToLlm / normalizeContext 在模型边界转换消息。
- Parallel 工具 preflight 顺序、执行并发、execution_end 完成顺序与 ToolResult source order 有明确实现和测试。
- Core AgentTool.replay metadata 不由 Agent Loop 使用；Durable ToolTask 持久化并执行 replay policy。
- v1.0.0 将 Harness / Session / Storage / Compaction 等从 Core 移出至 pi-durable。

### 推断 / 风险（静态推断，未复现）

- 低层 EventStream 没有容量上限；消费者慢于生产者时，事件会在内存 FIFO 中积压。
- low-level wrapper 没有 rejected runAgentLoop 的 catch->stream.end path；若自定义配置回调违约 reject，iterator / result 可能无法正常终结。
- tool 忽略 AbortSignal 时，Core 只能等待其 Promise；不能提供强制终止或外部副作用回滚。
- Agent.prompt() 正常 resolve 不能作为成功信号；需要宿主定义成功终态判断。

### 未知 / 资料缺口

- npm tarball 1.4.0 的 dist 文件与 tag 源码构建产物尚未 byte-for-byte 比较。
- 真实 Provider、工具副作用、取消、进程崩溃、跨进程恢复未运行。
- pi-durable 是独立 GenerationTask / ToolTask runtime，非 pi-agent-core adapter；其存储原子性、crash recovery、task scheduler、ownership、replay、compaction 和 session tree 尚未完成系统研究。
- pi-coding-agent 如何组合 Agent Core、Durable、MCP、extensions、Session UI / RPC，尚未完整追踪。

## 10. 对目标架构的非决策性启示

1. 把 Loop 与 Durable Runtime 分离研究：不要把 transcript orchestration 当成 durable execution；需要独立的 Task / Journal / Storage / Host 设计。
2. 明确高层屏障与低层观察流：持久化 Intent 的屏障必须在工具启动前 await；单纯 UI event stream 不具备该保证。
3. 事件顺序与事实顺序分离：工具完成事件反映真实时间；模型 transcript 需采用确定、可重放的 source order。
4. Tool replay policy 不是模型层能力：tool 声明只是策略输入，durable runner 需要持久化 intent、当前策略复核、未知结果与副作用幂等边界。
5. 取消要依赖执行端合作：AbortSignal 是通知机制，不是强制 kill、事务回滚或 Receipt。
6. 错误状态要显式：API Promise resolve、agent_end、turn_end、errorMessage 是不同层级；Host / App 需要明确成功终态契约。
7. 独立保留 truncation decision：Pi 的 error ToolResult-and-continue 是一个可选策略，不是普适安全默认。

以上是研究输入，不是已批准架构决策；旧 Kernel 不因此被保留。

## 11. 下一步

1. 将 pi-durable@1.4.0 作为独立 Agent runtime 研究：Harness / Conversation / GenerationTask / Task / Scheduler / ToolTask / abort / restart / replay / nested calls / compaction / Session storage；确认它如何复用 pi-ai 而不依赖 pi-agent-core。
2. 研究 @earendil-works/chord@1.4.0：document state、commit transaction、outbox、storage adapters、SQLite / JSONL / IndexedDB、checkpoint / delta replay、crash semantics。
3. 研究 @earendil-works/pi-coding-agent@1.4.0：AgentSession 如何组合 Core、Durable、MCP、extensions、permission、RPC 与 UI。
4. 对照 PR #48 旧适配原型，重新抽象 Journal / Host / Replay 的职责，不预设必须沿用现有 Kernel。
5. 完成 Pi 子系统研究后，与 Claude CLI / Desktop 同场景对照，再提出独立目标架构。明确批准前不进入开发。

## 12. 本轮边界

只新增研究报告和进度记录。没有新增 Agent Loop、adapter、tool executor、Session store 或 Kernel 实现；没有修改业务代码；没有提交开发 PR。

## 13. Evidence index

| 文件 | Blob SHA / commit | 关键锚点 |
|---|---|---|
| Release tag | commit 4a080252f06caf63a525d7873c5d94d3c23887e0 | Release v1.4.0 |
| packages/agent/package.json | ec1838680fda5465aacf490378c31e76b4ed767b | name/version/dependencies/engines/exports/files |
| packages/agent/src/index.ts | ca00bc77726653ff4a84e6f021d70c3cd3d7bbd0 | public export surface |
| packages/agent/src/agent.ts | c0a482d3a499b6baabd61cd1c4eed3f93cb2a9a6 | AgentOptions; PendingMessageQueue; Agent; prompt/continue/steer/followUp; runWithLifecycle; processEvents |
| packages/agent/src/agent-loop.ts | cfc9401e5581847f6d5a9bb1815ab0f0e663f2e5 | agentLoop; runAgentLoop; runLoop; declareToolChanges; streamAssistantResponse; executeToolCallsSequential/Parallel; prepareToolCall; executePreparedToolCall |
| packages/agent/src/types.ts | dbfba74a084f71951e48285869730b70a405ba3a | StreamFn contract; AgentTool replay; AgentContext; AgentState; AgentEvent |
| packages/ai/src/utils/event-stream.ts | eb968c016dfba785899c770099a74d0180b53364 | FifoQueue; EventStream.push/end/asyncIterator/result |
| packages/agent/test/agent.test.ts | 6fad6109fa090bd9348b87350c92d194c21d27f2 | async subscriber barrier; waitForIdle; AbortSignal |
| packages/agent/test/agent-loop.test.ts | 4a9386a131db7f24b3f309d4b9b2e545277a3fbc | parallel completion order vs ToolResult source order |
| packages/agent/CHANGELOG.md | 5b970f8d092e2254776025dc124e4cd061eba688 | v1.0.0 Harness removal; v1.4.0 identity |
| packages/durable/package.json | f5756989cdc757004bffd0b8105f78056a4ee1fc | pi-durable@1.4.0, exports, storage subpaths |
| packages/durable/src/harness/types.ts | 289b5c4e18b0a36267ef5f5e36d9afda2a649ecf | 独立 ToolRegistration replay enum / Agent contract |
| packages/durable/src/harness/generation.ts | c8d26791cd5a2e26287f73255b75f65ec21c3f22 | GenerationTask 直接依赖 pi-ai；不是 pi-agent-core loop |
| packages/durable/src/harness/tool.ts | 52bc4a3ada1892645aca5a35f4d90b875edda4ca | ToolTask intent checkpoint, replay-safe recovery, nested calls |
| packages/durable/src/harness/agent.ts | 64a15bb6a3069eb92f6dbad374a51b4f1f1c2a02 | Durable Agent / AgentDoc / settings / extension state |

**证据等级：** 固定 release tag 源码静态分析 + 既有发布包 fake-based 动态测试复核。没有真实模型、数据库、外部工具副作用、进程崩溃或恢复测试。
