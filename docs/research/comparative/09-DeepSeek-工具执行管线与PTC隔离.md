# 09 · DeepSeek Harness 工具 Pipeline、Native/PTC 执行和真实权限边界

> 日期：2026-10-25；固定 [DeepSeek Harness 22ddee3792402c3e70ec5f86a63c3e3e895a2f60](https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60) 的公开 TypeScript。源码静态分析，未运行 Native/PTC 后端或沙箱安全测试。

## 1. 必须把“工具声明”和“工具执行器”分开

`packages/core/tools/src/index.ts` 的 `ToolsService` 管理 Global/Agent Scope 中的工具声明和 Restrict/Guard；`setExecutor()` 允许 Scoped Executor。它不等同于真实工具体。以下新读取的文件补齐执行路径：

| 文件 | Blob SHA | 关注点 |
| --- | --- | --- |
| [tools/pipeline.ts](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tools/src/pipeline.ts) | 直接读取 | `ToolExecutionPipeline`、PreExecute/Ask/Guard/Dispatch/Complete |
| [tools/batch.ts](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tools/src/batch.ts) | `e9a378d997e6a05c305e3bcc1ae6d2e124641f6d` | 原序结果提交、独占/并发、取消合成结果 |
| [tool-executor-native](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tool-executor-native/src/index.ts) | `457749152c004c3b61fe4981eb9c89718bdb1640` | `NativeToolExecutor` 使用共享 Pipeline 和 Batch Scheduler |
| [tool-executor-ptc/ptc.ts](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tool-executor-ptc/src/ptc.ts) | `d23a37b471cdb156287d8a498440a7694cd70335` | `run_code`，程序执行、嵌套工具绑定、提权/沙箱、环境释放 |
| [agent-loop/inbox.ts](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/inbox.ts) | `affe0c6b2f653888dc2177fd2987c6082a93f758` | 模型 Step 前的 Durable Inbox 变更记录 |

## 2. 真实工具阶段的顺序

`tools/pipeline.ts:L185–355`：

```text
ToolCall（带 callId / ToolSet / Scope）
    ↓ createExecution：输入 JSON 快照 + deepFreeze + Token
tools/pre-execute Waterfall
    ↓ ask → approval 服务决策
tools.checkGuards（后置单调 Guard）
    ↓ 允许后调用 around-dispatch tools/execute
actual tool.execute(...)
    ↓ result canonicalization
tools/post-execute + 定义自己的 finalizeContent
    ↓ immutable/model-facing ToolResult
Session: tool/result + sourceEventSeqs
```

**具体代码证据**：

- `createExecution` 复制并冻结参数，赋予 Registry 签发的 execution token；不是任意插件生成的 JSON 就等于已被受信任调度器认可。
- `prepare` 中 `tools/pre-execute` Waterfall 返回 allow/deny/ask；若 ask，则通过 `serviceAsk` 请求 Approval；允许之后**还要通过 `tools.checkGuards`**，使最后的强制否决层独立于允许型 Hook。
- `executionMode()` 只有 `isConcurrencySafe(args) === true` 才返回 parallel；未知、声明缺失、抛异常和隐藏工具均保守为 exclusive。
- `dispatchToolBody` 将原始 Caller Signal 与 Wrapper Signal 融合；Started Body 的 Promise 会等到 settle，**而不是在收到 Abort 后直接忘掉仍运行的操作**。
- `complete` 应用项目内容与后处理，错误会规范化。这个结果是模型可见结果，不能直接当作主机级不可篡改的副作用收据。

## 3. 并发阶段、顺序提交与取消的实际区别

`tools/batch.ts:L110–270`：

- `runGroup` 使用 `maxParallelToolCalls` 限制 in-flight 数量，支持独占 Barrier；
- **prepare/pre-execute/guard 仍在受控顺序中执行，只有 tool body 可以重叠**，不是所有 Hook 都并发；
- `commitReady` 只推进连续完成的模型原始顺序槽位，所以模型历史中的 ToolResult 不能超越前面的调用；
- `BatchSettlement.start()` 在工具开始前向内存 Session 追加 `tool/call`，`commit()` 再 `tool/result`，用 `sourceEventSeqs: [callSeq]` 明确关联源调用事件；
- Cancel 时先 drain 已开始的调用，对后续未执行调用产生合成错误，保持模型可恢复历史的完整性。

**但是**：`Session.append` 到进程内历史不等于磁盘 flush 完成；[持久化研究](04-DeepSeek-Harness-源码研究.md) 已阐明两者保证不同。不能声称“tool/call 在模型流里先出现”就等价于不可逆副作用安全地被持久化。

## 4. Native 与 PTC 根本不是同一种 Tool Executor

### Native：工具调用原生执行

`tool-executor-native/src/index.ts:L8–36`：`NativeToolExecutor` 定义模型可见 Tool Schema，执行时调用 `executeToolBatch(input, pipeline, maxParallel)`。服务被安装在当前 Cordis Scope；不同 Agent 可使用不同工具集合和可见性。

### PTC：把工具 API 暴露给隔离的程序执行环境

`tool-executor-ptc/src/ptc.ts:L260–400`：

- `run_code` 是保留的程序执行传输，不等于普通 Tool Registry 可随便覆盖的工具名；
- 支持 TypeScript/Python Runtime，向程序提供经过限制的 `tools` bindings；
- `resolveSandboxPolicy` 在要求 confinement 的情况下强制取得 `sandboxPolicy` 服务，缺失则抛错；
- `sandbox_permissions` + `justification` 发生提权请求时，须调用 `approveEscalation`，通过 Approval 服务获得新 Mode；
- 返回的 Sandbox Report 可以包含 `full` / `partial` 强制水平，UI 文本明确提示部分文件沙箱执行限制。**报告只是运行时对自身的声明；其 OS 正确性必须独立验证。**

`ptc.ts:L530–705`：

- 内嵌调用按 `tools.schemas(exec.agent,exec.toolSet)` 暴露当前 Agent 许可集合；避免程序枚举未授权全局能力；
- 每个嵌套子调用有 `rootCallId`、`parentCallId`、`subCallId`，分别追加 `tool/ptc-dispatch-start` 和 `tool/ptc-dispatch` 事件；
- 采用同样的顺序 prepare、并发 body、按序 commit 与独占 Barrier；
- 程序退出或取消时 `runController.abort` 并 `await drainDispatches()`，减少遗留孤立子调用；
- 能看到 `Object.create(null)` 和 `Object.defineProperty` 防止诸如 `__proto__` 的工具名触发普通对象原型 Setter；
- Agent Scope 通过 `agent.ctx.effect` 在生命周期结束时释放对应 `runtime.release(agent)` 资源。

**重要局限**：这里不是在证明一个不受信任的程序无法调用任何 OS API；它仍依赖 PtcRuntime 的实际沙箱和 Tool Binding 的权限实施。这段代码可证明存在隔离接口、审批和清理路径，但不能当作沙箱强制执行漏洞评估。

## 5. Durable Inbox 的边界

`agent-loop/src/inbox.ts:L100–233`：

- `next-turn` 与 `next-step` 是不同队列；
- `claim()` 将下一 Step 输入与一个可消耗的 Turn 输入从投影中移除并形成 claimed 事件；
- `splice()` 会验证跨两条队列 Message ID 不重复；
- 真正写历史的是 `session.append('agent/inbox/spliced',...)`，内存投影与模型入场共享这份事件来源。

自研可借鉴“Inbox 是 Event Projection，而不是临时数组”，但要在**接受命令后、向客户 ACK 之前**设计持久化屏障，防止客户端收到已提交 ACK 后队列意图在 crash 中丢失。

## 6. 我们该如何取舍

| 机制 | 应借鉴 | 不能照搬 |
| --- | --- | --- |
| Step ToolSet + Scope | 每次 Step 冻结可执行集合和授权作用域 | 运行中的插件卸载后随意切换实现 |
| PreExecute → Ask → Guard | Guard 是不可被 allow 覆盖的硬否决 | 业务 Hook 给自己提权 |
| Execution Token + Frozen Args | 参数身份、版本和结果关联 | 将普通 JS Token 当进程间防伪凭据 |
| 并发 Barrier + 有序提交 | 生产性能与模型因果顺序兼顾 | 一元并发属性当资源冲突安全的全部依据 |
| PTC 安全程序绑定 | 面向工具编排的受限程序 API | 未经 OS 审计的任意 run_code 自动允许网络/文件操作 |
| Inbox Session Event | 持久输入与可恢复前置队列 | 内存 append 代替可信落盘/事务 |
| 合成 ToolResult | Context 完整性 | 用“用户取消”错误掩盖 Host 不确定副作用 |

## 7. 待验证测试

- Guard 与 PreExecute Allow 同时存在：Guard 必须否决；
- 一个工具输入非法、一个工具超时、另一个工具被取消，结果按原调用 ID/顺序提交；
- ToolSet 在执行过程中热卸载：不得执行新注册同名更高权限工具；
- PTC `run_code` 在无 SandboxPolicy 时必须拒绝 confinement，提权前不得启动；
- 父程序退出后嵌套调用的进程、网络和文件副作用不再冒出未知结果；
- Session `tool/call` append 但未 flush 时崩溃：如实区分损失与工具已启动情况；
- 传递 `__proto__` / 原型相关工具名：不得造成命名空间污染或权限扩展。

**阶段结论**：现在已能解释 DeepSeek 默认 Native/PTC 工具执行的实际阶段、权限拦截和资源生命周期；OS 安全性、全部失败运行状态仍须测试，不能以静态源码宣布研究透。
