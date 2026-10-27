# 15 · M1 Tool Intent / Receipt：持久审计与结果未知判定

> 交付状态：**已有 Kernel + Tool Scheduler + SQLite/EventStore 的执行前 Intent、执行后 Receipt 与只读审计功能**。本阶段仅支持可信只读工具，**不是外部副作用 exactly-once 协议，不具备自动恢复协调器或独立 Tool Host**。

## 1. 运行时合同

新增两种 Kernel Event 类型：

- `tool.intent`：助手完整 `assistant.message`（包含 ToolCall 参数）**成功持久化后**、任何工具 `execute` 之前，为批次内**全部工具调用**持久化记录 `{ callId, name, step }`。
- `tool.receipt`：每项工具处理结果分别持久化 `ToolResult`，同时在**相同 EventStore.append 事务批次**写入上下文专用 `tool.result`。包括被预检拒绝的调用，均产生明确的 `denied/failed` Receipt。两个事件只有顺序相邻与同批次的事务性，没有跨数据库/进程事务。

执行顺序：

```text
assistant.message (保存完整 ToolCall)
    |
    +-- tool.intent(call1), tool.intent(call2), ...  一次持久化批次
    |       |
    |       +-- Tool Registry preflight
    |       +-- Kernel lease guard -> tool.execute (仅可信只读)
    |               |
    |               +-- tool.receipt(call1) + tool.result(call1) 原子提交
    |               +-- tool.receipt(call2) + tool.result(call2) 原子提交
    |               +-- ...（独立提交，允许并行完成）
    |
    +-- 若有 outcome_unknown / 未决写入 / 丢失租约：禁止继续 Model Step
    +-- 所有调用已明确收据：可进入下一 Model Step
```

两阶段都通过已有 `record()` 的会话序列化/CAS。SQLite fenced adapter 对每一次事件 `append` 在同一 `BEGIN IMMEDIATE` 检查有效 Fencing Token；非 fenced 的旧 EventStore 仍仅适用于可信单进程兼容模式。

**安全性质**：没有 Intent 持久确认不能执行工具；每个 Receipt 一旦成功写入对应 Result，新的 Model Step 才能使用它。收据提交失败、提交已发生但确认丢失、工具执行中进程中止都不会被推断为“未执行”。

## 2. 审计接口

新增纯函数：

```ts
import { inspectToolAudit } from './packages/tool-audit/src/index.js';

const store = new SqliteEventStore('./agent.sqlite'); // 仅做持久日志读取
try {
  const events = await store.read('session-id'); // 无需先 openSession
  const entries = inspectToolAudit(events);
  // [{turnId, callId, name, intentSeq, receiptSeq?, outcome, needsReconciliation}]
} finally {
  store.close();
}
```

这允许在 `AgentKernel.openSession()` 因故障 Turn 返回 `RECOVERY_REQUIRED` 时，直接对原始事件做**只读**审计，不会调用任何工具。审计 API 自身不包含租户认证，网络暴露前必须由可信入口校验鉴权。

审计结果：

| 事件情况 | `outcome` | `needsReconciliation` | 安全操作 |
| --- | --- | --- | --- |
| Intent + 已确认成功 Receipt | `succeeded` | false | 仅作事实记录，不再次执行 |
| Intent + 明确失败 Receipt | `failed` | false | 根据业务决策处理 |
| Intent + 被拒绝 Receipt | `denied` | false | 不执行，不自动升权 |
| Intent + Receipt 为 outcome_unknown | `outcome_unknown` | true | 必须人工/可信宿主对账 |
| Intent 存在但 Receipt 缺失 | `outcome_unknown` | true | **不能判断是否执行，禁止盲目重试** |
| 重复 Intent、孤儿 Receipt、Receipt/Result 身份或内容不一致 | `CORRUPT_EVENT_LOG` | — | 拒绝重开，检查损坏 |

旧版 M0/M1 历史事件没有 `tool.intent`，继续可读；不会将历史无 Intent 的 `tool.result` 强行解释为新格式的收据。

## 3. 与 Kernel 恢复行为的关系

- `AgentKernel.openSession()` 原有完整流校验依旧存在；现在额外运行 `inspectToolAudit(events)`。**未结束 Turn 或存在任何需要对账的条目时抛 `RECOVERY_REQUIRED`**。
- Tool Scheduler 的可选结果回调在每个工具完成时被 await：每条已完成结果尽快单独落库，而不是等一批并发调用全部结束后才保存。
- 收据写入失败、可能已经提交却没有 ACK、预备阶段存储不确定，都使正在运行的 Turn 保持未决状态，并向调用方抛出 `TOOL_OUTCOME_UNKNOWN`。不伪造 `turn.failed` / `turn.cancelled` 以抹平未知结果。
- 明确记录 `outcome_unknown` 的 Receipt 也不允许后续 Step 继续运行，不允许以普通 `failed` 状态掩盖。
- 任何 `LEASE_LOST` 依旧优先走 Writer Lease fail-closed 中断。租约丢失后的 stale owner 不能写入工具结果；审计可能因此看到没有 Receipt 的 Intent。
- 事件流可能保留部分已有 Receipt 与一些未决 Intent；每一项单独判断，不因为批次的其它调用成功就宣称其成功。
- 本阶段**没有**自动处理未决 Turn 的恢复入口。审计结果仅用于人工对账或后续可信 Coordinator 实现；不自动追加“已完成”或重新提交模型调用。

## 4. 测试与证据

`tests/tool-audit.test.ts` 新增场景：

1. 工具执行前观察到已持久化 Intent；工具结束持久化 Receipt/Result 且结果进入下一次 Provider 上下文。
2. 无副作用权限的高风险工具不执行且产生明确拒绝收据。
3. Intent 已提交但 DB ACK 丢失时，不启动工具，不写虚假终态；重启时只能得到结果未知。
4. 工具实际执行成功但 Receipt 写入失败时，保持未决，不自动重跑。
5. 显式 `outcome_unknown` Receipt 即使 Turn 被标记终结也阻止重开。
6. 重复/孤儿/身份不匹配的审计事件直接报损坏。
7. SQLite ManagedSessionRunner 正常保存 Receipt，连接关闭后重开日志可读取。
8. 旧版仅有 `tool.result` 的已完成会话仍可以重开。
9. **子进程在持久化 Intent 之后 SIGKILL**，父进程重新读取 SQLite，将未决调用判定为未知并阻止重放。
10. 即使存在伪造 `turn.failed`，也不能掩盖缺失的 Receipt。
11. 收据与上下文 Result 内容不一致时拒绝。
12. 已开始的工具在用户取消时返回明确的 `outcome_unknown` Receipt，不伪造终结状态。
13. 并行工具中一项先完成就先持久提交自己的 Receipt，无需等待其它调用。

对应 GitHub Actions 运行 Node **22.16.0 和 22.x**，执行 `npm run check` 和 `npm test`，累计 55 项。测试通过情况以 GitHub Actions 记录为准。

## 5. 与完整执行收据协议的距离

现在实现的是**可信只读工具的持久审计与保守恢复判定**，不是完整 Tool Host Receipt：

- 没有 Host-issued execution ID / 开始执行时间 / 独立系统审计签名 / 执行沙箱证明。
- 工具仍在 Kernel 所在进程内运行，未提供 OS 沙箱、用户权限隔离与审批。
- 当前无 Host 级持久幂等表；执行前检查和真正执行之间仍可能发生租约过期。
- 本地 SQLite WAL + 单连接工具回调不等于跨独立工具进程的原子提交或 exactly-once。
- `tool.intent` 引用已持久化 `assistant.message` 的参数，EventStore 中可能包含敏感内容；未来需要权限、加密/脱敏策略。
- 需引入可信恢复协调器，定义 `Started`、`Receipt`、`Outcome Unknown` 与人工对账/不可重试策略，不能依靠 `turn.failed` 作为自动重跑许可。

下一步优先**独立 Tool Host + Host-side Fencing Token 校验 + 持久幂等/执行状态台账**，仍按只读与强制拒绝危险工具的安全基线逐步演进。

参见：[M1 自动租约](14-M1-ManagedSessionRunner-自动租约与中断.md)、[M1 租约原语](13-M1-Writer-Lease-与-Fencing-Token.md)、[ADR 0003 执行收据](adr/0003-远程控制事件确认与执行收据.md)。
