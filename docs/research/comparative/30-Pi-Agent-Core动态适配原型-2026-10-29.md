# 30 · Pi Agent Core 动态适配原型：E0 最小闭环验证

> 日期：2026-10-29。性质：已在 GitHub Actions 上运行的隔离动态实验。  
> 动态样本：发布包 `@earendil-works/pi-agent-core@1.4.0` 与 `@earendil-works/pi-ai@1.4.0`。  
> 静态源码参照：`earendil-works/pi@d5b3de22d0e24a3e9c38a9410d3329b099717283`。  
> **注意：本轮没有证明发布包与固定源码提交完全等价；没有运行 Pi Coding Agent 产品、真实 Provider 或真实外部副作用。**

## 0. 结论

**Pi Agent Core 值得继续做薄适配原型，但尚未采用，也不能直接替换当前 Kernel。**

本轮在 Node.js 22.19.0 下运行了四项确定性实验，四项全部通过：

1. 异步 `message_end` 监听器可以作为工具执行前的 Intent 持久化屏障。
2. 并发工具可以按 `fast → slow` 的真实完成顺序发出执行结束事件，同时按原始调用顺序 `slow → fast` 生成 ToolResult 消息并传给下一次模型请求。
3. Assistant 输出以 `length` 结束且包含 ToolCall 时，不执行该工具，而是生成错误 ToolResult；Pi 随后仍可继续下一次模型请求。
4. 模拟 Intent 持久化失败时，工具没有启动；但 **`Agent.prompt()` 会在内部捕获异常并通过错误消息/状态报告，调用本身不一定 reject**。适配器不能把 Promise 正常 resolve 等同于 Turn 成功。

本轮是针对指定循环路径的动态包测试，不是参考产品的全面动态基准，也不证明持久化、授权或沙箱安全。

## 1. 可复核实验环境

| 项目 | 实际值 |
|---|---|
| 仓库 PR | [PR #48](https://github.com/wwxst/agent-/pull/48) |
| GitHub Actions | [Final validation Run #40842575938](https://github.com/wwxst/agent-/actions/runs/40842575938); initial Pi run [#40841917262](https://github.com/wwxst/agent-/actions/runs/40841917262) |
| Node | 22.19.0（Pi Core 声明要求 `>=22.19.0`） |
| Pi Agent Core | npm 发布包 1.4.0 |
| Pi AI | npm 发布包 1.4.0 |
| 模型调用 | 确定性假 Stream；没有访问真实模型服务 |
| 工具 | 内存中的只读测试工具；没有 Shell、写入工具、凭据或真实外部副作用 |
| Pi 测试结果 | 4 tests，4 passed，0 failed，0 skipped |
| 自研 Kernel 回归 | 同一次 PR CI 的 Node 22.16.0 与 Node 22 两个矩阵任务均通过类型检查和现有确定性测试 |

CI 与测试文件：`experiments/pi-core-adapter/spike.test.mjs`。这些结果不替代后续故障注入、真实 Host、跨平台或真实工程任务测试。

### CI 时序复核

Run #40842275641 的一次复跑中，Node 22.16.0 的既有测试 `M1 managed runner: acquire, heartbeat, complete and release across sequential turns` 曾因 `LEASE_LOST` 失败；同一轮 Node 22 通过。该测试原先用 180ms Lease TTL、25ms heartbeat 与 330ms Provider 等待。新增的 Pi 实验 Job 当时还重复执行了整套 Kernel 测试，增加了并行 CI 负载。现有证据不能把失败完全归因于 CI 竞争，但原测试的时间余量明显过窄。

处理措施：

- 将该测试改为 1000ms TTL、100ms heartbeat、1300ms Provider 等待。等待仍长于 TTL，因此仍然覆盖 heartbeat 必须续租的路径，但对短暂调度停顿有更大余量。
- 移除 Pi 专项 Job 中重复的 Kernel 全套测试；Kernel 回归仍由原来的 Node 22.16.0 / Node 22 矩阵负责。
- 在 [Run #40842538682](https://github.com/wwxst/agent-/actions/runs/40842538682) 中，Kernel 两个矩阵任务和 Pi 四项测试均通过；随后在 [Run #40842575938](https://github.com/wwxst/agent-/actions/runs/40842575938) 中，两个 Kernel 矩阵任务与 Pi 专项任务再次全部通过。

这是**测试时间窗口的稳健性修正**，没有修改生产 Lease 的过期、续租或 fencing 语义。以后仍需继续观察多次运行的稳定性，不能把单次通过当作彻底消除竞态的证明。

## 2. 动态观察

### P30-1 · 异步事件屏障

实验把 `message_end` 的监听器人为阻塞在一个 Promise 上。在该监听器完成“持久化 Intent”的模拟动作前，工具执行计数保持为 0；解除屏障后，工具才开始。

**判定：PASS（仅针对该发布包、该调用路径）。**

这与固定源码中 `runAgentLoop()` 对事件 Sink 使用 `await emit(...)` 的静态观察一致。该实验没有模拟真实数据库事务、进程崩溃或存储 fsync。

### P30-2 · 并发完成顺序与模型消息顺序分离

固定调用序列为 `slow → fast`。慢工具等待快工具的 `tool_execution_end` 事件后才结束，因此真实执行完成顺序被确定为 `fast → slow`。

观察结果：

| 观测层 | 实际顺序 | 判定 |
|---|---|---|
| 工具结束事件 | fast → slow | PASS |
| Agent transcript 中的 ToolResult | slow → fast | PASS |
| 下一次 StreamFn 收到的 ToolResult | slow → fast | PASS |

这证明在该场景下，Pi 把完成时序和模型可见结果的顺序分开处理。它不证明 Session 文件、崩溃恢复或所有工具类型都具有相同的持久化语义。

### P30-3 · 截断输出

给定 `stopReason = "length"` 且响应中包含 ToolCall，Pi 生成错误 ToolResult，没有调用工具实现；然后发起下一次模型请求。

**判定：PASS（无工具执行）。行为合同与自研 Kernel 不同。**

自研 Kernel 当前把截断输出作为 `TRUNCATED_MODEL_OUTPUT` Turn 失败处理，不继续正常工具循环。不能因为 Pi 的路径通过就无意中改变当前合同。未来应通过 ADR 和回归测试明确选择：硬失败，还是让模型在收到错误 ToolResult 后重新发起完整调用。

### P30-4 · Intent 写入失败

监听器在包含 ToolCall 的 Assistant `message_end` 事件上抛出模拟存储错误。实验观察到工具启动次数为 0，Agent 状态中的 `errorMessage` 包含该错误。

**判定：PASS（该测试中未执行工具）；同时发现重要适配边界。**

`Agent` 高层封装的 `runWithLifecycle()` 会捕获循环异常并调用错误处理流程。因此调用者不能仅依靠 `await agent.prompt(...)` 是否 reject 来判定 Turn 成功。适配器必须检查可信事件状态或显式的错误终态，并以 Kernel 的 EventStore 为权威状态；不能把 Agent 内存 transcript 当作持久事实。

## 3. 对当前内核的实际意义

### 可以借鉴

- **异步事件屏障**：在工具开始前，让完整 Assistant 消息与该批全部 Intent 先通过一次受控的持久化提交。
- **顺序分离**：执行结束/遥测事件反映实际时序，模型上下文则按原始 ToolCall 顺序组装。
- **循环与宿主解耦**：Pi Core 提供了可注入 StreamFn、工具定义和事件 Sink 的低层接口，适合进一步验证是否能替换当前 Loop。

### 不能直接照搬

- **Agent 内存状态不是可信账本**：Pi 的 transcript、ToolResult 和生命周期事件不能替代 Kernel Intent、可信 Host Receipt、Lease/Fencing 或 OutcomeUnknown。
- **高层错误处理会吞掉循环异常**：必须显式映射为 Kernel 的失败/恢复状态，避免把正常返回误认为成功。
- **截断语义不一致**：必须保留明确的安全合同，不可无意更改。
- **运行时门槛不同**：发布包声明 Node `>=22.19.0`，而自研基线仍覆盖 Node 22.16.0。若采用，必须决定提升最低版本还是将 Pi Loop 放入独立进程/运行时。
- **包版本与源码证据有边界**：本轮运行 npm 发布包 1.4.0，静态源码分析固定在 Git 提交 `d5b3de22`。两者的精确对应关系尚未独立校验。
- **许可审查未完成**：发布包声明 MIT；采用前仍需审查完整依赖树、NOTICE、分发义务与更新策略。

## 4. 下一道适配门槛

继续独立原型，而不是迁移生产代码。下一轮必须增加：

1. **原子批次提交**：Assistant 消息与全部 ToolCall Intent 一次写入；任意提交失败都必须在首个工具启动前阻止整个批次。
2. **可信 Receipt**：Pi 工具执行返回值只作为模型结果；可信 Host 必须独立记录执行事实，不能把 ToolResult 当成 Receipt。
3. **Lease/Fencing**：运行期间撤租或撤权后，不允许新工具启动；已有工具要按可证明状态收敛，不能伪造终态。
4. **OutcomeUnknown**：Host 已开始但收据缺失时，不自动重放非幂等副作用；模型循环不得继续猜测结果。
5. **存储故障窗口**：分别注入 Intent append 失败、工具完成后 Receipt append 失败、进程中断和会话重开。
6. **取消与队列**：验证取消、Steering、Follow-up 不会越过安全屏障、丢失或重复执行。
7. **同条件比较**：用相同 FakeProvider 轨迹对照自研 Loop 与 Pi Core，报告行为差异、适配代码量、依赖与维护成本。

## 5. 裁决

- **KEEP**：当前自研 Kernel 的 Intent/Receipt、Lease、OutcomeUnknown 与恢复状态作为安全边界；不能因循环替换而移除。
- **ADOPT AS TESTED PATTERN**：异步事件 Sink 屏障；把真实完成事件顺序与模型上下文顺序分离。
- **KEEP AS EXPLICIT DIFFERENCE**：截断输出策略需单独决策；高层 `prompt()` 的错误终态需显式适配。
- **NEXT**：做一层仅用于实验的 Pi Adapter，把工具执行完全委托给现有可信 Host，并继续注入存储/租约/取消故障。
- **NOT DECIDED**：不把 Pi Core 加入生产依赖、不替换当前 Loop、不开放写工具、不声称已达到 Codex 或 Claude Code 的整体能力。

这轮结果支持“继续验证 Pi Core”，不支持“已经决定采用 Pi Core”。
