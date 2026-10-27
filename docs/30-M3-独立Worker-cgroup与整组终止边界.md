# 30 · M3 独立 Worker cgroup v2：启动前迁组与整组终止边界

> 本阶段交付**显式启用、需要已委派 Linux cgroup v2 子组**的 `startDedicatedToolHost()`。这不是自动为用户配置内核资源控制器，不支持 Mac/Windows，不增加新工具或外部副作用权限。GitHub Actions 的标准 Runner 不具备实际委派的子组，因此完整正向迁组运行必须在受信 Linux supervisor 的受控环境补测；未运行的测试不能被报告为已通过。

## 问题与新边界

M3-29 的 `startEnforcedToolHost()` 只能验证**控制器和 Worker 共用的父 cgroup 有限额度**。其 CPU、内存和 PID 限制可能被父进程或其他服务挤占，并非 Worker 自身的独立限制。这次引入另一条更严格的部署入口，不改变兼容用的 `ProcessToolHost` 或旧共享组入口：

```ts
import {startDedicatedToolHost} from './packages/tool-host/src/enforced.js';

const {host,limits}=await startDedicatedToolHost({
  databasePath:'/trusted/state/session-a/kernel.sqlite',
  sandbox:{
    binaryPath:'/usr/bin/bwrap',
    runtimeReadOnlyDirectories:['/usr'], // 按真实发行版配置
    privateTmpBytes:16*1024*1024,
    startupTimeoutMs:5000,
  },
  requiredBudget:{
    maxMemoryBytes:256*1024*1024,
    maxPids:32,
    maxCpuMillicores:500,
  },
  dedicatedCgroupRelativePath:'/trusted-supervisor/worker-session-a',
});
try{
  // ManagedSessionRunner 使用 lease=>host.createRegistry(lease)。
}finally{
  host.close();
  if(host.cgroupCleanupError){
    // 可信 Supervisor 必须人工/自动阻断并核查未完成清理；
    // 不得认定中断的 Tool Intent 已经确定失败。
  }
}
```

## 受信 Supervisor 必须先满足的条件

1. 主机必须启用统一 cgroup v2 文件系统；受信 supervisor **在父进程对应 cgroup 下创建独立的、尚无人使用的叶子 cgroup**（路径不是模型/Prompt/Tool 输出提供），并委派适当的迁组和 `cgroup.kill` 权限。
2. 该叶子组**本身**就已经设定 `memory.max`、`pids.max`、`cpu.max` 的有限强制额度，不允许只从祖先继承，也不接受单一维度没有额度上限。配额超过受信部署要求则拒绝。
3. 叶子组的 `cgroup.events` 需要显示 `populated 0`，`cgroup.procs` 为空，且 `cgroup.procs` 和 `cgroup.kill` 都有写入能力；不能误杀共享组或旧进程。预检是运行前检测，无法防御另一个特权 Supervisor 之后故意迁入其他进程。
4. 子组不得是 Controller 自身当前的 cgroup，而必须严格处于其子树之内；拒绝 `..`、绝对路径逃逸、符号链接绕过。
5. 受信部署必须在 Worker 使用期间避免重用该 cgroup 路径，确认所有进程退出后才能销毁目录或再次复用。同 OS 用户/管理员若能修改 cgroup 配置，可能在检查后修改额度，尚无持续硬锁定措施。

## 实际启动顺序（防迁组竞态）

- `startDedicatedToolHost()` 检查内核 cgroup2fs 类型、当前 `/proc/self/cgroup`、专用叶子的**直接**三维配额以及独占空状态；
- `ProcessToolHost` 不直接启动 Bubblewrap，而用 `node cgroup-launcher.js <leaf> <budget> <trusted-bwrap> <argv...>` 创建受信中间进程；Launcher 使用空环境、无 Shell、无模型可控命令；
- `cgroup-launcher.ts` **先写自己的 PID 到叶子的 `cgroup.procs`**，再核对其 `/proc/self/cgroup` 已属于请求叶子，并复核直接额度；
- 以上都通过后才 `spawn` 真正的 Bubblewrap Worker。Bubblewrap 子进程与未来子进程继承叶子 cgroup，原有 mount/user/PID/network namespace、private tmpfs、Worker namespace Ready、Host Ledger Fencing 与 Intent/Receipt 全部继续生效；
- 父端只在 Worker namespace READY 之后读取 `/proc/<launcher-pid>/cgroup`，确认仍在独立叶子，复核叶子直接配额，才返回可用的 Host。

**安全意义**：不能先运行 Worker 再异步把它搬进 cgroup，否则启动到迁组之间可能有不受资源限制的工具执行窗口。本实现不采用这种易错做法。

## 强制退出与结果状态

启动器使用现有 Bubblewrap 的 `--die-with-parent`；`ProcessToolHost` 在异常退出、取消、超时与显式 `close()` 时，针对已经预检的独立叶子写 `cgroup.kill=1`，请求 Linux 内核终止组内全部进程。命令失败时以 `host.cgroupCleanupError` 公开**非静默故障状态**，需要受信 Supervisor 介入；它不是清理成功的回执，也不承担回收 cgroup 目录本身的责任。普通不具备写权限的环境会在启动前拒绝；但写权限预检不能严格证明未来写入不会因环境变化失败。

终止执行**不等于**未发生副作用。此前已落库 `Host STARTED` 的 ToolCall 仍要求 Kernel/Host 双账本人工对账；`TOOL_OUTCOME_UNKNOWN` 不会自动重放。不开放文件写入、Shell、外部网络/进程等高风险工具。

## 测试与未验证条件

新增 `tests/dedicated-cgroup-tool-host.test.ts` **11 项**：

- 空的、严格位于父 cgroup 下的叶子与直接有限额度能够通过纯文件系统的策略检查；
- 叶子本身无限额即使祖先有限仍拒绝；微小 CPU 超额按 millicores 向上取整，不能以截断方式错误放行；
- populated 1、现存 PID、缺少 `cgroup.kill` 不得认作专有资源；
- 错误层级、逃逸路径、符号链接与三项资源任何一项过预算都拒绝；
- 缺失 Bubblewrap/Leaf 参数的安全入口不得启动；
- 真实 Linux 缺少目标委派目录时 fail-closed；
- **真实受信 launcher 进程**请求无效迁组时，所带子命令不会执行，不会创建测试标记文件。

累计目标由 227 增至 **238 项**；Node 22 / 22.16.0 的 `npm run check` 与 `npm test` 以 PR CI 最终结果为准。上述纯文件夹模拟只是验证**策略和错误分支**，不是 Linux cgroup 2 控制器端到端成功迁组与强制限额测试。完成这项正向验证需要支持 `cgroup.subtree_control` 委派和 `cgroup.kill` 的隔离 CI runner 或专用受信 Linux VM。

## 仍未完成的能力

- 未实现由本仓库进程**自动、安全、原子创建并配置**内核子组；创建/生命周期归属仍由受信 Supervisor 或运行平台承担。
- 没有对每个 Worker 独立 CPU/内存/PID 压测的真机正向证据、没有不可篡改的 Host/OS 身份签名或 seccomp syscall allowlist。
- Cgroup 路径复用与有特权进程恶意操作、持久审计的 OS 侧证据链依然需要设计；cgroup.kill 成功也不能回滚已执行副作用。
- 旧 `ProcessToolHost` 的普通 Node fork 与 Bubblewrap-only 构造方式仍兼容存在；不能称所有 Host 自动强制隔离。
- 不开放高风险工具，不会自动继续或重放任何未知结果。

参考：[29 继承 cgroup 部署入口](29-M3-强制沙箱入口与继承cgroup资源额度.md)、[27 Bubblewrap OS 隔离](27-M3-Linux-ToolHost-Bubblewrap-强制隔离.md)、[15 Intent/Receipt](15-M1-Tool-Intent-Receipt-执行审计.md)。
