# 13 · M1 SQLite Writer Lease 与 Fencing Token

> 状态：**租约基础模块与事务内事件写入校验已实现；后续已新增按单次操作自动抢占/续租/释放的 ManagedSessionRunner**。跨进程 Tool Host 强制安全边界与完整恢复仍未完成。本阶段仍仅允许可信只读工具；不要因为看见 `lease` 字样就开放 Shell/写工具/外部网络副作用。

## 一、代码和 API

- `packages/session-leases-sqlite/src/index.ts`：`SqliteWriterLeaseStore`。
- `packages/event-store-sqlite/src/index.ts`：`new SqliteEventStore(path, writerLease?)` 在提供 `WriterLease` 时对每次 `append` 执行事务内校验。
- `tests/writer-leases.test.ts`：多连接互斥、过期、释放、续约、重启、SIGKILL 和 fenced append 拒绝验证。

`WriterLease`：

```ts
interface WriterLease {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly fenceToken: number;
  readonly expiresAtMs: number;
}
```

`SqliteWriterLeaseStore`：

- `acquire(sessionId, ownerId, ttlMs): WriterLease | null`：抢占同一 Session 的写者租约，持有中返回 `null`；
- `renew(lease, ttlMs): WriterLease`：持有期内续约，丢失/过期抛 `LEASE_LOST`；
- `assertOwned(lease): void`：状态观察，不具有随后执行的原子保证；
- `release(lease): boolean`：有效持有者释放返回 true，旧 token 或重复释放返回 false；
- `close(): void`：关闭 SQLite 连接。

`ttlMs` 有效范围为 1–86,400,000ms。调用方应为每个独立执行者分配唯一 `ownerId`；`ownerId` 不是认证或密钥，安全性依赖数据库权限和可信运行进程。

## 二、状态及事务不变量

```text
acquire:
  BEGIN IMMEDIATE
    当前仍有效 -> Busy, 不授予任何新 token
    不存在 -> fenceToken = 1
    已释放/过期 -> fenceToken = old + 1
    owner_id / fence_token / expires_at_ms 一起提交
  COMMIT

renew / release:
  BEGIN IMMEDIATE
    检查 sessionId + ownerId + fenceToken + expiry > DB now
    条件不满足 -> 不修改
  COMMIT
```

- **Token 只增不减**：即使 ownerId 完全相同，过期或释放后重新获取也会递增；不得在重启时重置计数器。
- **旧持有者不能续命**：过期后即使尚无继任者，也不允许 `renew()` 恢复原 token。
- **独立数据库连接互斥**：两个 SQLite 连接对同一共享数据库文件竞争 `BEGIN IMMEDIATE`。
- **单一数据库时间源**：租约过期采用 SQLite 的毫秒墙上时间，不依赖调用者传入的系统时间戳；若 OS 时钟大幅跳变，租约仍可能出现提前/延后过期，生产环境需专门处理。
- **Fenced append**：事件日志连接绑定 `WriterLease` 后，在一次 `BEGIN IMMEDIATE` 中检查 token 与到期时间，然后检查 seq CAS、插入事件并提交。这样**已被接管的旧持有者即使知道最新 seq，也不能用该带租约的 EventStore 继续写事件**。

## 三、示例：显式绑定租约

```ts
const leases = new SqliteWriterLeaseStore('./agent.sqlite');
const claim = leases.acquire('session-1', 'unique-worker-instance-id', 5000);
if (!claim) throw new Error('SESSION_BUSY');
const events = new SqliteEventStore('./agent.sqlite', claim);
try {
  // 会话存在时使用 openSession；首次创建用 createSession。
  const kernel = new AgentKernel(events, provider, trustedReadOnlyTools);
  await kernel.openSession('session-1');
  // 若任务可能超过 TTL，必须由可信协调层定时 renew(claim, 5000)；
  // renew 丢失应停止接受新任务，并中止本地未完成工作。
  await kernel.runTurn('session-1', '继续');
} finally {
  // 仅可释放当前有效 claim；旧 token 释放不会影响新拥有者。
  leases.release(claim);
  events.close();
  leases.close();
}
```

上例是底层手动组合；后续已提供 [ManagedSessionRunner](14-M1-ManagedSessionRunner-自动租约与中断.md) 进行按操作的自动续租及结束释放。**若手动组合而不续租，超过 TTL 后 EventStore 将拒绝写入**。对模型或工具执行中的副作用仅靠数据库写入栅栏不足以撤销。

## 四、兼容性与防绕过边界

- `new SqliteEventStore(path)` **仍保持旧的非 fenced 模式**，方便 M0/M1 测试与迁移。它不会自动检查租约，不能作为多进程安全执行存储。要实现全局强制执行，还须由可信 Kernel Factory 限定只能使用带租约连接，并对数据库写入入口封装授权。
- `assertOwned()` 是时点观察；工具在检查后仍可能跨越租约超时点。Tool Host 最终需要独立持久验证 `fenceToken`，并对非幂等执行加 Intent/Receipt。
- `AgentKernel` 本身不负责持久租约，而可信 `ManagedSessionRunner` 已实现每次操作的 acquire/renew/fence/release；此实现仍不具备独立 Tool Host 的强制 Fencing，不能宣称完整跨进程副作用互斥。
- 本实现使用同步 `node:sqlite`，可能阻塞 Node 事件循环。没有提供长期续约 Worker、进程间心跳监控、失联补偿。
- 共享数据库文件要有安全访问控制；恶意代码持有原始 SQLite 写权限仍能绕过应用层约束。不应将它宣称为 OS 安全边界或鉴权系统。
- 不提供自动重跑未决 Turn，不提供 exactly-once；`RECOVERY_REQUIRED` 语义继续有效。

## 五、验证与剩余工作

新增测试覆盖：两个 SQLite 连接同时竞争、过期接管、同 owner 重新获得新 token、续约失效、迟到释放不影响继任者、SIGKILL 后过期接管、fenced append 阻止旧持有者用最新游标写入、过期而尚未接管时拒绝写入、新 Kernel 用新 token 重开已结束会话，以及 Provider 延迟导致租约失效时拒绝工具执行、保留未完成 Turn 并要求恢复。CI 运行 Node 22.16.0 与 Node 22.x，测试结果以对应 GitHub Actions 为准。

下一阶段优先：

1. 扩展已实现的 ManagedSessionRunner：完善跨进程 watchdog、故障注入与长时任务控制；
2. 把 event append 与 Tool Intent 持久化语义组合，Host 执行前独立校验 fence token；
3. 故障注入：在真正跨进程竞争、续约丢失和主进程 crash 时保证拒绝而非双执行；
4. 升级 SQLite 数据迁移、审计和隔离，再开放更多工具能力。

参见：[M1 会话重开](11-M1-会话重开与恢复边界.md)、[M1 SQLite WAL](12-M1-SQLite-WAL-事件日志.md)、[ADR 0003](adr/0003-远程控制事件确认与执行收据.md)、[ADR 0005](adr/0005-首版自主内核技术基线与取舍.md)。
