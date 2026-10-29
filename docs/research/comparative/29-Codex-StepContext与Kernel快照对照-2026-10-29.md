# 29 · Codex StepContext 对照：应借鉴快照原则，不照搬整套结构

> 日期：2026-10-29。固定 Codex 样本：[openai/codex @ 970111f6](https://github.com/openai/codex/tree/970111f6cb62cc02fe36a82ea7d71b37a2889c97)；自研基线：[main @ f10d2291](https://github.com/wwxst/agent-/tree/f10d2291a0c9808c01108f42838b47b0f401c86f)。性质：静态源码对照；没有运行 Codex 或修改 Kernel 代码。

## 0. 结论

Codex 的 StepContext 值得借鉴的核心，不是“字段比我们多”，而是**每次模型采样都有一个固定的请求上下文：模型设置、工具路由、MCP 绑定、执行环境、权限配置和扩展输入在同一个快照边界内绑定**。已经开始的 Step 不应因为会话配置、工具目录或工作区状态被实时更新而悄悄改变执行语义。

当前 Kernel 已有一个较窄但正确的起点：每次模型 Step 调用 ToolRegistry.snapshot()，并把同一份快照的 modelSpecs 交给 Provider、把快照本身交给 executeBatch。对当前只读 M0 来说，不应为了看起来像 Codex 而立刻加入几十个未使用字段。

建议：
- **ADOPT AS DESIGN RULE**：一份不可变 StepContext 同时绑定模型所见工具与实际执行工具。
- **KEEP CURRENT SIMPLE SNAPSHOT FOR M0**：继续保持只读工具默认策略，不引入尚未需要的复杂权限模型。
- **BEFORE WRITE TOOLS**：扩展成包含授权/审批版本、工作区与环境身份、Provider/模型配置、上下文检查点和预算的最小请求快照。
- **DO NOT COPY WHOLE CODEX STEP CONTEXT**：Codex 的字段来自成熟产品中的环境、多 MCP、插件、Realtime、遥测和子任务功能；照搬会把产品复杂度提前带进当前 Kernel。

## 1. Codex StepContext 实际固定了什么

固定源码的 StepContext 包含：

| 字段/子对象 | 固定的语义 |
|---|---|
| TurnContext | 所属 Turn 的身份与上下文 |
| preempt CancellationToken | 当前模型采样可被用户输入抢占 |
| RealtimeConversationSnapshot | 当前采样看到的实时会话状态 |
| Arc<ResolvedStepSettings> | 当前请求的模型设置、推理设置、审批策略和 reviewer 等解析结果 |
| TokenBudgetConfig | 与当前请求绑定的预算选择 |
| SessionTelemetry | 当前采样对应的模型遥测上下文 |
| TurnEnvironmentSnapshot | 当前 Step 的执行环境 |
| inherited environments | 子任务继承的环境快照 |
| executor hook sources / ExtensionData | 当前 Step 允许的执行扩展及其输入 |
| Arc<McpBinding> | 当前 Step 的 MCP 连接、配置和工具目录 |
| Arc<ToolRouter> | 当前请求实际向模型公开并用于执行的工具计划 |
| LoadedAgentsMd | 与当前环境快照对应的规范 AGENTS.md 内容 |

源码：
- [Codex step_context.rs](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/step_context.rs)
- [Codex step_settings.rs](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/step_settings.rs)
- [Codex turn.rs：捕获并在后续 Step 间传递上下文](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/turn.rs)

ResolvedStepSettings 还保留用户实际选择的设置输入与按固定模型解析后的有效设置。这样模型默认值、功能开关或实时配置发生变化时，不会反向污染已经开始的请求；下一 Step 可以再创建新快照。

Codex 的 ToolRouter 也不是单独生成一份 Schema 后再查找另一份实时工具注册表执行。它代表最终化后的工具计划，包含模型可见规格与匹配的执行运行时；StepContext 持有该 Router 的 Arc。这个设计将“模型被告知可以做什么”和“本 Step 实际能分派什么”绑定到同一对象。

本报告只确认这些固定源码结构，不把它们视为经过本轮动态验证的安全保证。

## 2. 当前 Kernel 已经做对的部分

当前 Kernel 每次模型 Step 都执行以下流程：
1. 获取 ToolRegistry.snapshot()；
2. 从该快照生成 modelSpecs，并构造 stepId、toolSetVersion 与 tools；
3. 将该 Step Admission 传给 Provider；
4. 模型返回 ToolCall 后，使用同一个 boundTools 快照调用 executeBatch()。

源码：
- [当前 Kernel runTurn](https://github.com/wwxst/agent-/blob/f10d2291a0c9808c01108f42838b47b0f401c86f/packages/kernel-core/src/index.ts)
- [当前 ToolRegistry.snapshot 与 modelSpecs](https://github.com/wwxst/agent-/blob/f10d2291a0c9808c01108f42838b47b0f401c86f/packages/tool-scheduler/src/index.ts)
- [当前 ModelStepRequest 合同](https://github.com/wwxst/agent-/blob/f10d2291a0c9808c01108f42838b47b0f401c86f/packages/contracts/src/index.ts)

这意味着在现有 M0 设计下，工具注册表在请求开始后发生变化，不会自动把当前执行改成另一个注册表实例；模型所见的工具规格与执行器使用的定义来自同一份快照。这是应当保留的基础，而不是从零重写。

但目前的快照合同较窄，主要包含 stepId、toolSetVersion 和工具规格。它还没有把将来写工具所需的审批策略版本、工作区/环境版本、模型配置版本、上下文 checkpoint 身份与权限授予范围统一到同一个请求对象中。

另外，ToolRegistry.snapshot() 对工具定义进行浅复制，Object.freeze 保护的是定义对象本身；嵌套的 inputSchema 与工具函数闭包并不会因此自动深度不可变。modelSpecs() 会单独克隆 Schema 给模型，但执行侧定义的嵌套数据仍需要明确所有权合同。当前只读实验环境下这不等于已证实的漏洞，但在把注册表当作安全快照前应测试深层变更与闭包可变状态。

## 3. 差距在哪里，而不是“字段不够多”

| 维度 | 当前 Kernel | Codex StepContext 的思路 | 取舍 |
|---|---|---|---|
| 工具目录 | 同一 ToolRegistry 快照用于模型规格和执行 | ToolRouter 绑定模型可见规格与匹配执行器 | 保留现有原则；补充深层不变性测试 |
| 模型设置 | Provider ID 与 Step Admission；模型参数版本未形成统一快照 | ResolvedStepSettings 固定模型元数据、推理设置与审批相关配置 | 需要模型切换/实时配置时再加入版本化设置对象 |
| 权限/审批 | M0 只允许 read 风险；写与外部副作用被拒绝 | StepContext 固定审批策略、reviewer、工具路由；具体审批再绑定命令/路径/环境等上下文 | 写权限开放前必须补齐；现在不为只读路径造空壳 |
| 执行环境 | 当前 M0 ToolExecutionContext 只有 sessionId、turnId、callId | TurnEnvironmentSnapshot、inherited environments、filesystem accessor 与权限授予一起绑定 | Workspace 写入前必须纳入环境/工作区身份与版本 |
| MCP/插件 | 当前工具注册表较简单，无完整 MCP/插件路由快照 | MCP binding、executor hooks 与 extension data 固定到 Step | 仅当真的引入 MCP/插件时增加对应快照 |
| Token/Context | 字符序列化预算与 Provider usage；不等同 Tokenizer | TokenBudgetConfig 与当前模型设置一起固定 | 明确当前预算合同，避免字符预算被误认为 Token 保证 |
| Live update | 当前尚无完整实时配置更新模型 | 当前 Step 使用旧快照，后续 Step 捕获新配置 | 需要实时 Steering/配置更新时测试 Step 边界 |
| 可观测性 | model.started 记录 Provider ID、工具集与版本 | StepContext 还能提供 model invocation context、telemetry 与捕获的上下文记录 | 只记录用于重放、审计和排障的必要字段 |

## 4. 提议的最小 KernelStepContext（PROPOSED）

不要直接复制 Codex 的完整结构。对本项目，未来每个模型请求可以先评估以下最小对象：

| 分组 | 候选字段 | 加入条件 |
|---|---|---|
| 身份 | sessionId、turnId、stepId、stepNumber | 现在就需要 |
| Provider/模型 | providerId、modelId、modelConfigVersion、request options snapshot | 支持可变模型配置或多模型时 |
| 工具 | toolSetVersion、工具实现快照、Schema hash | 现在保留工具版本；写工具前补深层不变性/哈希 |
| Context | checkpointSeq、Context 投影版本、tokenBudget 与实际 usage | 预算/压缩进入生产前 |
| 授权 | policyVersion、approval identity、scope/grant snapshot | 开放写或外部副作用前必须有 |
| 环境 | workspaceId、workspaceVersion、environmentId、sandbox profile | Coding Host 开放前必须有 |
| 生命周期 | cancellation signal、Lease epoch/fence identity | 当前已有取消/租约基础，必须在每次执行前继续实时验证 |
| 观测 | provider request ID、tool catalog version、关键配置摘要 | 仅记录安全且可用于诊断的字段 |

这个对象不应被误认为永久冻结所有外部状态。Lease 可以被撤销，授权也可以被撤回：StepContext 固定的是请求开始时的身份与预期版本，执行 Host 仍必须实时验证当前 Lease、权限和环境是否有效。快照不能成为绕过实时撤销的能力令牌。

## 5. 最小验证矩阵

1. **Tool registry race**：模型请求开始后更改注册表；当前 Step 的 Provider Schema 与实际分派必须仍使用同一版本，下一 Step 才能看到更新。
2. **Deep mutation**：模型请求开始后修改原始 inputSchema 的嵌套对象；验证当前 Step 的模型规格与执行验证不会被静默改变。
3. **Tool closure identity**：在请求中替换注册表或修改外部闭包状态；验证测试能区分“函数引用固定”与“函数所依赖的可变状态固定”。
4. **Policy/workspace version race**：审批完成后更换工作区版本或授权策略；旧批准不得自动授权新版本的写操作。
5. **Lease revocation**：快照创建后撤销 Lease；新副作用不得因为仍持有旧 StepContext 而启动。
6. **Model settings update**：请求中改变模型/推理配置；当前请求按旧快照完成或安全中止，下一请求才应用新版本。
7. **Checkpoint identity**：压缩或 Context 投影版本变化时，事件日志能够说明当前 Provider 请求使用哪个 checkpoint。
8. **Replay**：从事件日志重建相同 StepContext 的关键摘要；重放不得依赖进程内注册表的当前状态。

## 6. 本轮决策

- **KEEP**：当前每个 Step 固定 ToolRegistry 快照、模型规格与执行定义共用一份快照的原则。
- **ADOPT AS DESIGN RULE**：借鉴 Codex 将模型设置、工具计划、执行环境与权限配置绑定到每次采样请求的原则。
- **DEFER**：不在当前只读 M0 中复制 Codex 的 MCP、Realtime、插件、子任务和多环境字段。
- **REQUIRED BEFORE WRITE**：先定义最小 KernelStepContext，并测试审批、工作区、Schema 与 Lease 的版本竞态。
- **NOT RUN**：本轮没有运行 Codex 或自研动态竞态实验；上述测试是待执行验收项，不是通过结果。

关联：
- [Issue #42：四内核同条件对照与架构重评](https://github.com/wwxst/agent-/issues/42)
- [第 26 号架构重评](26-架构重评第一轮-2026-10-29.md)
- [第 28 号 Pi Core 适配边界审查](28-Pi-Agent-Core适配边界审查-2026-10-29.md)
- [Codex StepContext 固定源码](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/step_context.rs)
