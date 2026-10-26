# M2 第三批：Intent / Receipt 与 Session 恢复的一致性

> 2026-10-26；`feat/kernel-m2-sqlite-journal`。本阶段只运行可信、进程内、标记为 `risk:'read'` 的测试工具。**不是生产级 Tool Host 安全或跨外部服务事务认证。**

## 发现并修复的问题

M2 第二批已在 `runTurn` 中按顺序执行：

```text
acceptCommand + turn.queued/user.message/turn.started (一笔 SQLite 事务)
  -> assistant.message 已提交
  -> tool.intent (单独事务，先于工具 Body)
  -> trusted read-only ToolDefinition.execute(...)
  -> tool.local_receipt (单独事务)
  -> tool.result (模型可见)
  -> turn.completed / failed / cancelled
```

但原恢复逻辑 `resumeSession()` 仅匹配 Assistant ToolCall 与 `tool.result`。如果在 Intent 提交后发生取消，调度器可能生成合成 `tool.result:outcome_unknown`，而 SQLite `tool_intents.status` 仍为 `pending`。恢复逻辑可能误以为工具结果已经完整结清。

### 修复后的准入

1. 恢复时除检查日志中的 Session/Turn/ToolCall 与 Context Checkpoint 外，额外调用 `DurableExecutionStore.listToolIntents(sessionId)`。
2. 任意 Intent 状态 `pending` 或 `outcome_unknown` → `SESSION_RECOVERY_REQUIRED`，不重新执行、不自动标记成功。
3. 状态为 `settled` 的 Intent，必须找到匹配的 `tool.local_receipt` 事件；收据 ID、Turn ID、结果与 SQL 行一致，否则日志为 `CORRUPT_SESSION_JOURNAL`。
4. 当测试级 Local Receipt 本身报告 `outcome_unknown`，持久表写入的状态仍为 `outcome_unknown` 而不是 `settled`；旧数据即使状态误标 `settled`，恢复也复核 `outcome`。
5. `markUnconfirmedToolsUnknown` 可以在已终结的 Turn 后补写 `tool.outcome_unknown` 审计事件，恢复验证器识别该事件，但仍拒绝将未知副作用当成普通已完成会话。
6. 已结清的、收据匹配的只读工具会话仍可正常恢复并继续新的 Turn。

### 新增测试场景

`tests/m2-resume-intent-consistency.test.ts`：

- 看起来配对完整的 `tool.result:outcome_unknown` **不能掩盖 pending Intent**。
- 显式 `markUnconfirmedToolsUnknown` 后，仍不能自动恢复。
- SQLite 已结清的成功 Local Receipt 可以支撑已终止 Session 安全重新挂载。
- 磁盘中 `tool.local_receipt` 事件与 SQL Intent 收据 ID 不一致，恢复拒绝。
- 即使已写入 Local Receipt，只要结果是 `outcome_unknown`，恢复仍拒绝。

全量包括 M1 69、M2 第一批 16、M2 第二批 10、本批新增 5，共计 **100 个测试用例**。本轮 GitHub Actions Node 22.16.0 CI 的 `npm run check` 与 `npm test` 运行成功，见 [CI run](https://github.com/wwxst/agent-/actions/runs/40328962997)。

## 当前可靠性边界

- `Local Receipt` 仅证明当前进程内**可信测试工具**的执行返回，**不是受身份认证的独立 Host Receipt**。
- 已实现 SQLite 命令入场 / 工具意图与结果分步持久提交，但**数据库与任何外部副作用不能无条件实现 exactly-once 原子提交**。
- 当前 Unknown 只阻断自动恢复；还**没有**人工确认、可信 Host 查询、幂等外部协调或重放修复 UI。
- `SQLiteEventStore` 依赖 Node 22 实验性 `node:sqlite`，本地和 GitHub CI 验证不能替代真实断电/文件系统故障。
- Pending/Unknown Intents 应当是运维可见的事实，不允许由普通插件或模型输出清除；后续安全根必须增加多进程 Actor/Worker Fencing 和可信工具身份。

## 下一步（M2）

1. 拆出 **独立 Tool Host 协议/进程**，为请求定义 `callId, argsHash, toolVersion, policyVersion, isolationProfile, hostEpoch`。
2. 在可信 PolicyRoot/ApprovalRoot 里核验路径、用户授权与沙箱可用性；不能从模型文本、插件 Hook 或 UI 直接获得特权。
3. Host 产生可认证/防重放执行收据；建立明确的 `outcome_unknown -> inspected/confirmed` 人工和自动协调流程。
4. SQLite 存储隔离到 Worker 并配置数据库迁移、背压、故障恢复；对外 API 只在命令事务成功之后返回 Accepted。
