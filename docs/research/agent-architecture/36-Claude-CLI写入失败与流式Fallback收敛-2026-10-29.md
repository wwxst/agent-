# 36 · Claude CLI 2.1.304：Transcript 写入失败与流式 Fallback 的状态收敛

> 研究时间：2026-10-29  
> 性质：**直接读取发布版 JS 的静态源码研究**。未运行 Claude CLI、未注入磁盘故障或 Host 断连、未测试进程崩溃。  
> 前置材料：[报告 33](./33-Claude-CLI执行链源码复核-2026-10-29.md)、[报告 34](./34-Claude-CLI会话持久化与工具路由复核-2026-10-29.md)、[报告 35](./35-Claude-CLI远程工具Host与恢复状态机复核-2026-10-29.md)。  
> 本报告**不提出或批准新架构**，也不把旧 Kernel 的合同当作必须遵守的约束。

## 1. 研究问题

1. Storage V5 `append` 与 direct file append 的返回值，到底能保证到什么程度？
2. Transcript 写入队列遇到失败，会使调用方的 Promise reject，还是另外记录健康状态？
3. Stream fallback/refusal/model fallback 会怎样处置已经生成的模型消息、工具进度和已启动的工具？
4. 哪些状态是可证实的，哪些仍需动态测试？

本轮实际从资料库 `01-cli-source-only.zip` 读取 CLI 2.1.304 的发布版 JavaScript，不使用 2.1.88 TypeScript 代替当前版本。

## 2. 存储写入的分层与可证明边界

### 2.1 调用链

```text
Query/Session record
  → insertMessageChain / appendEntry
  → enqueueWrite (每个文件的队列)
  → scheduleDrain / drainQueuesOnce
  → appendToFile
  → pue
      ├─ Storage V5: backend.stat / backend.append (Result-like 接口)
      └─ direct file: appendFile 或 open + read + write + close
```

在 `chunk-4b60tdnk.js`：

- `enqueueWrite` @349710：加入队列，内部排定定时 drain（`FLUSH_INTERVAL_MS=100`）。
- `drainQueuesOnce` @352373：拼接待写 entry；按文件与 V5 backend 分组；`await appendToFile` 后处理队列 item。
- `appendToFile` @351708：`await pue(...)`，随后更新 writer health 和字节计数。
- `pue` @391653：Storage V5 分支 `await r.append(key, records, precondition?)`；direct 分支使用文件 append。
- `flush` @362968：取消 pending timer、等待 active drain、重新 drain，并等待 tracked writes 清零；若 `storeFence` 被设置才抛出该 fence 错误。

### 2.2 V5 backend 与 direct file 的保证不一样

`pue` 先判断 V5 功能条件与 backend/key 是否可用。V5 分支的形态是：

- 在 `onlyIfExists` 模式先 `await r.stat(key)` 检查文件是否存在与末尾是否 torn；
- 将待写的 JSONL text 经 `Jlo` 切分为 record 数据；
- `await r.append(key, records, precondition)`，并检查 `ok/error`；
- 若 `tornTailBytes>0`，可能先加换行/使用替代末尾记录以封合不完整尾部；
- 成功返回 `backend` 或 `backend-torn` 标记。

Direct-file 分支要么执行 `fs/promises.appendFile`，要么在 only-if-exists 情况 `open(O_RDWR|O_APPEND)`、读取最后一个字节、必要时补充换行、循环写入，最后 `close()`。这一层**没有直接出现 `fsync` 或 `fdatasync`**。

因此，`await r.append(...)` 只证明它按 backend 接口的完成规则返回成功；目前尚未定位 Storage V5 backend 的完整实现，也没有理由仅凭 Promise resolution 就推断它提供掉电恢复、跨进程顺序或 fsync 级保证。反过来，也不能凭此断言它没有这些能力。

### 2.3 写入失败的 Promise 语义（新发现）

同一模块中：

- `enqueueWrite` @349710 返回一个被 `pushQueueItem` resolve 的 Promise，正常情形不提供按 entry 失败 reject 的回调；
- 在 diskless 且无 backend 的路径，`enqueueWrite` 会记录 `writerHealth` 失败，并**返回已 resolve 的 Promise**；
- `drainQueuesOnce` 的 `catch` 分支记录 `qb(writerHealth,"drain",error,path)`、调用 `forgetLinesThatNeverLanded`，在匹配的错误类别上设置 `storeFence`，然后仍然 `resolve()` 尚未结算的队列项；
- `qb` @313835 管理 failure count、abandonedPaths 和 degradedStore；`nRt` @314728 在成功写入后可以清除该文件失败状态；
- `flush()` 会检查 `storeFence`，但从可见代码不能证明每种 `qb` 失败都一定导致 `storeFence`。

**可确定的合同：** per-entry `enqueueWrite` Promise resolve 本身不等价于“该 entry 已经写入磁盘”。部分失败由 `writerHealth`/degradedStore 表示，而不是逐条 reject。

**不能进一步推断：** 没有动态故障注入前，不断言在所有失败类别下最终 `flush()` 都会成功，也不断言已有 session replay 必然无法发现缺失的行。要确认具体用户可见行为，还需沿错误类别、reader/replay 路径及 exit/恢复过程继续核验。

### 2.4 进程正常退出与突然终止的差异

报告 34 已记录 `Pni` exit drain 和 `Qc → ga().flush`。这里进一步明确：这些 hook 是**正常退出时会尝试执行的收束路径**，并不构成 `SIGKILL`、掉电或直接进程崩溃时必定执行的保证。

缺少已验证的 V5 backend 与 crash-injection 结果前，必须把“队列接受”“后台 append 完成”“store 状态已刷新”“突然停止后可恢复”分成不同的研究问题。

## 3. Stream fallback 的消息和工具处理

### 3.1 Fallback 事件的产生与消费

`chunk-4b60tdnk.js` 的模型请求流路径在 @2821104、@2822514 可生成：

`{type:"streaming_fallback_began",cause:...}`

其来源包括部分 streaming 断裂/无完整数据路径，以及在建流时遇到特定失败（例如 `404_stream_creation`）而转 non-streaming 的路径。

`chunk-smbjjyps.js` 的 `su` Loop 在 @178321 收到此事件后：

1. 记录本次 orphaned Assistant 消息计数；
2. `yield* he.abandonAttempt("streaming_fallback")`；
3. 清空本轮 Assistant 暂存集合；
4. 然后继续消费 fallback 产生的后续模型内容。

**这是重新组织模型尝试与上下文的控制流；不构成外部副作用回滚。**

### 3.2 `abandonAttempt` 与 `discardAndAbortInFlight`

`chunk-smbjjyps.js`：

- `abandonAttempt` @121678：对当前已收集 Assistant 消息和 ToolResult 依次 `yield {type:"tombstone",message}`；调用 reset 清除本尝试临时消息/结果；调用 `gn` sweep 工具，并创建新的 `StreamingToolExecutor`。
- `gn` @52182：调用 `discardAndAbortInFlight`；记录 aborted、completedBeforeEvent、queuedNeverStarted 计数；生成 `set_in_progress_tool_use_ids remove` 的 UI/状态清理事件，并返回已经启动的 ToolCall IDs。
- `discardAndAbortInFlight` @53287：把 executor 标记为 discarded；把工具分为 `completed/yielded`、`queued` 和 `executing`。对于正在执行且有可用 abortController 的调用发 `abort(reason)`；已排队调用不会按执行中调用一样 abort；返回 `startedToolUseIds` 与全部 `toolUseIds`。

因此存在两类不同的操作：

- **消息撤回**：`tombstone` 和本次尝试状态 reset，影响上层如何显示或构造后续模型上下文。
- **工具尝试停止**：向执行中的工具发 abort signal，识别已经启动/已完成/尚未启动的状态。

Abort signal 是取消请求，不证明下游 Shell、MCP、Remote Host 的副作用全部停止；这一点需要按具体工具和 Host 继续验证。

### 3.3 不只 streaming fallback 使用该机制

同一个 `abandonAttempt` 还被 refusal 处理、refusal retry 和 model chain advance 等路径调用（`chunk-smbjjyps.js` @173789、@176812、@184315）。

在 refusal retry 的一条分支里，代码显式使用 `startedToolUseIds`，并结合 `kept` 消息、`notRun`、`nudge` 构建下一次 `transition:{reason:"refusal_retry"}`。这说明回退不是简单地“删除当前一轮再原样重放”，而是针对已启动工具决定后续可见消息和重试提示。

**仍不确定：** 每一条恢复路径如何与 Remote Host 的 `delivery_unknown` / late answer 账本衔接，以及“已执行但消息被 tombstone”的具体可恢复语义。报告 35 的 Remote Host reconcile 机制提供线索，但尚未完成端到端连接。

## 4. 证据锚点

| CLI 文件 | SHA-256 | 精确字符 offset（0 基，UTF-8 解码） |
|---|---|---|
| `chunk-4b60tdnk.js` | `c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb` | `qb` 313835；`enqueueWrite` 349710；`appendToFile` 351708；`drainQueuesOnce` 352373；`flush` 362968；`pue` 391653；streaming fallback event 2821104/2822514 |
| `chunk-smbjjyps.js` | `1e28512664e9ef8818c84e5c4f6b19ee48c8f0c832e6673f29ad1a7f0872a46d` | `gn` 52182；`discardAndAbortInFlight` 53287；`abandonAttempt` 121678；streaming fallback consumer 178321；refusal/model fallback 173789/176812/184315 |
| `chunk-k3djx6vq.js` | `1b4dc9236bf90b77cd9d9d13aa82f67c6a792920e9253d92ef402a2f6dd615fe` | streaming fallback consumer/helper @10342/12517 |

所有偏移均针对本次读取的 CLI 2.1.304 发布版 JS；旧版 TypeScript 未用来证明当前版本行为。

## 5. 本轮结论与未决问题

### 源码已证实

1. Transcript writer 区分 enqueue、drain、backend append 与 flush。
2. `enqueueWrite` 的 resolve 不是逐条写入成功的充分证据；部分写入失败通过 writerHealth/degradedStore 记录。
3. Streaming/nonstreaming fallback 能发出独立事件，Loop 通过 tombstone、executor abort/sweep 和新尝试继续处理。
4. 已启动、排队和已完成工具在取消/回退时有不同的状态处理路径。

### 推断（需要验证）

- 该设计的一个可能目标是允许流式低延迟工具调度，同时处理不完整响应、重试和多目标工具执行；复杂度集中在消息可见性和外部执行状态之间的协调。
- 对外部 Agent Runtime 来说，“重试模型请求”和“重试已经执行过的工具”不能简单视为同一动作。是否在 Claude 的所有实际运行路径中遵守这个边界，需要动态验证。

### 未决问题（续接顺序）

1. **Storage V5：** 从 `r.append` 继续定位实际 backend 与成功/失败语义，确认是否有可审计的掉电/进程崩溃保证。
2. **Writer recovery：** 各种 `qb` 错误类别何时 latch degradedStore/storeFence；reader/replay 是否能探测 writer 丢失的行。
3. **Fallback × Host：** abandoned streamed ToolCall 若已经进入 Remote Host，如何与 Host call ledger、`delivery_unknown`、late answer 或 adopted call 联动。
4. **Local/MCP：** 本地 Shell/MCP/remote ToolHost 对 abort signal 的承诺和不可取消副作用处理是否一致。
5. **Subagent/上下文：** 继续研究父子任务状态、预算、压缩、恢复和隔离边界。

**裁决：无。** 不提出确定架构、不修改旧 Kernel、不开发、不合并 PR。后续研究继续在 PR #49 中追踪。
