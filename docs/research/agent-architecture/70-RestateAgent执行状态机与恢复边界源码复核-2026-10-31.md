# 70：Restate Agent 执行状态机、Journal Replay 与外部效果边界源码复核（2026-10-31）

> 研究阶段补充；没有开发批准。本报告把报告 69 的 Restate Agent 初步研究推进到函数级执行链，重点核对 Controller/Turn 所有权、队列与 Signal 对账、pending operation supervisor、SDK run replay 语义、MCP/Shell 外部效果窗口、sandbox 边界和上游测试覆盖。**本轮只读源码与测试定义，没有执行测试、真实 Provider/MCP/Shell 请求或故障注入。**

## 1. 固定研究基线与证据等级

- Agent reference：restatedev/agent commit 0d69256f82ccb0e8826dc96dae64bc7952a78f05。
- TypeScript SDK：restatedev/sdk-typescript commit e39fcc3b3d64c5b931d8f9edf58b13833fc61369。
- Restate Server 版本/许可/兼容性沿用报告 69 的固定证据：Server v1.8.0/v1.8.1 发布说明与 BSL 1.1；reference package 使用 SDK 1.17.0，兼容矩阵需另行确认。
- 本轮证据类型：
  - **源码事实**：固定 commit 中的实现和注释。
  - **测试定义**：上游测试代码声明的场景与断言；不等于本轮测试通过。
  - **架构推断**：从上述代码路径推导的风险或设计含义。
  - **未知**：没有真实 Provider、MCP server、sandbox、Server operator 或生产集群证据。

## 2. Controller 与 Turn 执行所有权

### 2.1 双 Virtual Object，不是一个长锁

源码把同一 agentId 映射到两个不同的 Virtual Object：

- Agent：控制面，保存 active turn ID、pending 输入、steering reconciliation、profile、memory、approval、schedule、child directory 和 notification watermark。
- AgentSession：会话/执行面，保存 append-only history、summary checkpoint、sandbox reference，并执行独占的 doTurn。

固定源码：
- packages/libs/core/src/agent/service.ts blob caecc76e0037d2f635d01eac614902d81623ec16。
- packages/libs/core/src/session/service.ts blob 68f8bf46c5c674478b331d5483b8e61e1b869276。
- docs/architecture.md blob 376608e6b0d8f2f7dc2a20df2589a2b0b508b5df。

Agent 的 exclusive handler 只负责短时协调，不等待整轮模型/工具执行。它通过 sendClient(AgentSession).doTurn(request) one-way 启动执行，并把返回的 invocation ID 作为 turnId 写入 active-turn state。AgentSession 的 doTurn 自身是 exclusive invocation，因此同一个 agent 同时最多一个 turn 使用该 session/sandbox。

这不是“Agent controller 持有分布式锁一小时”；而是两个同 key VO 分别串行化各自的状态。Controller 可以在 Turn 执行期间继续接受 ask/steer/interrupt/approval 等请求。

### 2.2 输入受理、排队、steer、interrupt 是不同协议

agent/turns.ts 与 agent/active-turn.ts 形成明确状态机：

1. ask：idle 时调用 startTurn；busy 时把用户消息放入 FIFO pending queue。
2. startTurn：读取 profile、memory count、MCP server configuration 和 grants，形成 turn snapshot；把此前 parked entries 与新 entries 合并后启动 doTurn。
3. steer：仅当当前 turn 存在且未开始 interrupt 时接受；将 pending queue drain 到一个 steering batch，持久化 batch 记录，再向精确的 turnId resolve durable Signal。
4. interrupt：向精确的 turnId resolve interrupt Signal，并在 Controller state 写入 interrupt reason；可选 replacement message 单独进入 successor queue。
5. onTurnEnd：只接受与当前 active turn ID 匹配的 outcome；stale/duplicate outcome 被忽略；清理该 turn 的 child tasks/approvals；然后从 queue 启动 successor。

关键实现：
- packages/libs/core/src/agent/start-turn.ts blob 5458b3fe4d25ca8c0ccc4ce7bde072592e93ea04。
- packages/libs/core/src/agent/active-turn.ts blob 025cfd0f3c32b3576d08797cef215097ec9b8d9a。
- packages/libs/core/src/agent/turns.ts blob 941eff819274d16dac5035f976b76e4f587209ae。

### 2.3 消费计数解决 Signal 与 turn completion 竞争

这是值得借鉴的细节，不应只靠“Signal 已发出”来判断输入是否处理：

- Controller 把每个 steering batch 记在 active.steeringBatches。
- Session 在 Turn 内按 durable signal FIFO 消费，并递增 consumedSteering。
- Turn 结束时，Controller 用 active.steeringBatches.slice(outcome.consumedSteering) 找出未消费 batch，把其 queued entries 和 steering message 还原到 successor queue。
- 如果晚到的 interrupt 与普通 completion 竞争，Controller 用自己记录的 interruptReason 将 completed/stopped outcome 改成 interrupted；失败 outcome 仍保留 failure，避免用户 interrupt 隐藏真实失败。
- successor 无法启动时（例如配置错误），输入重新 park 到 pending queue，不因旧 turn 已结束而丢失。

这构成一个简单的控制面交付协议：**accepted batch、delivered signal、consumed count、terminal reconciliation** 分开记录。队列与 steering batch 分别限制为 32，避免每次整体 state rewrite 无限增长。

测试定义：packages/libs/core/test/local-agent.test.mjs 的 “steering the turn never consumed opens its successor in FIFO order” 覆盖了两个 batch 只消费第一个、第二个进入 successor 的情形；本轮未执行。

## 3. Turn Loop 与 pending operation supervisor

### 3.1 一个 doTurn invocation 是一个完整 Turn

session/service.ts 的 doTurn：

- 以 restate.handlerRequest().id 作为 turnId。
- 一次性 history.openTurn()，加载 summary + uncompacted entries，随后 append 本次 activated entries。
- 用 startTurn 传入的 instructions、guardrails、tool grants、MCP snapshot、memory count 等创建 invocation-local state。
- 循环最多 50 个 model/tool steps；每步 spawn 一个 agentStep，并与 durable interrupt signal race。
- 正常完成、失败、graceful interrupt、step-limit 都走显式 outcome；release MCP/sandbox resources 后向 Controller onTurnEnd 报告。
- doTurn 配置 inactivityTimeout 1 hour、abortTimeout 15 minutes；这两个配置不等于 operator hard-kill 的完整恢复协议。

### 3.2 Proposal gate 与 parallel tool dispatch

session/step.ts 先拿到模型 proposal，再对精确文本或整个 tool batch 执行 guardrail gate。被阻止的 proposal 不会进入工具 dispatcher。通过后：

- 同一模型响应中的 foreground calls 一起 spawn，并发执行，最后 join。
- 一个工具失败作为该工具 observation，不会自动丢弃其他 sibling 的成功结果。
- PTC nested calls 在实际 emit 时逐个经过同一 gate 和 dispatcher；不能只审批 JavaScript wrapper。
- steering 到达时，不取消普通工具；普通工具先完成。仍运行的 PTC program 被 handoff 到 Turn pending registry，模型可以先处理新 steering。
- 纯文本/模型错误 proposal 若在 step 中途被 steering 取代，会作为 stale proposal 丢弃。

### 3.3 pending Map 是进程内索引，不是独立 Durable Task Store

session/pending.ts 的 active registry 是 invocation-local Map，每个条目引用一个 Restate SDK Task。源码注释明确：Map 在内存中，但 Tasks 在 durable doTurn invocation 内运行，Restate journal 其 effects，recovery 会重建 Map。

- pending outcome 启动 completion phase 或 adopt 已 handoff task。
- Turn 等待时可在 completion、steering、interrupt 之间选择。
- cancelOperation 只 interrupt + join 被选中的 task；若完成先赢，真实 completion 被保留，取消结果报告 too late。
- Turn 正常提前退出会 stop + join 全部 pending operations。
- invocation cancellation 走 cancelAll：同步快照、interrupt 子 task，不等待已被取消的 coroutine tree；然后记录 cancellation transcript 并通知 Controller。

这套设计适合**由一个 Turn invocation 拥有、不能越过 Turn 生命周期的 pending operations**。它不等价于任意 Task 都可在 Turn 结束后独立存活；要做跨 Turn/跨 Agent/可长期排队任务，需要额外的 durable task owner 与业务状态。

固定源码：
- packages/libs/core/src/session/service.ts blob 68f8bf46c5c674478b331d5483b8e61e1b869276。
- packages/libs/core/src/session/step.ts blob d4ef64f240f4bfb4e7b2fa9fcd5036dfd9dd8ca0。
- packages/libs/core/src/session/pending.ts blob c29324f029242d62ec32a67c64850e28abec25c8。

## 4. SDK Journal Replay：已经记录的 run 不再执行 closure

固定 SDK 源码：
- packages/libs/restate-sdk/src/context_impl.ts blob ec3f5467b08d8e9865f66e163fb288aa0bba0d9b。
- packages/libs/restate-sdk-gen/src/restate-operations.ts blob 930e0c832a567031e8ee34e2e98f7afc8e3babc2。

ContextImpl.run 的关键流程：

1. 调用 VM sys_run 取得 run handle 与 command index。
2. 只有 wasmRun.replayed === false 才注册并执行用户 action closure。
3. replay 时不重新执行该 closure，而是从 journal completion 取得结果。
4. action 完成后将 serialized result 或 failure proposal 提交给 VM。
5. RetryOptions 的 maxAttempts 包含 initial attempt；RetryableError / 普通可重试错误由 VM 按 retry policy 处理。

这说明 durable replay 能避免**已写入 journal 的 run**再次调用 provider；它不能封闭“外部效果已成功，但 completion 尚未写入 journal”的窗口。此时 invocation replay 仍可能再次执行 action。maxAttempts: 1 只限制该 run 的 retry policy，不等于对 crash replay 禁止重新执行。

Restate Agent 的具体配置：
- Model：inference.ts 的 MODEL_RETRY.maxAttempts = 4；provider adapter 的 callOptions 设置 AI SDK maxRetries = 0，把 transport retry 交给 Restate。
- MCP：mcp-tools.ts 使用 maxAttempts = 1，同时发送 Idempotency-Key = turnId:toolCallId；源码明确指出 MCP 不标准化 idempotency，crash recovery 仍可能重复尚未 journal 的远端副作用。
- Shell：tools/sandbox.ts 对 command 使用 maxAttempts = 1，源码明确指出 transport error 可能发生在 command 已远端执行之后，且 crash recovery 仍可能重复未 journal command。
- 模型结果类型暴露文本/tool calls/error 与 inputTokens；没有在该 reference 的 ModelResult 中暴露 per-request providerRequestId/responseId、完整 usage/billing reconciliation 字段。

所以，**Journal 的 replay protection 与 Provider/Host 的 effect idempotency 是两层不同保证**。MCP Header 是协作提示，不是 MCP 协议级 exactly-once；Shell 命令也不是一个原子效果。

## 5. Transcript、Sandbox 与安全边界

### 5.1 Canonical transcript 与 execution journal 分离

session/history.ts 以 append-only sequence/chunk 存储公开 conversation history，chunk size 32；summary 只覆盖较旧前缀，至少保留最近 8 条 conversation messages 的 verbatim tail。Turn 通过一次 openTurn 建立 invocation-local cursor 和 tail chunk；每次 append 更新 chunk/meta 并发布 history invalidation。Compaction 使用 baseThrough/through reservation，只有匹配当前 reservation 的结果才能应用。

这说明公开 transcript 是 conversation log，不是完整执行轨迹；Restate journal 才记录 durable operation/control-flow。UI 不应把 transcript 当作完整 Tool/Provider audit ledger。

固定源码：packages/libs/core/src/session/history.ts blob 65ac4e37a7f5afbc4fac6fa1a420c2843d0097a9。

### 5.2 Local sandbox 不是安全 sandbox

sandbox/local-provider.ts 的 module 注释明确 commands 以 service process identity 运行；路径 containment 只限制工具路径，不限制命令可访问的其他文件/网络/系统调用。它只通过最小环境变量减少模型从 env 直接读出 provider keys，不能阻止 shell 读取服务用户有权访问的文件。目录在本机 /tmp，不保证 host replacement 后仍在。

### 5.3 Modal 是远端 compute adapter，不是 operation ledger

sandbox/modal-provider.ts 使用 per-Agent persistent Volume + disposable Sandbox compute。resume 会检查 stored sandboxId 是否仍运行；若 invocation 被杀导致 compute 仍存活则尝试复用，否则在同一 Volume 上创建新 compute。创建时使用 deterministic resource name；如果 Modal 已创建但返回 ACK 丢失，AlreadyExistsError 分支尝试重新获取同名 sandbox。

这为资源 provisioning 提供了 retry-safe pattern，但不能证明任意 shell command 的结果可恢复：sandbox ref 只标识环境，未记录每个命令的 operationId、effect receipt 或查询语义。进程/compute 的存在也不等于命令是否已完成的权威业务结果。

固定源码：
- packages/libs/core/src/sandbox/local-provider.ts blob abd3c0d1c4453527113167d74d4c8543822ef083。
- packages/libs/core/src/sandbox/modal-provider.ts blob 84ef809f139bb09acac105a55a438b969eca79fe。
- docs/sandboxes.md blob 09d9054718b85845d91968bfda53bd2ee4ad8b60。

## 6. 上游测试定义审计：覆盖了什么、没有覆盖什么

本轮只读测试文件，没有执行测试：

| 测试源码 | 覆盖的断言 | 不能据此声称 |
|---|---|---|
| test/restart.mjs + test/restart-service.ts | 对一个 PTC handler，在 checkpoint 后 SIGKILL endpoint，再重启；确认已 journal 的 lookup/score 不重跑，race winner 与分支顺序保持 | 不证明真实 Agent doTurn、真实 LLM、MCP、Shell、Host receipt 或 provider effect crash window 安全 |
| test/pending.test.mjs | handed-off program 取消另一个 pending operation 时，parked Turn 正确收到 completion | 不证明远端进程一定停止或副作用 rollback |
| test/local-agent.test.mjs | queue/steer、unconsumed steering FIFO successor、late interrupt/outcome reconciliation 等控制面行为 | 本地 harness 断言不是生产 Restate cluster 多节点故障证明 |
| test/mcp-config.test.mjs | mock fetch 成功一次后，journal replay 返回相同结果且不再次 HTTP fetch | 不证明真实 MCP server 对 Idempotency-Key 去重，也不覆盖 effect 成功而 journal 未提交的 crash |
| test/integration.test.mjs | PTC handoff、pending completion、selected cancel、steering 行为的 deterministic fixture | 不证明外部 MCP/Shell/provider exactly-once |

特别说明：test/restart-service.ts 顶部写明 “No model calls, credentials, or real tools”；其 lookup/score/checkpoint 都是测试内的确定性 run closure。它确实是 process SIGKILL/restart 测试定义，但不是真实外部副作用测试。本轮没有执行该测试。

## 7. 可借鉴模式与不可照搬的缺口

### 值得保留到目标架构评估的模式

1. **Controller/Turn 分离**：短时 Controller 负责受理/队列/权限配置/生命周期；独占 Turn owner 负责 model/tool loop。
2. **稳定 Turn identity**：turnId 直接绑定 durable invocation，所有 steer/interrupt/approval 目标精确到该 invocation。
3. **明确 delivery semantics**：ask queue、steer current turn、interrupt current turn + queue replacement 是不同 API/状态转移。
4. **Signal reconciliation**：accepted batches 与 consumed count 独立持久化，completion 时恢复未消费输入。
5. **Profile snapshot**：instructions/guardrails/tool grants/MCP config 在 Turn start 固定，避免同一 journal replay 时读取变化配置；需要在下一 Turn 应用变更。
6. **Pending supervisor**：同 Turn 内跨 step 保留长操作，支持选定取消、完成竞态和 handoff。
7. **Transcript 与 execution journal 分离**：用户可读历史、模型工作上下文、底层执行证据不是同一份数据。
8. **外部资源 provisioning 用确定性资源 ID**：在 provider create ACK 丢失后通过查询/AlreadyExists 恢复同一资源。

### 不能照搬到目标 Kernel 的缺口

1. doTurn 是一个长 invocation；operator hard kill 若发生在 onTurnEnd 前，reference 明确记录 Agent active turn 不会自动 reconcile，可能留下 busy state。Graceful invocation cancellation 有 cleanup path，不等于 hard kill。
2. 没有报告 66 的完整 Operation Journal / Host Capability Manifest / effectEvidence / UNKNOWN reconciliation；toolCallId 是当前 Turn 内 pending operation key，不等价于跨 Turn 的语义 operationId。
3. 没有报告 67/68 的 ModelCall requestAttempt/transportAttempt/providerRequestId/responseId/usage/billing ledger；Model run journal replay 不足以恢复 provider create ACK 丢失后的真实请求状态。
4. MCP 的 idempotency header 不具协议级保证；Shell 是任意进程/多副作用边界，maxAttempts:1 也不能消除 crash replay。
5. Permission 是 pinned turn grants + guardrail/tool dispatch 检查的参考实现，不是目标架构要求的独立 mandatory Permission Authority + last-mile Host policy revision check + revoke fence。
6. Local provider 明确不构成 OS sandbox；Modal remote compute 也不自动提供 per-command receipt/queryOutcome。
7. Reference README/architecture 明确没有 accounts/OAuth/tenant isolation，ingress 是可信 operator surface；不能把它作为多租户产品的完整安全基线。

## 8. 对独立 v0.2 架构的修订建议

- 保留 Hybrid C 的 Controller + TurnEngine + Durable Runtime 分层，但 TurnEngine 不拥有全部跨 Turn operation lifecycle。
- Runtime 负责确定性控制流、Signal/Timer/Task replay；领域数据库仍保存 submission、Turn、Operation、ModelCall、PermissionGrant、Receipt、Event Stream。
- Tool 执行前先创建稳定 operationId/argsHash/toolVersion/manifestVersion/grantRevision intent；Host 执行和查询必须使用同一 operationId/effectKey；无法 query 或 dedup 的工具维持 X0/UNKNOWN。
- ModelCall 单独记录 logical modelCallId、requestAttemptId、transportAttemptId、providerRequestId/responseId、conversationSessionId、context hash、usage evidence 和 billing reconciliation。
- Turn 完成或 owner 被 kill 时，由独立 reconciler/watchdog 通过 active invocation + lease/heartbeat + Controller state 检查孤儿；不能只依赖 Turn 的 finally/catch/cleanup。
- Profile snapshot 仍可借鉴，但权限撤销要定义：正在执行的 operation 在 admission 前/after-effect 各阶段的明确语义，不能仅等待下一 Turn。
- SandboxProvider 与 Host Capability 必须拆开：sandbox resource identity 不等于 command operation identity；每个命令/文件写/网络动作按实际 effect boundary 归类。
- 如果选 Restate，必须先解决 BSL 1.1 商业模式兼容、Server/SDK/reference protocol 版本矩阵和 hard-kill watchdog；如果选 Temporal/DBOS，保留领域账本与 Host 协议，不把 workflow step 当作外部 exactly-once。

## 9. 未决问题与下一步

1. 继续对 Temporal 与 DBOS 做同样粒度的 Agent Controller/Turn/Signal/Activity/Transaction 源码映射，避免只比较 SDK option 表。
2. 单独核对 Restate v1.8.x 与 SDK 1.17/1.18 的真实兼容矩阵、BSL 1.1 适用场景及多租户/托管服务计划；不把 reference repo 的实验 protocol flag 当作稳定生产能力。
3. 进一步把报告 70 的控制面状态机映射到 v0.2 的 Submission/Task/Operation/EventHub，形成 runtime-independent domain contract，但不承诺多 runtime 热切换。
4. 等用户确认首发部署、A/W/E/X capability profile、权限/sandbox、数据删除、工具/provider 幂等和成本 unknown UX 后，再决定是否进入 POC/故障测试；**当前仍未批准开发，也未批准执行 FI/POC 测试**。

## 10. 来源索引

- [Agent controller service](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/agent/service.ts)
- [Agent turn routing](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/agent/turns.ts)
- [Active turn state](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/agent/active-turn.ts)
- [Turn startup snapshot](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/agent/start-turn.ts)
- [AgentSession turn runtime](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/session/service.ts)
- [Step execution](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/session/step.ts)
- [Pending operation supervisor](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/session/pending.ts)
- [Transcript history](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/session/history.ts)
- [MCP tool invocation](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/session/mcp-tools.ts)
- [Local sandbox provider](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/sandbox/local-provider.ts)
- [Modal sandbox provider](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/src/sandbox/modal-provider.ts)
- [Restate SDK ContextImpl.run](https://github.com/restatedev/sdk-typescript/blob/e39fcc3b3d64c5b931d8f9edf58b13833fc61369/packages/libs/restate-sdk/src/context_impl.ts)
- [Restate SDK generated operation adapter](https://github.com/restatedev/sdk-typescript/blob/e39fcc3b3d64c5b931d8f9edf58b13833fc61369/packages/libs/restate-sdk-gen/src/restate-operations.ts)
- [Restart test](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/test/restart.mjs)
- [Restart test fixture](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/packages/libs/core/test/restart-service.ts)
- [Turn runtime semantics](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/docs/turn-runtime.md)
- [Hard-kill production gap](https://github.com/restatedev/agent/blob/0d69256f82ccb0e8826dc96dae64bc7952a78f05/docs/development.md)

