# Agent Kernel

> **Status: Design Draft v0.1** · **Implementation: Not started** · **Updated: 2026-10-24**

一个独立、自主实现、模型与宿主无关的 Agent 内核项目。本仓库从零开始制定架构，不以 Pi、Codex、Claude Code 任一现有运行时作为运行依赖；研究其公开设计，形成自己的状态机、协议、安全边界与扩展接口。

**当前仓库为空仓库初始化阶段。文档描述目标架构，不代表功能已开发、测试或发布。**

## 目标

- 自主实现 Agent Loop、Session/Turn 生命周期、Context、Tools、Policy、Hooks 和 Subagents。
- 支持多模型 Provider，可替换模型而无需修改 Kernel 的执行流程。
- 让 Kernel 与工具宿主解耦：本地、沙箱、容器、远程进程均可承载工具。
- 让 Web、CLI、桌面客户端统一使用自己的版本化协议和事件流。
- 安全、可恢复、可审计；不把“模型选择做什么”当作“工具已获授权”。

## 设计来源及边界

| 研究来源 | 借鉴方向 | 本项目原则 |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi) | 小型 Agent Loop、模型适配、Steering、工具抽象 | 独立实现，不嵌入 Pi 运行时 |
| [Codex](https://github.com/openai/codex) | Session/Turn/Item、事件、审批与沙箱、恢复 | 参考协议思想，定义自己的协议 |
| [Claude Code / Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | Hooks、权限规则、Skills、Subagents | 扩展点可插拔，但安全由宿主强制执行 |

## 第一阶段交付

1. 不依赖上述三套 Agent 的可测试 Agent Loop。
2. 两种模型适配器与规范化工具调用。
3. Session / Turn 状态机、事件日志、取消、重连后事件重放。
4. 受限 workspace 的 Read / Write / Edit / Bash 工具。
5. 权限审批、预算控制和最小 Web/CLI 协议。
6. 一组可自动运行的验收测试。

**非 v0.1：** 完整 IDE、分布式多 Agent、插件市场、远程 SSH Host、视频剪辑工作台。后者作为面向领域工具的后续扩展目标。

## 文档导航

详细文档将集中在 `docs/`：

- `docs/00-vision-and-scope.md`：产品边界、设计原则、非目标
- `docs/01-architecture.md`：总体架构、模块与依赖方向
- `docs/02-runtime-and-state.md`：Agent Loop、状态机与恢复语义
- `docs/03-data-and-events.md`：数据结构、事件合同及持久化
- `docs/04-tools-policy-security.md`：工具、审批、安全边界
- `docs/05-context-providers.md`：模型适配、上下文与预算
- `docs/06-extensions-subagents.md`：Hooks、Skills、MCP 和多 Agent
- `docs/07-api-protocol.md`：客户端协议与错误语义
- `docs/08-roadmap-and-acceptance.md`：阶段计划、验收与测试
- `docs/adr/`：架构决策记录

## 工程约定

- 首先设计稳定的内部接口和测试，避免只为了某个 Provider 特判核心执行逻辑。
- `Session` 是持久容器，`Turn` 是一轮用户任务，`Step` 是一次内部模型或工具操作。
- 先记录意图，再执行有副作用的工具；崩溃恢复时不可盲目重放危险操作。
- 审批机制不等于操作系统沙箱；不受信任代码必须在有实际隔离措施的执行环境中运行。
- 用户数据与密钥始终受保护，日志对敏感字段做脱敏。

## 当前状态

仅文档设计阶段。未来与 `wwxst/agent-web`、`wwxst/agent-cil` 的集成以独立适配层为原则，在确认两者现有接口后另行规划。
