# Pi Agent 内核源码研究：事件流、Steering 和工具执行

> 研究时间：2026-10-25；源码版本：[earendil-works/pi @ d5b3de22d0e24a3e9c38a9410d3329b099717283](https://github.com/earendil-works/pi/tree/d5b3de22d0e24a3e9c38a9410d3329b099717283)。证据 A2：直接读取固定提交的 TypeScript；未运行实际 Agent 测试。项目已从旧 `badlogic/pi-mono` 地址重定向到 `earendil-works/pi`，此处以当前位置为准。

## 一、研究范围与主要文件

| 文件 | 主要职责 |
| --- | --- |
| [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/agent-loop.ts) | `agentLoop`/`agentLoopContinue`、模型流与工具执行、双层循环 |
| [`packages/agent/src/agent.ts`](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/agent.ts) | `Agent` 有状态外壳、队列、取消、订阅、Lifecycle |
| [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/types.ts) | `AgentLoopConfig`、`AgentTool`、Model/Tool 事件和上下文合同 |

固定读取的 blob SHA：`agent-loop.ts=cfc9401e5581847f6d5a9bb1815ab0f0e663f2e5`、`agent.ts=c0a482d3a499b6baabd61cd1c4eed3f93cb2a9a6`、`types.ts=dbfba74a084f71951e48285869730b70a405ba3a`。

**重要边界**：这是 `packages/agent` 的通用 Agent Core，不等于整个 Pi Coding Agent 产品宿主；文件系统、Shell、会话文件/分支树、Skills 等高层功能可能由上层包承载。没有在核心发现强制 OS 沙箱，不能说整个 Pi 产品没有权限机制。

## 二、真正的循环

`agent-loop.ts`：

- L47 `agentLoop()` 接受新消息并驱动执行；L80 `agentLoopContinue()` 在已有上下文上续跑；L111/137 提供显式 `runAgentLoop*`。
- L172 `runLoop()`：**外层 while** 用于后续 FollowUp，**内层 while** 处理当前 assistant 的工具调用以及 Steering。
- L203 附近 `prepareNextTurn` 可以切换上下文、模型和推理级别；这为压缩与策略调整预留了显式时机。
- L223 `prepareRequest` 允许在请求发送前更新模型和上下文；L390 `streamAssistantResponse` 调用模型并流式发事件。
- L254：模型 error/aborted 是硬退出；L267：筛选 ToolCall；如果 stopReason 为 `length`（输出 Token 截断），**拒绝执行所有被截断消息中的工具调用**，发错误结果，避免截断后的 JSON 被误当完整参数。
- L296 `turn_end` 后，`finishTurn` 可以明确 end/continue；L311 再检查 FollowUp；最后结束 Agent Run。

```text
用户输入 / Agent.prompt
  → Agent.run()
  → runLoop（外层 follow-up，内层工具/steering）
  → prepareNextTurn / prepareRequest
  → streamAssistantResponse（StreamFn）
  → toolCalls? → executeToolCalls
  → tool_result / message 生命周期
  → finishTurn → steer or follow-up or agent_end
```

这里的“Turn”是 **一次 assistant 响应 + 对应工具结果**；我们的设计里 User Turn 可包含多个 Model Step，**不能复用同名而不重新定义语义**。

## 三、工具并发已经比过去的简单印象复杂

`agent-loop.ts L518–690`：

- `executeToolCalls` 遍历本次 assistant ToolCall，发现配置 `toolExecution=sequential` 或任一 Tool 的 `executionMode=sequential`，整批调用串行处理；否则并行。
- 串行模式：依次 `prepareToolCall`（解析、Schema、beforeHook），执行并 finalize/afterHook，发每个 ToolResult。
- 并行模式：**按模型原始顺序进行 preflight**，将可执行操作收集成回调后通过 `Promise.all` 并发执行；执行完成事件可按完成先后出现，模型历史里的 ToolResult 消息仍按原始顺序回填。
- L730 附近的 `prepareToolCall` 对未知工具、非法参数和 beforeToolCall.block 返回错误结果，而不是直接将非法调用交给宿主。
- `types.ts L310–336` 明确描述并发模式和 before/after hooks；`afterToolCall` 可修改模型可见的结果，包括 content/details/isError/usage，**因此自研内核必须将真实执行收据与展示结果分离**。
- `shouldTerminateToolBatch`：当所有最终 ToolResult 都提示 terminate 时停止；不能把一个工具的主观标记等同于整个 Turn 的硬状态确认。

**局限**：单个工具的 `executionMode` 是相对粗粒度的声明。全批只要含一个串行工具即串行；它尚不能表达任意两条写工具的资源冲突图。自研可在保持清晰 API 的基础上做资源锁/冲突图与幂等性约束。

## 四、事件和外部消费

`types.ts L512–539` 定义 `agent_end`、`turn_end`、`message_start/end`、`tool_execution_start/update/end` 等生命周期事件。Agent 类中的 `subscribe()` 允许异步监听者；`agent.ts L575–620` 先把事件写入进程内状态，再调用 listeners。

- 状态含正在流式更新的消息、已完成消息、工具运行集合和 errorMessage。
- `Agent.abort()` 通过当前 `AbortController` 通知运行；`waitForIdle()` 等待执行及异步监听者结束。
- `steer()`、`followUp()` 是不同队列；队列有 one-at-a-time / 其他 drain 策略。Steering 不是未经授权直接替换已经执行的工具。

**关键限制**：这是进程内事件流和状态同步契约，不是持久事件日志。核心类并没有证明任务在断电后可按 Event Sequence 恢复，也没有把外部 ToolCall 的副作用原子提交到 EventStore。

## 五、模型抽象与 Context

`StreamFn` 适配 Provider；`transformContext`、`prepareRequest`、`prepareNextTurn` 是与特定模型厂商无关的受控扩展点。这体现了 Pi 最应该学习的部分：

- Agent Loop 不需要知道具体模型 HTTP 接口。
- 上下文转换在明确边界触发，可以添加压缩策略。
- 模型的错误与取消必须映射为标准 Assistant 终态；不能仅有 throw 无模型可见事件。
- 工具集变化可通过显式 system 消息声明增删，避免模型工具描述与执行器可调用集合不同步。

## 六、与 Claude Code 和 Codex 的不同处

Pi 的低层 Kernel 相对紧凑，控制点通过 Callback 和明示状态表达；Claude Code 的真实 CLI 还包括庞大的宿主、安全、Hook、工作树与任务设施；Codex Rust 的 Session/Turn/工具审批则在核心服务里更紧密地持有持久状态。

因此不能仅凭 `packages/agent/src` 的代码少，就断定 Pi 整个产品安全性差、性能差或没功能；但如果把 Pi Core 单独当生产级可恢复任务服务，就还需要我们自行提供持久化、审批与隔离。

## 七、对自己的内核的借鉴优先级

**优先借鉴（P0）**：

1. 核心 Loop 小而明确，外层任务循环与内层工具循环分开；
2. Provider `streamFn` 规范化模型输出；
3. Steering / FollowUp 分队列，生命周期事件顺序可测试；
4. before/afterToolCall 的纯接口与强制 Schema preflight；
5. 输出截断时一律拒绝运行不完整 ToolCall。

**经过修改借鉴（P1）**：

- 并发工具仍先执行受信任的全批 preflight，但安全资源冲突调度应从“全批串行/并行”升级成每 ToolCall 权限、读写集和隔离；
- Context 压缩可插拔，但压缩前后应提交版本化检查点；
- Callback 不能成为提高 OS 权限或伪造 EventStore 终态的途径。

**不直接采用**：

- 不把 `Agent` 的进程内 transcript 数组当成可靠持久化来源；
- 不把 `AbortController.abort()` 当成外部 Shell 的已撤销证明；
- 不依赖任一 `@mariozechner/pi-agent-core` API 作为我们内核不可替换的核心接口。

## 八、完成度和测试清单

| 项目 | 本轮状态 |
| --- | --- |
| Loop 入口、双层循环、Steering/FollowUp | **A2 直接确认** |
| Tool 并发 Preflight 与回填 | **A2 直接确认** |
| 核心模型/工具事件 API | **A2 直接确认** |
| Pi 产品级 Session/Skills/扩展宿主 | 未完整审计 |
| OS Sandbox 与权限实际实施 | 未完整审计 |
| 断电持久化、进程崩溃恢复 | 未完成动态测试 |
| 成本、延迟、任务成功率基准 | 未进行同条件实验 |

拟议测试：同一模型返回三工具（两只读、一写）时并发有序且不越权；StopReason length 导致实际工具执行 0 次；beforeHook 拒绝不执行；afterHook 改结果不得篡改宿主收据；Steering/FollowUp 不重复或乱序；Listener 异常能清晰报告；崩溃恢复交由自研事件层实现。

**判断：Pi 的通用 Agent Core 主干已能高置信理解，Pi 完整 Coding Agent 产品及真实故障语义尚未“研究透”。**
