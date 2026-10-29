# 27 · 第二轮重评：工具结果顺序合同与 Adopt-vs-Build 可行性

> 日期：2026-10-29。固定自研基线：main @ f9f36ac100f2521bca0868b6d6563e2a1a18df04。性质：静态源码对照与集成成本初判；**不是参考产品动态基准，也不是最终架构决策**。

## 0. 本轮结论

1. 当前内核有一个尚未定义清楚的合同：**工具执行/收据事件按实际完成顺序记录，而下一轮模型上下文也跟随事件序列，因此并发工具结果可能按完成顺序进入上下文；返回数组则按模型调用顺序。**
2. Pi、Codex 与 DeepSeek Harness 的源码都体现了“并发执行可以乱序完成，但模型可见的工具结果按原始调用顺序组装”这一模式。它们在事件/遥测顺序上的做法并不完全相同。
3. 推荐把“可信执行事实的记录顺序”和“下一轮模型消息的投影顺序”分开定义：**尽快记录真实收据，模型上下文按原始 ToolCall 顺序投影。** 这样不必为了让日志看起来整齐而延迟已完成副作用的收据。
4. Adopt-vs-Build 初步结论：**Pi Agent Core 是最值得先做轻量适配验证的候选，不等于现在就决定采用；DeepSeek Harness 是强有力的调度/会话设计参照，但直接采用的运行时和工作区成本更高；Codex 适合作为架构与安全设计参照，整套 Rust Core 直接嵌入当前 TS 项目的成本很高；Claude Code 目前只作行为参考。**
5. 继续自研必须与上述候选公平比较。已有代码、投入时间和“已经写了安全控制器”都不是保留它的充分理由。

## 1. 证据与版本边界

| 样本 | 固定源码 | 本轮证据 | 没有证明的内容 |
|---|---|---|---|
| 自研 Kernel | [当前仓库基线](https://github.com/wwxst/agent-/tree/f9f36ac100f2521bca0868b6d6563e2a1a18df04) | 直接读取 Kernel、Scheduler、Context Projector 与对应测试 | 没有新增动态对照测试 |
| Pi Agent Core | [earendil-works/pi @ d5b3de2](https://github.com/earendil-works/pi/tree/d5b3de22d0e24a3e9c38a9410d3329b099717283) | 直接读取并行工具执行与结果组装源码、package.json | 没有运行 Pi 产品或本地适配器 |
| DeepSeek Harness | [deepseek-ai/deepseek-harness @ 22ddee3](https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60) | 直接读取有序批次提交、Session 事件接口与 package.json | 没有运行 Harness，也没有测试崩溃时序 |
| Codex | [openai/codex @ 970111f](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97) | 直接读取 StepContext、parallel tool runtime 与 Thread Store 文档 | 没有运行 Rust 测试或 Codex 产品 |
| Claude Code | CLI 2.1.304 / Desktop 3.1623.1 用户提供样本 | 既有静态打包实现复核 | 本轮没有动态运行；不能由静态符号推断运行行为，也没有确认可复用许可 |

本报告中的“源码已确认”不等于“产品动态通过”。本轮所有跨产品行为仍应标记为 STATIC_SOURCE；REAL_PRODUCT_RUNTIME 仍为 NOT RUN。

## 2. T02：工具执行顺序与模型上下文顺序不是一回事

### 2.1 当前 Kernel 的实际行为

- Scheduler 的 **executeBatch()** 先同步完成有序 preflight，再并发运行一组普通工具。
- 每个并发任务在自己的 Promise 中调用 **onResult**；Kernel 的 onResult 将 **tool.receipt** 与 **tool.result** 原子成对写入 EventStore。
- 因为 onResult 在每个工具完成时调用，持久化的结果事件顺序可能反映真实完成顺序。与此同时，Scheduler 最终返回的 results 数组使用原始输入下标，仍然是模型调用顺序。
- **AgentKernel.projectContext()** 目前按事件序号扫描 tool.result 并直接追加到 ContextMessage 数组，没有根据前一条 assistant.message 中的 ToolCall 顺序重排结果。因此下一轮模型看到的顺序跟随 EventStore 中的结果事件顺序。

源码位置：
- [Scheduler executeBatch](https://github.com/wwxst/agent-/blob/f9f36ac100f2521bca0868b6d6563e2a1a18df04/packages/tool-scheduler/src/index.ts)
- [Kernel projectContext](https://github.com/wwxst/agent-/blob/f9f36ac100f2521bca0868b6d6563e2a1a18df04/packages/kernel-core/src/index.ts)
- [对应的 Scheduler 测试](https://github.com/wwxst/agent-/blob/f9f36ac100f2521bca0868b6d6563e2a1a18df04/tests/kernel.test.ts)

现有测试验证了并发重叠、独占屏障以及返回数组的模型顺序；它没有验证**结果事件顺序与下一轮 Provider 实际收到的 Context 顺序**。所以准确结论是“该合同未被测试锁定”，而不是在没有端到端探针时宣称所有场景都已失败。

### 2.2 Pi：完成事件可以按真实时序，模型消息仍按调用顺序

Pi 的并行执行器会在每个工具执行完成时发出 execution-end 事件；随后等待并行调用集合结束，再按原始 toolCalls 数组顺序创建并发出 ToolResultMessage，并按同一顺序追加到当前上下文。

这把两种顺序分开了：
- 运行时事件：反映工具实际结束时序；
- 模型对话：稳定地按原始调用顺序组装。

源码：[Pi agent-loop.ts 的并行执行与结果组装](https://github.com/earendil-works/pi/blob/d5b3de22d0e24a3e9c38a9410d3329b099717283/packages/agent/src/agent-loop.ts)。

这证明该设计模式存在于 Pi 源码；不证明 Pi 的外部持久化或崩溃恢复等同于自研 Kernel。

### 2.3 DeepSeek Harness：在有序槽位上提交结果

DeepSeek Harness 的 runGroup() 用槽位保存并发执行结果，commitReady() 只提交从当前 committed 下标开始的连续完成项。较晚的调用即使先完成，也会等待前面的槽位，然后按模型调用顺序提交 Session 的 tool/result 事件与附加上下文。

该实现还会在取消/调度失败时停止继续启动新工具、等待已启动的工具收敛，并生成跳过调用的恢复结果。它比当前 Scheduler 的简单 Promise.allSettled 模式复杂，复杂度来自明确的有序提交与恢复合同。

源码：
- [DeepSeek batch.ts 的 commitReady](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tools/src/batch.ts)
- [DeepSeek BatchSettlement](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e3e895a2f60/packages/core/tools/src/batch.ts)

注意：有序提交可能增加 Head-of-line blocking；更重要的是，若工具 B 已完成副作用但工具 A 仍未完成，B 的结果在轮到提交前可能尚未写入 Session 日志。崩溃后必须靠执行 Host 的可信记录或保守的 UNKNOWN 恢复处理，不能仅靠 Session 中暂时没有 tool/result 就认定 B 没执行。

### 2.4 Codex：结果就绪遥测与模型结果收集分开

Codex 的 tools/parallel.rs 明确记录结果就绪事件，并注明采样循环会在流结束后按顺序收集结果。这与 Pi 的分层思路相符：真实执行何时完成可以单独观测，而模型输入所需的结果集合有自己的稳定顺序合同。

源码：[Codex parallel.rs](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/tools/parallel.rs)。

本轮只确认了该源码路径，不据此推断 Codex 所有工具类别、取消分支和持久化路径都具有同一语义；这些仍需动态验证。

## 3. 建议采用的 T02 合同（PROPOSED，尚未改代码）

| 层次 | 建议合同 | 原因 |
|---|---|---|
| ToolCall Admission / Intent | 按模型原始调用顺序固定 callId、step 与工具快照 | 审计与恢复需要可追踪的原始意图 |
| 工具实际执行 | 允许已获准的并行调用乱序完成；独占工具继续作为屏障 | 保留并发收益与现有风险分类 |
| 可信 Receipt / 执行事实 | 工具结果一经可信 Host 确认，立即持久化；事件序列反映事实何时被观察到 | 避免为了日志顺序延迟收据，扩大“副作用已发生但结果未落盘”的窗口 |
| Model Context Projection | 对同一 assistant ToolCall 批次，按原始 ToolCall 顺序输出 ToolResultMessage | 与 Pi/Codex 的可见结果合同对齐，保证重放和测试可确定 |
| Scheduler 返回值 | 保持输入下标顺序 | 现有实现已经如此，调用方可稳定关联结果 |
| 取消/未知结果 | 不因上下文重排而把 UNKNOWN 转成失败或成功；未解决批次不得继续模型循环 | 排序不应改变安全状态或授权语义 |

这里有一个重要设计取舍：**不建议仅为了让 EventStore 看起来按调用顺序排列，就延迟已经完成工具的可信收据。** 更合适的候选方案是保留事件日志的事实时序，在 Context Projector 中按 assistant.message 的 ToolCall ID 顺序组装可见结果。是否能在所有 Steering、失败、恢复和压缩分支下安全做到，必须先写测试合同，再改代码。

### T02 最小测试矩阵

1. **Reverse completion**：调用顺序 A、B；B 先完成。断言返回数组与模型上下文均为 A、B，收据日志按实际完成事实记录。
2. **Three-call mix**：A 慢、B 快、C 为 exclusive。断言 C 仍等前一并发组排空；上下文仍按 A、B、C。
3. **Partial result / UNKNOWN**：A 完成，B 结果未知。断言不会误把未完成批次当作普通成功，也不会自动重放 B。
4. **Cancellation**：取消时已启动调用必须收敛或进入 UNKNOWN；未启动调用有明确结果；Context 投影不改变任何安全状态。
5. **Actual Provider input**：不只测 Projector 输出；捕获下一次 Provider 收到的完整消息数组并断言 ToolCall ID 与结果对应。
6. **Restart/replay**：把相同事件日志重建两次，断言投影完全一致；不能依赖进程内 Map 的偶然插入顺序。

## 4. Adopt-vs-Build：接入成本初判

| 路线 | 直接采用的可行性 | 本轮判断 | 最大未知项 |
|---|---|---|---|
| Pi Agent Core | **中等，最适合先做薄适配原型** | 与当前 TypeScript/ESM 架构接近；公开包 @earendil-works/pi-agent-core 是 MIT，依赖 @earendil-works/pi-ai 与 TypeBox。固定包版本 1.4.0 声明 Node >=22.19，而当前内核要求 >=22.16，存在可管理的运行时门槛 | Provider/消息类型映射、Kernel Lease 与事件合同能否通过 AgentTool/AgentEvent/stream 接口保持；引入后能否删掉现有 Loop，而不是双层维护 |
| Pi Coding Agent | **不建议直接等同于 Kernel 采用** | 它是包含 read/bash/edit/write 工具、会话管理和 CLI 的完整 Coding Agent 产品层；可能作为工作流与宿主参考，但直接搬入会带来更多产品层依赖 | 我们真正需要的是 Core、Coding Host，还是完整 CLI 产品 |
| DeepSeek Harness | **包级直接接入成本偏高；整套采用是另一条路线** | 固定版本 0.2.1-rc.3，仓库要求 Node >=24.9、pnpm workspace，并依赖 Cordis、Scope、Session、Projection、Tools 等相互协作的包。其有序调度与 Session 模型值得深入研究 | 是否接受 Node 24+、整套 workspace/服务容器与持久化架构；裁剪子包是否反而比保留当前 Kernel 更费力 |
| Codex Core | **在当前 TypeScript 进程中直接采用成本很高** | Rust Core 依赖大量 Codex 内部 workspace crates；如要采用，应评估 Rust 作为主内核、sidecar/RPC 边界或单独复用具体 crate，而不是把它当成普通 TS 依赖 | Rust 运行时集成、跨进程协议、升级维护、目标平台与实际可复用边界 |
| Claude Code | **本轮不评估为直接依赖** | 继续作为产品行为和机制参考；现有样本是打包发布版的静态复核，不能将其等同于公开、可自由复用的 Core | 具体许可/使用条款、产品动态运行与可公开验证接口 |
| 继续自研 | **技术上可继续，维护成本必须被证明值得** | 目前有 TS Kernel、EventStore、Lease 与 Host 实验；但只读工具默认策略仍意味着它不是已完成的自主 Coding Kernel。不能把已写出的模块数量当成竞争优势 | 自研是否能以更少复杂度满足完整 Coding、权限、恢复和跨平台需求 |

许可证仅作初步核查：Pi Agent Core 固定包声明 MIT；DeepSeek Harness 根与核心包声明 MIT；Codex 仓库声明 Apache-2.0。仍须检查各自 NOTICE、依赖许可证、商标和分发义务。Claude Code 的具体复用许可尚未确认。本表不构成法律意见。

## 5. 当前建议：先验证 Pi Core，而不是马上迁移

下一步建议建立**独立的 adapter spike / 研究分支**，不触碰主分支生产执行逻辑，完成以下比较：

- 用同一组 FakeProvider 轨迹驱动当前 Kernel 与 Pi Agent Core：普通文本、多个工具、截断输出、工具失败、Steering/Follow-up、取消。
- 用适配器包裹当前只读工具，验证 Pi 的工具生命周期事件能否正确映射到 Kernel 的 Intent、Receipt、Result、Lease Fencing 与取消合同。
- 对比完成任务的消息序列、真实工具启动次数、失败状态、上下文顺序、延迟和所需适配代码。
- 若 Pi Core 的 Loop 可以替换现有 Loop，且安全与恢复合同不退化，则评估**删除自研 Loop、保留必要 Host/Storage Adapter**。如果无法满足，不为了“采用 Pi”而强行迁移。
- 同时以 DeepSeek 的 commitReady 为对照，确定我们是否需要有序提交，还是只需把 Context Projector 改成按 ToolCall ID 有序投影。

该 spike 是研究候选，不是已执行任务。本报告没有新增代码、没有运行 Pi/Codex/DeepSeek/Claude 的同条件基准，也没有启用写工具。

## 6. 本轮裁决

- **KEEP AS TEST CONTRACT**：模型上下文结果顺序必须稳定，并与原始 ToolCall 顺序对应。
- **ADOPT AS TEST HYPOTHESIS**：参考 Pi/Codex 的“完成遥测与模型结果投影分开”模式；参考 DeepSeek 的有序槽位提交与取消排空策略，但先比较故障窗口和复杂度。
- **DO NOT CHANGE YET**：不立刻重排 EventStore 事件、不引入新的调度图、不继续增加 Workspace 收据补记链。
- **NEXT CANDIDATE**：Pi Agent Core 薄适配原型；采用与否由测试和实际集成成本决定。
- **NOT RUN**：所有参考产品动态横向比较；不能将静态源码结论标记为 PASS。

关联：
- [Issue #42：四内核同条件对照与架构重评](https://github.com/wwxst/agent-/issues/42)
- [第 26 号架构重评](26-架构重评第一轮-2026-10-29.md)
- [Pi Agent Core 固定版本源码](https://github.com/earendil-works/pi/tree/d5b3de22d0e24a3e9c38a9410d3329b099717283)
- [DeepSeek Harness 固定版本源码](https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)
- [Codex 固定版本源码](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97)
