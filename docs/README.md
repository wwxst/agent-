# Agent Kernel 中文设计文档

> 文档集版本：v0.1｜维护状态：架构草案 + M0/M1 增量实现记录｜更新：2026-10-27

本目录包括自研 Agent 内核的**架构设计草案和已经落地的 M0/M1 增量实现记录**。没有对应代码与真实测试的提议不视为已交付；当前尚未具备生产部署要求。

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
| M1-11 | [安全重开与恢复边界](11-M1-会话重开与恢复边界.md) | 已实现 session 重开、未决 Turn 停机保护、校验测试 |
| M1-12 | [SQLite WAL 事件日志](12-M1-SQLite-WAL-事件日志.md) | 已实现事务 CAS、跨连接与 SIGKILL 测试 |
| M1-13 | [Writer Lease 与 Fencing Token](13-M1-Writer-Lease-与-Fencing-Token.md) | 租约事务与 fenced append 的实现记录 |
| M1-14 | [ManagedSessionRunner 自动续租与中断](14-M1-ManagedSessionRunner-自动租约与中断.md) | 已实现按操作自动租约管理与协作中断；尚无独立 Tool Host |
| M1-15 | [Tool Intent/Receipt 执行审计](15-M1-Tool-Intent-Receipt-执行审计.md) | 执行前持久化、单项收据、结果未知时拒绝重放；仅可信只读工具 |
| M1-16 | [子进程 Tool Host 与执行账本](16-M1-子进程ToolHost-与执行账本.md) | 独立 Node 子进程、Host 侧 Intent/Fence、STARTED 台账，尚无 OS 沙箱 |
| M1-17 | [双账本只读对账与证据判定](17-M1-双账本只读对账与证据判定.md) | SQLite 一致只读快照、证据归类与强制无盲目重试 |
| 11–20 | [Claude Code 深入源码研究](research/claude-code/README.md) | Loop、工具调度、权限、压缩、子 Agent、真实 Shell 执行、CLI/Bridge 协议及证据边界 |
| 综合 | **[四套 Agent 内核源码研究与技术取舍](research/comparative/README.md)** | 15 份文档：证据登记、四家专项、执行/持久化审计、工具异常、安全方案与未验证边界 |
| ADR | [ADR 0001：自主内核与宿主隔离](adr/0001-自主内核与宿主隔离.md) | 架构取舍与接受条件 |
| ADR | [ADR 0002：能力组合与可信内核边界](adr/0002-能力组合与可信内核边界.md) | 插件能替换什么、不能替换什么 |
| ADR | [ADR 0003：远程 ACK 与工具收据](adr/0003-远程控制事件确认与执行收据.md) | 区分传输确认、持久接受、执行开始、执行结束 |
| ADR | [ADR 0004：工具隔离与中断语义](adr/0004-工具执行隔离与中断语义.md) | 沙箱强制执行、内部字段信任边界、Interrupt/Cancel/Background |
| ADR | **[ADR 0005：首版自主内核技术基线与取舍](adr/0005-首版自主内核技术基线与取舍.md)** | 推荐 TS Kernel / SQLite WAL / 独立 ToolHost / 保守并发，尚未接受 |

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

当前 M0 已有可运行的单 Agent 状态机与确定性测试；M1 的 session 重开和 SQLite WAL 日志已有增量代码。下一步优先为现有子进程 Tool Host 添加 OS 权限隔离、Host 鉴权及基于已实现只读对账的受控恢复/审批，不是先做 UI 或放开不受信任工具执行。
