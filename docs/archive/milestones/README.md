# M1–M3 历史里程碑索引

> 下列文件位于 `docs/` 原位置，本页只做中文分类与摘要。记录的是**源码被清理之前**的实现与测试历史；当前仓库不提供运行环境。

## M1：持久化与工具审计

- [11 会话安全重开](../../11-M1-会话重开与恢复边界.md)：验证旧事件、拒绝未决恢复。
- [12 SQLite WAL 事件日志](../../12-M1-SQLite-WAL-事件日志.md)：事务追加、序列竞争与崩溃边界。
- [13 写入租约与 Fencing Token](../../13-M1-Writer-Lease-与-Fencing-Token.md)：单写者租约及旧持有者隔离。
- [14 托管会话运行器](../../14-M1-ManagedSessionRunner-自动租约与中断.md)：历史阶段自动续租与中断。
- [15 Tool Intent/Receipt](../../15-M1-Tool-Intent-Receipt-执行审计.md)：工具执行前留痕、执行后收据。
- [16 子进程 Tool Host](../../16-M1-子进程ToolHost-与执行账本.md)：隔离进程和 Host 账本。
- [17 双账本对账](../../17-M1-双账本只读对账与证据判定.md)：结果不确定时的证据检查。
- [18 人工审核记录](../../18-M1-证据绑定人工审核记录.md)：审核证据快照和不可变记录。
- [19 Provider 与 CLI 集成](../../19-M1-旧PR2-真实Provider和CLI整合.md)：历史真实模型流与 CLI。

## M2：命令、上下文与授权

- [20 命令收件箱](../../20-M2-Command-Inbox-事务ACK与幂等.md)：持久 ACK 与幂等。
- [21 Steering](../../21-M2-Steering-活动Turn指令与审计.md)：活动轮次调整指令和审计。
- [22 上下文 Checkpoint](../../22-M2-Context-Checkpoint-可信摘要投影.md)：可信摘要投影。
- [23 Command Dispatcher](../../23-M2-Command-Dispatcher-持久Turn绑定与重放阻断.md)：命令与轮次持久绑定。
- [24 本地认证与 Session 权限](../../24-M2-本地认证控制面与Session权限.md)：控制面身份与授权。
- [25 凭据轮换撤销](../../25-M2-持久凭据轮换撤销与授权审计.md)：授权审计与失效机制。
- [26 执行中撤销](../../26-M2-执行期间授权撤销与协作中断.md)：动态重检和中断。

## M3：Linux 工具隔离

- [27 Bubblewrap](../../27-M3-Linux-ToolHost-Bubblewrap-强制隔离.md)：Linux namespace 和显式安全入口。
- [28 启动可信根](../../28-M3-沙箱启动可信根与私有临时空间预算.md)：运行时路径与临时空间预算。
- [29 继承 cgroup 配额](../../29-M3-强制沙箱入口与继承cgroup资源额度.md)：主机现有资源边界。
- [30 专属 Worker cgroup](../../30-M3-独立Worker-cgroup与整组终止边界.md)：进程组终止语义与待验收点。
- [31 Worker 身份核验](../../31-M3-ToolHost-内核侧进程身份验证.md)：进程、namespace 和启动证据核验。
- [32 seccomp](../../32-M3-Linux-Seccomp-网络与特权调用限制.md)：网络与特权 syscall 限制。
- [33A SQLite 专用挂载目录](../../33-M3-ToolHost-SQLite专用挂载目录准入.md)：最小化数据库可写目录。
- [33B 生产入口强制 seccomp](../../33-M3-生产安全入口强制Seccomp与配置拒绝.md)：配置拒绝与强制隔离。

> 原历史文档有两篇编号 33。本索引使用 33A/33B 区分，**不移动原文件**，以保持链接稳定。
