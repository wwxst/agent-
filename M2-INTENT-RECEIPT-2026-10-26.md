# M2 第二批：事务化执行入场、Tool Intent 和本地执行观测

> 2026-10-26；分支 `feat/kernel-m2-sqlite-journal`。**仅验证内核的可信写入顺序与进程内只读工具观察；没有独立 OS Tool Host，不涉及危险 Shell，也不能据此宣称 exactly-once 外部副作用。**

## 本轮已经实现

1. `AgentKernel.runTurn(sessionId, text, turnId, commandId)` 在 `SQLiteEventStore` 下使用 `acceptCommand` 将 `command.accepted`、`turn.queued`、`user.message`、`turn.started` 写入**同一 SQLite WAL 事务**。若事务失败，Provider 不会启动；旧命令重放不赋予第二次执行权限。
2. 执行前由 Tool Scheduler 做同步 Preflight：未知工具、参数错误、有副作用工具继续被 **fail-closed** 拒绝。
3. 对合法的可信只读 ToolCall，在执行 Body **之前**事务提交 `tool.intent` 事件及 `tool_intents` 表记录，字段包括 `sessionId/turnId/callId/toolName/toolVersion/argsHash`，并确认该调用存在于已经提交的 assistant message 中。
4. Body 执行结束后，事务提交 `tool.local_receipt` 及对应记录（结果成功/失败/未知），此后才把 `tool.result` 回填给模型。**`tool.local_receipt` 是进程内执行器观察结果，不是签名的 OS Host Receipt。**
5. Intent 插入失败，工具 Body 不开始；执行成功但 Receipt 写入失败，不向模型反馈成功，未确认 Intent 留在数据库中供后续协调。
6. 并行 ToolCall 出现其中一个执行日志写入失败时，Batch Scheduler 使用 `Promise.allSettled` 等待**所有已经启动的 Body**结束后才让 Turn 失败，避免在仍有工具执行时误判任务终结。
7. 显式恢复 API `listToolIntents`、`markUnconfirmedToolsUnknown`：把未收到本地 Receipt 的 Intent 原子标为 `outcome_unknown`，并写 `tool.outcome_unknown` 事件。`markUnconfirmedToolsUnknown` 重复调用幂等；**不会重执行工具，不会伪造已观察到的 Host Receipt。**
8. 原有 `resumeSession` 对未结束 Turn 或未匹配 ToolCall 仍返回 `SESSION_RECOVERY_REQUIRED`；即使 Intent 已标记 Unknown，也不会自动继续该 Turn。

## 离线实际验证

```bash
npm run check
npm test
```

- 基线 85 项 + 新增 10 项 = **95/95 项通过**。
- 新增覆盖：Turn 接受的原子性、参数不一致命令重放、Intent 必须先于执行、Intent 写入失败工具不执行、Receipt 写入失败后不报告成功、跨进程 SQLite 重开后协调 Unknown、伪造/重复 ToolCall 拒绝、两个数据库连接竞争、并行任务收敛、子进程 Intent 提交后 SIGKILL、Unknown 协调失败的事务回滚。
- `SIGKILL` 是**进程崩溃模拟**；没有断电模拟，也不代表磁盘设备保证。

## 安全边界与已知不足

- `tool.local_receipt` **不具备可信 Host 身份、执行签名、OS 级资源权限或租约 fencing**。它由可信的 in-process read-only ToolDefinition.observe 创建，不能对外开放给不可信插件。此字段刻意不命名为远程 `host_receipt`。
- `markUnconfirmedToolsUnknown()` 是管理员/恢复协调入口，目前没有 Worker Epoch fencing；只应在确认原 Tool Worker 已停止后调用，否则仍可能与正在执行的 Body 竞争。后续必须引入 ToolHost 租约/围栏和真正的 Host ACK。
- SQLite 单进程或跨连接命令 CAS 不代表外部 API 请求和 SQL 事务之间存在原子性。`OutcomeUnknown` 必须保留可能已经发生副作用的事实。
- 仍然没有生产审批、受限 Shell/文件写入、外部可认证 Receipt、Snapshot 的可靠重放、跨主机幂等协调、实际电源故障验证。
- TypeScript/`node:sqlite`（Node 22）的兼容性、运行模式和实验性 API 还需评审。

## 下一阶段

将已验证的 **Intent/Result 双阶段事件**作为真正独立 `Tool Host` 进程间协议的基础；先实现 `ToolHostIdentity`、`HostEpoch`、不可由工具修改的审批绑定、取消/超时与可查询 Receipt，再考虑开启受控文件/网络/命令工具。与此并行开发 SQLite 真实恢复协调器，不能靠 `resumeSession` 自动重放危险动作。
