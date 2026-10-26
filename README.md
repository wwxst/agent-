> **M2 第二批阶段记录**：实现事务型 Turn 接受与 Tool Intent / Local Receipt；**95/95 离线测试通过**。详见 [M2 第二批记录](M2-INTENT-RECEIPT-2026-10-26.md)。这不是 OS ToolHost 安全认证。

# Agent Kernel — M1 开发快照（69 项测试）

自研 TypeScript Agent Kernel。OpenAI 兼容 SSE、Anthropic Messages SSE、Step ToolSet 快照、Steering、Provider Usage/Token 预算、Context Checkpoint 与安全的 Session 重新挂载。

测试：Node.js 22+，执行 `npm install && npm run check && npm test`。离线通过 69 项测试；无实际付费 API 联调，未验证真实 OS 沙箱或磁盘断电恢复。

M1 安全恢复：`resumeSession(id)` 只重新挂载全部 Turn 已终止的 EventStore；不自动重试未确认 ToolCall；异常与未配对结果返回显式错误。MemoryEventStore 只支持进程内对象重用。详细见 m1/README.md。

正式 GitHub 分支：feat/kernel-m1-provider-stream。`main` 保持 M0，PR #2 仍处于 Draft。
