# 72：LangGraph JS Pregel 执行引擎、Pending Writes 与 Interrupt 恢复边界（2026-10-31）

> **状态：静态源码研究；未获开发批准。** 本报告研究 Agent 图执行/检查点语义，不把 LangGraph 与 Temporal/Restate/DBOS 视为同层产品。固定源码为 langchain-ai/langgraphjs @ commit b09eb0662358457955131fe0bfec1d7c11e7d7c5；libs/langgraph-core/package.json 为 @langchain/langgraph 1.5.3、MIT、Node >=18。
>
> 证据标记：F=固定源码事实；T=上游测试定义（未运行）；D=官方文档；I=架构推断；U=未知。本轮未运行测试、POC、crash injection、Provider/MCP/Shell 或真实数据库。

## 0. 结论摘要

LangGraph JS 是 Pregel 风格的 Agent/Workflow graph orchestrator。它将节点执行、并行 superstep、channel reducer、task checkpoint、interrupt 和 time travel 结合起来。

1. **双层 checkpoint 是主要参考价值**：superstep 边界保存完整图状态；同一 superstep 中成功 task 的 Pending Writes 可以先独立保存。兄弟 task 失败时，恢复可重用成功 task 结果，而不必重跑整个并行批次。
2. **Pending Writes 不是外部副作用收据**：外部 HTTP/MCP/Shell/模型调用可能已经产生效果，但 task writes 尚未持久化；恢复仍可能重复外部操作。
3. **durability=sync 不是 effect commit barrier**：固定源码在 superstep 完成后等待 checkpointer promises，再进入下一 superstep；它不保证外部副作用前先提交 OperationIntent，也不证明底层 DB 已 fsync/同步复制。
4. **interrupt() 是异常驱动暂停**：需要 checkpointer；恢复从 node 函数开头重跑，interrupt 前的代码和副作用会再次执行。
5. **ToolNode 不是可信 Tool Host**：它支持并发工具调用、传递 toolCallId、将普通异常映射为 ToolMessage；core 路径没有本项目需要的 Operation/Effect Ledger、Permission Authority 或 OS sandbox。
6. **LangGraph 是 Domain Orchestration 参考，不是通用 Durable Runtime**：task checkpoint/reducer/interrupt 可吸收；外部效果仍需独立 Host evidence。

## 1. 固定源码地图

| 层 | 文件 | 关键实现 |
|---|---|---|
| 主循环 | libs/langgraph-core/src/pregel/index.ts | 创建 PregelLoop / PregelRunner、循环 tick |
| 状态机 | libs/langgraph-core/src/pregel/loop.ts | tick、putWrites、checkpoint、恢复和 Pending Writes reapply |
| 并发执行 | libs/langgraph-core/src/pregel/runner.ts | task fan-out、retry、settle、commit |
| 重试/超时 | pregel/retry.ts、pregel/timeout.ts | attempt 清理、retry policy、AbortSignal、late writes |
| 中断 | libs/langgraph-core/src/interrupt.ts | checkpointer、resume index、GraphInterrupt |
| 工具节点 | libs/langgraph-core/src/prebuilt/tool_node.ts | toolCallId、Promise.all、ToolMessage 错误映射 |
| Agent 图 | libs/langgraph-core/src/prebuilt/react_agent_executor.ts | agent↔tools conditional loop、v2 Send fan-out |
| Checkpointer | libs/checkpoint/src/base.ts | put / putWrites / getTuple / list |
| DB adapter | libs/checkpoint-postgres/src/index.ts、checkpoint-sqlite/src/index.ts | checkpoint 与 task writes 存储 |

源码链接：
- [固定 commit](https://github.com/langchain-ai/langgraphjs/tree/b09eb0662358457955131fe0bfec1d7c11e7d7c5)
- [PregelLoop](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/loop.ts)
- [PregelRunner](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/runner.ts)
- [interrupt](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/interrupt.ts)
- [ToolNode](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/prebuilt/tool_node.ts)
- [PostgresSaver](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/checkpoint-postgres/src/index.ts)
- [SqliteSaver](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/checkpoint-sqlite/src/index.ts)

## 2. Pregel 执行与 Agent 图

**F：** PregelLoop.tick() 计算下一批 tasks；PregelRunner.tick() 并发执行 pending tasks。节点写入 channel/reducer，在 superstep 边界合并，后续 superstep 消费合并后的状态。

**F：** createReactAgent() 装配 StateGraph：agent 节点调用模型，tools 节点使用 ToolNode，conditional edge 根据尚未回填 ToolMessage 的 tool calls 决定继续工具节点还是结束。v2 分支为每个 pending tool call 生成 Send("tools", ...) 独立任务。

**F：** ToolNode.runTool() 将 toolCallId 传给工具 runtime；run() 对多个 pending tool calls 使用 Promise.all；普通异常默认转为 error ToolMessage，GraphInterrupt 继续向运行时传播。

源码：[react_agent_executor.ts L855–940](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/prebuilt/react_agent_executor.ts)、[tool_node.ts L210–260、L300–330](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/prebuilt/tool_node.ts)。

**I：** Promise.all 只是工具并发，不是按文件、DB 行、网络目标、锁或 capability 建立读写冲突图的资源调度器。

## 3. 双层 checkpoint 与 Pending Writes

### 3.1 Task-level writes

**F：** PregelLoop.putWrites(taskId, writes) 规范化 message IDs、清理旧 task writes、保存本轮 pending writes，并在 durability 非 exit 时调用 checkpointer.putWrites(config, writes, taskId, taskPath)，跟踪其 Promise。

**F：** PregelRunner 在 task settle 后调用 _commit；成功 task 的 writes 交给 loop.putWrites；失败 task 写入 ERROR 等控制记录。runner 通过 Promise race 收集并发任务完成。

源码：[loop.ts L978–1065](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/loop.ts)、[runner.ts L124–205、L300–475](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/runner.ts)。

### 3.2 Superstep checkpoint 与恢复

**F：** superstep 完成后 loop 应用 writes 到 channels，保存完整 checkpoint；sync 模式再等待本轮 checkpointer promises。恢复时根据 checkpoint 和 pending writes 重建 task；skipDoneTasks 路径通过 _reapplyWritesToSucceededNodes() 重用已完成 task 的写入，只执行尚无 writes 的 task。

源码：[loop.ts L1240–1300、L1310–1378](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/loop.ts)。

**T：** 上游 checkpoint.test.ts 的 should test pending writes resume functionality 定义了 one 节点成功、two 节点失败并重试的场景。恢复后 one.calls 仍为 1，two.calls 增加；two 成功后最终 reducer 结果正确。测试使用 MemorySaver，本轮未运行。

源码：[checkpoint.test.ts L1109–1275](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/tests/python_port/checkpoint.test.ts)。

**证据限制：** 该测试证明 Pending Writes 算法定义，不证明真实进程崩溃、断电、外部副作用或数据库生产耐久性。

### 3.3 Reducer 重放顺序

**F：** BaseCheckpointSaver.putWrites() 接受 taskPath；接口注释要求 getTuple()/list() 返回 pendingWrites 时按 writesSortKey 顺序排列，因为 order-sensitive reducer 在重放换序后可能得到不同状态。

源码：[base.ts L190–245](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/checkpoint/src/base.ts)。

**I：** 并发 task 完成顺序可以不确定，但 reducer replay 顺序必须确定；外部事实/Receipt 的时间顺序与图状态规范合并顺序应分开建模。

## 4. Durability 与真实存储边界

**F：** 固定源码解析 durability 默认值为 async。exit 模式不做 task-level 增量保存；async 可与后续 step 并行保存；sync 在 superstep 完成后等待 outstanding checkpointer promises。

源码：[pregel/index.ts L2168–2173](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/index.ts)、[loop.ts L1240–1300、L1409–1448](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/loop.ts)。

官方文档说明：首次 input checkpoint 还未 durable 时，用户节点可能已开始执行；此时进程崩溃可能造成“从未调用”和“已接受但未持久”无法区分，建议在 checkpointer 外先持久化 admission/outbox。

来源：[LangGraph Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)。

**F：PostgresSaver** 的 put() 将 checkpoint blobs 与 checkpoint row 放在一个 PostgreSQL transaction；putWrites() 使用另一个 transaction。

**F：SqliteSaver** 设置 WAL；checkpoint put 与 putWrites 也分开执行；setup() 没有显式设置 synchronous=FULL。

源码：[PostgresSaver L641–770](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/checkpoint-postgres/src/index.ts)、[SqliteSaver L170–225、L470–595](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/checkpoint-sqlite/src/index.ts)。

**I：** durability=sync 是 checkpointer promise barrier，不是外部 effect commit barrier；也不自动证明 fsync、同步复制或硬件持久化。外部副作用与 task completion checkpoint 之间仍有 crash window。

## 5. Interrupt、Retry、Timeout

### 5.1 Interrupt

**F：** interrupt(value) 从 graph runnable config 读取 checkpointer；无 checkpointer 时抛 MISSING_CHECKPOINTER；通过 PregelScratchpad.interruptCounter 选择 resume value；无 resume value 时创建 Interrupt 并抛 GraphInterrupt，runner 将 interrupt 写入 task Pending Writes。

源码：[interrupt.ts L92–168](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/interrupt.ts)、[runner.ts L430–465](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/runner.ts)。

**D：** 官方文档明确 resume 从发生 interrupt 的 node 函数开头重新执行；interrupt 前的代码/副作用会再次运行，多个 interrupt 的调用顺序必须稳定。副作用应放在 interrupt 之后，或使用稳定幂等键。

来源：[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)、[Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)。

**I：** interrupt 是可恢复暂停原语，不认证审批者身份，也不将 resume value 绑定到 operationId + argsHash + policyRevision。真实审批必须由 Permission Authority 与 Host gate 验证。

### 5.2 Retry / Timeout

**F：** retry attempt 开始时清空 task writes，失败后按 RetryPolicy 重跑 node。timeout 通过 Promise.race/watchdog、AbortController 和 TimedAttemptScope 清空 buffered writes，并拒绝 scope 关闭后的迟到 graph writes。

源码：[retry.ts L1–155](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/retry.ts)、[timeout.ts L160–325](https://github.com/langchain-ai/langgraphjs/blob/b09eb0662358457955131fe0bfec1d7c11e7d7c5/libs/langgraph-core/src/pregel/timeout.ts)。

**I：** AbortSignal 需要 node/tool/provider 合作消费；Promise.race 和 writes scope close 不能证明外部请求已撤销、shell 后代进程已终止或外部副作用没有发生。

## 6. 与目标架构的关系

| 维度 | LangGraph JS 1.5.3 | 目标架构 v0.2 候选 |
|---|---|---|
| 主抽象 | StateGraph / Pregel superstep / Node task | Session / Run / Turn / Task / Operation |
| 状态恢复 | thread checkpoint + task pending writes | Event Journal + Task checkpoint/projection |
| 并发 | superstep fan-out + reducer | 资源感知 Scheduler + 独占屏障 + 规范提交 |
| task 恢复 | 成功 task writes 可重用 | Task result evidence 与 Operation effect evidence 分离 |
| 外部副作用 | node/tool 作者负责幂等 | OperationIntent + Host ledger + Receipt/UNKNOWN |
| HITL | interrupt/resume | PermissionGrant + principal/scope/argsHash/policyRevision |
| 取消 | AbortSignal / timeout | Cancel intent / Host ack / effect evidence |
| 历史 | checkpoint history / time travel | immutable Event Journal |
| 多租户 | core checkpointer API 不定义 tenant ACL | API auth + Permission Authority + Host gate |

值得吸收：task-level completion checkpoint、deterministic reducer replay、显式 durability mode、interrupt/HITL 原语、Checkpoint 与 Store 分层。

不应照搬：图 checkpoint 作为唯一事件日志；ToolNode Promise.all 作为资源调度器；resume value 作为授权凭证；sync 作为外部事务屏障；AbortSignal 作为强制进程终止证明。

与报告 69–71 的层次关系：
- LangGraph：Agent graph/domain orchestration；
- Restate：durable invocation journal、Virtual Object、durable promise/signal；
- Temporal：Workflow History replay、Activity、Signal/Update、Worker/Task Queue；
- DBOS：PostgreSQL-backed Workflow/Step 与 transaction completion。

**推荐组合而非互斥选型**：图/状态机可表达 Domain Workflow；Durable Runtime 管理恢复；Operation/ModelCall/Permission/Host Effect Evidence 独立建模。

## 7. 未知与未执行

**已证实（F）**：固定源码包含 PregelLoop/PregelRunner、Pending Writes、superstep checkpoint、retry/timeout、interrupt、ToolNode；默认 durability=async；Postgres/SQLite checkpoint put 与 putWrites 分离；ToolNode 并行执行并传递 toolCallId。

**官方文档（D）**：Pending Writes 避免重跑成功 task；interrupt resume 从 node 开头重跑；time-travel replay 会重新执行 checkpoint 后节点；Checkpointer 是 thread state，Store 是跨 thread application data。

**未知（U）**：LangSmith/Agent Server 的 worker scheduling、tenant ACL、API auth、多区域 failover；真实 DB fsync/replication；同 thread 多 worker owner fencing；Python parity；部署级 retention。

**未执行**：未运行上游测试、SIGKILL/断电/DB crash injection、真实 Provider/MCP/Shell、benchmark、POC、chaos 或 failover；未修改业务代码、Kernel、开发测试或 ADR。

**研究结论**：LangGraph 的 task checkpoint/reducer/interrupt 值得吸收，但它的持久化事实是 graph state/task result，不自动成为外部 Operation effect ledger。开发阶段门禁保持：未获得用户明确批准。
