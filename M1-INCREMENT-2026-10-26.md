# M1 第二阶段：Anthropic Messages + Context 入场预算

2026-10-26 · 分支 `feat/kernel-m1-provider-stream`。**离线协议测试，不是 Anthropic/OpenAI 真实 API 联调或生产安全认证**。

## 此次新增

- `packages/model-providers/src/anthropic-messages.ts`: 原生 Anthropic Messages `/v1/messages` SSE。使用 `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop` 校验结束；支持 `text_delta` 与 `tool_use/input_json_delta`，完结后才交给 Kernel。
- `packages/context-engine/src/index.ts`: 确定性 `maxSerializedCharacters` 请求前限额，包含消息历史和 Model Step 的工具 Schema。**仅是字符预算，不是 tokenizer、上下文自动压缩或 API token 使用量账本。** 超限时模型网络请求次数为 0，日志记录失败。
- `apps/cli/src/main.ts`: `AGENT_PROVIDER=anthropic` 或 `openai-compatible`，`AGENT_MAX_OUTPUT_TOKENS`、`AGENT_MAX_CONTEXT_CHARS` 可配置，不内嵌凭据。
- `tests/m1-anthropic-context.test.ts`: 分片 UTF-8、工具 JSON、历史映射、未知块拒绝、长度截断、断流、重复工具 ID、HTTP 失败脱敏、Context 限额及配置等离线测试。

## 验证

```
npm install
npm run check
npm test
```

截至本次构建：TypeScript strict 检查通过，**45/45 离线测试通过**（此前 31 项 + 新增 14 项）。真实服务端未联调，未提交真实 API key。

启动 Anthropic 示例（需要用户自己合法配置凭据及网络；这里未运行）：

```
AGENT_PROVIDER=anthropic AGENT_API_KEY="$ANTHROPIC_API_KEY" AGENT_MODEL="<your-anthropic-model>" npm run cli -- "你好"
```

OpenAI 兼容模式仍是默认值：

```
AGENT_API_KEY="$OPENAI_API_KEY" AGENT_MODEL="<your-chat-completion-model>" npm run cli -- "你好"
```

## 明确的功能边界

- Anthropic 仅覆盖基础 text/tool_use，**不处理 thinking/signature、server_tool_use、多模态 block、Prompt Caching、自定义 Beta 功能**。收到未知块会拒绝而非丢弃后继续执行工具。
- OpenAI 兼容模式为 Chat Completions SSE，不等于支持 Responses API。
- Provider 错误/断流不重试已经开始的工具；本阶段不实现模型重试策略，避免重复收费及重复 Side Effect。
- 内核 ModelFacing ToolResult 与 HostReceipt 尚未分离为生产事务模型；M0/M1 只允许受信任的只读工具。
- `MemoryEventStore` 不支持断电恢复；`maxContextCharacters` 也不保证真实 Token 上限。Context 压缩/Token Budget 与 Provider Usage 规范化将在后续阶段实现。
- 不实现沙箱、写工具、真实后台 Subagent、MCP/Skills；权限根和持久收据属于 M2/M3。

## 参考协议

Anthropic 当前 Messages SSE 事件说明：https://platform.claude.com/docs/en/build-with-claude/streaming
Anthropic Messages API：https://platform.claude.com/docs/en/api/messages/create
