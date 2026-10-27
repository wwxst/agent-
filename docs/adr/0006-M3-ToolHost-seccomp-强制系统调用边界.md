# ADR 0006 · Linux Tool Host seccomp 启动约束与信任边界

- 状态：**接受（限 Linux x86-64 的显式部署策略）**
- 决策日期：2026-10-27
- 关联：[M3-32 Linux seccomp](../32-M3-Linux-Seccomp-网络与特权调用限制.md)、[ADR 0004 工具隔离与中断](0004-工具执行隔离与中断语义.md)

## 背景

现有隔离组合：Loopback 持久身份授权、Command/Turn/Fencing、独立 Tool Host Intent/Receipt、Bubblewrap Linux namespaces、cgroup v2 资源策略、/proc Worker 进程身份校验。但允许的 Worker 仍能尝试大量 OS 内核接口；仅有网络 namespace 不代表不能创建 socket，缺少 syscall 层约束。

## 决策

1. 选择 **明确受信本地配置**的 `seccompPolicy:'network-and-privilege-deny-v1'`，不从 Model、技能、工具请求体、未授权 HTTP 提取该配置。当前仅 Linux x86-64 采用固定 syscall ABI；平台不符必须拒绝。
2. 使用经典 BPF，经 `AUDIT_ARCH_X86_64` 检查和 x32 ABI 拒绝；禁止一组网络 socket、namespace 管理、ptrace、kernel 内核模块等高风险 syscalls，拒绝动作是内核 `EPERM`；其他仍为 allow。明确**不把 denylist 当作 seccomp 全 allowlist 或任意不可信代码执行的充分防护**。
3. 父进程一次性创建完整 cBPF 内容，打开只读语义的有效文件描述符，并**在 spawn 前 unlink 文件路径**；Bubblewrap 使用 `--seccomp 3` 读取 FD3。独立 cgroup 模式必须由受信预迁组 launcher 向 Bubblewrap 逐级传入 FD3。丢失 FD、架构不受支持、无法创建 BPF 文件即拒绝启动，不自动回退。
4. 启动 READY 和每次 ToolCall 前，在原有 /proc PID/namespace proof 上叠加 `Seccomp:2` 和严格大于宿主的 `Seccomp_filters` 核验；该核验确认至少安装了一个新的 kernel filter，但 **不能证明 BPF 字节属于特定版本**，不可声称数字认证。
5. Node/V8/libuv 和 SQLite 需要正常运行；不采取未验证地禁止 `clone`、`execve` 或 `openat` 的激进做法。Worker 的全部允许工具仍只有 `read.echo/read.sleep`，仍依赖原 Tool Intent/Receipt/Fencing、孤儿未知结果保守审核机制。

## 替代方案及拒绝理由

- **只用 Bubblewrap network namespace**：无法禁止子进程自行创建 socket 等系统调用；缺少 syscall 层执行限制。
- **直接移植 Docker 系统调用白名单**：Node 版本、宿主架构和 SQLite 行为需要完整平台测试；任何误禁会使 Host 失效，不适合本轮偷偷宣称完成。
- **动态允许模型选择 syscall**：突破受信边界，拒绝。
- **磁盘上长期持有 seccomp 过滤器文件**：可能遭到文件替换和部署漂移；本阶段采用短生命周期匿名化 FD。

## 接受条件与未完成

- 严格 TypeScript + Node 22/22.16.0 全量测试；真实 Bubblewrap 中创建 socket 返回 `EPERM`，启用过滤器时 Node Worker 仍可完成 Ledger/Receipt；无 FD 路径拒绝；真实 /proc `Seccomp:2` 校验。
- **受限于当前实现**：这仅是 denylist、仅在显式 opt-in 生效，不覆盖未经审核的其他 ToolHost，也不是 Linux arm64、Windows 或 macOS 的安全策略。
- 后续需构建独立 cgroup 正向 E2E、分平台 syscall allowlist、LSM/PIDFD、更强 Worker DB Broker 与受信身份/人工审批；未通过这些前不打开高风险工具。

不得将本 ADR 当作用户授权调用 Shell 或文件/网络副作用的许可。
