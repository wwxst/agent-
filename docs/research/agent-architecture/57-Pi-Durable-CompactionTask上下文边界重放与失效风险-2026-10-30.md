# 57：Pi Durable 1.4.0 CompactionTask、上下文边界、重放与并发失效风险（2026-10-30）

> 研究阶段：固定 v1.4.0 发布版 TypeScript 源码静态追踪及上游已有测试源码审查；**本轮未运行测试**。  
> 上游：earendil-works/pi，tag v1.4.0，release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。  
> 仅在 PR #49 更新研究证据，不修改 Kernel、开发代码或 PR #48 实验实现。

## 1. 核心结论

Pi Durable 的 compaction 不是删除 transcript、也不是无状态 prompt 摘要函数，而是独立持久化任务：

- CompactionTask：select / summarize / retry 三种 phase checkpoint，持久化 model / thinking / stream options / maxTokens / tail / firstKept / attempt。
- GenerationTask：在 request prepare 的 threshold 或 provider context overflow 触发 blocking compaction；也可在提前预警阈值启动 conversation-owned background compaction。
- 原始 Entries 继续存在；摘要写为 pi.compaction Entry，head 指向第一条保留的 entry。Context view 通过最新 head marker 选择活跃范围、重建模型消息。
- 手动/后台 compaction 不独占 Conversation，而是通过 durable write Submission 在适当 boundary 落地；若 head 指向已经被新边界排除的历史，会得到 unanswered/stale。
- 跨进程重开后 Task checkpoint 和 Submission 可恢复，但已请求、未提交完成的 summarization 会被重新发送；无法据此保证 provider 调用 exactly-once 或重复计费可避免。
- 测试明确展示：压缩正在总结旧历史时，另一个 application edit 可能落地；摘要成功后该 edit target 不再位于活跃范围，修改未体现在后续 model context。这是有意接受的已知语义边界，不应称为“上下文无损合并”。

## 2. ContextView：不可变 transcript 与 head marker

### 2.1 读取一致性

packages/durable/src/harness/context.ts：

1. captureContextBounds() 在 Session serialized read line 上以 O(1) 最新 entry 与最新 head-marker 两次读取固定 head/tail；
2. Entries 提交后 immutable，可在离开 Session line 后分页扫描（scan page size 256）；
3. rangeQuery() 从 head.head（第一条保留的旧 Entry）或 transcript start 扫至 tail；
4. selectActive() 将最新 head marker 置于首位，过滤范围中其他 old head markers；
5. deriveRange() 从整个 range 汇总 ContextEdits，每个 target 以最新编辑为准，形成 contributions 与 Message[]；
6. readContextFrom() 在 head marker 不变时可增量复用旧 ContextRange；tail 前移时裁剪，出现 edits/head 则重新 derive。

注意 head.id 是新 marker 自己的 Entry ID；head.head 是第一条被保留的旧 Entry ID，二者不可混用。

### 2.2 模型消息还原

- Edit omit 使 entry 不进入模型消息；replace 使 replacement messages 参与。
- stopReason 为 aborted/error/deferred 的 assistant response 不进入模型 context；raw transcript 仍保存。
- orderToolResults() 把工具结果按 assistant ToolCall 的 source order 排在 assistant 后；不匹配的结果丢弃，缺失结果合成 isError/missing_result。
- leadWithSystem() 将符合条件的首条 positional baseline system message 移至开头，保留工具声明/prompt sections 的顺序；不随意移动其他 system messages。
- 最新 head marker 自己贡献 summary user message；原始 history 仍可通过 Storage 查询，但被 cut 的部分不进入当前 LLM context。

这是独立的 Canonical transcript → projected LLM context 规则，不等于简单 append-only chat。

## 3. Cut selection：保留消息预算但避免切坏工具轮次

CompactionTask.selectCut(view, keepRecentTokens)：

- 从尾部按 estimateMessageTokens() 累加 contributions，直到达到保留 token budget；
- 选取不早于该位置的首个合法 candidate，或最后一个 candidate；
- candidate 必须从 user 或 assistant 有效贡献开始；
- 不把 cut 放在 ToolResult、空贡献/display-only、system、excluded error/aborted response；
- user 之后若仍有属于之前 assistant calls 的 ToolResult，不能在该 user 处切断关联；
- cut 之前无真正可总结内容时返回 undefined；
- 二次压缩时先把之前 summary marker 包含进总结来源，保证有机会保留先前摘要的信息。

预算是近似值；大型 ToolResult 可以使保留量超过指定 keepRecentTokens，但切口仍须维持合法模型上下文。

上游 harness-compaction.test.ts L230–346 覆盖 user/assistant/tool-result/empty/system/error/edited contributions、旧 summary 与 huge result。

## 4. Generation 阈值、Overflow 与重试

### 4.1 Threshold policy

每 model 可通过 modelOverrides['provider/modelId'] 对 enabled/reserveTokens/keepRecentTokens/backgroundTokens 逐字段覆盖。

- blocking threshold = model.contextWindow - reserveTokens；
- background threshold = blocking threshold - backgroundTokens；
- policy disabled、窗口未知/≤0、无可切旧范围、backgroundTokens=0 时不会启动相应自动路径；
- 已存在 compaction status 时，不重复启动 background task。

estimateContext() 尽可能使用最新 assistant.usage 的上下文 token 作为已知前缀，再估算新增消息与计划 system entries；没有可用 usage 时估算全量。

### 4.2 Blocking threshold

GenerationTask.prepare：

1. resolve model、replay sections、计划新的 pi.system entries；
2. 阈值越界且有 cut，单次 commit 创建 child CompactionTask；GenerationTask checkpoint=prepare/compacted/threshold，waiting on child；
3. child 生成 summary 后直接 append pi.compaction Entry（非 Submission），因为是 generation-owned 且运行中的 Generation 持有对话写入权；
4. generation 重新 prepare，检查 child outcome：失败/aborted 导致 run 失败；declined/no-cut 可继续原 request；
5. 同一 generation 不会二次阈值压缩（避免无限循环）。

### 4.3 Background threshold

- 请求超过背景阈值、尚未超过阻塞阈值时，Generation 在准备 request 的 commit 中创建 conversation-owned background compaction 并照常发送请求；
- selection/summarization 与后续 turn 可以并发；
- 完成时创建 idempotent write Submission，requestId=compaction:taskId；
- idle 直接 placement，busy 排队 postTools/final boundary；其 entry.head 若小于 active boundary.head，settle unanswered/stale；
- manual compaction 同样 conversation-owned，但 background=false；不会阻止对话继续。

### 4.4 Provider overflow

- 仅 assistant.stopReason=error 且 isContextOverflow(message) 时走 overflow compaction；长度截断 length 不算；
- 若本 generation 尚未 compaction、策略 enabled、有 cut，则 append error assistant entry、创建 owner child CompactionTask、generation waiting；
- Child 成功并有 entryId 时以原 attempt 重新发模型请求；child 未提供摘要、失败或中止则以原 overflow text fail；
- 一个 generation 至多一次 overflow compaction，防止循环。

## 5. CompactionTask 各 phase

### 5.1 select

- 读取 model、当前 policy、ContextView、firstKept；
- beforeCompact hooks 可 decline 或直接返回 summary，首个非空 decision 生效；hook throw 按 extension hook 规则 report/skip；
- 无 cut 时 terminal completed 而不产生 summary；
- 模型请求前持久化 summarize checkpoint：attempt、固定 model/thinking/options/maxTokens/tail/firstKept；
- tail 是选取范围时最新 EntryId，summarize 阶段通过 runtime.context(at:tail) 重建固定历史，不随新 entries 偷换摘要输入。

### 5.2 summarize

- 独立的 summarization prompt，system role 指令 + user role 包裹 conversation 文本与结构化 summary 模板；
- serializeConversation() 只含 user、assistant visible text/tool calls、tool results；省略 system messages 和 thinking；每个 ToolResult 文本最多 2000 chars；
- maxTokens = min(floor(0.8 * reserveTokens), model.maxTokens)；
- option 去掉 deferred、cacheRetention=none，带 Task AbortSignal / telemetry / provider sessionId；
- 只接受 stopReason=stop、无 ToolCall、非空纯文本；
- 模型错误根据 retryable/policy 持久化 sleeping retry/until，其他以 terminal failed/model_error 结算；
- usage 与新 summary Entry/Submission、task terminal outcome 在同一个 runtime.commit 中 settlement；
- abort handler 同一个 commit 删除 pi.live.compactions status，task terminal=aborted。

### 5.3 retry

- until 到期前不再调用 provider；到期后更新 attempt、清除 retry status、恢复 summarize，仍使用 pinned params；
- maxRetries 限制正常失败重试，但 crash-resend 不是同一回事；
- 崩溃后外部模型已经计费的请求未必在 UsageDoc 反映。

## 6. 摘要 placement、竞争与失效

- Summary Entry kind=pi.compaction；model 是 summary user message；data.reason=manual/threshold/overflow；head=firstKept。
- Blocking child 直接 append；conversation-owned 通过 write Submission。
- Inbox.applyBoundary 写入时比较 boundary.head 与 entry.head：更老则 stale；同一 boundary 中多个 write 按队列顺序推进 head。
- 多个摘要选择相同 firstKept，后写可能替换先写摘要，不代表二者被合并。
- 新 reset marker 会使旧 summary stale；已排队、未 placement 的 write 可以在 Conversation.abort 后保留。
- stale summary provider usage 仍记账，只是不作为 active context。

上游 harness-compaction.test.ts L524–705、L1200–1223、L1803–1859、L2157–2186 覆盖 reset、background vs blocking、equal cut、stale placement。

### 6.1 明确的安全/一致性风险：并发应用编辑被遮蔽

上游测试 L1877 标题为“loses an application edit placed while a compaction summarizes (spec §12)”：

1. Compaction 选定旧 entry u1，开始产生摘要；
2. 应用又写入一个 ContextEdit，将 u1 的模型消息替换为 REDACTED；
3. 摘要依据先前固定 tail 的未 edited 输入生成；
4. 新 summary 的 firstKept 使 u1 离开 active context range，该 edit target 也随之不再应用；
5. 后续 ContextView 不包含 REDACTED；summary 可能继续携带原始 u1。

此行为对历史删除、脱敏、授权撤销或合规更新具有实质性风险。如果目标 Agent 支持历史编辑/脱敏，不能照搬此并发模型，必须对 compaction 输入与 edit revision 的有效性做 fence 或重新生成。

**这是上游测试文件显示的行为，本轮未实际执行该测试。**

## 7. Recovery：Durable Task 不意味着 exactly-once Provider

- Summarize checkpoint 在 provider request 前已经提交。
- 已 complete/committed 的 summary，重开后不再调用 provider。
- 如果关闭发生在 summarize request 执行中，重开会使用同一 checkpoint 重新调用 provider；上游测试 L1705–1728 明确预期 summaryRequests=2 且请求内容相同。
- 未提交结果的第一次请求不计入 UsageDoc；但真实 Provider 可能已计费，不能从本地 usage 推断真实账单。
- sleeping retry/until 会随 reopen 保留，未到时间不额外发请求；
- blocking generation 等待 child、queued summary Submission 都可恢复；
- classify commit 失败会使 Harness failed；一笔 summary+usage+submission 原子结果不应半写入，但未提交 provider 请求是否产生费用仍未知。

上游测试 L1620–1802、L2119–2145 覆盖 SQLite graceful close/reopen、模拟 in-flight provider、commit failure；不等于真实 crash/power-failure 行为。

## 8. 事实 / 推断 / 未知

**源码事实：** CompactionTask checkpoint select/summarize/retry；请求 pin model、tail、firstKept、options、attempt；cut 避免工具消息错配；原始历史不删除；summary placement 有 Conversation boundary/stale 检查；读取 context 时合成缺失工具结果；中断摘要重发是允许的，不保证 exactly-once。

**上游测试（本轮仅阅读）：** range/cut、manual/background/blocking/overflow、per-model policy override、reset/stale/multiple summaries、SQLite reopen select/summarize/retry/waiting/submission、classify commit failure，以及应用 ContextEdit 在 concurrent compaction 中被旧范围遮蔽。

**未验证：** 真实 Provider billing/dedup、真实 overflow、摘要信息正确性、断电/磁盘满/跨多进程、应用脱敏对新旧摘要的强一致失效规则。

## 9. 对独立目标架构的非决策性启示

1. 分离不可变原始 transcript、model projection、summary entry 与历史 edit/revision。
2. Summary commit 应附带 input snapshot identity（tail/head/version）和 output validity precondition；安全敏感历史编辑必须能 invalidate 旧 summary。
3. ToolCall/ToolResult 配对必须可重建，不能随意切分或丢消息。
4. 长耗时 summarization 模型请求需单独建模 sent、responded、committed；外部计费没有 idempotency 时不得承诺 exactly-once。
5. Background compaction 仅是延迟优化，不可绕过 Task/Submission 的一致性边界。
6. 需要 fuzz context edits、fork/reset、tool results、concurrent summary、provider/storage failure，而不只验证摘要 happy path。

以上只是研究输入，不是目标架构已批准决策。

## 10. 下一步

1. 研究 pi-coding-agent@1.4.0 的 AgentSession、Core Agent、SessionManager、自有 compaction、MCP、permissions、extensions、TUI/print/RPC 的真实组合路径。
2. 对照 coding-agent JSONL session tree/recovery 与独立 pi-durable Harness 的 SQLite/JSONL Task/recovery，不将同 monorepo 视为同一能力。
3. 完成后与 Claude CLI/Desktop/SDK 做同场景架构比较，独立提出目标架构、风险矩阵、验证和实施路线图，交用户审阅。
4. 只提交研究报告与进度；尚无开发批准。

## 11. Evidence index

| v1.4.0 上游路径 | Git blob SHA | 关键锚点 |
|---|---|---|
| packages/durable/src/harness/compaction.ts | b7376a8822c6d2023e983e0f18b73da0395b6391 | CompactionTask select/summarize/retry, selectCut, estimateContext, placeSummary |
| packages/durable/src/harness/context.ts | c818b3cb5bad1430233ecf0649984c75e378b026 | captureContextBounds, readContextFrom, deriveRange, edits, orderToolResults |
| packages/durable/src/harness/generation.ts | c8d26791cd5a2e26287f73255b75f65ec21c3f22 | prepare threshold, thresholdCompaction, overflow |
| packages/durable/src/harness/inbox.ts | ced6977677c2a38ada04d5ad714b4a9e20cedaa8 | applyBoundary, isStale, head marker, reset |
| packages/durable/test/harness-compaction.test.ts | cc4a857970d21d901761306041c2d38780cda279 | range L230–346; concurrency L524–705; recovery L1620–1802; lost edit L1877–1895 |
| packages/durable/test/harness-context.test.ts | f3a9ada0ed2a16bf438a07e990da61c8478a6e67 | ContextView projection, edit, system, result ordering |

**证据等级：** 固定 release TypeScript 源码 + 已有测试源码静态审查；未运行新测试或真实 Provider/DB/OS crash。