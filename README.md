> **M2 第三批阶段记录**：SQLite 事务型 Turn 接受、Tool Intent、Local Receipt 和安全恢复一致性校验已实现。**100 项测试，GitHub Actions 严格检查通过**。详见 [M2 第三批记录](M2-RECOVERY-INTEGRITY-2026-10-26.md)。仍不是生产级 OS ToolHost 或外部 exactly-once 认证。

# Agent Kernel — M2 事务执行与安全恢复开发快照

自研 TypeScript Agent Kernel。OpenAI 兼容 SSE、Anthropic Messages SSE、Step ToolSet 快照、Steering、Provider Usage/Token 预算、Context Checkpoint 与安全的 Session 重新挂载。

测试：Node.js 22.16.0+，执行 `npm install && npm run check && npm test`。M1 69 + M2 31 项离线及真实临时 SQLite 测试；GitHub Actions 已验证 CI 通过。无实际付费 API 联调，未验证 OS 沙箱或磁盘断电恢复。

M1 安全恢复：`resumeSession(id)` 只重新挂载全部 Turn 已终止的 EventStore；不自动重试未确认 ToolCall；异常与未配对结果返回显式错误。MemoryEventStore 只支持进程内对象重用。详细见 m1/README.md。

当前开发分支：`feat/kernel-m2-sqlite-journal`，基于 M1 的 `feat/kernel-m1-provider-stream`。M2 对应 PR #3，M1 对应 PR #2（均未合并）。`main` 保持 M0 已合并的基线。

M2 代码：`packages/event-store-sqlite`、`packages/kernel-core`、`packages/tool-scheduler`；相关测试在 `tests/m2-*.test.ts`。限额、工具、权限及完整设计参见 [M2 说明](m2/README.md)。
