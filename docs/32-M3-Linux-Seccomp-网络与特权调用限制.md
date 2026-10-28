# 32 · M3 Linux Tool Host：Bubblewrap seccomp 网络与特权系统调用拒绝

> 当前新增**显式启用的 Linux x86-64 seccomp cBPF 限制策略**。与 Bubblewrap 的 mount / network / PID / user namespace 并用，额外从 Linux 内核 syscall 层阻止网络 socket 和部分敏感系统接口。默认旧 Worker、没有开启本策略的 Bubblewrap Worker，以及其他 OS/CPU 架构**不应被称为已经执行 seccomp 规则**。这不是完整的通用任意代码执行沙箱。

## 背景与接口

原 M3-27/31 已通过 Linux namespace 隔离文件系统与网络，通过独立 /proc 验证 Worker PID、血缘、Node 可执行文件和实际 namespace，但没有针对 Worker 系统调用的 seccomp deny profile。

新增 `LinuxBubblewrapSandbox.seccompPolicy?: 'network-and-privilege-deny-v1'`：

```ts
const sandbox={
  binaryPath:'/usr/bin/bwrap',
  runtimeReadOnlyDirectories:['/usr'], // 按可信宿主发行版/Node 路径调整
  privateTmpBytes:16*1024*1024,
  startupTimeoutMs:5000,
  seccompPolicy:'network-and-privilege-deny-v1',
} as const;

const host=new ProcessToolHost('/trusted/state/session.sqlite',4000,sandbox);
await host.waitUntilReady();
```

**M3-33 后续约束**：M3-29 `startEnforcedToolHost` 与 M3-30 `startDedicatedToolHost` 两个资源受限的受信高层入口现在**强制要求** `seccompPolicy:'network-and-privilege-deny-v1'`；缺失、非法或不支持的平台会在任何 Host 启动之前拒绝。底层兼容 `ProcessToolHost` 在非专有组模式下仍可显式不设置 seccomp，**不能把它当作该强制入口**。

## 受信生成与传输

1. `packages/tool-host/src/seccomp.ts` 实现确定性的、可测试的 classic BPF `sock_filter` 指令序列，按 Linux **x86-64** 系统调用号生成 LE 字节。任何非 Linux/x64 或无效 Profile 一律抛出结构化错误 `HOST_SECCOMP_UNAVAILABLE`。
2. 首先检查 `seccomp_data.arch` 必须是 `AUDIT_ARCH_X86_64`；不同 arch 返回 `SECCOMP_RET_KILL_PROCESS`。随后检查 x32 ABI syscall 编号标记并拒绝绕过。
3. 匹配内核敏感 syscall 时返回 `SECCOMP_RET_ERRNO | EPERM`，否则允许；与 runtime 拒绝高风险工具白名单、Session/ToolCall Intent/Receipt 权限机制是**不同层**。
4. 受信父进程在独立的临时目录使用 `O_CREAT|O_EXCL` 和 `0600` 生成完整 BPF，**立刻 unlink 临时路径**，通过打开的 FD 3 传给 Bubblewrap 的 `--seccomp 3`；父进程 spawn 后立即关闭 FD。不将指令文件留下供工具或第三方修改。
5. 如果使用 M3-30 的受信 cgroup launcher，FD 3 会被明示转交到同一个 `--seccomp 3` Bubblewrap 命令；先迁组再运行 Worker 的顺序不改变。FD 未正确传入、BPF 无效、Bwrap 未能安装过滤器，则启动失败，**无非沙箱化 fallback**。

## 拒绝的高风险接口与保持可用的调用

拒绝集包括：
- 网络 socket 创建、socketpair、connect、bind、listen、accept/accept4、sendto、sendmsg、recvmsg 等；
- ptrace、process_vm_writev、unshare、setns、mount/umount2/pivot_root；
- 通过传统 `clone(flags,...)` 建立新 mount/cgroup/UTS/IPC/user/PID/network/time namespace 的标志，逐位检查 `seccomp_data.args[0]` 后返回 `EPERM`；`clone3` 的 flag 结构体位于用户态指针，cBPF 不能安全解引用，因此专门返回 `ENOSYS`，促使 libc 回退到受标志检查的传统 `clone`。
- bpf、perf_event_open、内核模块修改、部分 keyring/kernel reboot/kexec、userfaultfd、io_uring 系统调用。

保留基础 Node.js/V8/libuv/SQLite WAL 工作所需的 `read/write/open/openat/execve/futex/mmap` 及**未携带新 namespace 标志的传统 `clone`** 等 syscall。**因而这不是任意代码的安全执行平台**：仍可 fork/exec 已挂载的受信文件；SQLite 目录仍有 RW 权限，也未加入完整路径政策、cgroup 独占分配、系统级 LSM 或 seccomp allowlist。只靠禁用系统调用不能撤回已经发生的工具副作用。

## 内核证明与失败语义

除 M3-31 的身份和 namespace 校验外，如果开启了 `seccompPolicy`，`ProcessToolHost` 会在 READY 及每次 ToolCall 前读取 **真实 Linux `/proc/<workerPid>/status`**，要求：

- `Seccomp: 2`（过滤模式）；
- Worker 的 `Seccomp_filters` 比父进程已安装的数量至少多 1 层。

这可排除 Worker 未安装任何附加过滤器的误配置，但 Linux procfs **不会披露已安装 BPF 规则的真实字节**，不能把过滤层数等同于密码学代码证明。启动或运行中无法读取、进程身份改变、未达要求则拒绝继续 ToolCall，保留任何已 STARTED 调用的未知结果，遵守原 Tool Ledger/Fencing/人工审核机制。

## 测试

`tests/seccomp-tool-host.test.ts` 现有 **10 项**（本轮从 9 项增加 1 项）：

1. 固定 cBPF 字节序、Linux arch 检查、x32 syscall 拒绝；
2. 明确 deny syscall 与 Node/SQLite 启动保留 syscall；
3. 无效/未知 Profile 拒绝；
4. 无路径可复用的匿名 FD 及字节内容一致性；
5. Bubblewrap `--seccomp 3` 参数正确，普通模式不伪称已启用；
6. **真实 Linux Bubblewrap** 中 Node 网络 socket 创建返回明确 `EPERM`，与仅由 network namespace 导致的路由失败相区分；
7. **真实 seccomp Worker** 继续执行 `read.echo` 并写入 SQLite Host Ledger 和 Kernel Receipt；父进程读取内核 Seccomp 模式；
8. 缺失过滤 FD 的启动必须失败，绝不退回普通 Worker；
9. 普通父进程或不存在的 PID 无法冒充已经附加 seccomp 的 Worker；
10. 用精简 cBPF 指令解释器验证 **8 种新 namespace clone 标志均拒绝、普通 Node 线程 clone 放行、clone3 ENOSYS 回退**，同时回归既有 network/ABI 拦截。

现有 Node 22 / 22.16.0 严格 TypeScript 和完整测试结果，以 GitHub Actions 最终 PR SHA 为准。CI 缺乏独立 cgroup 委派导致的 1 项原有正向配额集成测试仍会明确跳过；**这不影响本轮真实 seccomp socket/Worker 验收**。

## 下一步与明确未完成

- 进一步采用 **经过平台测试的 seccomp allowlist** 或分阶段安装 Node 运行时收敛策略；目前 `clone3` 拒绝走的是 libc 兼容回退路径，并非所有 Linux 发行版/运行时的实测兼容保证。不能直接禁止所有 `clone/execve` 破坏 Node 自身启动并称为安全增强。
- Linux arm64 独立审核 syscall ABI 后再引入，不猜测 syscall 编号。
- 结合独立 cgroup 真机正向验证、可信 supervisor、持续配额、Linux LSM/ptrace 限制和 OS 密钥隔离；完整第三方工具副作用审计与认证审批仍未实现。
- seccomp 可阻断一类 syscall，**不代表任意恶意代码、数据库写权限或同用户进程均已被可靠隔离**。Shell、网络、文件写入和其他高风险副作用工具继续禁用。

参考：[31 Kernel Host 身份验证](31-M3-ToolHost-内核侧进程身份验证.md)、[30 独立 Worker cgroup](30-M3-独立Worker-cgroup与整组终止边界.md)、[27 Bubblewrap 强制隔离](27-M3-Linux-ToolHost-Bubblewrap-强制隔离.md)。
