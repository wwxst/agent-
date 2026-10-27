# 22 · M2 可信 Context Checkpoint 与不可变历史投影

> 范围：**将早已完整结束的历史 Turn 转成可供模型参考的摘要投影**，用于字符预算超过阈值时的显式降载。Kernel、Tool Host、Writer Lease、工具授权和未决状态恢复继续以**完整 Event Journal**为准。此摘要不等于历史事实，也没有签名、权限或可重放执行的效力。

## 交付内容

本阶段以新版 Kernel 为基线，选择性借鉴旧 [PR #2](https://github.com/wwxst/agent-/pull/2) 的 Context Compaction 思想，而不覆盖已经接入的 Tool Intent/Receipt、Steering、Fencing Token 和持久化运行时。

新增 `packages/context-engine/src/checkpoint.ts`：

- `safeCompletedPrefix(events, fromSeq, beforeSeq)`：从上一个 Checkpoint 的事件位置开始，寻找**连续、安全结束的历史 Turn** 前缀，只以 `turn.completed` 为边界，不跨越 `turn.failed` 或 `turn.cancelled`。先前 Checkpoint 存于活动 Turn 中，扫描时继承它关联的活动 Turn，否则连续压缩会遗漏先前 Turn 的关闭事件。
- `hashContextSource(events, throughSeq)`：对原始事件前缀计算 SHA-256，包含 Session/Turn/Seq/事件 ID、类型、数据、时间。用于检测可信进程中的意外旧快照/源记录篡改；**不能抵御拥有相同数据库写权限的恶意进程，也不是数字签名**。
- `inspectContextCheckpoints(events)`：只读审计每个持久 Checkpoint 的 `throughSeq`、`summary`、`sourceHash`、`sourceEventCount`，验证只覆盖已完成历史、没有未决 ToolCall/Steering、来源 Hash 未变；异常返回 `CORRUPT_CONTEXT_CHECKPOINT`。

新增 `KernelOptions.contextCompactor?: ContextCompactor` 与 `ManagedSessionOptions.contextCompactor`。只允许受信显式配置的摘要器返回字符串，默认**不启用**。运行时此前的 `maxContextCharacters` 仍只是 JSON 字符预算（包含 Tool Schema），不是模型 tokenizer 的准确 token 计费。

## 执行顺序

```text
当前 Turn 正准备下一个 Model Step
  ├─ 消费已接受的 Steering，核验当前 Writer Lease
  ├─ 对完整 Event Journal 校验全部历史 Checkpoint
  ├─ 生成模型上下文投影（最近摘要 + throughSeq 之后的用户、模型、工具结果）
  ├─ 按 JSON 字符阈值计算本步骤的准入预算
  └─ 如超额、且显式配置 ContextCompactor：
       ├─ 寻找早于当前 Turn 的安全已完成前缀，拒绝跨越失败/取消记录
       ├─ 审计 prefix：全部 Tool Intent/Receipt 结清、Steering 队列无残留
       ├─ 调用可信 compactor.compact(历史投影, 当前 AbortSignal)
       ├─ 再检查 Lease/Fencing 与 Cancel
       ├─ 检查摘要非空、最长 32,768 字符
       ├─ 同一 EventStore.append 持久 context.checkpoint 及 Source Hash
       ├─ 接受期间新到达的 Steering，按顺序追加 consumed/user.message
       ├─ 重新投影、重新进行字符预算准入
       └─ 成功才写 model.started 并请求 Provider
```

`context.checkpoint` 是**当前 Turn 内**的投影事件，但 `throughSeq` 指向**之前某个已完成 Turn 的 `turn.completed`**。因此必须以 `throughSeq` 为模型投影切点，而不是以 Checkpoint 自己的事件号为切点：否则会误删当前 Turn 的用户输入。新事件只能附加，**不物理删除、不修改已持久化的原始 Kernel Event**。原始工具收据和 Host 台账始终留存，所有权限审计只读取原始日志。

摘要被表达为 `ContextMessage {role:'summary'}`，真实模型适配器将其作为**未受信任的历史上下文摘要**传给模型，不应视为新的用户授权指令。应用必须为摘要内容设置隐私、保留与成本策略；本版本没有认证过的摘要服务、注入隔离或独立 Summary Host。

## 故障与恢复

- 没有安全的历史 Turn 可压缩：`CONTEXT_COMPACTION_UNSAFE`，模型步骤不会调度；没有显式摘要器则原样返回 `CONTEXT_BUDGET_EXCEEDED`。
- 摘要器抛错、返回空/过长内容：`CONTEXT_COMPACTION_FAILED`，本次不写 Checkpoint。
- 摘要期间取消、失去 Writer Lease：不写 Checkpoint，也不会因此恢复或重放任何工具；租约失去仍留待人工处理未完成 Turn。
- 已提交摘要但后续字符预算仍超额：不会发起 Provider；Checkpoint 仍是带前缀 Hash 的持久投影，原始日志完整，当前 Turn 可记录失败。
- SQLite 事件前缀/Checkpoint 元数据被意外篡改：`AgentKernel.openSession()`、`SqliteToolReconciler`、`SqliteCommandInbox` 均调用审计，按 `CORRUPT_CONTEXT_CHECKPOINT` 拒绝重开、对账可信判断及新命令接收。
- Checkpoint 落库之后进程 SIGKILL：旧的已完成 Turn 原始历史仍在；当前未决 Turn 不会因摘要而自动重开（`RECOVERY_REQUIRED`）。

## 测试矩阵

新增 `tests/context-checkpoint.test.ts` **12 项**，覆盖：

1. 完整历史安全压缩、摘要投影仍包含当前用户消息且历史事件完全不变。
2. 未显式启用 compactor 拒绝超预算模型步骤。
3. 当前没有已完成旧 Turn 时拒绝压缩。
4. 摘要器失败不创建 Checkpoint。
5. 返回过长摘要被拒绝。
6. 摘要仍超预算时没有第二次 Provider 调度。
7. Compactor 等待期间取消。
8. Compactor 等待期间租约被 Fencing。
9. Compactor 阻塞期间接受 Steering 并确保进入下一 Model Step。
10. **连续两次**历史压缩，能够跨前一 Checkpoint 识别活动 Turn 的 terminal 边界。
11. 事件源被篡改后 Kernel/只读对账/Command Inbox 全部拒绝。
12. Checkpoint 持久提交后 SIGKILL，源历史仍在且未完成 Turn 不会被错误重开。

原有 **146 项**，新增 **12 项**，目标总计 **158 项**，在 Node 22 和 Node 22.16.0 上执行严格 TypeScript 类型检查及全部测试，以最终 PR SHA 的 CI 为准。

## 明确未实现

- 不承诺摘要在语义上完整、准确或抵抗 Prompt Injection；模型推理可能误解摘要。
- 没有独立授权的 Context Compactor 服务、真实厂商 Tokenizer、自动质量评估/摘要对抗测试。
- 不支持压缩未确认外部副作用、已接受但未消费 Steering、损坏 Event Journal、未完成 Turn。
- 不提供 OS 强制 Tool Host 隔离、生产鉴权、远程 Steering、Command Dispatcher 或 Exactly-once 工具执行。 

参见：[Provider 与 Context 字符准入](19-M1-旧PR2-真实Provider和CLI整合.md)、[Steering 故障审计](21-M2-Steering-活动Turn指令与审计.md)、[双账本](17-M1-双账本只读对账与证据判定.md)。
