# Agent 内核中文文档导航

> 更新：2026-10-31。**这是纯文档归档库，当前没有源码、测试、构建和 CI**。历史报告中的“已实现”“已验证”均指清理前固定版本，不代表当前仓库可以执行。

## 从哪里开始

建议先读 [中文综合总结](中文综合总结.md)，掌握项目架构和研究结论；再查阅 [技术术语表](技术术语表.md) 和 [历史模块地图](模块地图.md)。本页为按主题整理的**完整逐篇目录**，既保留原有文件路径，也避免凭空合并或删减研究证据。

## 阅读顺序

1. **概览（约 10 分钟）**：[中文综合总结](中文综合总结.md) → [愿景与范围](00-愿景与范围.md) → [总体架构](01-总体架构.md)。
2. **设计（按需查阅）**：执行循环、事件存储、权限、模型上下文、扩展和协议。
3. **技术取舍**：[跨内核研究索引](research/comparative/README.md) → [正式评审稿](research/comparative/14-自研内核架构取舍正式评审稿.md) → [后续架构重评](research/comparative/26-架构重评第一轮-2026-10-29.md)。
4. **历史实现**：M1–M3 专题是阶段性记录；以原记录所述版本和测试条件为限。
5. **证据核对**：研究目录内的静态分析、动态探针、未验证事项与 ADR 相互印证，不混同为当前生产能力。

## 一、总体设计与历史实现（36 篇）

### 基础架构与设计

- [愿景与范围](00-愿景与范围.md)
- [总体架构](01-总体架构.md)
- [执行循环与状态机](02-执行循环与状态机.md)
- [事件与持久化](03-事件与持久化.md)
- [工具与安全](04-工具与安全.md)
- [模型与上下文](05-模型与上下文.md)
- [扩展与多智能体](06-扩展与多智能体.md)
- [客户端协议](07-客户端协议.md)
- [开发路线与验收](08-开发路线与验收.md)
- [DeepSeek-Harness-借鉴评估](09-DeepSeek-Harness-借鉴评估.md)
- [Claude-Code-内核源码追踪](10-Claude-Code-内核源码追踪.md)
- [模块地图](模块地图.md)

### M1：事件持久化、租约与工具收据

- [M1-会话重开与恢复边界](11-M1-会话重开与恢复边界.md)
- [M1-SQLite-WAL-事件日志](12-M1-SQLite-WAL-事件日志.md)
- [M1-Writer-Lease-与-Fencing-Token](13-M1-Writer-Lease-与-Fencing-Token.md)
- [M1-ManagedSessionRunner-自动租约与中断](14-M1-ManagedSessionRunner-自动租约与中断.md)
- [M1-Tool-Intent-Receipt-执行审计](15-M1-Tool-Intent-Receipt-执行审计.md)
- [M1-子进程ToolHost-与执行账本](16-M1-子进程ToolHost-与执行账本.md)
- [M1-双账本只读对账与证据判定](17-M1-双账本只读对账与证据判定.md)
- [M1-证据绑定人工审核记录](18-M1-证据绑定人工审核记录.md)
- [M1-旧PR2-真实Provider和CLI整合](19-M1-旧PR2-真实Provider和CLI整合.md)

### M2：指令、上下文与授权控制

- [M2-Command-Inbox-事务ACK与幂等](20-M2-Command-Inbox-事务ACK与幂等.md)
- [M2-Steering-活动Turn指令与审计](21-M2-Steering-活动Turn指令与审计.md)
- [M2-Context-Checkpoint-可信摘要投影](22-M2-Context-Checkpoint-可信摘要投影.md)
- [M2-Command-Dispatcher-持久Turn绑定与重放阻断](23-M2-Command-Dispatcher-持久Turn绑定与重放阻断.md)
- [M2-本地认证控制面与Session权限](24-M2-本地认证控制面与Session权限.md)
- [M2-持久凭据轮换撤销与授权审计](25-M2-持久凭据轮换撤销与授权审计.md)
- [M2-执行期间授权撤销与协作中断](26-M2-执行期间授权撤销与协作中断.md)

### M3：Linux 工具执行隔离

- [M3-Linux-ToolHost-Bubblewrap-强制隔离](27-M3-Linux-ToolHost-Bubblewrap-强制隔离.md)
- [M3-沙箱启动可信根与私有临时空间预算](28-M3-沙箱启动可信根与私有临时空间预算.md)
- [M3-强制沙箱入口与继承cgroup资源额度](29-M3-强制沙箱入口与继承cgroup资源额度.md)
- [M3-独立Worker-cgroup与整组终止边界](30-M3-独立Worker-cgroup与整组终止边界.md)
- [M3-ToolHost-内核侧进程身份验证](31-M3-ToolHost-内核侧进程身份验证.md)
- [M3-Linux-Seccomp-网络与特权调用限制](32-M3-Linux-Seccomp-网络与特权调用限制.md)
- [M3-ToolHost-SQLite专用挂载目录准入](33-M3-ToolHost-SQLite专用挂载目录准入.md)
- [M3-生产安全入口强制Seccomp与配置拒绝](33-M3-生产安全入口强制Seccomp与配置拒绝.md)

> 历史文档中存在两个编号为“33”的专题，为避免破坏大量历史链接，当前保留原文件名，用中文标题区分，不代表缺少内容。

## 二、架构决策记录（6 篇）

- [自主内核与宿主隔离](adr/0001-自主内核与宿主隔离.md)
- [能力组合与可信内核边界](adr/0002-能力组合与可信内核边界.md)
- [远程控制事件确认与执行收据](adr/0003-远程控制事件确认与执行收据.md)
- [工具执行隔离与中断语义](adr/0004-工具执行隔离与中断语义.md)
- [首版自主内核技术基线与取舍](adr/0005-首版自主内核技术基线与取舍.md)
- [M3-ToolHost-seccomp-强制系统调用边界](adr/0006-M3-ToolHost-seccomp-强制系统调用边界.md)

决策记录可能包含“提议”“待接受”状态。请以文内证据和结论为准，不要把候选设计直接视为最终方案。

## 三、Claude Code 专项研究（10 篇）

[专项研究总目录](research/claude-code/README.md)

- [执行循环与工具调度](research/claude-code/11-执行循环与工具调度.md)
- [权限审批与沙箱](research/claude-code/12-权限审批与沙箱.md)
- [上下文压缩](research/claude-code/13-上下文压缩.md)
- [子智能体与恢复](research/claude-code/14-子智能体与恢复.md)
- [借鉴取舍与测试矩阵](research/claude-code/15-借鉴取舍与测试矩阵.md)
- [沙箱执行与策略映射](research/claude-code/16-沙箱执行与策略映射.md)
- [SDK控制协议与审批竞态](research/claude-code/17-SDK控制协议与审批竞态.md)
- [远程Bridge事件确认与恢复](research/claude-code/18-远程Bridge事件确认与恢复.md)
- [Shell实际执行与取消语义](research/claude-code/19-Shell实际执行与取消语义.md)
- [CLI子进程协议与Desktop证据边界](research/claude-code/20-CLI子进程协议与Desktop证据边界.md)

研究以特定版本和来源为范围；静态证据不等于真实端到端运行验证。

## 四、四套参考内核对比研究（29 篇）

[跨内核研究总目录](research/comparative/README.md)

- [研究方法与证据登记](research/comparative/00-研究方法与证据登记.md)
- [Claude-Code-2.1.304-新版复核](research/comparative/01-Claude-Code-2.1.304-新版复核.md)
- [Pi-Agent-源码研究](research/comparative/02-Pi-Agent-源码研究.md)
- [Codex-源码研究](research/comparative/03-Codex-源码研究.md)
- [DeepSeek-Harness-源码研究](research/comparative/04-DeepSeek-Harness-源码研究.md)
- [架构取舍与候选设计](research/comparative/05-架构取舍与候选设计.md)
- [未完成事项与验证计划](research/comparative/06-未完成事项与验证计划.md)
- [Pi-Coding-Agent-上层会话扩展与Shell](research/comparative/07-Pi-Coding-Agent-上层会话扩展与Shell.md)
- [Codex-AppServer-指令审批与持久化屏障](research/comparative/08-Codex-AppServer-指令审批与持久化屏障.md)
- [DeepSeek-工具执行管线与PTC隔离](research/comparative/09-DeepSeek-工具执行管线与PTC隔离.md)
- [Claude-Desktop-SDK-进程控制与错误边界](research/comparative/10-Claude-Desktop-SDK-进程控制与错误边界.md)
- [跨内核不变量与架构评审门槛](research/comparative/11-跨内核不变量与架构评审门槛.md)
- [四内核执行与持久化证据审计](research/comparative/12-四内核执行与持久化证据审计.md)
- [工具权限与异常恢复对照](research/comparative/13-工具权限与异常恢复对照.md)
- [自研内核架构取舍正式评审稿](research/comparative/14-自研内核架构取舍正式评审稿.md)
- [研究完成判据与剩余缺口](research/comparative/15-研究完成判据与剩余缺口.md)
- [跨内核统一验证规约](research/comparative/16-跨内核统一验证规约-2026-10-28.md)
- [第三轮隔离动态复现](research/comparative/17-第三轮隔离动态复现-2026-10-28.md)
- [第四轮执行边界审查](research/comparative/18-第四轮执行边界审查-2026-10-28.md)
- [完整Kernel动态验证](research/comparative/19-完整Kernel动态验证-2026-10-28.md)
- [真实ToolHost并发故障及沙箱复核](research/comparative/20-真实ToolHost并发故障及沙箱复核-2026-10-28.md)
- [编码工作流能力边界与动态实验](research/comparative/21-编码工作流能力边界与动态实验-2026-10-28.md)
- [真实Bubblewrap-Workspace执行边界](research/comparative/22-真实Bubblewrap-Workspace执行边界-2026-10-28.md)
- [Workspace执行隔离与纯补丁规划](research/comparative/23-Workspace执行隔离与纯补丁规划-2026-10-28.md)
- [可信Workspace提交器与HostLedger实证](research/comparative/24-可信Workspace提交器与HostLedger实证-2026-10-28.md)
- [可信Workspace收据缺口修复](research/comparative/25-可信Workspace收据缺口修复-2026-10-28.md)
- [架构重评第一轮](research/comparative/26-架构重评第一轮-2026-10-29.md)
- [工具结果顺序与Adopt-vs-Build](research/comparative/27-工具结果顺序与Adopt-vs-Build-2026-10-29.md)
- [Pi-Agent-Core适配边界审查](research/comparative/28-Pi-Agent-Core适配边界审查-2026-10-29.md)

重点研究 Pi Agent、Codex、Claude Code 和 DeepSeek Harness。不同轮次的研究结论可能互相修正，建议按日期和证据等级比较。

## 五、实验记录与研究方法

- [README](research/comparative/probes/2026-10-28/README.md)

实验原始脚本已按纯文档仓库要求移除，保留的 README 属于历史说明，不意味着当前可以重现其运行。

## 文档语言和维护规则

- 中文用于标题、解释、结论、风险和文档导航；API 名、函数名、事件名、引用项目名称等保留英文原名。
- 如果中文同义词有歧义，首次出现可使用“中文名称（英文术语）”。
- 已实现、已验证、计划、建议、未验证是不同证据状态，需保持清楚。
- 不修改历史报告的原始结论或实验结果以制造新的“已验证”事实。
- 文档之外的 `README.md`、`AGENTS.md`、`m0/` 不属于本次整理范围。
