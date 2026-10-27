# 33 · M3 受信部署入口强制 seccomp 与内部启动描述隔离

> 状态：**M3 资源约束入口安全增强**。从本阶段开始，`startEnforcedToolHost()` 和 `startDedicatedToolHost()` 必须显式配置经过验证的 Linux x86-64 seccomp deny profile。旧版 `new ProcessToolHost(path, timeout)` 与明确只使用普通 Bubblewrap 的低级 API 为兼容保留，**不具备本阶段“强制部署入口”的安全保证**。不应称所有 Tool Host 默认进入完整生产沙箱。

## 1. 修复的安全歧义

M3-29 的共享 cgroup 受控入口和 M3-30 的专有 Worker cgroup 入口，虽然保证了预配置的 namespace 与有限 cgroup 额度，但其 `sandbox.seccompPolicy` 是**可选字段**。这造成“调用的是安全工厂，却遗漏了 syscall 过滤”的易错配置；尤其当下游将其称为 production/enforced Host 时，可能误以为已经包括 M3-32 的过滤保护。

另一问题：`startEnforcedToolHost` 原样透传 `sandbox` 给底层 `ProcessToolHost`。如果额外包含内部 `dedicatedCgroup` 描述，构造器可能意外改走独立迁组路径，与共享额度安全工厂的原始语义不一致。该描述应该**只由独立组工厂在验证完空组、预算和权限后内部生成**。

## 2. 本轮合同

新增 `assertEnforcedSandboxPolicy(sandbox)`，受信部署工厂在触碰运行中 cgroup 或创建 Host/DB 之前执行：

1. 必须有 `seccompPolicy:'network-and-privilege-deny-v1'`，拒绝遗漏、`undefined`、`null`、`'none'` 或未知 profile；错误码 `HOST_SECCOMP_UNAVAILABLE`。
2. 通过 `buildHostSeccompBpf()` 先验证当前运行平台与策略是否支持。仅 Linux x86-64 接受；任何不匹配**不能退回仅 Bubblewrap/普通子进程**。
3. 任何外部预先出现的 `sandbox.dedicatedCgroup` 属性——包括值为 `undefined`——在两个高层安全工厂均拒绝，错误码 `HOST_INVALID_OPTIONS`。专用工厂只在 `assertDedicatedCgroupReady()` 成功后，自行生成内部带预算的迁组描述。
4. 底层 `ProcessToolHost` 如果明确传入 `dedicatedCgroup`，**也必须携带**受认可的 seccomp profile，防止直接构造器绕开最低组合要求；普通未声明 dedicated cgroup 的历史调用继续兼容。
5. 上述策略在 *启动前* 拒绝，无数据库初始化、无 Bubblewrap 进程、无安全降级。经过策略门槛后仍保留旧有内核证据：READY 前检查 Worker 的 PID/namespace 与 seccomp filter，ToolCall 前重新检查，Tool STARTED/Receipt 未知结果不自动重放。

## 3. 调用示例与迁移

```ts
const sandbox={
  binaryPath:'/usr/bin/bwrap',
  runtimeReadOnlyDirectories:['/usr'],
  privateTmpBytes:16*1024*1024,
  startupTimeoutMs:5_000,
  seccompPolicy:'network-and-privilege-deny-v1', // 强制
} as const;

// 共享 cgroup：需要控制进程所在组已被内核限制。
const {host}=await startEnforcedToolHost({
  databasePath:'/trusted/state/kernel.sqlite',
  sandbox,
  requiredBudget:{maxMemoryBytes:512*1024*1024,maxPids:64,maxCpuMillicores:1000},
});
```

若使用 `startDedicatedToolHost`，在相同 `sandbox` 和预算上额外传入受信 Supervisor 已创建的 `dedicatedCgroupRelativePath`；**不允许**在 `sandbox` 里填 `dedicatedCgroup`。部署者需要升级旧的未含 seccomp 配置的受限工厂调用。若部署在 macOS、Windows 或 Linux ARM64，此类受控工厂按设计拒绝启动；跨平台安全实现需要独立审核，不能套用 x86-64 syscall 号。

## 4. 本轮故障验证

新增 `tests/enforced-seccomp-policy.test.ts` **9 项**：
- 有效策略通过 Linux/x64 内核过滤器构造门槛；其他平台拒绝；
- 缺失、伪造、空的 Profile 全部拒绝；
- 调用方伪造内部专有 cgroup 描述（含显式 `undefined`）拒绝；
- 共享工厂和独立工厂遗漏策略，必须在读写 SQLite 之前拒绝；
- 共享工厂不得接受专有组描述，专有组工厂也不接受外部预制描述；
- 直接调用低级 Host 带专有组但没有 seccomp 也拒绝；
- 配额本身非法仍保留原先 `HOST_CGROUP_BUDGET_UNSATISFIED` 的 fail-closed 行为。

历史 255 项，本轮目标累计 **264 项**。PR 同 SHA 的 `npm run check` / `npm test` 在 Node 22.16.0 与 Node 22.x 结果为准。既有 GitHub Runner 因缺少三维有限 cgroup 委派可能跳过**1 项**正向集成测试；不能把该跳过解释为独立 cgroup 真实成功迁组。

## 5. 严格保留的限制

- “强制 seccomp”适用于**两个明确的高层资源受限工厂**，并不禁止受信代码故意选择旧式未隔离 `ProcessToolHost`。尚未实现不可绕过的全局生产编排入口或组织部署政策。
- 当前 Linux x86-64 seccomp 是经测试的**拒绝列表**，不是完整 syscall allowlist；`execve/clone` 等仍可用，RW SQLite 目录仍属于 Worker。
- `/proc` 的 seccomp 模式/层数证明**不等于**特定 BPF 程序的加密签名或防恶意宿主篡改证据。
- 高风险 Shell、文件写入、网络工具继续禁用；对于任何 Tool STARTED 的未知外部副作用，不保证 exactly-once，不自动重试。

参考：[M3-29 共享 cgroup 入口](29-M3-强制沙箱入口与继承cgroup资源额度.md)、[M3-30 专用 cgroup](30-M3-独立Worker-cgroup与整组终止边界.md)、[M3-32 seccomp 实现](32-M3-Linux-Seccomp-网络与特权调用限制.md)、[ADR 0006](adr/0006-M3-ToolHost-seccomp-强制系统调用边界.md)。
