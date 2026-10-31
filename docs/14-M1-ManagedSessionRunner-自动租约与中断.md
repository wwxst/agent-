# 14 · M1 ManagedSessionRunner：自动租约生命周期与执行边界

> 状态：**已实现单次操作的租约自动获取、续租、Kernel 协作中断和释放**；测试用的是可信只读工具和本地 SQLite。**尚非生产级独立 Tool Host / 安全沙箱 / exactly-once 外部副作用协议。**

## 当前状态校准（2026-10-31）

本文记录的是 ManagedSessionRunner 首次落地时的历史实现边界，不能直接代表当前仓库全部能力。后续已经新增并记录：

- Tool Intent/Receipt 持久审计：见 [15 号文档](15-M1-Tool-Intent-Receipt-执行审计.md)。
- 独立 Node 子进程 Tool Host 与 Host 执行账本：见 [16 号文档](16-M1-子进程ToolHost-与执行账本.md)。
- Kernel/Host 双账本只读对账：见 [17 号文档](17-M1-双账本只读对账与证据判定.md)。
- 证据绑定的不可变人工复核记录：见 [18 号文档](18-M1-证据绑定人工审核记录.md)。
- M3 Linux Bubblewrap、cgroup、进程身份校验和 seccomp 增量：见 [27–33 号文档](27-M3-Linux-ToolHost-Bubblewrap-强制隔离.md)及相关文档。

因此，本文后续“明确未完成和限制”及“下一步”部分应理解为该功能最初交付时的历史说明；当前整体状态以根目录 README、[开发路线与验收](08-开发路线与验收.md)和上述后续实现记录为准。后续能力仍有生产级鉴权、完整隔离策略及真实 cgroup 正向验收等缺口，不能据此宣称生产就绪。

## 目标和接入点

新增 `packages/session-runtime/src/index.ts` 的 `ManagedSessionRunner`，作为可信调用方唯一推荐的 M1 单 Session 入口：

- `createSession(sessionId)`：独立抢占租约、使用绑定 Fencing Token 的 `SqliteEventStore` 创建会话，最后释放。
- `runTurn(sessionId, text, turnId?)`：独立抢占租约、调用 `openSession()` 验证**上次 Turn 必须已终结**、执行当前 Turn、释放租约。
- `readEvents(sessionId, afterSeq?)`：在临时租约下读取**可重开且历史已完全结束的**会话事件；有未决 Turn 时拒绝 `RECOVERY_REQUIRED`，不是运营用无条件审计 API。

`ManagedSessionOptions` 的 `ttlMs` 默认 3000ms，`renewEveryMs` 默认 TTL 的约三分之一（但至少 10ms）；续租间隔必须小于 TTL，托管 TTL 至少 30ms。过短 TTL 仅供确定性测试，不建议生产部署。

```ts
import { ManagedSessionRunner } from './packages/session-runtime/src/index.js';

const runner = new ManagedSessionRunner(
  './agent.sqlite',
  provider,                 // 实现 ModelProvider
  trustedReadOnlyRegistry,  // 仅注册可信 read 工具
  { ttlMs: 3000, renewEveryMs: 900 },
);
await runner.createSession('s-1');
const result = await runner.runTurn('s-1', '下一条输入', 'turn-1');
```

示例展示 TS 源码 API，不是已经交付的 CLI 或后端网络服务。

## 自动协调的实际流程

```text
ManagedSessionRunner.runTurn()
  -> SQLite LeaseStore.acquire(session, uniqueOwner, ttl)
     -> Busy => SESSION_BUSY，无模型/工具运行
  -> SqliteEventStore(databasePath, acquiredLease) // 强制 fenced append
  -> AgentKernel.openSession()                       // 仅接受所有 Turn 已终结
  -> AgentKernel.runTurn()
       每个 Model Step 之前/之后检查有效 Lease
       每次工具 execute 之前检查有效 Lease
       每次 SQLite append 在 BEGIN IMMEDIATE 内检查 Token + 时间 + seq
       setInterval 周期调用 SQLite LeaseStore.renew()
  -> 运行结束（或抛异常）清除续租计时器
  -> release(claim) -> close SQLite connections
```

重要：心跳定时器**只在进程实际获得执行机会时运行**。Node 事件循环遭到长时间阻塞或宿主进程暂停时，租约可先过期。之后所有模型/工具边界校验以及带租约 EventStore 的追加将拒绝旧 Token。

## Fencing 失败的具体语义

当续租失败或 `assertOwned()` 检查失败：

1. Runner 标记此操作为失去所有权，调用 `AgentKernel.fenceActiveTurn(sessionId)`，中止在途 Provider/Tool 的 `AbortSignal`。
2. Agent Kernel 不把租约丢失伪装成用户取消，也不写 `turn.failed` 或 `turn.cancelled` 的虚假终态，而是抛出 `LEASE_LOST`。已经入库但未结束的 Turn 将保留，下一任通过 `openSession()` 收到 `RECOVERY_REQUIRED`。
3. 工具调度器现在支持第 4 个可选参数 `assertLease`，每个工具的实际 `execute` 之前都检查，独占屏障之后的下一工具也必须重新检查。并行只读调用出错时会等所有在途执行 settle，再离开批次。
4. 失效 owner 的 release 只有旧 Token，不会释放新的持有者。

这些是**代码协作控制与日志事务屏障**。若 Provider 忽略取消并长时间不返回，Kernel 无法强制杀死其进程；若可信只读工具忽略取消，已经开始的调用可能继续运行到完成。不能将此视作操作系统强制中断。

## 已新增的自动化测试

`tests/managed-session.test.ts` 新增 6 项：

1. 模型时间长于短 TTL，周期续租仍保证完整 Turn 且执行结束释放租约，可连续运行两轮。
2. 两个 Runner 在同一 SQLite 文件竞争同一 Session，后者得到 `SESSION_BUSY`；前者结束后后者才可执行。
3. 模拟管理者吊销活跃租约并向新 owner 发放较大 Fencing Token：旧执行检测到失权、中断；即便模型忽略 AbortSignal 并晚返回，也不执行后续工具、不伪造终态，新进程重开遇 `RECOVERY_REQUIRED`。
4. 未知 Session 不会被 `runTurn` 默默创建；非法租约配置拒绝。
5. 工具独占屏障之后再次验证租约，旧 owner 不能执行后一条 ToolCall。
6. 并发只读工具中有一项租约检测失败时，等其它已启动工具全部结束后才向上抛错，不会提前释放 Runner 的 claim。

本轮连同历史测试累计 42 项；类型检查/测试运行于 Node 22.16.0 与 Node 22.x，最终状态以具体 GitHub Actions 记录为准。

## 明确未完成和限制

- **没有 Tool Intent/Receipt/Unknown 对账**，尚不允许执行写文件、Shell、网络发送及其他非幂等/高风险工具。
- **没有受独立进程/OS 权限隔离的 Tool Host**；目前可用 `ToolRegistry` 依然是 M0 的内存可信注册器，仅允许 `risk: 'read'`。
- **没有数据库独占执行的完整租约协调服务**：本模块每次调用重新取得一份短期 claim，心跳同 Node 事件循环；长期任务需要更强 watchdog、服务中断和故障恢复调度。
- **旧的无栅栏 `SqliteEventStore(path)` 接口仍保留**用于兼容迁移，可绕开 Runner；不能赋予不受信任业务进程底层 SQLite 原始写权限并声称全局租约受强制保护。
- **租约检查存在 TOCTOU**：检查有效到工具执行期间可能失效。未来 Tool Host 必须再次验证 Token，并借助持久 Intent/Receipt 或宿主幂等协调；任何 DB Fence 方案都无法撤销已经发生的外部副作用。
- SQLite 租约使用数据库墙上时间，若宿主时钟大幅跳跃仍有提早/延后过期风险；此外 `node:sqlite` 同步 DB 操作会阻塞 Node 事件循环。
- 取消依然是 cooperative，而不是 OS 硬中断。未决 Turn 不自动恢复/重放。

## 下一步

1. Tool Intent/Prepared/Started/Result/Outcome Unknown 的 Schema + 事务写入，建立不盲目重试的恢复查看 API；
2. 可信 Tool Host 进程隔离、强制校验 Fencing Token/租户授权和最小 OS 权限；
3. 续租心跳 watchdog 与进程级故障注入、进程停止前 drain、迁移/备份/TTL 监控；
4. 在上述边界验证完成之后才考虑真实 Provider 与高风险工具的分级开放。

参考：[租约和 Fencing Token](13-M1-Writer-Lease-与-Fencing-Token.md)、[SQLite WAL](12-M1-SQLite-WAL-事件日志.md)、[会话恢复边界](11-M1-会话重开与恢复边界.md)、[ADR 0003](adr/0003-远程控制事件确认与执行收据.md)。
