# 29 · M3 强制沙箱部署入口与继承 cgroup v2 资源上限

> 范围：新增受信宿主代码显式调用的 **`startEnforcedToolHost()`**。该入口不允许遗漏 Linux Bubblewrap 或资源预算，先证明当前进程所在 cgroup v2 已被内核限制，再启动并等待 sandbox namespace 就绪。**不是自动为 Worker 创建独占 cgroup，更不是将全部旧版 Tool Host API 替换为强制沙箱**。高风险工具和未知结果自动重放继续禁用。

## 为什么需要部署入口

`new ProcessToolHost(path, timeout)` 是为既有 M1 测试兼容保留的未隔离子进程形式。M3-27 / M3-28 已实现显式配置的 Linux Bubblewrap namespace，但业务侧可能漏传第三个 `sandbox` 参数。本轮新增 **另一个必须明确选择的入口**，适合受信部署管理程序在正式启动之前执行最小安全预检：

```ts
import {startEnforcedToolHost} from './packages/tool-host/src/enforced.js';

const {host,limits} = await startEnforcedToolHost({
  databasePath:'/dedicated-state/agent.sqlite',
  sandbox:{
    binaryPath:'/usr/bin/bwrap',
    runtimeReadOnlyDirectories:['/usr'],
    privateTmpBytes:16*1024*1024,
    startupTimeoutMs:5000,
  },
  requiredBudget:{
    maxMemoryBytes:512*1024*1024,
    maxPids:64,
    maxCpuMillicores:1000, // 1000 = one logical CPU's aggregate quota
  },
});

try {
  const runner = new ManagedSessionRunner(
    '/dedicated-state/agent.sqlite',provider,
    lease=>host.createRegistry(lease),
  );
  // 使用原有可信 Session / Command API。
} finally { host.close(); }
```

如果宿主尚未通过外部系统分配符合要求的 cgroup v2 资源上限，上述函数**直接拒绝启动**；它不会自己创建系统组、不临时修改全局 cgroup、不以进程 `ulimit` 假装完整资源配额、不尝试换成未沙箱化 `fork`。

## 实际验证

`inspectCurrentCgroupV2()` 从内核提供的 `/proc/self/cgroup` 取得唯一 `0::...` 成员身份，并遍历 `/sys/fs/cgroup` 对应 cgroup 自身与所有可见祖先，对以下控制文件取最严格上限：

| Linux v2 控制文件 | 约束范围 | 本入口处理 |
| --- | --- | --- |
| `memory.max` | 进程组内存上限 | 必须找到有限、合法的字节上限 |
| `pids.max` | 进程/线程数量上限 | 必须找到有限、合法的进程数上限 |
| `cpu.max` | CPU 时间配额与周期 | 必须找到有限配额；换算成 millicores |

`max` 表示该层没有额度限制。如果所有可见祖先都无限额、Controller 文件不可读取、数据损坏、真实路径逃出 cgroup 根目录、身份格式不合法，一律 `HOST_CGROUP_UNAVAILABLE`；额度虽有效但高于声明预算，返回 `HOST_CGROUP_BUDGET_UNSATISFIED`。

只有所有三类资源都已经满足预算，才构造 Bubblewrap Host 并调用新增 `waitUntilReady()`：确保完整执行之前 Worker 已回传并通过 mount / network / PID / user namespace identity 检查。之后父进程再次读取 `/proc/<launcher-pid>/cgroup`，确认启动器仍在相同 cgroup 内；任何读取失败、启动超时或沙箱不支持均拒绝，不向上层提供 Host。

### 重要：这是*共享组额度*，不是独立 Worker 配额

Bubblewrap Worker **继承控制进程的 cgroup**，所以 Linux 内核对整个父进程、Worker 以及该组其他进程施加共同上限。当前没有为每个 Worker 单独创建并验证 cgroup 子组，也没有保证 Group 内只有 Agent；过多的其他进程可能占用预算，变更 Group 上限的特权服务也可能后续调整额度。只有独立部署编排（systemd/Kubernetes/受信 supervisor）先创建明确分配的、不可被普通 Worker 修改的 cgroup，才能把该预算合理归属到单个工作负载。

本阶段 **不提供** Worker 独占 CPU/RSS/PID 限制、跨进程树的独立使用量审计、不间断重新验证控制文件或外部 IdP。被撤销的受信身份与未决 Tool Intent 仍由前序授权与双账本负责。

## 测试矩阵

新增 `tests/enforced-tool-host.test.ts` **11 项**，验证：

- 子组/父组叠加时内核有效上限按最严格一层计算；
- 子组 `max` 不会覆盖祖先额度；全部无限额则失败；
- 损坏/重复 cgroup v2 身份、越界路径、恶意符号链接拒绝；
- 非法 `memory.max / pids.max / cpu.max` 拒绝；
- 缺少 sandbox、缺少 requiredBudget、非法预算 **在 spawn 前**拒绝；
- 内核上限即使满足预算，也不能授权错误 Bubblewrap 二进制或普通 Worker fallback；
- 预算中任何一个维度低于已有额度时都拒绝；明确区分“共享组额度符合要求”和“Worker 专有预算不可证明”。

前主分支共有 216 项，本轮目标 **227 项**。严格 TS 检查和 Node 22 / Node 22.16.0 全套测试以本 PR 最终 CI 为准。

**CI 环境说明：** 当前 GitHub Runner 不具有同时可验证的有限 CPU、内存和 PID cgroup v2 上限；依赖真实现成配额的集成检查会**明确跳过**，不把它伪称为端到端的 cgroup 资源强制验证。离线 cgroup 文件夹/伪造损坏路径测试仍执行。独立的真正已委派 cgroup 环境下才能完成这项剩余验收。

## 尚未交付

1. 由受信 supervisor **在 Worker 执行前原子地分配独享 cgroup v2**、真正每 Worker 额度和进程树可靠销毁；
2. Kernel/App 其他启动方式不允许绕过安全工厂的**全局生产入口策略**；
3. cgroups 持续额度审计与 Linux seccomp syscall allowlist、执行程序身份、持久审批链；
4. 高风险文件/网络/Shell 工具的认证审批和副作用可验证结果；
5. 安全跨平台沙箱（Windows/Mac）及主机对等身份签名认证。

参考：[27 Bubblewrap Tool Host](27-M3-Linux-ToolHost-Bubblewrap-强制隔离.md)、[28 启动信任根与 tmpfs](28-M3-沙箱启动可信根与私有临时空间预算.md)、[26 运行期授权撤销](26-M2-执行期间授权撤销与协作中断.md)。
