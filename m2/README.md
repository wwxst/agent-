> **2026-10-26 第三批更新（CI 已通过）**：恢复阶段同时核对 Event Journal、Tool Intent 和 Local Receipt。拒绝 pending/outcome_unknown 工具，即使模型侧已有配对的 tool.result；为未知结果保留状态而不自动重新执行。增加 GitHub Actions 自动执行 TypeScript 与全部测试。本阶段累计 100 项测试（M1 69 + M2 首批 16 + Tool Intent 10 + 恢复一致性 5），CI 运行见 [Kernel checks](https://github.com/wwxst/agent-/actions/runs/40328962997)。详见 [第三批安全审计](../M2-RECOVERY-INTEGRITY-2026-10-26.md)。

> **2026-10-26 第二批更新**：`runTurn` 的 Turn 接受已和 SQLite Command Journal 同事务；新增 Tool Intent / Local Receipt / OutcomeUnknown 协调与 10 项故障测试。**95/95 项通过**。具体边界见 [M2 第二批](../M2-INTENT-RECEIPT-2026-10-26.md)。

# M2 第一批：SQLite Event Journal 与事务型命令接受

> 状态：开发原型，可运行和测试；不是生产级 Tool Host 或端到端 exactly-once 系统。

本阶段实现 `packages/event-store-sqlite/src/index.ts` 的 `SQLiteEventStore`，直接符合已有的 `EventStore` 接口，并额外提供 `acceptCommand`。

## 运行环境与验证

需要 **Node.js 22.5+**（`node:sqlite` 当前为实验性 API），TypeScript 5.x；开发环境建议 Node.js 22.16.0 或较新版本。

```bash
npm install
npm run check
npm test
```

`npm test` 使用真正的临时 SQLite 数据库（非 Mock），包括 SQL Trigger 故障注入、两个独立连接写冲突、进程在命令提交 ACK 后被 SIGKILL 并重新打开数据库。Windows 环境会跳过 POSIX SIGKILL 用例。当前完整回归 **85 项（M1 69 + M2 16）**，实际运行记录见研究笔记。

## 最小接入

```ts
import { SQLiteEventStore } from './packages/event-store-sqlite/src/index.js';
import { AgentKernel } from './packages/kernel-core/src/index.js';
import { FakeProvider } from './packages/model-providers/src/fake.js';
import { ToolRegistry } from './packages/tool-scheduler/src/index.js';

const store = new SQLiteEventStore('./runtime/events.db');
const kernel = new AgentKernel(store, new FakeProvider([]), new ToolRegistry());
const session = await kernel.createSession();
// 下次用新的进程、新的 SQLiteEventStore 连接及 AgentKernel 调用 resumeSession(session)
store.close();
```

事务型命令入场：**当前已接入 AgentKernel.runTurn 的 SQLite 路径**，但还没有完整 HTTP 客户端接入。底层 Store API 示例：

```ts
const current = await store.read(session);
const ack = await store.acceptCommand(session, current.length, 'unique-request-id',
  'turn.start', { text: 'Hello' }, [{ type: 'user.message', data: { text: 'Hello' } }]);
// ack.replayed === true 表示相同命令此前已提交，不会重复追加。
```

上例仅展示 Store 层命令写入；Kernel 会在 `runTurn(sessionId, text, turnId, commandId)` 中调用 `acceptCommand` 并与 `turn.queued/user.message/turn.started` 同事务写入。相同 Command ID 的重放被拒绝再次执行模型，不会把重复命令当成新的授权。调用方不要在事件载荷中存储 API Key、凭据或不必要的敏感信息。

## 可证明的边界

- 在同一事务里 CAS `sessions.last_seq`、追加 `events`，并可写入 `commands` 去重记录；违反任何写约束即回滚整批写入。
- 同一 Session 的相同 `commandId + kind + payload` 可以跨连接重试并返回原始 ACK；同 ID 改内容拒绝。
- WAL + `synchronous=FULL`：这是 SQLite 在受支持平台上的写入配置，不是本项目已经在真实掉电/失效磁盘环境下通过验证的保证。
- `read()` 保留原始消息及序号，`AgentKernel.resumeSession()` 只恢复终态完整、事件一致的会话；未完成 ToolCall 仍 fail-closed。
- 事件 JSON 严格限 1MiB，禁止不能安全 JSON 序列化的字段；本实现不提供日志加密、访问控制或恶意篡改防护。

## 没有实现的部分

- `AgentKernel.runTurn()` 已在 SQLite 路径连接事务型 `acceptCommand`，但客户端级 requestId 传输、跨进程活跃 Turn 租约与完整重连协议尚未实现。
- 已实现 Tool Intent 与 **本进程可信只读工具的测试级 Local Receipt**；**真实独立 OS Tool Host、签名审批、外部执行回执验证及 Worker Epoch 尚未实现**。不可将 Local Receipt 称为已验证的外部 Host Receipt。
- SQLite `DatabaseSync` 会阻塞 Node 事件循环，不建议直接作为高吞吐 Web 服务器的最终模式；后续应放在专用 Worker/进程里。
- 只测试子进程 SIGKILL 后重新读取，未做真实断电、目录 fsync、NFS 或存储损坏压力验证。
- 因 Node 22 `node:sqlite` 仍实验性，生产路线须评估接口变化及长期维护。
