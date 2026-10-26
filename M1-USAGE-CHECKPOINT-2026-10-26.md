# M1 第三批：Provider Usage、Turn Token 预算与 Context Checkpoint

> 2026-10-26 · 分支 `feat/kernel-m1-provider-stream`。基于真实模型协议的**离线模拟测试**；没有使用付费 API、没有 OS 沙箱和断电故障测试。

## 实现内容

1. `ModelProvider.stream` 规范事件新增 `type:'usage'`，统一 `inputTokens/outputTokens`，只采用**Provider 报告**的使用量，不拿字符长度猜测 Token。
2. OpenAI 兼容 Chat Completions 在请求中设置 `stream_options.include_usage=true`，解析独立 Usage Chunk；不兼容此选项的模型服务可设置 `includeUsage:false`，但在启用硬 Token 上限时，如果无最终 Usage，Turn 将被拒绝完成。
3. Anthropic Messages 从 `message_start.message.usage.input_tokens` 和 `message_delta.usage.output_tokens` 组合 Usage，只有两者齐备才提供统一 Usage 事件。不支持的消息块仍 fail closed。
4. `KernelOptions.maxTotalTokens`：每个 User Turn 内累计各**已完成 Model Step** 的真实 Provider 报告 Usage。模型请求之前检查剩余额度；当某 Step 报告的用量导致额度超过上限时，记录 `model.usage`、终止 Turn，**不执行本次新产生的工具调用**。
5. 增加 `ContextCompactor` 可信注入接口，序列化字符预算超限且存在已完成旧 Turn 时可生成 `context.checkpoint` 事件；事件记录 `throughSeq` 与摘要，模型使用最新 Checkpoint 的派生投影，但 EventStore 原始 `user.message/assistant.message/tool.result` **全部原样保留**。
6. Context 摘要以明确的**非可信历史摘要**身份进入模型消息，不提升到系统指令。只允许压缩已完成的旧 Turn，当前执行的 Turn、失败/中断历史和未确认 ToolCall 不被静默跳过。
7. 在一次 Step 入场中只尝试一次 Compaction，失败或压缩后仍过预算时明确拒绝 Provider 请求。取消期间不生成 Checkpoint。
8. CLI 新增 `AGENT_MAX_TURN_TOKENS` 参数；M1 CLI 尚未自带实际摘要模型与压缩服务，需要集成者显式提供 `contextCompactor`。

## 测试与验证

```sh
npm run check
npm test
```

完成：**60 项 Node 内建测试通过**（原 45 + 15 个 M1 第三批测试）；TypeScript 严格检查通过。新增覆盖：Usage 快照去重、Token 超额阻断工具、下一 Step 入场拒绝、OpenAI Usage-only chunk、Anthropic Usage、非法 Usage、Context Checkpoint 原始事件保留、无安全切点、摘要失败、超额摘要、压缩期间取消、事件写入失败不伪造成功。

## 限制与关键安全语义

- **Token 硬预算不是 Provider 侧硬停止**：Token 数是服务端报告的，通常到 Step 结束才知道；本系统可以阻止超额后继续执行工具和下一步请求，但**无法追回该 Step 已经生成/计费的 Token**。
- 如果模型发生断流且没有提供完整最终 Usage，无法准确清算；该 Turn 进入失败，不会虚报已计量费用为 0，也不会执行未完成工具。
- Context Checkpoint 是投影替换而非 EventStore Compaction；原始历史仍在内存中。`MemoryEventStore` 不具备断电恢复，M2 必须迁移 SQLite 和可核验执行收据。
- Compactor 是由可信宿主提供的接口，不能假定任何不受信任插件能安全生成摘要。摘要可能失真，不代表工具、权限或审批事实。
- 本阶段没有服务端原生 Responses API、自动模型重试、精确剩余窗口 tokenizer、真实 Context 摘要服务、完整多模态、OS Sandbox 或外部 Tool Host。
- 为避免二次收费和非幂等风险，Provider 断流/5xx 不自动盲重试；必须由明确的上层策略决定是否重新运行。

研究与架构原则见 [四内核对照](docs/research/comparative/README.md)（仓库根路径）及 [ADR 0005](docs/adr/0005-首版自主内核技术基线与取舍.md)。
