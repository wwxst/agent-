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
- [历史实验报告 30：Pi Loop 动态实验](https://github.com/wwxst/agent-/blob/experiment/pi-agent-core-adapter-spike-20261029/docs/research/comparative/30-Pi-Agent-Core动态适配原型-2026-10-29.md)
- [历史实验报告 31：Pi 边界适配原型](https://github.com/wwxst/agent-/blob/experiment/pi-agent-core-adapter-spike-20261029/docs/research/comparative/31-Pi-Agent-Core-Kernel边界适配原型-2026-10-29.md)
- [历史研究报告 32：Claude 与旧 Kernel 对照](https://github.com/wwxst/agent-/blob/experiment/pi-agent-core-adapter-spike-20261029/docs/research/comparative/32-Claude-Agent与Kernel架构对照-2026-10-29.md)

报告 30–32 是之前实验/对照的历史材料。它们包含以旧 Kernel 为参照的判断，必须重新核验并从新目标出发评估，**不得直接视为最终架构决策**。
