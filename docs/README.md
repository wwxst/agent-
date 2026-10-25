# Agent Kernel 中文设计文档

> 文档集版本：v0.1｜维护状态：设计草案｜创建日期：2026-10-24

本目录是自研 Agent 内核的**设计草案**。仓库尚未开始内核编码，这些文字定义拟议接口、约束和验收标准，不表示功能已经上线。

## 文档阅读顺序

| 顺序 | 文档 | 重点 |
| --- | --- | --- |
| 00 | [愿景与范围](00-愿景与范围.md) | 自主实现的原则、MVP 目标、非目标 |
| 01 | [总体架构](01-总体架构.md) | Kernel、Provider、Tool Host、存储与客户端边界 |
| 02 | [执行循环与状态机](02-执行循环与状态机.md) | Session/Turn/Step、取消、Steering |
| 03 | [事件与持久化](03-事件与持久化.md) | Event Journal、Snapshot、重放与副作用恢复 |
| 04 | [工具与安全](04-工具与安全.md) | Tool Registry、审批、能力、安全沙箱 |
| 05 | [模型与上下文](05-模型与上下文.md) | Provider、模型流式事件、预算与上下文压缩 |
| 06 | [扩展与多智能体](06-扩展与多智能体.md) | Hooks、Skills、MCP、Subagents |
| 07 | [客户端协议](07-客户端协议.md) | HTTP/SSE、事件游标、幂等、错误码 |
| 08 | [开发路线与验收](08-开发路线与验收.md) | M0-M4 阶段、测试矩阵、完成条件 |
| 09 | [DeepSeek Harness 借鉴评估](09-DeepSeek-Harness-借鉴评估.md) | Cordis、可组合能力、Scope 与可信内核边界 |
| 10 | [Claude Code 内核源码追踪（第一轮）](10-Claude-Code-内核源码追踪.md) | 2.1.304 Agent Loop、ToolCall、权限、回填和 2.1.88 对照 |
| 11–20 | [Claude Code 深入源码研究](research/claude-code/README.md) | Loop、工具调度、权限、压缩、子 Agent、真实 Shell 执行、CLI/Bridge 协议及证据边界 |
| 综合 | **[四套 Agent 内核源码研究与自研取舍](research/comparative/README.md)** | 版本锁定、四项目产品层/工具/存储深追、候选架构及 12 条不变量 |
| ADR | [ADR 0001：自主内核与宿主隔离](adr/0001-自主内核与宿主隔离.md) | 架构取舍与接受条件 |
| ADR | [ADR 0002：能力组合与可信内核边界](adr/0002-能力组合与可信内核边界.md) | 插件能替换什么、不能替换什么 |
| ADR | [ADR 0003：远程 ACK 与工具收据](adr/0003-远程控制事件确认与执行收据.md) | 区分传输确认、持久接受、执行开始、执行结束 |
| ADR | [ADR 0004：工具隔离与中断语义](adr/0004-工具执行隔离与中断语义.md) | 沙箱强制执行、内部字段信任边界、Interrupt/Cancel/Background |

## 设计来源

项目研究 Pi 的 Agent Loop、Codex 的事件/会话/执行隔离，以及 Claude Code 的 Hooks/Skills/Subagents，另研究 DeepSeek Harness 的组件组合、Scoped Registration、Profile 和可逆生命周期；但核心状态机、执行调度与公共协议由本项目自主实现。参考项目只是研究对象，不是本项目已经接入的运行依赖。

## 与外部仓库的关系

未来可为 `wwxst/agent-web` 或 `wwxst/agent-cil` 开发 Client Adapter 或迁移接口。尚未对两个已有仓库做本轮接口审计，因此不承诺现成兼容。

## 改动文档的规则

- 行为改变：同步更新对应设计文档、类型与测试。
- 架构、数据格式、安全边界变化：新增或修订 ADR。
- 未经实际执行的测试不得标记为通过。
- 文档存在尚未决策处时标注“提议”或“待确认”，不伪装为既定事实。
- 新开发任务首先阅读仓库根目录 `AGENTS.md`。

## 建议从哪里开始

先完成 M0 的 contracts、FakeProvider、MemoryEventStore 和 FakeToolHost，然后在无网络情况下验证最小 Agent Loop。第一个目标不是 UI，而是可重复执行并通过测试的单 Agent 状态机。
