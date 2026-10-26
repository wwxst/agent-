# Agent Kernel｜自研智能体内核

> **项目阶段：v0.1 自主内核开发** · **代码状态：M0 + M1 会话重开/SQLite WAL 增量已实现（非生产就绪）** · **最后更新：2026-10-27**

本仓库用于从零开发**属于自己的 Agent 内核**。研究并借鉴 Pi Agent、OpenAI Codex、Claude Code 与 DeepSeek Harness 的公开设计，但不以其中任何一个的 Agent 运行时作为核心依赖；本项目独立设计并实现 Agent Loop、会话状态、工具、安全边界和客户端协议。

**注意：M0 Agent Loop 已实现，M1 已完成会话安全重开、SQLite WAL 及 Writer Lease/Fencing 的基础原语。** 可信 Kernel 自动获取/续租/释放、Tool Host 独立栅栏、Intent/Receipt 和完整恢复仍未完成。详见 [M0 说明](m0/README.md)、[M1 会话重开](docs/11-M1-会话重开与恢复边界.md)、[M1 SQLite WAL](docs/12-M1-SQLite-WAL-事件日志.md) 和 [Writer Lease 设计边界](docs/13-M1-Writer-Lease-与-Fencing-Token.md)。

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
12. [Claude Code 多轮源码研究（含沙箱、Shell 执行、SDK、Bridge）](docs/research/claude-code/README.md)
13. **[四套 Agent 内核源码对照与自研取舍（持续深研）](docs/research/comparative/README.md)**：Pi 的 Coding Agent 产品层、Codex 的 App Server/持久化、Claude Code 2.1.304/Desktop、DeepSeek Native/PTC，并记录 [12 条执行不变量](docs/research/comparative/11-跨内核不变量与架构评审门槛.md)。
14. **[四内核证据审计与正式技术取舍](docs/research/comparative/14-自研内核架构取舍正式评审稿.md)**：推荐 TS Kernel、SQLite WAL、可信 Tool Host、S2 调度。详见 [研究完成边界](docs/research/comparative/15-研究完成判据与剩余缺口.md)，未运行测试不得称完成。
15. [M1 安全重开与恢复边界](docs/11-M1-会话重开与恢复边界.md)：日志结构验证、未决 Turn 停机保护。
16. [M1 SQLite WAL 事件日志](docs/12-M1-SQLite-WAL-事件日志.md)：事务 CAS、跨进程 crash 测试和持久化边界。
17. [M1 Writer Lease 与 Fencing Token](docs/13-M1-Writer-Lease-与-Fencing-Token.md)：租约基础协议、旧持有者隔离、仍缺少自动执行协调。

附加约束：

- [ADR 0001：自主实现内核与宿主隔离（提议）](docs/adr/0001-自主内核与宿主隔离.md)
- [ADR 0002：能力组合与可信内核边界（提议）](docs/adr/0002-能力组合与可信内核边界.md)
- [ADR 0003：远程事件 ACK、持久接受和工具执行收据（提议）](docs/adr/0003-远程控制事件确认与执行收据.md)
- [ADR 0004：工具隔离与 Interrupt/Cancel 执行语义（提议）](docs/adr/0004-工具执行隔离与中断语义.md)
- **[ADR 0005：首版自主内核技术基线与取舍（推荐方案，待接受）](docs/adr/0005-首版自主内核技术基线与取舍.md)**
- [AGENTS.md：AI 开发协作规则](AGENTS.md)

## 四、第一版范围（拟议）

优先实现单 Agent、多模型适配、基础工具、Session/Turn 生命周期、持久事件流、权限审批、取消和故障恢复。先保障正确性与安全，再增加多 Agent、远程 Host 和媒体工作流。

**暂不计划在第一版实现**大型插件市场、完整 IDE、分布式集群或视频时间线编辑器。

## 五、代码与集成状态

- **M0（已合并 main）**：`packages/contracts`、`packages/kernel-core`、`packages/model-providers`、`packages/tool-scheduler`、`packages/event-store-memory`；17 项离线确定性测试。
- **M1 安全重开（已合并 main）**：`AgentKernel.openSession()` 校验既有完整会话日志，遇未结束 Turn 返回 `RECOVERY_REQUIRED` 而非自动执行；新增 4 项测试。
- **M1 SQLite WAL（已合并 main）**：`packages/event-store-sqlite` 使用 Node 自带 `node:sqlite`，实现事务 compare-and-append、SQLite 文件级重开和 read cursor；新增 5 项测试（含 SIGKILL 重开）。M1 的存储接口**不等于**完整恢复系统。
- **M1 Writer Lease/Fencing（本轮开发分支）**：新增 `packages/session-leases-sqlite` 租约事务、过期后递增 Fencing Token 和可选的 SQLite EventStore 事务内栅栏。增加 9 项测试，但**尚未集成 Kernel 的自动 acquire/renew/release**。
- **自动验证**：GitHub Actions 同时运行 Node 22.16.0 和 Node 22.x 的 `npm run check` 与 `npm test`，目前合计 36 项确定性测试；结果以具体 workflow run 为准。
- **仍未具备**：真实模型、可信 Kernel 自动租约协调、Tool Host 独立 Fencing、Tool Intent/Receipt、权限审批、OS 沙箱、外部副作用工具、Subagent/MCP/Skills 和桌面/Web API。
- **安装和测试**：Node.js **>=22.16.0**；运行 `npm install`、`npm run check`、`npm test`。由于 Node 22 的 SQLite API 仍是实验性功能，运行时可能提示 ExperimentalWarning。本阶段还没有提交可重复安装的锁文件。

## 六、下一步

先将 Session lease/fencing 原语接入可信 Kernel admission + heartbeat + abort，再实现 Tool Intent/Receipt 的故障恢复协议，继而接入独立可信 Tool Host、安全审批与真实 Provider。完整目标不缩水，但在这些边界完成前不开放具有副作用的执行工具。
