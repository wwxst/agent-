# DeepSeek Harness：Cordis 可组合内核、Session 日志及恢复机制

> 研究时间 2026-10-25；版本 [deepseek-ai/deepseek-harness @ 22ddee3792402c3e70ec5f86a63c3e3e895a2f60](https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)；证据 A2（源码）+ C（项目自身文档）。未运行 dsh 或多进程故障测试。

## 一、研究范围和文件

| 文件 | 直接确认 |
| --- | --- |
| [`packages/core/agent-loop/src/agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts) | `ReactLoopAgent`、Inbox、Turn/Step、模型请求与取消 |
| [`packages/core/agent-loop/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/index.ts) | Agent 工厂、作用域、会话创建/恢复与关闭 |
| [`packages/core/agent/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent/src/index.ts) | 公共 Agent Contract、进程内启动源 AsyncLocalStorage |
| [`packages/core/session/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/session/src/index.ts) | Session 事件、不可变消息、日志与历史投影 |
| [`packages/core/tools/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tools/src/index.ts) | Scope 化工具注册、Guard 与 Executor |
| [`packages/core/tools/src/batch.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tools/src/batch.ts) | 并行工具批次与按序结果提交 |
| [`docs/subsystems/persistence.md`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/subsystems/persistence.md) | 持久化 Handle/append/flush、单写租约和崩溃修复 |
| [`packages/core/agent-loop/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/README.md) | 官方合同、明确列出的已知限制 |

## 二、“一切皆插件”具体是什么

Cordis 是组件运行容器。模型 Adapter、Session、Agent Loop、Tool Registry、UI/SDK 都由插件提供服务。消费者依赖公共 `ctx.agents`、`ctx.tools`、`ctx.sessions` 等，而不是直接依赖默认 Driver。

`packages/core/agent/src/index.ts` 提供公共 Agent handle、Registry 和进程内 `AsyncLocalStorage` initiator scope；`agent-loop` 通过注册 AgentFactory 实现 Agent 的创建和执行。扩展可为单个 Agent 添加 Prompt Sections/Tool 能力，也能在卸载时撤销这些注册。

**“插件可替换”与“用户安装插件可无条件升权”是两件事。** Cordis 的组件组合不是操作系统级沙箱；安全仍依赖实际 Tool Executor、Permission、Sandbox、Host。

Profile/Bundle/Config Patch 组合应用，支持 web、headless、sdk、sdk-minimal、acp 等运行形态。它更偏向组件装配，而不是只有代码插件市场。

## 三、实际 Turn/Step Driver

[`agent.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts) 中：

- L103：`ReactLoopAgent` 持有 AgentModel、Inbox、Session、phase。
- L163–181：`send` 把输入放入 `next-turn` 或 `next-step`；与 FollowUp、Steer、Inject 对应的唤醒策略不同。
- L225–269：Driver 处理异步启动、取消与任务结束。
- L276：`preStep()` 从 Inbox 认领输入，调用 `ctx.tools.resolve` 取得当下可用 ToolSet，调用 `ctx.systemPrompt.assemble` 准备消息，并经 `agent/pre-step` 做入场检查。
- L319：`turn()` 先追加 `turn/start`，再进入 Step Loop；L354 追加 `step/start`。后续模型回复及工具调用通过 Session Event 记录，直到 `turn/end`。

```text
Agent.send / steer / inject / followup
  → Durable Inbox（session 投影）
  → ReactLoopAgent.turn
  → session.append(turn/start)
  → preStep：工具集解析 + Prompt 组装 + 审核
  → session.append(step/start)
  → Adapter model.stream
  → Tool Executor batch
  → assistant/message / tool/call / tool/result / step/end
  → 下一 Step 或 turn/end
```

该结构最值得借鉴的是：**模型能看见的内容被归入 Session Event，由日志投影成历史**，便于恢复和审计。它与 Pi Core 的进程内 transcript 数组是不同的状态来源哲学。

## 四、工具 Scope 与并发批次

`packages/core/tools/src/index.ts`：

- `ToolsService.register()` 将工具声明与执行者放入 Global 或 Agent Scope；同作用域重复名称受限；
- `restrict()` 只能在 Agent Scope 中使用，并检查非法/未知名称；
- `resolve()` 在 Step 入场时挑选可执行工具集合；
- `setExecutor()` 指定当前执行器；`guard()` 注册单调安全拒绝规则；
- `checkGuards()` 在预处理/审批后再次检查，避免插件绕过最终强制条件。

`packages/core/tools/src/batch.ts`：

- 为每个 ToolCall 解析参数并安排执行；
- 独占工具构成队列屏障，安全工具可受 `maxParallelToolCalls` 配额并发；
- 正常情况下并发体可重叠，但 pre-execute 政策、最终结果和模型历史中的顺序有更严格的提交关系；
- L247 附近在执行前将 `tool/call` 追加到 Session，L254 之后追加工具结果，Abort/失败时还会产生合成错误结果保持日志闭合。

**与 Pi 对照**：Pi 目前一个 Tool 的 executionMode=sequential 可让整个同批串行；DeepSeek 的批次调度允许“独占屏障 + 安全工具并发”更精细，并显式提供可回放的 ToolCall/Result 事件。

但是并发分类仍主要基于**单工具的一元安全属性**。官方 README 明确指出，如果安全与兄弟调用或读写资源冲突有关，应保守使用独占，不能据此证明具备全资源冲突图。

## 五、最重要的细节：Session Event != 已经持久化

[`persistence.md`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/subsystems/persistence.md) 对接口语义区分十分明确：

- `Session` 是进程中的 append-only Event Log，记录模型可见的事实，后续通过 `deriveMessages` 生成模型历史；
- `session/event` 是提交后的观察通知；持久化由插件/SessionPersistence 处理；
- `SessionHandle.append(events)` 要求事件序号连续、不可改写，但**成功返回并不必然意味着掉电后保证存活**，某些后端允许缓冲；
- **只有 `SessionHandle.flush()`** 构成明确持久化屏障。写 Handle 的 close 会 drain；
- `SessionPersistence.open(id,'write')` 声明单写入所有权，读者可只读观察，保护恢复过程不会与另一写者同时改动。

这一点意味着不要把产品文档中的“Event Sourcing”直接翻译成“每个状态变更先写盘再做副作用”。这两个系统性质不同，需要针对危险 ToolCall 额外制定强制 `flush` 时机或工具意图事务机制。

## 六、崩溃恢复：日志物理修复与 Agent 语义修复分开

`packages/core/agent-loop/src/index.ts L765–814` 的 `resume`：

1. 首先尝试获取 Session **write handle**，避免同 ID 的并发恢复；
2. 读取物理连续有效的持久事件前缀；
3. 调 `interruptedTurnClosers(persisted)` 为未结束 ToolCall 补合成失败、缺失的 `step/end` 和 `turn/end(kind:'interrupted')`；
4. 将这些修复事件通过同一个 write handle append；
5. 准备带恢复事件的 Session 并重新启动 Agent。

**关键区别**：

- 存储层只负责物理上有效的日志，不能擅自“猜”某工具是否执行；
- Agent 层负责语义上的闭合；
- 合成结果使模型会话可恢复，但**不等于证明某个外部工具从未产生副作用**。

对自研内核应增加：已准备的副作用执行收据、`OutcomeUnknown`、Host 端查询/人工协调。

## 七、官方明确承认的局限（截至锁定提交）

[`agent-loop/README.md L208–221`](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/README.md#L208-L221)：

1. **没有内建 Turn 预算**：需要额外策略在现有生命周期扩展点施加最大轮数/步数/工具预算。
2. **Root shutdown persistence**：活动 Agent 在根上下文关闭时，最后 `turn/end` 有可能已经存在于内存但未进入持久日志；Teardown 完成不保证最终事件保存。
3. 工具并发分类为一元属性，无法直接表达跨调用资源冲突。
4. 某些 Config Agent 创建默认生成新的 Session ID；要稳定恢复需显式固定标识。

这些是公开的限制；不能以“Source 里有 flush 接口”就反推关闭已严格保证持久化。

## 八、与 Pi、Codex、Claude 的不同处

- **Pi** 强调小型 Loop + Callback，基底更容易理解。
- **Codex** 强调明确 Step Snapshot、审批/沙箱、持久会话、强工程分层。
- **Claude Code** 具备长时工具与子 Agent 机制，但新版打包产物对调用者可读性不如这几个开源项目。
- **DeepSeek Harness** 把 Session 事实流与组件 Scope 都作为正式合同，Profile/Bundle 组合适合多业务 Agent。

作为自研项目，不建议把安全根、Turn 状态机和 EventStore 的关键事实提交也放进普通热卸载插件里。我们可以把 Provider、Tool Adapter、Skill、Transport 和业务工作流插件化，而把状态不变量、审批准入、故障恢复保留在可信内核。

## 九、借鉴优先级

**P0**：Agent/Session/Turn/Step 事件语义、Inbox 认领与可回放、Step 工具集固定、Scope 化注册与撤销、工具入场时合成错误结果、显式持久化屏障。

**P1**：Profile/Bundle、子 Agent Scope、动态 Tool Set、可逆生命周期、数据投影、受控事件 Hook。

**暂缓/不直接照搬**：全系统任意热替换、复杂配置层叠、没有硬 Turn 预算、把 `append` 当永续提交、插件能替换权限根、仅靠合成中断终态掩盖未知副作用。

## 十、研究完成度与测试计划

A2 已确认：ReactLoopAgent Turn/Step、Session Event、批次执行与独占屏障、单写入 Handle/append/flush、恢复闭合、官方限制。

未完成：具体 File/System Sandbox 平台 enforcement、全部 Tool Guard 与审批时序的动态路径、多进程竞争场景、压力下的缓冲持久化、UI/SDK Profile 环境多样性、最新 Feature Gate 的实际部署启用状态。

**必须测试**：ToolCall Intent append 后尚未 flush 进程崩溃；审批与工具执行冲突；部分写入日志物理截断；两个 Writer 抢同一个 Session；Root shutdown 时工具/Turn 终态的持久性；卸载 Scope 时运行中工具使用旧实现还是错误终结；多个 Session Profile 的权限不可越界。

**判断：DeepSeek Harness 默认 Core 的执行和事件机制已有直接证据，但官方承认的运行终态持久性和安全边界意味着不能据静态代码宣布“研究透”。**
