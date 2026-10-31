> **归档提示（2026-10-31）：本仓库已清除全部源码、测试、构建和 CI，仅保留 Markdown 文档。以下内容包含源码仍存在时的历史实现、验证与路线记录；提及的代码路径及测试命令在当前分支不可直接运行。**

# Agent Kernel — M0 自主内核基础

> **状态：M0 可运行原型，不是生产就绪版本。** 采用完整内核的接口方向，分阶段实现。既不包装 Pi/Codex/Claude Code/DeepSeek Harness，也不执行用户 Shell 或其他高风险工具。

## 先验验证

- 仓库当前要求 Node.js >=22.16.0（因新增的 M1 SQLite 模块）；TypeScript 5.x；运行前安装开发依赖：`npm install`。
- `npm run check`：严格 TypeScript 类型检查。
- `npm test`：编译 + Node 内建测试运行器的确定性测试。

## 当前具备

- `packages/contracts`：模型消息、规范化 Provider Event、ToolCall/ToolResult、事件和存储接口。
- `packages/kernel-core`：单会话单活跃 Turn、多 Step Loop，带最大步数/工具次数上限，拒绝截断工具调用，支持明确取消和失败终态。
- `packages/model-providers`：完全离线的 `FakeProvider`；没有真实模型网络调用。
- `packages/tool-scheduler`：严格按原顺序 Preflight，模型参数检查，拒绝非只读工具，安全只读并行/独占屏障/模型调用顺序回填。
- `packages/event-store-memory`：比较序列号追加与事件重放，进程内存储，**不具备断电持久性**。
- `tests`：文本响应、工具回填、非法参数、拒绝写入、截断/缺少完成事件、重复 ToolCall、并发屏障、事件冲突、预算、同会话互斥、取消竞态及日志失败。

## 内核边界

1. Provider **只提议**工具调用；Provider 的流式文本绝不直接执行工具。
2. 所有工具在 M0 中必须标记为 `risk: 'read'`，而且需要经可信注册；高风险写/外部副作用直接拒绝。**M0 的 ToolDefinition.execute 是受信任的测试接口，不是隔离进程或沙箱。切勿注册不受信任代码。**
3. Token delta 是临时 UI 信号；终态通过 EventStore 的规范事件回放。
4. 一次 User Turn 可以包含多个 Model Step；每个完整 ToolCall 按 ID 回填。
5. 取消是尽力终止 Provider 和当前工具；如果实际工具已经有副作用，不能从本模块的 Cancel 认定其已撤销。M0 不开放有副作用工具。

## 明确没有实现

本节仅对应历史 M0 阶段。M0 时尚无 SQLite 事务 Event Journal；后续 M1 增量已另行实现会话安全重开和 SQLite WAL 接口（详见 [M1 SQLite 文档](../docs/12-M1-SQLite-WAL-事件日志.md)），但**跨进程锁、Tool Intent/Receipt、持久故障自动恢复仍未实现**。真实模型、隔离 Tool Host / 沙箱、审批凭据、上下文压缩、Subagent、MCP/Skills、Desktop/Web API 和流控/重试同样尚未完成。

研究依据：[四内核对照](https://github.com/wwxst/agent-/tree/main/docs/research/comparative)，[ADR 0005](https://github.com/wwxst/agent-/blob/main/docs/adr/0005-首版自主内核技术基线与取舍.md)。
