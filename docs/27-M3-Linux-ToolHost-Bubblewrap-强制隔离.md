# 27 · M3 Linux Tool Host：Bubblewrap 强制命名空间隔离

> 状态：本阶段新增**显式选择**的 Linux Bubblewrap Worker 沙箱，使用真实 Linux namespace 与只读/读写 mount 策略并通过双版本真实运行测试。原有非沙箱 `ProcessToolHost` 调用方式为兼容模式，**不可宣称所有调用已受 OS 沙箱保护**。本实现仍只允许 `read.echo` 和 `read.sleep`，不开放 Shell、网络访问、文件写入工具或第三方任意代码。

## 1. 边界与启动协议

`ProcessToolHost(databasePath, timeoutMs, sandbox?)` 新增第三个可选配置对象 `LinuxBubblewrapSandbox`：

```ts
interface LinuxBubblewrapSandbox {
  binaryPath: string;                     // 可信 Bubblewrap 的绝对路径
  runtimeReadOnlyDirectories: string[];     // 显式只读 runtime / ELF 动态链接库目录
}
```

示意（**只可在受信本地宿主配置中生成**，请按当前 Linux 发行版与 Node 安装位置定制）：

```ts
import {ProcessToolHost} from './packages/tool-host/src/index.js';

const host = new ProcessToolHost('/dedicated-state/agent.sqlite', 4000, {
  binaryPath:'/usr/bin/bwrap',
  runtimeReadOnlyDirectories:['/usr'], // 仅示例；Node 必须位于允许的目录中
});
try {
  const runner = new ManagedSessionRunner(
    '/dedicated-state/agent.sqlite', provider,
    lease => host.createRegistry(lease),
  );
  // 后续仍由原可信 Runner 管理 Session / Turn / Tool Intent。
} finally {
  host.close();
}
```

**运行前提**：Linux 系统已安装可信 Bubblewrap，内核和主机策略允许创建所要求的 user、mount、PID 和 network namespaces；SQLite 数据库文件已经存在，且宿主程序提前完成 Schema 引导。**最好将每个 Agent / Session 的 SQLite 文件放进只服务该 Host 的私有目录**：因为 Worker 为保证台账持久性，需要把 SQLite 所在目录作为 RW mount；若里面还有其他文件，当前沙箱也能读取或更改它们。

显式选择 sandbox 后，`buildBubblewrapLaunch` 先用 `realpathSync` 检查 Node、Worker、bwrap 可执行文件及目录的可信布局，再使用 `spawn` 直接传 argv，**没有 shell / fallback / 动态 `eval`**。缺失二进制、非 Linux、允许目录配置不符、namespace 被内核拒绝、子进程提前退出时都 fail-closed：**不会偷偷改回普通 `fork`**。默认不传第三参数时，保留旧的未隔离 IPC Host，主要供兼容性和测试使用。

## 2. Linux 强制策略

- `--unshare-all --unshare-user`：要求隔离 user、mount、PID、network 等 namespace，不接受 `--unshare-user-try` 弱化行为。显式 `--cap-drop ALL` 丢弃 Linux capabilities，`--new-session`、`--die-with-parent` 约束生命周期。
- `--clearenv` 清理凭据、`NODE_OPTIONS` 和无关环境变量，只设置 Worker stdio 模式及 `HOME/TMPDIR`。
- 从独立的空文件系统视图开始，只把明确列出的 Node/runtime 和已编译应用目录用 `--ro-bind` 挂入；不允许把 `/`、`/home`、`/proc`、`/sys`、`/dev`、`/run`、`/tmp`、`/etc` 等宿主敏感目录作为任意运行时只读挂载。
- 仅为 Worker 创建隔离的 `/proc`、最小 `/dev`、private tmpfs `/tmp`。在合并 `/usr` 的 Linux 发行版上，必要且指向允许范围内的 `/lib64` 等 symlink 可显式重建。
- **唯一可写宿主挂载：SQLite 数据库所在目录**；不得与应用代码树或运行时只读目录重叠。这样 SQLite WAL、Journal、Writer Lease 与 Host STARTED/Receipt 仍能按原协议落盘。
- 模型工具目录和 Worker 的 `validatedInput` 仍只允许演示 read-only 工具；OS 视图受限**不是允许任意未审核可执行程序的许可证**。

## 3. Worker 完整性与 Transport

普通模式继续用 Node 内建 IPC；sandbox 模式通过 STDIN/STDOUT 的有界 JSON-line 帧传递控制消息，无继承的应用环境。读取端和发送端都有 32 KiB 单条消息上限、累计 buffer 上限；协议错误、Socket/管道死亡时调用失败，不制造成功 Receipt。

启动完成时 Worker 上报 `/proc/self/ns/{mnt,net,pid,user}` 的 namespace identity。父进程在接受 `ready` 之前要求其格式有效且全部**不同于父进程的 identity**；若内核实际上没有隔离，不接受 Worker 就绪。这里的身份检查仅是协作式的启动时校验：对于不可信的 Worker 自身或遭同权限进程篡改的 IPC，**不是远程证明/加密签名**；真正的权限边界仍来自 Linux namespace/mount/capability 策略。

Host 侧租约验证、持久 Tool Intent 校验、STARTED 先落库、Fencing Token 校验、完成后 Durable Receipt、未知执行结果禁止重试，**仍复用既有 HostExecutionLedger 与 ManagedSessionRunner**；取消或 SIGKILL 后的 STARTED 不能当成未执行证据。

## 4. 已验证的隔离行为

新增 `tests/linux-sandbox-tool-host.test.ts` **8 项**，包括：

1. Namespace / capability / environment / mount 启动参数不弱化；
2. 缺失 bwrap、危险运行时目录或坏路径明确拒绝；
3. SQLite RW 与只读应用/运行时不得重叠；
4. Worker 文件路径不得逃出受信只读目录；
5. merged-`/usr` 链接只有在已允许 runtime 下才重建；
6. 启动失败不回退普通 Host；
7. **真实 Bubblewrap Worker** 通过 Fencing Runner 成功写入 Host 台账与 Tool Receipt；
8. **真实 Linux namespace** 探针直接验证：沙箱不能读取宿主同级私有文件、不能写代码目录、能写 SQLite 专用目录、不能连接宿主 `127.0.0.1` TCP 端口。

在 CI Node 22 / Node 22.16.0 上，上述两个真实隔离测试都已运行且未跳过；对应最后一个分支 CI 执行 **212/212 通过、0 skip**（此前主分支 204 项 + 8 项新测试）。在不支持 Bubblewrap / unprivileged namespace 的非目标平台，这些测试会报告明确跳过，**跳过不能被视为真实隔离验证**；而选择启用 Sandbox 的业务启动接口仍要求失败即拒绝，不自动降级。

## 5. 未完成、禁止过度声明的能力

- **不是完整生产级任意代码沙箱**：目前没有 per-process cgroups 内存/CPU/PID 强制预算、seccomp syscall allowlist、只读独立 Token Broker、Linux LSM 配置、安全的可执行代码签名/校验或多租户加密隔离。
- 宿主与 Worker 仍共享 SQLite 数据库目录的 RW 权限，且 Worker 与父进程能从中获取租约/事件/执行记录；如果任意恶意代码进入 Worker，应假定这些**状态和其他同目录文件处于风险之中**。真正不可信副作用工具需要拆分其数据库权限、通过 Broker 仲裁并独立签名验证。
- 沙箱只对**显式传入第三参数**的 `ProcessToolHost` 实例生效，旧 API、CLI 以及其他自定义工具执行仍不是自动强制沙箱。
- 不支持任何 Shell、文件写入、无审计任意代码执行、网络工具的权限开放，不保证执行成功 Exactly-once，更不会自动重试已经 STARTED 的未知副作用。
- 权限撤销仍为协作式；Linux 隔离将网络及文件系统能力限制在前述 mount/namespace 范围，但不保证逆转已落库工具结果。

下一阶段建议优先做 **OS 级资源预算 / kill-tree / 强制不降级部署策略 + 可信 Host 身份**，再做需要真正认证身份和原始 Intent 绑定的危险能力审批。

参考：[16 子进程 Tool Host](16-M1-子进程ToolHost-与执行账本.md)、[15 Tool Intent/Receipt](15-M1-Tool-Intent-Receipt-执行审计.md)、[26 执行期间授权撤销](26-M2-执行期间授权撤销与协作中断.md)。
