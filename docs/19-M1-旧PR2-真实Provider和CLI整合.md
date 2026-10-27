# 19 · 旧 PR #2 模型适配能力移植到新版 M1 Kernel

> 本文档对应 `feat/m1-provider-adapters-on-current-kernel`。**代码以当前 main 的 Kernel/Writer Lease/Tool Host/Receipt 为准**；旧版的 Model Loop、SQLite/ToolScheduler 实现没有回退合并。真实外部 API、结算费用和生产安全尚未联调或认证。

## 来源、范围与架构取舍

- 参考历史 [PR #2](https://github.com/wwxst/agent-/pull/2)：`packages/model-providers/src/openai-compatible.ts`、`anthropic-messages.ts`、`packages/context-engine` 和离线 SSE 测试。
- 新增 ModelStepRequest（stepId、toolSetVersion、ToolSpec[]）、`usage` ProviderEvent 与 `model.usage` 持久事件。
- `ToolRegistry.snapshot()` 在每个模型步骤**固定可信执行对象**；模型只接收到 `risk=read` 的工具 Schema/description。经过 Model 完整结束、参数校验后仍必须先写 `assistant.message` 与所有 `tool.intent`，后调用独立 Host，再分工具持久化 `tool.receipt` + `tool.result`。
- `AgentKernel` 可选 `maxContextCharacters` 与 `maxTotalTokens`。前者只是 JSON 字符数准入，**不是 tokenizer 或模型上下文保证**；后者只在 Provider 有可信非递减 Usage 快照时生效，否则 `USAGE_UNAVAILABLE` 并拒绝执行 Tools。单步骤的 Usage 快照只记录最新值，不对中间事件重复求和。
- `ManagedSessionRunner` 可转发两项 Budget，保留租约租用、续租和失效停止语义。
- 真正的 `ProcessToolHost` 只实现两个演示只读工具（read.echo/read.sleep），Schema 仅帮助模型生成参数；Host Worker **再次验证**参数和持久 Intent/Fencing，绝不信任模型 Schema 为授权证明。

## Provider 验证范围

### OpenAI-Compatible Chat Completions SSE

SSE 按事件拆分、UTF-8 分片、CRLF/注释、多行 data、Frame 上限；组装分片的函数参数 JSON，检查工具 ID 唯一与完成标记（`[DONE]`、finish_reason），对不完整/截断/无效 JSON **拒绝工具执行**。可选请求 stream_options.include_usage，支持 Usage-only Chunk。仅支持 Chat Completions 兼容结构，不等同 Responses API 或所有兼容厂商扩展。

### Anthropic Messages SSE

处理 message_start、content_block_start/delta/stop、message_delta/stop；支持 text 与 tool_use/input_json_delta，以及用量；无法确认或未知的 thinking/server-tool block **fail closed**。未实现 extended thinking、多模态、缓存 token 成本统计等厂商特性。使用本地假 Fetch 流验证协议，**没有真实 Anthropic 计费 API 调用**。

### 预算与工具透明度

`ToolRegistry` 的只读工具目录在步骤开始时创建执行快照：即使工具在模型响应过程中被新注册，也不能成为当前步骤的可执行工具。此处只是受信本地定义的 ToolSpec，不允许 Provider 修改注册工具、凭 ToolCall 自行提升权限。

`model.started` 存储名称/版本与字符准入元数据；`model.usage` 在 Tool Intent 前落库。超过总额度/无 Usage 时不保存可执行的 Tool Intent。此 Usage 是 Provider 报告的模型 token 数量，不保证跨供应商成本可比，也不包含外部工具/非模型开销。

## CLI（受限示范）

```bash
npm install
npm run check
npm test

# 默认仅文本，不注册任何 ToolDefinition；自动持久化新 Session
AGENT_PROVIDER=openai-compatible AGENT_API_KEY='<key>' \
AGENT_MODEL='<model>' AGENT_DB_PATH='./agent-cli.sqlite' \
npm run cli -- '你好'

# Anthropic Messages
AGENT_PROVIDER=anthropic AGENT_API_KEY='<key>' \
AGENT_MODEL='<model>' AGENT_MAX_OUTPUT_TOKENS=1024 \
npm run cli -- '你好'
```

- CLI 按调用创建新的唯一 Session 和 SQLite 文件事件；通过 Fencing-aware `ManagedSessionRunner` 调用真正 Provider；仅一轮非交互请求，不支持接续指定 Session 或人机审批。
- **CLI 强制 `maxToolCalls=0` 且不注册任何可执行工具**。既不授予模型 Shell、文件写入或网络副作用，也不会把未解决的审计风险掩盖成安全沙箱。
- 可选 `AGENT_API_BASE_URL`、`AGENT_MAX_CONTEXT_CHARS`、`AGENT_MAX_TURN_TOKENS`；地址原则上仅 HTTPS 或 localhost HTTP。生产级密钥托管和 HTTP 代理/隔离未实现。
- 真实 API 联调需用户显式准备 Key 和实际调用；测试不请求外部网络，也不消费付费 token。

## 测试与遗留

新增从旧版挑选并适配的 OpenAI/SSE、Anthropic/Context、Usage/Budget 离线协议测试，并新增模拟真实 SSE `→` Fencing Runner `→` 独立 Host `→` Tool Receipt 的全链路测试。所有版本的 `npm run check` / `npm test` 以 GitHub Actions 最终状态为准。

**明确暂缓**：原 PR #2 的 Steering 与 Context Checkpoint/自动摘要，以免绕过新版的 Session 日志不变量和未决 Turn 恢复边界；未来单独做状态机与安全测试。原 PR #2 应在新实现验证后标记部分功能已被替代，但不能声称所有历史功能已经被移植。下一批整合历史 PR #3 的 **Command Inbox / Command Idempotency**，保持现有 `SqliteEventStore`、Host Receipt 和 Fencing Token 不变。
