# 四套 Agent 内核源码研究与自研架构取舍

> 更新至 2026-10-28 · 文档状态：**静态源码研究已推进到产品宿主与执行边界；动态实验与全部异常路径研究仍未完成；候选设计尚未定案。**

本目录把四个参考内核放在**同一证据规则**下研究：不只是列出它们的产品功能，而是追踪实际 Agent Loop、工具/权限、上下文、Session 事实和失败恢复，并为我们的第五套 Agent Kernel 提出可验证的取舍。

## 推荐阅读顺序

| 文档 | 内容与作用 |
| --- | --- |
| [00 证据方法与版本锁定](00-研究方法与证据登记.md) | 四套源码版本、证据级别，避免旧版内容冒充新版 |
| [01 Claude Code 2.1.304 新版复核](01-Claude-Code-2.1.304-新版复核.md) | 用户 ZIP 的 Agent Loop、沙箱实际分支、Desktop SDK ProcessTransport |
| [02 Pi Agent 源码研究](02-Pi-Agent-源码研究.md) | TS 双层循环、Steering、FollowUp、工具并发与事件 |
| [03 Codex Rust 源码研究](03-Codex-源码研究.md) | Turn/StepContext、ToolRouter、审批、沙箱与 ThreadStore |
| [04 DeepSeek Harness 源码研究](04-DeepSeek-Harness-源码研究.md) | Cordis Scope、Session Event、工具批次、append/flush 与恢复 |
| [05 四套机制取舍与候选架构](05-架构取舍与候选设计.md) | 目前可支持的技术建议，**尚未冻结** |
| [06 研究缺口、运行验证与完成门槛](06-未完成事项与验证计划.md) | 18 项故障/安全/状态测试、未完成调查项目 |
| [07 Pi Coding Agent 产品层](07-Pi-Coding-Agent-上层会话扩展与Shell.md) | 会话树、Fork、Context Edit、压缩切点、Extension 和 Shell |
| [08 Codex App Server 与持久化](08-Codex-AppServer-指令审批与持久化屏障.md) | Turn Start/Steer/Interrupt、审批优先级、Rollout 写入与 SQLite 投影 |
| [09 DeepSeek 工具管线和 PTC](09-DeepSeek-工具执行管线与PTC隔离.md) | Native/PTC Executor、Guard、嵌套工具和隔离要求 |
| [10 Claude Desktop SDK 进程控制](10-Claude-Desktop-SDK-进程控制与错误边界.md) | 进程参数、控制消息、senderFrame 校验、错误分类 |
| **[11 四内核不变量与评审门槛](11-跨内核不变量与架构评审门槛.md)** | 12 条执行不变量、测试门槛与候选方案决策闸门 |
| [12 四内核执行事实与持久化证据审计](12-四内核执行与持久化证据审计.md) | 逐层区分 Session Event、Handle.append、文件 Flush/Sync、外部副作用 |
| [13 工具权限与异常恢复对照](13-工具权限与异常恢复对照.md) | ToolCall 入场、审批优先级、并发/取消/沙箱、异常矩阵 |
| **[14 自研内核架构取舍正式评审稿](14-自研内核架构取舍正式评审稿.md)** | **明确选择 TS、SQLite WAL、独立 Tool Host、S2 调度及协议** |
| [15 研究完成判据与剩余缺口](15-研究完成判据与剩余缺口.md) | 四套各子系统的证据等级、待验证故障测试，不虚报研究透 |
| **[16 统一跨内核验证规约（第二轮）](16-跨内核统一验证规约-2026-10-28.md)** | 版本锁定、7 条安全不变量与 T01–T12 同条件验收规格；参考内核尚未动态运行 |
| **[17 第三轮隔离动态复现](17-第三轮隔离动态复现-2026-10-28.md)** | 调度器精确源码隔离测试：并发结果乱序、独占工具身份缺失、写工具拒绝 |
| **[18 第四轮执行边界审查](18-第四轮执行边界审查-2026-10-28.md)** | 9 项隔离观察：风险标签、parse 副作用、取消、租约、并发收据与冻结快照 |
| **[19 完整 Kernel 动态验证（第五轮）](19-完整Kernel动态验证-2026-10-28.md)** | 固定提交在 GitHub Actions 上实际运行 5 项观察探针；区分完整 Kernel 与 Scheduler 证据，尚无参考内核动态横向基准 |
| **[20 真实 Tool Host 并发取消与 Linux 隔离复核](20-真实ToolHost并发故障及沙箱复核-2026-10-28.md)** | ProcessToolHost 双 Worker 竞争与取消的 CI 动态测试，并校正 GitHub Actions 中已运行的 Linux Namespace/Seccomp 证据等级 |
| **[21 编码工作流能力边界与动态实验](21-编码工作流能力边界与动态实验-2026-10-28.md)** | GitHub CI 中的真实“读→修改→测试失败→修复→测试通过”实验；明确区分脚本式不安全适配器与正式写工具拒绝路径 |
| **[22 真实 Bubblewrap Workspace 写入范围实验](22-真实Bubblewrap-Workspace执行边界-2026-10-28.md)** | 默认只读 Workspace、受限可写子目录、宿主秘密/符号链接/网络边界与真实失败修复复测的 Linux CI 证据；不等于生产 Host 已支持编码 |
| **[23 第九轮 Workspace 控制/执行隔离与纯补丁规划](23-Workspace执行隔离与纯补丁规划-2026-10-28.md)** | 真实 CI 发现硬链接跨只读路径改写内容和旧 Host DB 挂载暴露；分离 Stage 执行与账本；纯 SHA-256 CAS 补丁预览 |
| **[24 可信 Workspace 条件提交与 Host Ledger](24-可信Workspace提交器与HostLedger实证-2026-10-28.md)** | Linux 普通文件原子替换、版本校验、租约写事务和 STARTED/UNKNOWN 实证；仍未开放模型写权限或完整 Kernel 收据协调 |
| **[25 第十一轮可信 Workspace 收据缺口补记](25-可信Workspace收据缺口修复-2026-10-28.md)** | Host 已成功而 Kernel 结果缺失时，在新 Lease、冻结证据与独立授权下补记收据/结果；不恢复 Turn、不重放工具 |
| **[26 架构重评第一轮：先验证参考方案，再决定自研方案](26-架构重评第一轮-2026-10-29.md)** | 核对当前 Kernel 与四套参考设计；明确暂停扩展 Workspace 恢复链，优先验证 Loop、StepContext、并发结果顺序与存储取舍 |
| [ADR 0005 首版自主内核技术基线](../../adr/0005-首版自主内核技术基线与取舍.md) | 推荐技术选择（Proposed，尚待批准） |

原 Claude Code 专题分析及 2.1.88 Source Map 研究还在 [旧版与专题目录](../claude-code/README.md)；本轮新版文件研究以 **01** 为准。

## 原则

1. **源码中存在一个分支**不等于**所有平台真实使用它**。
2. **Session 中已写入事件**不等于**已持久落盘**；不同项目的 append/flush 语义各异。
3. **工具返回取消/错误**不等于**真实外部副作用没有发生**。
4. **插件可注册权限/Hook**不等于**插件能赋予 OS 沙箱之外的权限**。
5. **模型能力**与**Agent Harness 工程能力**分开对照。
6. 要声明某版本“研究透”，必须走完正常/异常/取消/恢复调用链并做可复核动态测试。

## 当前可做的取舍

可以把 **Pi 的可读执行循环、Codex 的 StepContext 与权限安全边界、Claude Code 的流式工具/长时任务、DeepSeek Harness 的 Scope/事件模型** 作为候选机制。

**不能做的决定**：在动态测试之前给这四个项目排序、宣布某个 OS 沙箱无绕过、选择最终编程语言/部署架构，或把 `docs/05-架构取舍与候选设计.md` 当成已接受的实现标准。

正式架构决策须由维护者审阅 ADR、明示 Accepted，并有测试与类型合同支撑。对可恢复外部副作用必须实行可信 Tool Host 收据和不确定结果处理。

## 2026-10-28 增量验证资料说明

上述 16–18 是新一轮**研究文档**：第三轮与第四轮的 Node.js 隔离观察确已运行，但不是完整 AgentKernel 端到端、不是 Codex/Pi/Claude 动态对照，也不是 Linux OS 沙箱安全认证。文中的 `PASS` 指观察测试符合预期，其中部分预期本身是在复现设计缺口。

原始 ZIP 证据包（包含源码副本、TAP 日志和待运行探针）当前以研究对话附件形式保留，**不包含在本次 docs-only 提交中**。因此 GitHub 上的报告可以直接阅读和审阅，但不应将本目录误当作已经具备全部原始试验工件的可独立重放归档。上述声明描述 16–18 号文件的原始研究阶段；现已在第 19 号报告中完成固定基线 **5 项全仓 CI 观察探针**（其中两项贯穿完整 Kernel，另外三项覆盖完整构建中的 ToolScheduler）。第 20 号报告补充了 GitHub Actions 上实际执行的 Linux Bubblewrap/Seccomp 隔离测试，以及新运行的进程内并发取消、Worker 竞争和 SQLite 账本实证。**专用 cgroup 真实部署、跨 OS/内核平台、外部副作用崩溃恢复，以及 Codex/Pi/Claude 同条件动态比较仍 NOT RUN**。最终架构决策仍待同条件实验。

第 22 号报告进一步验证了**研究用 Linux Namespace Workspace Mount** 可以支持限定子目录的真实修改与测试闭环，但该测试进程未接入生产 Tool Host 的审批、强制 Seccomp 与持久收据。**不能把它当作已经开放生产编码权限。**
