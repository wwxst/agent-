# Agent 架构研究

> 当前状态：**架构研究中；未批准开发。**
>
> 本目录是跨对话的研究入口。每次继续前先读 `PROGRESS.md`，确认研究进度、证据、未决问题和下一步；完成一轮研究后更新它并提交到本研究 PR。

## 研究目标

独立确定我们真正需要的 Agent 系统架构。现有 Kernel 可以舍弃、重写或只复用局部组件，不构成新设计的前提。Claude Code、Claude Desktop、Claude Agent SDK、Pi Agent Core 是研究样本，不预设任何一个会成为最终方案。

## 不可违反的工作顺序

1. 研究真实源码与执行链，记录版本、路径、符号和证据。
2. 比较架构、边界、失败行为和维护代价。
3. 形成完整的新架构方案、备选方案、风险和验收标准。
4. **先交用户审阅并取得明确批准，才可开始编码、修改实现或提交开发 PR。**

本 PR 只保存研究计划和进度，不代表架构已确定，不引入实现代码。

## 研究阶段

1. **资料与证据盘点**：版本、文件清单、可读性、来源与研究覆盖率。
2. **Claude Code CLI**：入口、Agent Loop、模型流、工具路由/执行、权限、并发、上下文压缩、Subagent、恢复与错误处理。
3. **Claude Desktop / Agent SDK**：宿主进程、Session 生命周期、双向协议、权限代理、MCP、取消、超时和退出/恢复。
4. **Pi Agent Core**：完整 loop、事件语义、工具执行、扩展点、流式、并发、取消、消息顺序和失败边界；核对发布包与源码提交是否一致。
5. **横向比较与架构综合**：按相同场景比较事实、优缺点、未知项和复杂度。
6. **目标架构提案**：需求、模块图、职责/接口、关键时序、持久化与恢复、安全边界、技术选型、替代方案、风险、测试和分阶段验收。
7. **用户评审**：交付完整方案并等待明确批准。

## 证据纪律

- 区分 **源码已证实 / 动态验证 / 推断 / 未知**。
- 每个关键结论标明项目版本、文件路径、函数/符号，必要时记录行号和相关测试。
- 静态阅读不等于运行验证；模拟 Host/Journal 的测试不等于真实持久化、权限或外部副作用验证。
- 不把历史报告中的建议当成已经批准的设计决策。
- 资料缺失或无法读取时明确标注，不猜测填空。

## 研究入口

- [当前进度与续接点](./PROGRESS.md)
- [报告 33：Claude CLI 执行链源码复核（第一轮）](./33-Claude-CLI执行链源码复核-2026-10-29.md)
- [报告 34：Claude CLI 会话持久化与工具路由复核](./34-Claude-CLI会话持久化与工具路由复核-2026-10-29.md)
- [报告 35：Claude CLI 远程工具 Host 与恢复状态机复核](./35-Claude-CLI远程工具Host与恢复状态机复核-2026-10-29.md)
- [报告 36：Claude CLI Transcript 写入失败与流式 Fallback 收敛](./36-Claude-CLI写入失败与流式Fallback收敛-2026-10-29.md)
- [报告 37：Claude Storage V5 读取恢复与 WriterHealth 证据](./37-Claude-StorageV5读取修复与WriterHealth证据-2026-10-29.md)
- [报告 38：Claude CLI 远程工具取消、执行账本与迟到结果收敛](./38-Claude-CLI远程工具取消与执行账本收敛-2026-10-30.md)
- [报告 39：Claude Bash 与 MCP 工具取消语义](./39-Claude-Bash与MCP工具取消语义-2026-10-30.md)
- [报告 40：Claude CLI 后台 Bash 与 MCP Task 的恢复边界](./40-Claude-CLI后台Bash与MCP任务恢复边界-2026-10-30.md)
- [报告 41：Claude CLI 取消时序矩阵与结果回收边界](./41-Claude-CLI取消时序矩阵与结果回收边界-2026-10-30.md)
- [报告 42：Claude Subagent 生命周期、所有权、停止与恢复](./42-Claude-Subagent生命周期所有权停止与恢复-2026-10-30.md)
- [报告 43：Claude CLI 上下文压缩与 Subagent 恢复连续性](./43-Claude-CLI上下文压缩与Subagent恢复连续性-2026-10-30.md)
- [报告 44：Claude Remote Agent 云端 Session 生命周期与恢复](./44-Claude-Remote-Agent云端Session生命周期与恢复-2026-10-30.md)
- [报告 45：Storage V5 Backend 来源与 Sidecar 持久化保证](./45-Claude-StorageV5Backend来源与Sidecar持久化保证-2026-10-30.md)
- [报告 46：Claude Transcript 与 Remote Agent 联合恢复状态矩阵](./46-Claude-Transcript与RemoteAgent联合恢复状态矩阵-2026-10-30.md)
- [报告 47：Claude Desktop / SDK Session 启动与双向协议第一轮](./47-Claude-Desktop与SDKSession启动双向协议及宿主生命周期-2026-10-30.md)
- [报告 48：Claude Desktop SSH 进程接管、MCP 拓扑与权限事件链](./48-Claude-Desktop-SSH进程接管与MCP权限事件链复核-2026-10-30.md)
- [报告 49：Claude Desktop 本地进程关闭、Idle 与 Session 冷恢复状态机](./49-Claude-Desktop本地进程关闭Idle与Session恢复状态机复核-2026-10-30.md)
- [报告 50：Claude Desktop SDK Hooks 与 Pending 请求重交付](./50-Claude-Desktop-SDKHooks与Pending请求重交付复核-2026-10-30.md)
- [报告 51：Claude Desktop custom3p-mcp URL Elicitation 与 Utility Host 生命周期](./51-Claude-Desktop-custom3pMCP-URL-Elicitation与UtilityHost复核-2026-10-30.md)
- [报告 52：Pi Agent Core 1.4.0 发布基线、Loop 与工具调度](./52-Pi-Agent-Core-1.4.0发布基线Loop与工具调度复核-2026-10-30.md)
- [报告 53：Pi Durable Harness、TaskScheduler 与 Generation / ToolTask 状态机](./53-Pi-Durable-HarnessTaskScheduler与GenerationToolTask状态机复核-2026-10-30.md)
- [报告 54：Chord 1.4.0 Host / Object / RPC / ReplicatedState 与热更新协议](./54-Chord-1.4.0HostObjectRPC与ReplicatedState热更新协议复核-2026-10-30.md)
- [报告 55：Pi Durable Storage Adapters 事务原子性、恢复与耐久性边界](./55-Pi-Durable-StorageAdapters事务原子性恢复与耐久边界-2026-10-30.md)
- [报告 56：Chord HostManager 进程锁、重启与子 Host 生命周期](./56-Chord-HostManager进程锁重启与子Host生命周期-2026-10-30.md)
- [报告 57：Pi Durable CompactionTask 上下文边界、重放与失效风险](./57-Pi-Durable-CompactionTask上下文边界重放与失效风险-2026-10-30.md)
- [报告 58：Pi Coding Agent 产品组合、Core、Session、MCP、权限与 RPC](./58-Pi-CodingAgent产品组合CoreSessionMCP权限与RPC-2026-10-30.md)
- [报告 59：Claude / Pi 同场景执行、权限和恢复语义矩阵](./59-Claude与Pi同场景执行权限恢复矩阵-2026-10-30.md)
- [报告 60：独立 Agent 执行内核目标架构草案 v0.1](./60-独立Agent执行内核目标架构草案-2026-10-30.md)
- [报告 61：目标 Agent 架构故障验证、风险与实施门槛](./61-目标Agent架构验收矩阵风险与实施路线-2026-10-30.md)
- [报告 62：Operation UNKNOWN、Host 执行协议、迟到 Receipt 与双 Owner 恢复](./62-Operation执行协议未知结果对账与多Owner恢复合同-2026-10-30.md)
- [报告 63：权限沙箱、历史脱敏与三种独立架构备选评审](./63-权限沙箱上下文脱敏与独立架构选型评审-2026-10-30.md)
- [报告 64：独立 Agent v0.2 事务/事件/任务恢复集成合同](./64-目标Agent架构v0.2事务事件与恢复协议整合-2026-10-30.md)
- [报告 65：可靠性保证向量、Storage ACK、Transactional Outbox 与 Event Cursor 合同](./65-可靠性保证向量存储ACK与事件游标合同-2026-10-31.md)
- [报告 66：Host Capability Manifest、UNKNOWN 查询语义与 Tool Execution conformance suite](./66-HostCapabilityManifest与工具执行一致性验收合同-2026-10-31.md)
- [报告 67：Model Provider 请求生命周期、重试层级与费用不确定性](./67-ModelProvider请求生命周期重试与费用不确定性-2026-10-31.md)
- [报告 68：Provider Request ID、异步 Job 可恢复性与数据保留合同](./68-Provider请求ID与异步Job可恢复性及数据保留合同-2026-10-31.md)
- [报告 69：Durable Execution Runtime 选型与 Restate Agent 参考架构源码研究](./69-DurableExecutionRuntime选型与RestateAgent参考架构源码研究-2026-10-31.md)
- [报告 70：Restate Agent 执行状态机、Journal Replay 与外部效果边界源码复核](./70-RestateAgent执行状态机与恢复边界源码复核-2026-10-31.md)
- [报告 71：Temporal 与 DBOS 执行语义、控制面 API 和事务恢复源码对比](./71-TemporalDBOS执行语义与Agent控制面源码对比-2026-10-31.md)
- [报告 72：LangGraph JS Pregel 执行引擎、Pending Writes 与 Interrupt 恢复边界](./72-LangGraphJS-Pregel执行引擎PendingWrites与Interrupt恢复边界-2026-10-31.md)
- [报告 73：Deep Agents JS Harness、子代理权限委派与 Sandbox 执行边界](./73-DeepAgentsJS-Harness子代理权限与Sandbox执行边界源码研究-2026-10-31.md)
- [报告 74：Python Deep Agents Harness、Code、ACP 与 Sandbox Provider 生命周期源码研究](./74-PythonDeepAgentsHarnessCodeACP与SandboxProvider生命周期源码研究-2026-10-31.md)
- [历史实验报告 30：Pi Loop 动态实验](https://github.com/wwxst/agent-/blob/experiment/pi-agent-core-adapter-spike-20261029/docs/research/comparative/30-Pi-Agent-Core动态适配原型-2026-10-29.md)
- [历史实验报告 31：Pi 边界适配原型](https://github.com/wwxst/agent-/blob/experiment/pi-agent-core-adapter-spike-20261029/docs/research/comparative/31-Pi-Agent-Core-Kernel边界适配原型-2026-10-29.md)
- [历史研究报告 32：Claude 与旧 Kernel 对照](https://github.com/wwxst/agent-/blob/experiment/pi-agent-core-adapter-spike-20261029/docs/research/comparative/32-Claude-Agent与Kernel架构对照-2026-10-29.md)

报告 30–32 是之前实验/对照的历史材料。它们包含以旧 Kernel 为参照的判断，必须重新核验并从新目标出发评估，**不得直接视为最终架构决策**。
