# M1：真实模型流协议、Step 准入、Context 预算与安全恢复

> **2026-10-26 第四批更新**：新增 `resumeSession()`，只重新挂载完整终止的 Session，校验事件序列、ToolCall 结果配对和 Checkpoint 边界；取消事件写入失败仍将 Abort 传给 Provider。**69/69 项离线测试通过**。详见 [恢复与故障说明](../M1-SESSION-RECOVERY-2026-10-26.md)。

> **2026-10-26 第三批更新**：新增两种 Provider 的实际 Usage 解析、每 User Turn Token 累计限额、只压缩已完成旧 Turn 的 Context Checkpoint；**60/60 离线测试通过**。详细规则及限制见 [第三批源码与验收记录](../M1-USAGE-CHECKPOINT-2026-10-26.md)。早期 31/45 项数字是历史批次记录。

> **2026-10-26 第二批更新**：原生 Anthropic Messages + 序列化字符预算；45/45 离线测试已通过。具体范围见 [增量说明](../M1-INCREMENT-2026-10-26.md)。旧文中 31 项数字仅描述第一批成果。\n\n> 2026-10-26 · 开发分支 `feat/kernel-m1-provider-stream`。本阶段已经实现并离线测试 **OpenAI 兼容 Chat Completions SSE**；未提供或使用真实 API 密钥，未进行真实服务端的计费请求。

## 可运行的内容

- **可配置模型适配器** `OpenAICompatibleProvider`：独立接口，HTTPS（或显式的本机 HTTP），支持 OpenAI 兼容 Chat Completions 的流式文本和函数工具调用，支持自定义根 URL 连接遵循此协议的服务。
- **流安全性**：按 SSE 事件解析，支持 CRLF、注释、跨 UTF-8/网络分片；在 `data: [DONE]` 和合法 `finish_reason` 之前，绝不提交可执行 ToolCall；工具参数 JSON 和调用 ID 要经过完整组装与校验。带流、单帧、工具参数容量上限。
- **Step ToolSet 快照**：模型入场时记录 `stepId/toolSetVersion/tools`，调用执行时仍使用当步版本；新增工具只影响下一 Step。模型只看见内核允许的只读工具。尚未实现完整的 Context/Budget/Policy 版本冻结。
- **Steering**：按 `expectedTurnId` 向运行中的 Turn 排队消息，在下个安全模型步骤投递；异步写入事件并保留 `steer_queued` / `steer_consumed` 的区别。
- **简单 CLI**：不注册危险工具；只向配置的真实模型提交文本，实时显示 `text_delta`。SIGINT 请求取消 Turn。
- **测试**：原 M0 17 项 + 本批新增 14 项 = 31 项离线确定性测试。包括流断开、无效工具 JSON、取消阻塞 SSE、重复 ID、输出长度截断、Steering 竞态、动态工具列表和协议错误。

## 本地命令

需要 Node.js 22+、npm 与 TypeScript 开发依赖：

```bash
npm install
npm run check
npm test
```

使用兼容的模型服务（下面是占位符，**不要把真实密钥加入 Git**）：

```bash
export AGENT_API_KEY='YOUR_KEY'
export AGENT_MODEL='CHAT_COMPLETIONS_MODEL'
export AGENT_API_BASE_URL='https://api.openai.com/v1'
npm run cli -- 'Hello from my own Agent Kernel'
```

自定义 API 根必须使用 HTTPS；仅允许指定本机 HTTP，禁用 HTTP 重定向以避免密钥经跨域跳转泄漏。兼容性受具体模型与服务是否支持 Chat Completions SSE / tool_calls 影响。新的 OpenAI 应用通常建议 Responses API，但这里先通过可替换的 Chat Completions Adapter 打通第一种实际 Provider 通道。

## 核心限制

1. **没有发起过真实收费 API 请求**：只有模拟 `fetch` 的离线 HTTP 协议测试；真实供应商的事件格式差异、限额和网络故障仍需联调。
2. **不是全面 M1/生产产品**：当前只支持文本、OpenAI 兼容 Chat Completions SSE，已新增原生 Anthropic Messages 的基础 text/tool_use，但不支持 thinking/server tools；也不支持 OpenAI Responses 全部特性、OAuth、图片和推理用量对账。
3. **内核仍非持久化**：MemoryEventStore，重启即丢；Steering 的“接受”只进入进程内日志。M2 才引入事务型 SQLite / 跨进程收据。
4. **没有 OS Tool Host 安全边界**：注册 ToolDefinition 只可用于可信只读工具/离线测试，**不得注册不可信或写入型工具**。
5. **构建可重复性待加强**：本开发环境缺 npm registry 的离线缓存，无法生成/验证 `package-lock.json`；从公共 registry 安装时应再生成并提交锁文件，运行 CI 验证 Node LTS 版本。
6. **Steering 当前是“下个安全 Step 消费”**：不会抢占工具和当前模型调用。强一致 durable inbox、幂等键、跨进程恢复尚未实现。

## 资料

- [自研内核架构取舍](../docs/research/comparative/14-自研内核架构取舍正式评审稿.md)
- [ADR 0005](../docs/adr/0005-首版自主内核技术基线与取舍.md)
- OpenAI Chat Completions API：https://platform.openai.com/docs/api-reference/chat
