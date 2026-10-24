# Agent Kernel｜自研智能体内核

> **项目阶段：v0.1 设计草案** · **代码状态：尚未开始实现** · **最后更新：2026-10-24**

本仓库用于从零开发**属于自己的 Agent 内核**。研究并借鉴 Pi Agent、OpenAI Codex、Claude Code 与 DeepSeek Harness 的公开设计，但不以其中任何一个的 Agent 运行时作为核心依赖；本项目独立设计并实现 Agent Loop、会话状态、工具、安全边界和客户端协议。

**注意：当前只有设计文档，没有可运行的 Agent Kernel。文档中的接口、模块和能力均为计划目标，不代表已经实现。**

## 一、项目目标

- 自主实现 Agent Loop、Session/Turn、Context、Tool Scheduler、Policy 与事件流；
- 接入不同厂商或本地模型，不为每个模型维护独立执行内核；
- Kernel 与 Tool Host 分离，所有高风险工具经过服务端权限与运行环境验证；
- 将 API、Web、CLI、桌面客户端与内核解耦；
- 通过事件日志、幂等控制与明确的副作用状态实现可审计、可恢复的任务执行；
- 基础可靠性稳定后，再构建 Hooks、Skills、MCP、Subagents 和领域工具。

## 二、借鉴什么，不借鉴什么

| 研究对象 | 重点学习 | 自研边界 |
| --- | --- | --- |
| [Pi Agent](https://github.com/earendil-works/pi) | 简洁的 Agent Loop、工具和模型流式抽象 | 由本项目实现 Loop，不直接依赖 Pi 内核 |
| [OpenAI Codex](https://github.com/openai/codex) | Session/Turn、事件、审批、上下文和执行隔离 | 重新定义自己的状态机与协议 |
| [Claude Code](https://code.claude.com/docs/en/agent-sdk/overview) | Hooks、Skills、权限、多 Agent 扩展 | 扩展不能破坏 Kernel 安全边界 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 能力组合、插件作用域、可逆生命周期、Profile | 核心状态机、授权和持久化语义不可由普通插件接管 |

## 三、中文设计文档

从 [**中文文档总目录**](docs/README.md) 开始阅读。

1. [项目愿景与范围](docs/00-愿景与范围.md)
2. [总体架构与模块边界](docs/01-总体架构.md)
3. [Agent 执行循环与状态机](docs/02-执行循环与状态机.md)
4. [事件日志、数据模型和持久化](docs/03-事件与持久化.md)
5. [工具、权限、审批和安全](docs/04-工具与安全.md)
6. [模型 Provider 与上下文压缩](docs/05-模型与上下文.md)
7. [Hooks、Skills、MCP 与 Subagents](docs/06-扩展与多智能体.md)
8. [客户端 API 与事件协议](docs/07-客户端协议.md)
9. [开发路线、测试矩阵与验收](docs/08-开发路线与验收.md)
10. [DeepSeek Harness 架构研究与借鉴评估](docs/09-DeepSeek-Harness-借鉴评估.md)
11. [Claude Code 2.1.304/2.1.88 内核源码追踪（第一轮）](docs/10-Claude-Code-内核源码追踪.md)
12. [Claude Code 多轮深入源码研究（含沙箱、SDK、Bridge）](docs/research/claude-code/README.md)

附加约束：

- [ADR 0001：自主实现内核与宿主隔离（提议）](docs/adr/0001-自主内核与宿主隔离.md)
- [ADR 0002：能力组合与可信内核边界（提议）](docs/adr/0002-能力组合与可信内核边界.md)
- [ADR 0003：远程事件 ACK、持久接受和工具执行收据（提议）](docs/adr/0003-远程控制事件确认与执行收据.md)
- [AGENTS.md：AI 开发协作规则](AGENTS.md)

## 四、第一版范围（拟议）

优先实现单 Agent、多模型适配、基础工具、Session/Turn 生命周期、持久事件流、权限审批、取消和故障恢复。先保障正确性与安全，再增加多 Agent、远程 Host 和媒体工作流。

**暂不计划在第一版实现**大型插件市场、完整 IDE、分布式集群或视频时间线编辑器。

## 五、代码与集成状态

- **代码**：未开始。当前没有可执行程序、API 服务或运行通过的测试。
- **协议**：v0.1 设计草案；实现前以类型定义、Schema 和 ADR 进一步确认。
- **外部系统**：未来可为 `wwxst/agent-web`、`wwxst/agent-cil` 提供适配层，需先审查这些仓库实际接口。
- **分支**：详细设计在 `docs/agent-kernel-design-v0.1` 中编写，尚未合并到主分支。

## 六、下一步

先完成基础类型合同、FakeProvider、MemoryEventStore、FakeToolHost 和可重复测试的独立 Agent Loop，再逐步交付真实 Provider、隔离的文件/Shell 工具及客户端连接。
