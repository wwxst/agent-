# 28 · Pi Agent Core 适配边界审查：可替换循环，但不是即插即用

> 日期：2026-10-29。样本：[Pi Agent Core @ d5b3de22](https://github.com/earendil-works/pi/tree/d5b3de22d0e24a3e9c38a9410d3329b099717283)；自研基线：[main @ f9f36ac1](https://github.com/wwxst/agent-/tree/f9f36ac100f2521bca0868b6d6563e2a1a18df04)。性质：静态 API 与控制流审查；没有写适配器，没有运行产品。

## 0. 结论

Pi Agent Core 不只是值得借鉴的代码，它有明确的低层接口，可以作为替换自研循环的真实候选。但适配方式很重要：

- **优先评估 Pi 的低层 runAgentLoop()，不要直接使用 agentLoop() 事件流封装来承载持久化。** runAgentLoop() 接受异步 EventSink，并在关键步骤 await 它；agentLoop() 的公共封装只把事件推入内部队列，外部消费者的异步处理并不构成工具执行前的持久化屏障。
- Pi 在完整 assistant message 的 message_end 事件之后才开始工具准备/执行。因此，适配器有机会在这一边界原子写入 assistant.message 与该批次全部 tool.intent，确保第一个工具启动之前意图已经持久化。
- 但不能把所有存储错误直接从工具完成事件抛出。Pi 的并行执行器用 Promise.all 汇总工具闭包；单个事件回调拒绝可能使等待提前失败，而其他工具闭包仍在运行。适配器必须让已启动工具全部收敛，再将持久化失败升级为 Turn 级错误。
- Pi 对截断输出的处理与当前 Kernel 不同：Pi 会为被截断消息中的工具调用生成错误结果并可能继续循环；当前 Kernel 在记录 assistant.message 之前就以 TRUNCATED_MODEL_OUTPUT 失败。若采用 Pi，必须显式保留当前安全合同或由维护者接受经测试的新行为，不能无意中改变。
- 因此当前结论是 **ADAPTER SPIKE WORTH RUNNING / NOT ADOPTED**。可以用 Pi 替换 Loop，但 Session/EventStore、Lease、预算、可信 Host、UNKNOWN 与恢复仍需由自研适配层负责。

## 1. 关键 API 与控制流证据

### 1.1 低层运行入口

Pi 的 agent-loop.ts 同时导出：
- agentLoop()：返回事件流，并在内部将 runAgentLoop() 的事件推入该流；
- runAgentLoop()：直接接受异步 emit 回调，逐事件 await，并返回本次产生的消息数组；
- agentLoopContinue() / runAgentLoopContinue()：从已有上下文续跑。

对于需要在工具执行前提交数据库事务的 Kernel，runAgentLoop() 更适合作为适配边界，因为自定义异步事件处理可以成为执行屏障。

源码：[Pi agent-loop.ts](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/agent-loop.ts)。

### 1.2 assistant.message 与 tool.intent 的安全屏障

Pi 的控制流顺序是：

1. streamAssistantResponse() 完成响应，await message_end 事件；
2. runLoop() 检查 AssistantMessage 的 stopReason；
3. 提取 ToolCall；
4. executeToolCalls() 先逐个准备调用；并行模式下，全部准备结束后才通过 Promise.all 启动实际执行闭包。

因此，在 runAgentLoop() 的异步 EventSink 中处理 assistant 的 message_end 时，可以先检查 stopReason、ToolCall ID 唯一性、调用数预算和输出预算，然后把完整 assistant.message 与该批全部 tool.intent 放进一次 EventStore append。该 append 成功后才返回，之后 Pi 才会进入工具执行阶段。

这在结构上可以保留当前 Kernel 的关键不变量：**所有工具意图在第一个真实工具副作用前持久化**。它不代表这一实现已写成或已通过崩溃测试。

源码：
- [Pi assistant response 完成与 message_end](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/agent-loop.ts)
- [Pi parallel tool preparation 与执行](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/agent-loop.ts)

### 1.3 beforeToolCall 不是批次持久化的首选位置

Pi 的 beforeToolCall 会在单个工具参数完成 Schema 验证后调用，但异常会被 prepareToolCall 捕获并转成即时工具错误结果。它不是一个自动保证失败会中止整个批次的数据库事务钩子。

因此：
- 不要只在每个 beforeToolCall 内分别写 Intent，并假设任意写入失败都会安全阻止同批其他工具；
- 更适合在完整 assistant message 的 message_end 边界一次性提交整批 Intent；
- beforeToolCall 用于单个调用的授权、工作区版本、工具快照和执行前策略检查；
- 真正的 Host 仍必须独立检查权限与 Lease，不能把 Pi Hook 当作安全边界。

源码：[Pi prepareToolCall](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/agent-loop.ts) 与 [AgentLoopConfig hooks](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/types.ts)。

### 1.4 并行工具期间的存储故障处理

Pi 的并行工具执行器会在每个闭包中执行工具、finalize 结果并 await tool_execution_end 事件，之后用 Promise.all 汇总结果。Promise.all 在一个 Promise reject 时可能提前 reject，不会自动等待其他已启动 Promise 全部 settle。

这与当前 Kernel 的一个显式安全要求不同：当前 executeBatch() 用 Promise.allSettled 排空并发组，再把 Lease 或收据错误传回 Kernel，以免上层过早释放执行权。

因此适配器不能简单地在 tool_execution_end 的 EventSink 中遇到 EventStore 错误就抛异常。候选策略：
1. 在工具完成事件的持久化失败时，记录一个进程内 fatal 状态并触发共享 AbortController；
2. EventSink 不因该状态立即 reject，确保 Pi 的并发汇总等待已启动工具全部返回；
3. 在所有工具闭包收敛后的 finishTurn / 下一次请求边界检测 fatal 状态，并让 Kernel 进入需要对账的失败路径；
4. 在真实 Host 中，不能因为 AbortController 已触发就假定副作用已停止；无法确认的调用必须进入 UNKNOWN / reconciliation。

这是一项需要真实测试的适配复杂度，不应只凭接口存在就判定 Pi 可以直接承载现有可靠性合同。

源码：
- [Pi executeToolCallsParallel](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/agent-loop.ts)
- [当前 Kernel executeBatch 的排空行为](https://github.com/wwxst/agent-/blob/f9f36ac100f2521bca0868b6d6563e2a1a18df04/packages/tool-scheduler/src/index.ts)

## 2. 与当前 Kernel 的接口映射

| 当前 Kernel 合同 | Pi 适配点 | 主要风险/工作 |
|---|---|---|
| 每次模型请求写 model.started、固定 StepContext | prepareRequest 在每个 Provider 请求前调用；可建立本 Step 的闭包快照 | 要保证模型声明的工具与执行器使用同一份工具快照，并保留 stepId/toolSetVersion |
| ProviderEvent 的 text_delta / usage / message_complete | 自定义 StreamFn 返回 AssistantMessageEventStream；可以把现有 ModelProvider 的流事件映射为 Pi 的 start/text/toolcall/done/error 事件 | 当前 Provider 不暴露逐段 ToolCall delta，需要在完成事件时合成 ToolCall 内容块；必须正确映射 stopReason 与 usage |
| ContextMessage 与 AssistantMessage | 在 convertToLlm / Context Projector 中转换角色、内容和 ToolCall ID | summary 角色不是完全相同的原生消息类型；ToolResult outcome 需要在 Kernel 事实层保留，不可只剩 isError 布尔值 |
| assistant.message + 批次 tool.intent | 异步 runAgentLoop EventSink 的 assistant message_end | 检查截断、重复 ID、预算和 finish reason；一笔事务写入整批意图；写入失败时禁止进入工具阶段 |
| 工具 Schema、风险与并发模式 | AgentTool Schema、beforeToolCall、executionMode | Hook 不是 OS 安全边界；写入/外部副作用仍必须由可信 Host 强制授权 |
| tool.receipt 与 tool.result | tool_execution_end 可观测执行完成；工具结果消息之后按模型调用顺序产生 | Receipt 应及时落盘；Context Projector 按 ToolCall ID 排序；持久化错误必须排空其他并发调用 |
| cancelTurn / Lease fencing | AbortSignal + 包装后的 Tool.execute + 外部 Kernel 控制器 | Abort 只是一种请求；Lease 失效时必须防止新副作用，并对已开始任务做对账 |
| maxSteps / maxToolCalls / Token Budget | prepareRequest、assistant message_end、finishTurn 边界 | 在工具启动前做硬预算检查；Provider 未返回 usage 时不能假装满足 Token 上限 |
| Steering / Follow-up | getSteeringMessages、getFollowUpMessages、prepareNextTurn、finishTurn | 必须与持久化队列和消费事件对应；不能让内存队列成为唯一事实源 |
| Context compaction | transformContext / prepareRequest | Pi 的 transformContext 契约要求安全返回，不适合直接把可能抛错的可信压缩器原样接入；需设计失败传播和 checkpoint 映射 |

Pi 的 AgentTool 定义本身包含 replay 策略与 sequential/parallel 执行模式，AgentLoopConfig 也提供 prepareRequest、beforeToolCall、finishTurn、steering 与 follow-up 等钩子。这让集成具备可行性，但没有替我们提供 Session 事件真相源、租约、可信 Host 收据或恢复协调。

相关源码：
- [Pi AgentLoopConfig 与 AgentTool](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/types.ts)
- [Pi EventStream](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/ai/src/utils/event-stream.ts)
- [当前 Kernel contracts](https://github.com/wwxst/agent-/blob/f9f36ac100f2521bca0868b6d6563e2a1a18df04/packages/contracts/src/index.ts)

## 3. 必须明确的行为差异

### 3.1 截断输出

当前 Kernel 在 finishReason 为 length 时拒绝整个响应，并在记录 assistant.message / tool.intent 之前终止 Turn。

Pi 的 runLoop 对 length 响应中的 ToolCall 生成错误结果，而不是执行这些调用；之后通常可以继续后续循环。因此，简单替换 Loop 会改变 Turn 终态与重试语义。

适配器首轮应优先保留现有安全合同：在 assistant message_end 时发现 length，立即拒绝并确保没有任何 Tool Intent 或工具执行。如果未来想采用 Pi 的“合成工具错误后继续”策略，应另立 ADR 并测试，不能作为无意的迁移副作用。

### 3.2 重复 ToolCall ID 与 finish reason

当前 Kernel 在工具执行前检测同一 Turn 内重复 callId，并校验 tool_use 与工具调用数量、截断原因之间的一致性。Pi 的执行准备主要按工具名与参数 Schema 处理调用。适配器必须在完整 assistant message 的屏障处补齐 Kernel 的全批次校验，而不是假设 Pi 的单工具验证足够。

### 3.3 不确定结果

Pi 的工具错误结果不天然等同于 Kernel 的 succeeded / failed / denied / outcome_unknown。Host 返回 UNKNOWN 时，适配器必须将真实状态保存在可信事件中，并阻止模型把它当作普通失败后重试。不要只把 UNKNOWN 转成 Pi 的 isError=true。

## 4. 最小适配原型的验收条件

该原型只用于研究分支，先使用 FakeProvider 和只读 Fake Host，不启用生产写工具。

1. **Admission fence**：故意让 assistant.message + intents 的事务失败；断言真实工具启动次数为零。
2. **Truncated response**：返回 stopReason=length 且含 ToolCall；断言无 Intent、无 Host 启动，Turn 按当前 Kernel 合同失败。
3. **Duplicate callId**：同一消息内重复 ID；断言整个批次在执行前被拒绝。
4. **Reverse completion**：B 先于 A 完成；Receipt 记录真实完成事实，下一次 Provider 的 ToolResult 顺序仍为 A、B。
5. **Receipt persistence failure**：A、B 并发；故意让一个结果的 EventStore 写入失败；断言其他已启动调用全部 settle/进入 UNKNOWN 后才结束，不能提前释放 Lease 或继续模型循环。
6. **Lease lost**：在执行开始前和执行中分别撤销 Lease；断言不再启动新副作用，且不把未知外部结果伪装成普通失败。
7. **Cancellation**：工具不响应 AbortSignal 时，Kernel 不能宣称它已经停止；必须等可信 Host 的终态或进入对账。
8. **Hard budgets**：最大 Step、ToolCall 与 Token 预算在工具启动前生效；usage 缺失时按当前硬合同拒绝。
9. **Steering / Follow-up**：持久队列中的消息恰好消费一次，并在正确的下一请求边界出现。
10. **Context rebuild**：从 EventStore 重建 Pi 上下文，重复重建结果一致；不依赖 Agent 实例的内存状态。

成功标准不是“Pi 测试通过”，而是同一批测试在当前 Kernel 与适配器上都满足相同安全不变量，并比较代码量、依赖、延迟和维护成本。

## 5. 本轮决定

- **KEEP**：当前 EventStore、Lease 与可信 Host 的事实边界，直到替代方案证明不退化。
- **PROPOSE**：以 Pi 的 runAgentLoop() 作为第一个 Loop 替换原型，而不是直接搬入整个 Pi Coding Agent。
- **BLOCKER**：并行回调存储失败必须 drain；截断与重复 ID 必须在执行前拒绝；UNKNOWN 与 Lease 语义不能降级。
- **NOT IMPLEMENTED / NOT RUN**：本报告只完成 API 与控制流审查，没有新增适配代码或执行 Pi 动态基准。
- **DECISION GATE**：若薄适配器不能以可维护的复杂度满足全部合同，就应比较 DeepSeek Harness 整体采用或保留自研，而不是无限给 Pi 增加补丁。

关联：
- [Issue #42：四内核同条件对照与架构重评](https://github.com/wwxst/agent-/issues/42)
- [第 27 号工具结果顺序与 Adopt-vs-Build 报告](27-工具结果顺序与Adopt-vs-Build-2026-10-29.md)
- [Pi Agent Core 固定版本源码](https://github.com/earendil-works/pi/tree/d5b3de22d0e24a3e9c38a9410d3329b099717283)
