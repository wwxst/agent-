# 31 · M3 Tool Host：内核侧 PID、进程血缘与 Namespace 验证

> 本阶段将 Bubblewrap Tool Host 的 READY 握手从“**信任 Worker 自报 namespace 字符串**”加固为“**父进程通过真实 Linux /proc 证明被信任的 Worker 身份，再检查自报字符串一致**”。这是受信宿主内核对实际子进程的启动时验证，**不是远程可信计算证明、数字签名身份或不可突破的恶意代码沙箱**。

## 现有问题

M3-27 的 Worker 会发出 `ready` 和自身 `mnt/net/pid/user` namespace inode，父端只拿这些自报值与 `/proc/self/ns/*` 比较。一个被替换/伪装的 Worker 或被污染的 IPC 可能发出四个看似不同的虚假 inode，而父端在旧机制中无法从 Linux 内核单独证明这些值对应**自己启动的实际 Worker 进程**。

## 当前实现

新增 `packages/tool-host/src/host-attestation.ts`：

- `attestSandboxWorker({launcherPid,nodePath,workerPath,databasePath,claimedNamespaces})`：父进程从自己持有的真实 ChildProcess PID 开始读取 `/proc/<pid>/task/<pid>/children`，**有界遍历**所有子孙（最多 48 个进程，超过/重复/读不到就拒绝），在子孙中寻找恰好一名符合预期的 Node Worker；
- 与 kernel 的 `/proc/<pid>/exe` 比较真正 Node 可执行文件的 realpath，并从 `/proc/<pid>/cmdline` 核对可信只读 `worker.js` 和当前数据库绝对真实路径；不接受简单的进程自报 PID 或伪造的 READY 身份字段，也不接受多个匹配 Worker；
- 从 `/proc/<workerPid>/ns/{mnt,net,pid,user}` **独立读取**四个 namespace inode，要求确实与父进程不同，且与 READY 自报的四个值逐项一致；多余或缺失字段拒绝；
- 通过 `/proc/<workerPid>/stat` 中的 kernel starttime（字段 22）记录 PID 的**进程生命周期标识**，避免 PID 数字重用后把不同进程错误视为已经认证的 Worker；
- `assertWorkerIdentity()` 在**每次工具调用前**复核 PID starttime 和四个 namespace inode，任一变化/进程消失就拒绝继续，调用 `ProcessToolHost.close()`；已 STARTED 的工具保留未知结果，不能自动重播；
- 只在完整验证成功后兑现 `ProcessToolHost.waitUntilReady()`；未设置 Bubblewrap 的旧 IPC Host 不会被虚构成具备真实 OS 身份验证。

`ProcessToolHost.verifiedWorkerPid` 是**只读的诊断元数据**，只有内核验证后才有值。不能把这个数值本身当作安全 Token 或跨进程授权凭据。

## 边界与安全行为

1. READY 消息本身不授予任何执行权限，必须与 `/proc` 内核证据一致；实际启动树与 Worker 信息不匹配时拒绝启动，绝不回退普通 Worker。
2. Linux 的 `/proc` 状态具有瞬时性质。此实现在 READY 和 ToolCall 前校验；**不是**持有 pidfd 的原子身份/存活锁。两个检查点之间进程可能退出，已有 Intent/Receipt、超时/Abort、未决人工审核机制继续承担失败恢复；不会承诺 exactly-once。
3. 受信 Node Worker 代码必须仍位于只读挂载内，OS namespace/cgroup/seccomp 保护是**不同层**。如果宿主用户级别的恶意进程能对同权限子进程进行 ptrace、修改其执行环境或替换宿主代码，不能把这个检查误称为抗本地管理员篡改的加密证明。
4. 控制进程必须能够读取其子孙的 `/proc`，而且命名空间/进程启动结构必须满足 Bubblewrap 预期；内核限制、进程树发生不寻常改变会 **fail closed**，不改变工具白名单或权限。
5. 有独立 cgroup 的模式仍需受信 Supervisor 预先委派空叶子 cgroup；真实 cgroup 成功迁入仍缺专用 CI 验收。这个身份增量不能替代实际 cgroup 资源隔离测试。

## 测试

新增 `tests/host-identity-attestation.test.ts` **8 项**：畸形/多余/缺失 Namespace 字段、父进程假扮沙箱、非法 Launcher PID、无血缘关系的进程、伪造 PID 生命周期、伪造 Namespace inode、已退出进程、普通 Node 进程试图冒充沙箱等拒绝测试。

同时增强已有 **真实 Bubblewrap** 端到端测试：实际等待 Host READY，检查 `verifiedWorkerPid` 与 Bubblewrap Launcher PID 不同，Linux 内核中四种 namespace 与宿主不同，且真实 Worker cmdline 包含受信 Node 工具实现；然后继续验证 Tool Host Durable Ledger 和 Kernel Receipt 完成。

基线 **238 项** + 新增 8 项，目标 **246 项**。严格 TypeScript 和 Node 22 / 22.16.0 全量测试以最新 PR 同 SHA GitHub Actions 验收为准。

## 仍未完成

- kernel `pidfd_open` 绑定、操作系统级 pidfd signal、seccomp BPF、独立 cgroup 真机正向 E2E 和 Host/Controller 双向加密认证；
- 将 Loopback Bearer 授权审计与最终 Host 每个 ToolCall 的同一不可篡改凭据绑定；
- 受信宿主重新编排、多租户 OS 密钥隔离、防 ptrace/LSM，以及部署级零信任服务；
- 任何 Shell、文件写入、网络访问等高风险副作用工具的开放与自动重试。

参考：[27 Linux Bubblewrap Tool Host](27-M3-Linux-ToolHost-Bubblewrap-强制隔离.md)、[30 独立 Worker cgroup](30-M3-独立Worker-cgroup与整组终止边界.md)、[26 执行期间授权撤销](26-M2-执行期间授权撤销与协作中断.md)。
