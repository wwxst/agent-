# 33 · M3 Bubblewrap SQLite 专用 RW 挂载目录准入

> 范围：在显式启用的 Linux Bubblewrap Tool Host 启动之前，拒绝把包含无关文件的 SQLite 数据库目录以读写权限挂入 Worker。本轮**没有**实现 SQLite 只读代理或剥离 Worker 对数据库内容的写入权限，也不开放 Shell、写文件、网络工具。

## 背景与风险

原 `buildBubblewrapLaunch()` 为了保证 `HostExecutionLedger` 的 WAL / STARTED / Receipt 可以持久写入，需要把 `dirname(databasePath)` 以 `--bind` 挂入。假设这个目录同时有 Bearer Token 文件、其他租户 SQLite、备份、密钥文件或符号链接，Worker 也能访问这些不属于 Tool Host 必需数据的文件。即使模型工具当前只允许 `read.echo` 和 `read.sleep`，此目录级暴露也是不必要的权限扩大。

## 已实现的启动前强制拒绝

`packages/tool-host/src/sandbox.ts` 在产生 Bubblewrap argv 前，检查数据库所在目录：

- 目标 SQLite 数据库必须是存在的普通文件，代码与 DB 目录不得重叠。
- 目录中只允许 `database.sqlite`、`database.sqlite-wal`、`database.sqlite-shm` 和 `database.sqlite-journal` 这些**以实际数据库文件名为前缀**的明确文件名；其中 sidecar 是可选项。
- 每一项必须是普通文件；**拒绝符号链接、子目录、其他备份、凭据、其他租户状态文件、意外命名的文件**。
- 不符合上述条件时返回 `HOST_SANDBOX_UNAVAILABLE`，Worker 不启动，不退回到未沙箱化 Host。
- 兼容旧非沙箱 Host 的 API 不受影响；需要用户迁移目录布局时，必须由受信操作员在 Worker 之外完成，不能自动删除或搬动未知文件。

## 安全边界

此检查只是**启动时目录清单校验**，不能抵抗另一个同权限宿主进程在检查与 mount 之间替换文件的 TOCTOU，也**不能阻止 Worker 修改目标 SQLite 数据库、撤销凭据记录或其他已存入同一数据库中的表**。尤其不能把“目录只含 SQLite 文件”混同为“Tool Host 数据库写入被隔离”。下一阶段应当通过 DB broker/独立 Host Ledger 存储，把 Tool Worker 的数据库修改能力从主 Kernel EventStore、授权凭据和租约状态彻底分离，并由受信 Broker 执行 Intent/Lease 校验与审计事务。

## 测试

在 `tests/linux-sandbox-tool-host.test.ts` 新增 3 项：

1. 存在同目录凭据文件时，构建 Bubblewrap 启动参数和真正创建 `ProcessToolHost` 都拒绝；
2. 尽管名称符合允许的 `-wal` 后缀，符号链接仍拒绝；
3. 正常的真实 SQLite 主文件以及可选 WAL/SHM 普通文件允许，生成的 RW mount 仍只指向该目录。

原有完整隔离、真实 Tool Intent/Receipt、Writer Lease、seccomp、cgroup 和恢复阻断测试保持执行。基线 264 项，新增 3 项，目标 267 项；最终通过数量必须以对应 PR 的双版本 CI 为准。

参考：[27 Linux Bubblewrap 强制隔离](27-M3-Linux-ToolHost-Bubblewrap-强制隔离.md)、[32 Linux seccomp](32-M3-Linux-Seccomp-网络与特权调用限制.md)。
