# 12 · M1 SQLite WAL 事件日志：实现、证据与局限

> **实现状态：增量交付（2026-10-26）**。本文件描述真实代码与测试，不将 SQLite 存储原型误称为生产级完整恢复架构。
>
> 代码：`packages/event-store-sqlite/src/index.ts`；测试：`tests/sqlite-store.test.ts`；依赖 Node.js **>=22.16.0** 内置的实验性 `node:sqlite`。

## 1. 本轮交付

`SqliteEventStore` 实现现有 `EventStore` 接口，提供：

- 文件型 SQLite 数据库，初始化 `PRAGMA journal_mode=WAL`、`PRAGMA synchronous=FULL`；
- `session_id + seq` 唯一的有序事件表，`event_id` 全局唯一；
- 每次 `append(sessionId, expectedSeq, drafts)` 使用 `BEGIN IMMEDIATE` 开启写事务，读当前游标，执行 compare-and-append；
- 任何序列冲突抛 `ConflictError`，不会写入事件；
- 批量编码或插入过程中失败时 `ROLLBACK`，不会留下部分已提交事件；
- `read(sessionId, afterSeq)` 从 SQLite 按序重放；`close()` 关闭连接；
- 对已完成 Turn，结合 `AgentKernel.openSession()` 在新 `AgentKernel` 实例中读取完整事件并继续追加新 Turn；对未结束 Turn 继续 fail closed。

**关键区别**：日志 `append` 提供事务 CAS，不等于同一 Session 的跨进程**独占执行租约**。两个 Kernel 进程可以在工具层同时执行（即使其中一个较晚遭遇存储 CAS 冲突）。未来引入有副作用工具之前必须解决这一点。

## 2. 持久化模型

```text
BEGIN IMMEDIATE
  SELECT COALESCE(MAX(seq), 0)
    FROM kernel_events WHERE session_id = ?
  if last_seq !== expectedSeq -> ROLLBACK + ConflictError
  for each draft:
    INSERT (session_id, seq, event_id, turn_id,
            type, data_json, occurred_at)
COMMIT
```

- 用户内容由 JSON 字符串保存，SQLite 参数绑定处理 `sessionId` 等外部输入。当前不对任意事件数据做体积/深度限制。
- 为避免误读并发语义，`EventStore` 本身不负责编排模型、执行工具、持有租约或处理外部幂等。
- `synchronous=FULL` 提供比 NORMAL 更保守的 WAL 提交同步策略，但不证明所有文件系统、磁盘缓存和断电条件下绝对持久。测试覆盖 **进程 SIGKILL 后重开**，不是物理断电注入。
- 没有任意事件格式迁移，也没有版本化 schema 检验、数据加密、密钥管理、备份、清理策略。

## 3. 使用方法

```ts
import { SqliteEventStore } from './packages/event-store-sqlite/src/index.js';
import { AgentKernel } from './packages/kernel-core/src/index.js';

const store = new SqliteEventStore('./agent-kernel.sqlite');
try {
  const kernel = new AgentKernel(store, provider, trustedTools);
  // 首次：await kernel.createSession('session-id');
  await kernel.openSession('session-id'); // 历史 Turn 必须有终态
  await kernel.runTurn('session-id', '下一条输入');
} finally {
  store.close();
}
```

注意：以上是 API 说明，不是仓库内提供的可直接运行的 CLI；`provider` 与 `trustedTools` 需由调用者构造。M0 目前 **仅允许可信只读工具**。

## 4. 自动化测试

`tests/sqlite-store.test.ts` 的五项测试：

1. 关闭 SQLite 文件连接后重新打开，与新 Kernel 合作安全续写，检验旧事件不变和序号连续。
2. 两个数据库连接对同一 Session 竞争旧游标，验证 CAS 拒绝，同时验证不同 Session 正常写入和游标过滤。
3. 批次第二条包含无法 JSON 编码的 BigInt，验证事务完整回滚。
4. 子进程写入事件并提交后发送 SIGKILL，父进程重新打开 WAL 文件并读取提交的数据。
5. 旧日志存在未完成 Turn 时，关闭/重开 SQLite 后 `openSession` 必须拒绝，不静默重跑工具。

执行命令：`npm install`、`npm run check`、`npm test`。CI 同时验证 Node 22.16.0 和当前 22.x；最终通过情况必须按 GitHub Actions 实际结果判定。

## 5. 故障和安全边界

| 场景 | 当前处理 |
| --- | --- |
| 存储层过期游标 | 同一事务内比较并拒绝；不覆盖事件 |
| 批量序列化/插入错误 | ROLLBACK，不提交半个批次 |
| 进程终止在已提交之后 | 已有 SIGKILL 重开测试 |
| 进程终止在未提交事务期间 | 依赖 SQLite 事务机制；尚无专门故障注入测试 |
| 崩溃时正在执行 Tool | 未实施 Intent/Receipt 协议，禁止有副作用工具，遇未决 Turn 不自动恢复 |
| 多实例运行同一 Session | **尚无执行租约；不要部署成多写者执行服务** |
| WAL 损坏、设备掉电、备份恢复 | 尚无完整演练 |
| 租户鉴权、密钥、数据加密 | 未实现，不能处理受监管生产数据 |

## 6. 下一批实现顺序

1. Session **writer lease + fencing token**（数据库内创建/续约/失效事务协议），保证只有一个执行拥有者；
2. Tool Intent/Receipt/Outcome Unknown 原子日志与恢复检查；
3. SQLite schemaVersion、migration、数据清理/备份机制；
4. 将阻塞的 `DatabaseSync` 存储访问封装为 worker 或换异步实现，验证压力下延迟；
5. 可信独立 Tool Host、权限审批和 OS 隔离，最后才开放写入/外部副作用。

关联：[M1 会话重开](11-M1-会话重开与恢复边界.md)、[事件与持久化](03-事件与持久化.md)、[ADR 0003](adr/0003-远程控制事件确认与执行收据.md)、[ADR 0005](adr/0005-首版自主内核技术基线与取舍.md)。
