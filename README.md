# Agent Kernel｜自研智能体内核

> **项目阶段：v0.1 自主内核开发** · **代码状态：M0 + M1/M2 真实 Provider/可信 Host/Command Inbox 增量已实现（非生产就绪）** · **最后更新：2026-10-27**

本仓库用于从零开发**属于自己的 Agent 内核**。研究并借鉴 Pi Agent、OpenAI Codex、Claude Code 与 DeepSeek Harness 的公开设计，但不以其中任何一个的 Agent 运行时作为核心依赖；本项目独立设计并实现 Agent Loop、会话状态、工具、安全边界和客户端协议。

**注意：M0 Agent Loop 已实现；M1 已实现安全重开、SQLite WAL、Writer Lease/Fencing、ManagedSessionRunner、持久 Intent/Receipt，并新增真正独立 Node 子进程的只读 Tool Host 与 Host 自身的执行账本。** M3 已提供显式 Linux Bubblewrap namespace、cgroup 安全入口和初步 seccomp 拒绝策略，但尚非默认全局强制或完整生产级 OS 沙箱；未决 Turn 自动修复/重放、审核者生产鉴权与外部副作用幂等仍未实现。详见 [M0 说明](m0/README.md)、[M1 会话重开](docs/11-M1-会话重开与恢复边界.md)、[M1 SQLite WAL](docs/12-M1-SQLite-WAL-事件日志.md) 和 [Writer Lease 设计边界](docs/13-M1-Writer-Lease-与-Fencing-Token.md)及[ManagedSessionRunner](docs/14-M1-ManagedSessionRunner-自动租约与中断.md)及[Tool Intent/Receipt](docs/15-M1-Tool-Intent-Receipt-执行审计.md)及[子进程 Tool Host](docs/16-M1-子进程ToolHost-与执行账本.md)及[双账本只读对账](docs/17-M1-双账本只读对账与证据判定.md)及[证据绑定人工复核](docs/18-M1-证据绑定人工审核记录.md)。

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
17. [M1 Writer Lease 与 Fencing Token](docs/13-M1-Writer-Lease-与-Fencing-Token.md)：租约基础协议、旧持有者隔离。
18. [M1 ManagedSessionRunner](docs/14-M1-ManagedSessionRunner-自动租约与中断.md)：自动续租、租约丢失协作中断，尚无 Tool Host 安全边界。
19. [M1 Tool Intent/Receipt 执行审计](docs/15-M1-Tool-Intent-Receipt-执行审计.md)：执行前意图、每项结果持久收据、结果未知时拒绝自动重放。
20. [M1 子进程 Tool Host 与执行账本](docs/16-M1-子进程ToolHost-与执行账本.md)：子进程白名单、Host 端租约及 Intent 复核、重复执行防护。
21. [M1 双账本只读对账](docs/17-M1-双账本只读对账与证据判定.md)：Kernel 事件/Host 台账一致快照，保守审计，禁止自动重放。
22. [M1 证据绑定人工复核记录](docs/18-M1-证据绑定人工审核记录.md)：审计 Hash 与审核记录在事务内绑定，缺少生产鉴权且不自动恢复。
23. [M1 旧 PR #2 真实 Provider 与 CLI 移植](docs/19-M1-旧PR2-真实Provider和CLI整合.md)：SSE 适配、工具目录快照、用量/字符准入、无工具 CLI。
24. [M2 Command Inbox 事务 ACK 与幂等](docs/20-M2-Command-Inbox-事务ACK与幂等.md)：Fencing 事务、CommandId 指纹去重、进程崩溃后重复 ACK；**不代表执行**。
25. [M2 Steering 活动 Turn 指令与审计](docs/21-M2-Steering-活动Turn指令与审计.md)：活动 Turn FIFO 追加指令、持久队列、未消费输入恢复阻断。
26. [M2 Context Checkpoint 可信摘要投影](docs/22-M2-Context-Checkpoint-可信摘要投影.md)：仅已完成历史 Turn 的可验证摘要、不删除源日志、拒绝未决状态与篡改。
27. [M2 Command Dispatcher 持久 Turn 绑定](docs/23-M2-Command-Dispatcher-持久Turn绑定与重放阻断.md)：事务绑定 ACK/Turn、单次模型执行、崩溃后只读状态与禁止自动重放。
28. [M2 本地认证控制面与 Session 权限](docs/24-M2-本地认证控制面与Session权限.md)：127.0.0.1 强 Bearer、Session 白名单、读写独立权限与隐私响应；非生产网关。
29. [M2 持久身份权威、轮换撤销与审计](docs/25-M2-持久凭据轮换撤销与授权审计.md)：SQLite 主体信任根、实时权限决策、CAS 轮换/撤销与失效后的持续拒绝。
30. [M2 执行期间授权撤销与协作中断](docs/26-M2-执行期间授权撤销与协作中断.md)：受信持久 Grant、周期重检、模型/工具边界授权栅栏和未决 Turn 保守恢复。
31. [M3 Linux Tool Host Bubblewrap 隔离](docs/27-M3-Linux-ToolHost-Bubblewrap-强制隔离.md)：显式启用的 Linux user/mount/PID/network namespaces、只读代码与专用 SQLite 写目录、真实隔离探针；不支持即拒绝。
32. [M3 沙箱启动可信根与临时空间预算](docs/28-M3-沙箱启动可信根与私有临时空间预算.md)：拒绝可写目录中的伪装 launcher、私有 /tmp 容量硬上限和 Worker READY 启动超时。
33. [M3 强制沙箱入口与继承 cgroup v2 额度](docs/29-M3-强制沙箱入口与继承cgroup资源额度.md)：受信部署入口必须同时具备 Bubblewrap、有效 Linux cgroup v2 有限额度与隔离就绪证明；共享额度非专用配额。
34. [M3 独立 Worker cgroup 与整组清理](docs/30-M3-独立Worker-cgroup与整组终止边界.md)：受信 Supervisor 预设空独立叶子组，迁组后启动 Bubblewrap，cgroup.kill 整组终止；真机迁组正向验证待补。
35. [M3 Tool Host 内核侧进程身份验证](docs/31-M3-ToolHost-内核侧进程身份验证.md)：父进程独立核验 Worker 进程血缘、可执行代码与 namespace inode；PID 启动版本复核与 READY 伪造拒绝。
36. [M3 Linux seccomp 网络与特权调用限制](docs/32-M3-Linux-Seccomp-网络与特权调用限制.md)：显式 x86-64 BPF syscall 拒绝、匿名 FD3 传入 Bubblewrap、Worker 内核过滤模式确认与真实 socket EPERM 验证。
37. [M3 受控部署入口强制 seccomp](docs/33-M3-生产安全入口强制Seccomp与配置拒绝.md)：资源受限 Host 工厂必须同时验证 seccomp 配置与 cgroup，禁止调用方伪造内部迁组元数据。
38. [M3 SQLite 专用挂载目录准入](docs/33-M3-ToolHost-SQLite专用挂载目录准入.md)：拒绝无关文件及 sidecar 符号链接被同目录 RW 暴露；不代表数据库写权限隔离。

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
- **M1 Writer Lease/Fencing（已合并 main）**：新增 `packages/session-leases-sqlite` 租约事务、过期后递增 Fencing Token 和可选的 SQLite EventStore 事务内栅栏。增加 10 项测试；后续已接入托管 Runner 自动 acquire/renew/release。
- **M1 托管 Session（已合并 main）**：新增 `packages/session-runtime`，按操作自动获取/续租/释放 Writer Lease，所有 append 绑定 Token，Kernel/工具执行前检查租约，租约丢失时协作中断且不伪造终态；新增 6 项测试。
- **M1 Tool Intent/Receipt 执行审计（已合并 main）**：新增 `packages/tool-audit`、事件合同、Kernel 执行前 Intent 和按 ToolCall 单独持久 Receipt；面对收据丢失、进程崩溃或 outcome_unknown 坚持人工对账而非自动重试；新增 13 项测试。
- **M1 子进程 Tool Host（已实现增量）**：新增 `packages/tool-host`（IPC Client、Worker、SQLite 执行账本），子进程自己复核有效租约和持久 Intent，在调用前提交 STARTED、结束时再验证 Fencing Token；仅支持 `read.echo/read.sleep` 两个演示工具，新增 10 项测试。
- **M1 双账本只读对账（已合并 main）**：新增 `packages/tool-reconciliation`；只读事务同时快照 Kernel 与 Host，区分已验证、缺失收据、未开始证据、STARTED、冲突、孤儿 Host 等情况；强制 Receipt/Result 相邻，新增 12 项测试。
- **M1 证据绑定人工复核（已合并 main）**：新增 `packages/recovery-review`，单事务检查全量双账本证据 Hash，插入不可变审核记录；不授予重试/恢复许可。修复 Tool Host 冷启动 Schema 初始化竞争，新增 11 项测试（含 10 轮冷启动测试）。
- **M1 真实 Provider/CLI（已合并 main）**：选择性移植旧 PR #2 的 OpenAI Chat Completions SSE 与原生 Anthropic Messages SSE，新增每步只读工具目录快照、模型用量与预算、字符准入、基于 Fencing Runner 的文本 CLI；不移植旧 Kernel。新增 37 项离线/真实进程集成测试，累计 125 项。
- **M2 Command Inbox（已合并 main）**：新增 `packages/command-inbox` 受租约保护的持久 Command ACK、SHA-256 指纹幂等、Session scoped `command.accepted` 事件，Runner 可接受控制消息但不会自动分发命令；新增 12 项故障测试。
- **M2 Steering（已合并 main）**：新增在持有租约的活动 Turn 中持久排队指令，按下一模型步骤 FIFO 消费；未消费指令阻止会话重开和新 Command Inbox 接受，新增 9 项含独立 Host 的集成测试。
- **M2 Context Checkpoint（已合并 main）**：显式可信 Compactor，仅压缩已完整结清的旧 Turn；Checkpoint 保留原始事件摘要 Hash 并强制恢复验证；Steering/租约/崩溃期间 fail-closed，新增 12 项测试。
- **M2 Command Dispatcher（已合并 main）**：新增唯一 Command→Turn 映射、Fenced SQLite 原子入场、绑定用户文本指纹和崩溃后只读状态；首次执行保留既有 Host Intent/Receipt，重复交付从不重放，新增 14 项测试。
- **M2 本地认证控制面（已合并 main）**：新增 `packages/control-plane`，显式配置随机 Bearer 凭据、Session 作用域与接受/分发/查看权限；只监听 127.0.0.1，响应不返回 Prompt、密钥或模型内容。新增 13 项真实 HTTP/故障测试。非生产级远端鉴权。
- **M2 持久身份权威（已合并 main）**：新增 `SqliteControlAuthority`，可信本地 Bootstrap、CAS 凭据轮换/永久撤销、历史 Token 不可复用；每次授权含允许/拒绝都在事务内持久记录，审计失败拒绝放行；原临时密钥模式可继续兼容。新增 13 项故障及 HTTP 测试。
- **M2 执行期间授权撤销（已合并 main）**：HTTP 持久身份凭据版本绑定执行 Guard，Writer Lease 心跳重检授权，模型/工具继续执行前拒绝旧版本；失效后保持未决 Turn 且不盲目重放。新增 6 项集成/故障测试。
- **M3 Linux Bubblewrap Host（已合并 main）**：新增可选的 OS namespace 隔离 Worker、只读 runtime/code 与专用 SQLite RW 挂载、独立有界 JSON-line IPC、启动时 namespace 身份校验和绝不降级回退；新增 8 项含真实 Linux Worker 和私有文件/网络隔离验证的测试。
- **M3 沙箱启动强化（已合并 main）**：仅允许来自显式 RO runtime 的 bwrap 可执行文件；隔离 Worker 启动未 READY 超时则拒绝，不回退普通 Host；/tmp 私有 tmpfs 配置 1–128 MiB 硬容量。新增 4 项测试。
- **M3 安全部署入口（已合并 main）**：新增 `startEnforcedToolHost`，要求 Linux Bubblewrap 以及已由宿主内核强制的 CPU/内存/PID cgroup v2 共享额度，验证命名空间 READY 和 launcher cgroup 归属；不满足条件坚决拒绝，不提供默认降级。新增 11 项测试。
- **M3 Worker 独立 cgroup（已合并 main）**：新增 `startDedicatedToolHost`、受信 `cgroup-launcher` 先迁组再启动 Bubblewrap、独立叶子直接有限额度和空组强制检查、整组 `cgroup.kill` 退出与清理故障报告；新增 11 项策略/真实拒绝测试。新增 Worker READY 和每次 ToolCall 前真实 PID cgroup 成员归属与直接额度复核，累计新增 4 项纯 fixture 运行期回归测试；仍无真实成功委派 cgroup 环境的正向验收。
- **M3 Tool Host 内核身份校验（已合并 main）**：不再单纯相信 Worker READY 自报 namespace；父进程检查 Linux /proc 中唯一 Node Worker 的祖先关系、exe、真实编译入口和 namespace inode，并用 PID starttime 防替换，执行前重检。新增 8 项伪造身份与退出测试，现有真实 Bubblewrap 端到端加入 OS 身份验证断言。
- **M3 Linux x86-64 seccomp（已合并 main）**：新增 opt-in `seccompPolicy:'network-and-privilege-deny-v1'`，构建固定 cBPF，匿名 FD3 传入 Bubblewrap，拒绝网络 socket/ptrace/namespace 等敏感 syscall；READY 和调用前查 Linux 内核过滤状态。新增 9 项测试，含真实 socket `EPERM` 和过滤下持久 Tool Receipt。
- **M3 安全工厂策略硬化（本轮分支）**：`startEnforcedToolHost`、`startDedicatedToolHost` 强制 Linux x86-64 已审核的 seccomp 配置，不支持则启动前拒绝；两个工厂拒绝外部注入的内部 `dedicatedCgroup` 描述，底层专有组构造器也不再接受未过滤路径。新增 9 项 fail-closed 测试，保留普通旧 Host 兼容。
- **M3 SQLite 挂载目录收紧（本轮分支）**：Bubblewrap 仅允许专用 SQLite 主文件与 WAL/SHM/JOURNAL sidecar 同目录，其他文件、子目录、符号链接在 Worker 启动前拒绝；不声称已拆分 DB 主体写权限。新增 3 项安全拒绝测试。
- **自动验证**：GitHub Actions Node 22.16.0 与 Node 22.x 运行 `npm run check` 和 `npm test`，目标累计 271 项；既有 1 项实际 inherited cgroup 正向验证在 CI 可能条件跳过。
- **仍未具备**：生产级完整 OS 安全策略（独立 Worker cgroup 真机正向验证/完整 seccomp allowlist/DB 权限隔离/默认强制所有工具）、真实计费 API 端到端联调、生产鉴权与危险能力审批、受控 Recovery 修复、外部副作用工具、Subagent/MCP/Skills 和桌面/Web API。
- **安装和测试**：Node.js **>=22.16.0**；运行 `npm install`、`npm run check`、`npm test`。由于 Node 22 的 SQLite API 仍是实验性功能，运行时可能提示 ExperimentalWarning。本阶段还没有提交可重复安装的锁文件。

## 六、下一步

已实现双账本证据对账与版本绑定的不可变人工复核记录，但不具备鉴权或恢复权限。旧 PR #2/#3 中选定的 Provider、Command Inbox、Steering、Context Checkpoint 已按新版安全边界分别实现。现已实现受租约保护的 Command Dispatcher 首次原子绑定/分发与重复投递只读报告，但没有后台自动恢复。控制面已具备可选择启用的持久 Principal 凭据、轮换/撤销和授权决策审计，但不提供公开管理接口，也不能终止已授权并在途的执行。持久模式现已将 HTTP 分发的凭据版本绑定到执行边界与心跳重新校验；但无法强制停止忽略取消的外部工具，也不能撤销已发生副作用。本轮已提供显式可选的 Linux Bubblewrap 命名空间隔离，不表示其他工具调用或默认 Host 自动受限。本轮补上沙箱启动可信根、私有 /tmp 容量预算与启动超时；已提供可选择使用的强制部署入口，可校验调用进程继承的 CPU/内存/PID cgroup v2 有限额度并禁止不安全启动；但是它不是独占 Worker cgroup。当前新增由受信 supervisor **预先分配**独立 Worker cgroup 后的启动路径，仍需要真实可委派环境验证成功迁组及持续配额；本轮已加入受信 Host 的内核侧 PID/namespace 检查，但不是数字身份签名或 pidfd 原子防 PID 复用，之后还需 seccomp 完整 allowlist、独立 cgroup 真机正向验收、可信执行凭据审计与高风险工具审批。完整目标不缩水，但在这些边界完成前不开放具有副作用的执行工具。
