# 报告 75：LangGraph Python Pregel Durability 与 Agent Server 队列、认证及恢复边界源码研究

> 日期：2026-10-31  
> 研究阶段：只读源码 / 官方文档审计；未批准开发  
> 固定源码：langchain-ai/langgraph commit e5c961d7fbe7ca6fdd4c94c84d90511372514d55  
> 包版本：langgraph 1.2.19；langgraph-checkpoint-sqlite 3.1.3；langgraph-checkpoint-postgres 3.2.0  
> 证据等级：S = 固定源码事实；D = 官方产品 / 数据库文档；I = 基于源码控制流的推断；U = 现有可读材料不能证明  
> 执行纪律：没有运行测试、POC、benchmark、crash/race injection、真实 Provider / Tool / Server 请求；没有修改业务代码、Kernel 或 ADR。

## 0. 本轮研究问题与边界

本轮接续报告 72–74 中未完成的 LangGraph Server 与 Python Core 研究，聚焦五个问题：

1. LangGraph 开源 Core、CLI、SDK 与 Agent Server 的真实边界在哪里？
2. Server 如何组织 API、Queue Worker、PostgreSQL、Redis 与执行恢复？
3. Python Pregel 的 checkpoint durability、pending writes 和持久化顺序到底保证什么？
4. SQLite / PostgreSQL saver 的事务边界、WAL、fsync 与多 Worker 适用范围是什么？
5. Server AuthN / AuthZ 是否默认启用，Thread owner 与 Core checkpoint storage 是否形成真正的租户隔离？

**证据限制：** LangGraph Server / langgraph-api 不在公开仓库源码中。Server 的 Worker Lease、队列表、调度器、取消执行器和事件恢复只能以官方文档为证据，不能伪装成源码结论。

## 1. 固定版本与开源边界

### 1.1 固定基线

| 组件 | 固定版本 / 基线 | 本轮用途 |
|---|---|---|
| langgraph | 1.2.19 | Python Pregel / graph loop / durability |
| langgraph-checkpoint-sqlite | 3.1.3 | 同步与异步 SQLite saver |
| langgraph-checkpoint-postgres | 3.2.0 | PostgreSQL checkpoint saver |
| langgraph-sdk | 当前仓库 commit | AuthN / AuthZ handler contract |
| langgraph-cli | 当前仓库 commit | dev / up / Docker topology |
| Agent Server | 闭源运行时 | 仅采用官方架构与部署文档 |

固定源码链接：

- [langgraph pyproject](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/langgraph/pyproject.toml)
- [checkpoint-sqlite pyproject](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-sqlite/pyproject.toml)
- [checkpoint-postgres pyproject](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-postgres/pyproject.toml)

### 1.2 Server 不是公开 Core 源码的一部分

**S：** 仓库 .github/THREAT_MODEL.md 将以下组件列为范围外：

- LangGraph Server / langgraph-api：closed-source server runtime；
- LangChain Core；
- 用户应用代码与部署基础设施。

该 Threat Model 的生成时间为 2026-03-28，基于旧 commit 0ba22143，且文档自身声明为自动生成、实验性、非权威。因此这里只把它作为源码可见范围的线索，不能把它当成当前 Server 安全保证。

**S：** CLI 的 langgraph dev 从 langgraph_api.cli 导入 run_server；CLI 配置默认基础镜像为 langchain/langgraph-api，distributed 模式使用 langchain/langgraph-executor。

**S：** 当前仓库 libs/sdk-py/integration/docker-compose.yml 的注释说明其 API 镜像基础层包含 langgraph-api、langgraph_runtime_postgres、langgraph_license 和 Go core-server；测试容器在此基础上安装本仓库的 LangGraph Core 与 checkpoint 包。

来源：

- [Threat Model](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/.github/THREAT_MODEL.md#L1-L40)
- [CLI dev import](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/cli/langgraph_cli/cli.py#L763-L855)
- [CLI base image selection](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/cli/langgraph_cli/config.py#L1701-L1711)
- [Integration image boundary](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/sdk-py/integration/docker-compose.yml#L36-L87)

**结论：** 本轮能够审计 Core saver、Pregel、SDK Auth 与 CLI topology 生成逻辑；不能审计 Agent Server 内部队列、Lease、调度器和 Go core-server 的具体实现。

## 2. Agent Server 的生产执行拓扑

### 2.1 API 与 Queue Worker 是可独立扩展的职责

**D：** 官方 Agent Server / scale 文档描述了三类部署形态：

1. **Combined Queue Worker**：API Server 与 Queue Worker 管理逻辑位于同一部署，CLI 默认基础镜像对应此模式。
2. **Split API / Queue Worker**：API Server 与 Queue Worker 独立部署、独立扩缩容。
3. **Distributed Runtime**：API Server、Orchestrator、Executor 分离。CLI 源码在 distributed 模式生成独立 executor 镜像；完整 Orchestrator / Executor 运行时代码仍在闭源镜像中。

官方文档还区分了 API request concurrency 与 Agent run concurrency。API Server 接收请求并创建 Run；Queue Worker 执行实际 Agent Run。默认每个 Worker 的并发 Run 数为 10（N_JOBS_PER_WORKER），可通过 Worker 数量与每 Worker job 数控制总并发。

**D：** Worker Lease 保证同一 Thread 同一时刻最多一个 Run 被执行。官方文档说明 Worker 被中断后，Run 可以从最后一个持久化 Checkpoint 恢复。至少需要一个 Queue Worker 才能消费队列。

来源：

- [Agent Server architecture](https://docs.langchain.com/langsmith/agent-server)
- [Configure Agent Server for scale](https://docs.langchain.com/langsmith/scale)
- [CLI topology generation](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/cli/langgraph_cli/config.py#L1701-L1711)
- [CLI distributed runtime compose generation](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/cli/langgraph_cli/config.py#L1872-L1928)

### 2.2 Run 生命周期的可确认部分

根据官方 Agent Server 文档，可建立以下外部可见状态链：

1. 客户端提交 Run 请求。
2. Server 创建 Pending Run 并持久化，HTTP 请求不需要等待整个 Agent 执行结束。
3. Worker 从队列获取任务并持有该 Run 的 Lease。
4. Worker 运行 Graph，Graph Checkpointer 持久化执行状态。
5. 同一 Thread 的其他 Run 不会与当前 Run 并发执行。
6. Worker 被中断后，Server 可以尝试从最近的持久化 Checkpoint 恢复。
7. Run 进入终态，Worker 释放执行容量。

**I：** 这意味着 Agent Server 的可靠性不是只靠 Pregel Checkpointer，而是依赖 Run Queue、Lease、Worker Recovery 与 Checkpoint 的组合。

**U：** 公开文档没有给出 Lease 的具体表结构、owner token、heartbeat 周期、TTL、续租失败策略、fencing epoch、进程死亡检测时限或 stale worker 写入拦截方式。不能据“有 Lease”推断它已经实现强 fencing。

### 2.3 扩缩容维度

**D：**

- API Server 主要按 HTTP 请求量扩展。
- Queue Worker 主要按 Pending / Running Runs 与每 Worker 并发容量扩展。
- Self-hosted operator 可结合 CPU HPA 与 KEDA；官方当前文档说明队列 Worker 可按 Pending / Running Run 指标扩容。
- API 和 Worker 可以分开扩展，不应把请求吞吐和模型/工具执行吞吐当作同一个容量指标。

**架构结论：** Agent Kernel 应将 API admission、Run scheduling 与 Agent execution 分成不同的容量域。一个 API replica 不应等同于一个 Agent 执行槽。

## 3. PostgreSQL 与 Redis 的职责边界

### 3.1 PostgreSQL 是持久化事实源

**D：** LangSmith Data Plane 文档明确：

- PostgreSQL 保存 threads、runs、assistants、crons 与 long-term memory。
- PostgreSQL 也是默认 Checkpoint backend。
- 即使 Checkpoint 改用 MongoDB，PostgreSQL 仍然必需，用于其他 Server resources。

因此，MongoDB 替代的是 checkpoint storage，不是 Agent Server 的全部持久化层。

### 3.2 Redis 是通信和临时元数据设施

官方 Data Plane 文档逐项说明：

| 功能 | Redis 中的内容 | 真实数据来源 / 结果 |
|---|---|---|
| Worker wake-up | List 中只有 Sentinel | Worker 再从 PostgreSQL 读取 Run |
| Cancellation | String + Pub/Sub signal | 向对应 Worker 发送取消请求 |
| Streaming output | Pub/Sub channel | 事件实时转发，不在 Redis 保存 |
| Retry attempt | 短 TTL String | 只记录 attempt number，最多 3 次 |
| Run / Thread / Checkpoint | 不存储 | PostgreSQL |

官方文档当前描述的自动重试范围是执行期间遇到的 transient PostgreSQL errors；每个 Run 最多 3 次。它不是任意 Tool / Model / Business error 的通用 retry policy。

来源：[LangSmith Data Plane](https://docs.langchain.com/langsmith/data-plane)

### 3.3 对恢复语义的影响

**S/D：** Redis wake-up 不是 Run 的持久化事实源；实际 Run 由 Worker 从 PostgreSQL 读取。Redis Pub/Sub 不保存输出事件。

**I：** 这使得 Redis 重启或 Pub/Sub 断连不应被等同于 Run 数据丢失，但会影响实时唤醒、取消传播或当前 streaming 连接。

**U：** 官方文档没有完整说明 Redis 全量丢失后 Worker 如何重新发现所有 Pending Runs、断连客户端能否从持久化 Event Log 重放完整输出、取消信号丢失时如何收敛，以及 streaming cursor 是否能跨 Worker / API restart 恢复。

**架构建议：** Redis 只能做可重建的通知层；不能作为 Event Log、Operation Ledger 或 Run 状态的唯一事实源。

## 4. Python Pregel 的 Checkpoint Durability

### 4.1 三种 durability 模式

Python Core 的 durability 类型包含 sync、async、exit。官方 persistence 文档将默认模式描述为 async。

| 模式 | 可确认行为 | 故障窗口 |
|---|---|---|
| sync | 当前 superstep 完成后等待 Checkpoint Future，再继续后续执行 | Checkpoint ACK 增加关键路径延迟 |
| async | Checkpoint 在后台保存，Graph 可以继续推进 | 下一步执行时，前一 Checkpoint 可能尚未完成 |
| exit | 中间步骤不按常规节奏保存，Graph 退出路径保存最终 Checkpoint | 运行中进程硬崩溃可能丢失多个未持久化步骤 |

源码：

- [Durability type](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/langgraph/langgraph/types.py#L98-L104)
- [sync stream barrier](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/langgraph/langgraph/pregel/main.py#L3077-L3082)
- [async stream barrier](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/langgraph/langgraph/pregel/main.py#L3546-L3550)
- [PregelLoop checkpoint scheduling](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/langgraph/langgraph/pregel/_loop.py#L1237-L1381)

### 4.2 Checkpoint 保存不是简单的 fire-and-forget

**S：** Python PregelLoop 的 _put_checkpoint：

1. 创建新的 checkpoint snapshot。
2. 计算 channel version delta。
3. 把本次 checkpoint 依赖的 DeltaChannel write futures 拿出来。
4. 将保存任务提交到 background executor。
5. 新的 checkpoint save 等待前一个 checkpoint save future。
6. 通过 _checkpointer_put_after_previous 保证同一 loop 的 checkpoint 保存顺序。

源码注释明确说明：后台保存可能乱序开始，所以必须链式等待 previous checkpoint；否则 checkpointer 可能收到错误 checkpoint 的 writes。

**S：** DeltaChannel 另有持久化顺序约束。代码先等待依赖的 delta writes，再保存读取这些 writes 的 checkpoint，避免 checkpoint 已可见但依赖数据尚未落库。

**架构判断：** LangGraph 的持久化正确性不仅依赖 saver 的 put()，还依赖 PregelLoop 的 Future 排序、delta-write barrier 与 step durability policy。

### 4.3 失败与重放边界

**T：** 上游 test_delta_channel_write_failures.py 定义了以下测试：

- Delta write 失败后，重试时不得静默丢失该写入；
- Checkpoint save 失败后，不应基于未成功保存的 checkpoint 向前构建；
- 同步与异步执行路径均有相应测试定义。

本轮只读测试源码，没有运行这些测试。测试定义不能证明真实 PostgreSQL crash、机器断电、网络分区或外部工具副作用恢复。

**I：** sync 只把 Checkpoint commit 放到下一步执行之前，不会把 Tool 的远端副作用与 Checkpoint 放入同一个事务。若一个外部工具已经成功执行，而 Checkpoint 尚未持久化，恢复后该 Node / Tool 仍可能再次执行。

因此：

- Checkpoint 是 Graph state recovery mechanism；
- Pending Writes 是 task completion / partial superstep recovery 数据；
- 二者都不是外部副作用 receipt；
- Graph 恢复不能被解释成 Tool exactly-once。

**架构建议：** 所有非事务型外部副作用仍需要稳定 operationId、effect key、Host receipt、queryOutcome / UNKNOWN 与 reconciliation。

## 5. SQLite Checkpointer：WAL、同步与多进程限制

### 5.1 LangGraph SQLite Saver 的实际实现

**S：**

- SqliteSaver 文档明确定位为 lightweight synchronous use cases，并明确说不扩展到 multiple threads。
- AsyncSqliteSaver 使用 aiosqlite 与 asyncio lock；文档不建议用于生产 workload，原因是 SQLite 写性能。
- 两种 saver 的 setup 都执行 PRAGMA journal_mode=WAL。
- saver setup 未显式设置 PRAGMA synchronous=FULL 或 NORMAL。
- 同步 saver 的 cursor() 在每次 context 退出时 commit；put() 与 put_writes() 是不同调用、不同 commit。
- 异步 saver 的 aput() 与 aput_writes() 也分别执行 commit。

源码：

- [SqliteSaver class and limitations](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py#L49-L84)
- [SqliteSaver WAL / schema](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py#L134-L184)
- [SqliteSaver cursor commit](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py#L187-L208)
- [SqliteSaver put / put_writes](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py#L400-L496)
- [AsyncSqliteSaver WAL / setup / aput / aput_writes](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/aio.py#L310-L359) and [L524-L616](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/aio.py#L524-L616)

### 5.2 WAL 并不等于多主写入或跨主机共享存储

**D：** SQLite 官方 WAL 文档明确：

- WAL 依赖同一台机器上进程共享的 wal-index / shared memory。
- WAL 不支持通过 network filesystem 让不同主机共享同一个 database file。
- WAL 允许 reader 与 writer 并发，但一个 WAL file 同时只有一个 writer。
- WAL 需要独立 checkpoint 操作；默认自动 checkpoint 阈值约为 1000 pages。

来源：[SQLite WAL](https://www.sqlite.org/wal.html)

**结论：** 多 Pod / 多主机通过 NFS、EFS 或类似共享文件系统共用一个 WAL SQLite 数据库，不是可接受的 Agent Server 持久化拓扑。SQLite 更适合单机开发、小型单实例或本地桌面场景；分布式 Worker 应使用 PostgreSQL 等服务端数据库。

### 5.3 synchronous 与真正的 power-loss durability

**S：** LangGraph saver 只显式设置 WAL，没有显式覆盖 PRAGMA synchronous。

**D：** SQLite 官方说明：

- WAL + synchronous=FULL 会在每次事务提交后额外同步 WAL，提供更强的 power-loss durability。
- WAL + synchronous=NORMAL 保持数据库一致性，但事务在 power loss / system crash 后可能回滚。
- 应用进程自身崩溃与操作系统 / 机器掉电是不同故障等级。

来源：[SQLite PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)

**U：** 仅凭 LangGraph saver 源码不能得出实际运行环境的 synchronous 值；它取决于 SQLite runtime、连接设置和部署配置。不能把 WAL 直接写成“每次 commit 已 fsync”。

### 5.4 2026 年 SQLite WAL-reset bug 是必须核验的版本风险

**D：** SQLite 官方 WAL 文档记录：WAL-reset bug 可能影响 SQLite 3.7.0 至 3.51.2；SQLite 3.51.3（2026-03-13）及后续版本修复。触发条件包括同一 WAL 数据库存在多个连接，并发 write / checkpoint 在非常窄的时序窗口相遇。官方称其概率很低，但建议升级到修复版本。

来源：[SQLite WAL-reset bug](https://www.sqlite.org/wal.html#the_wal_reset_bug)

**S/U：** LangGraph checkpoint-sqlite 包本身没有把 Python 所链接的 SQLite C library 版本固定为 3.51.3+；Python stdlib sqlite3 / aiosqlite 的实际 SQLite runtime 取决于部署环境。

**架构建议：** 若继续使用 SQLite WAL，启动时必须读取并记录 sqlite3.sqlite_version，验证版本至少为 3.51.3；不能仅检查 Python 或 LangGraph 包版本。

## 6. PostgreSQL Checkpointer：事务范围与多租户边界

### 6.1 表结构与主键

**S：** PostgreSQL saver 将 checkpoint、channel blobs 与 task writes 分开存储：

- checkpoints：thread_id + checkpoint_ns + checkpoint_id；
- checkpoint_blobs：thread_id + checkpoint_ns + channel + version；
- checkpoint_writes：thread_id + checkpoint_ns + checkpoint_id + task_id + idx。

Checkpoint / Writes 使用复合唯一键与 upsert / insert-ignore 语义，支持重复写入时按 channel 类型采取不同冲突策略。

来源：

- [Postgres checkpoint schema / migrations](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-postgres/langgraph/checkpoint/postgres/base.py)
- [PostgresSaver put](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-postgres/langgraph/checkpoint/postgres/__init__.py#L268-L350)
- [PostgresSaver put_writes](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/checkpoint-postgres/langgraph/checkpoint/postgres/__init__.py#L352-L384)

### 6.2 单次 put 内部的事务范围

**S：** PostgresSaver.put() 在同一个 _cursor(pipeline=True) 中先写 checkpoint blobs，再写 checkpoint row。

**D：** Psycopg 3 pipeline mode 即使在 autocommit 下，也会把 pipeline 中的 statements 放在隐式事务中，在 Sync 时提交；pipeline 发生错误时，该组命令的事务会中止。

来源：[Psycopg Pipeline mode](https://www.psycopg.org/psycopg3/docs/advanced/pipeline.html#synchronization-points)

因此，标准 pipeline 路径下，同一次 put() 的 blob 与 checkpoint row 作为一组提交。若 pipeline 不可用，源码回退到 connection transaction context。

但 put_writes() 是另一个 _cursor(pipeline=True) 调用，因此它与 put() 不是一个跨方法的共享事务。SQLite saver 也将 put 与 put_writes 分开 commit。

**架构判断：** Saver 的事务边界是 Checkpointer 内部操作级，而不是“整个 superstep 的 task writes + checkpoint + Run status + external effects”组成的统一事务。

### 6.3 Checkpointer 不是 Run Queue，也不是 Owner Fence

**S：** 上述 checkpoint 表按 thread / namespace / checkpoint / task key 组织；核心 saver schema 没有 tenant_id、user_id、lease_owner、worker_epoch 等强制隔离列。PostgresSaver 的 lock 是 saver 实例内的进程级同步，不是跨主机 owner lease。

**I：** 直接持有数据库连接的调用者可以绕过 Agent Server API 的 metadata ACL；因此不能把 Server 的 Thread owner filter 当成数据库层租户隔离。

**U：** Agent Server 可能在自己的私有 Run / Thread 表、SQL query 或 Worker Lease 层实现额外隔离和 fencing，但公开源码不能证明其具体机制。

**架构建议：** 目标 Kernel 的 Run Queue、Checkpoint Store、Operation Ledger、Tenant/Owner Authority 应是不同概念；不能把 thread_id 当作身份，也不能把 Checkpointer 的本地 lock 当成分布式 writer fencing。

## 7. AuthN / AuthZ：默认安全模型与常见配置陷阱

### 7.1 Authentication 与 Authorization 分开

**D：** 官方 Auth 文档将两者分开：

- @auth.authenticate：每个请求执行，校验 token / API key 并返回 identity。
- @auth.on：按资源和动作执行授权，返回 metadata filter、修改创建 payload，或抛出 403。

langgraph_auth_user 可被注入 Graph config，供节点执行用户授权操作；官方明确建议从 Secret Store 读取用户凭据，不要把 secret 放入 Graph state。

来源：

- [Authentication & access control](https://docs.langchain.com/langsmith/auth)
- [Add custom authentication](https://docs.langchain.com/langsmith/custom-auth)

### 7.2 Self-hosted 默认没有 Authentication

**D：** 官方安全默认模型明确区分：

- LangSmith managed：默认使用 LangSmith API key。
- Self-hosted：默认没有 authentication，安全模型由部署者自行实现。

官方 Custom Auth 文档也说明：如果没有自定义 @auth.authenticate，Server 看到的只是 API-key owner（通常是开发者），请求不会自然地按最终用户隔离。

**安全结论：** Self-hosted Agent Server 不应直接暴露到不可信网络；必须配置真实的 AuthN / AuthZ 或由可信 Gateway 提供等价控制。

### 7.3 Auth SDK 的默认授权与 handler 优先级

**S：** SDK Auth 源码说明：没有注册 global authorization handler 时，未匹配资源的请求按允许处理。官方文档提供 global reject_unhandled_requests 作为 default-deny 模式。

但 handler 不是逐层累积执行：

1. Global @auth.on；
2. Resource @auth.on.threads；
3. Action @auth.on.threads.create。

每个请求只执行最具体的匹配 handler；更具体的 handler 会覆盖较宽泛 handler，而不是先执行 global deny 再执行 resource handler。

**I：** 只配置一个 global deny，再添加一个宽泛 resource handler，并不代表 global deny 仍会覆盖该资源的所有动作。Resource handler 必须明确实现自己允许的动作与拒绝策略。

来源：

- [Auth SDK implementation](https://github.com/langchain-ai/langgraph/blob/e5c961d7fbe7ca6fdd4c94c84d90511372514d55/libs/sdk-py/langgraph_sdk/auth/__init__.py)
- [Handler precedence / default deny examples](https://docs.langchain.com/langsmith/auth#resource-specific-handlers)

### 7.4 Owner metadata 必须在创建时写入，读取时再过滤

官方示例在创建 Thread 时写入 metadata.owner = ctx.user.identity，在 read / search 时返回相同 owner filter。Runs 除 create_run 外，通常继承父 Thread 的授权路径。

Store 的授权方式不同：需要重写 namespace，而不是仅返回 metadata filter。

**I：** 这套模型依赖应用开发者在资源创建、读取、更新、删除、搜索与 Run 创建路径中正确配置 handlers；它不是 Core Checkpointer 自带的 row-level tenant enforcement。

**架构建议：** 目标 Kernel 默认 deny；每个 resource/action 都有明确授权合同；owner / tenant 由服务端权威写入，不能由客户端 payload 指定；DB 查询也应带 tenant partition，而不是只靠 API 层 metadata filter。

## 8. 事实、推断与未知汇总

| 等级 | 结论 |
|---|---|
| S | Python LangGraph 1.2.19 Core 支持 sync / async / exit durability；sync 在下一步之前等待 checkpoint future；checkpoint save 按顺序串行化，DeltaChannel writes 有前置等待。 |
| S | SQLite saver 使用 WAL；没有显式设置 synchronous；sync saver 声明不扩展到多线程；async saver 使用单连接与实例级 asyncio lock。 |
| S | Postgres saver 的一次 put 将 blobs 与 checkpoint row 放入同一 pipeline / transaction；put_writes 是独立 saver 操作。 |
| S | Core checkpoint schema 以 thread / namespace / checkpoint / task 为 key，不是 Tenant/Lease/Run Queue 数据模型。 |
| S | CLI 使用闭源 langgraph-api / executor 镜像；开源仓库不包含 Agent Server 内部执行引擎。 |
| D | Agent Server 的数据面使用 PostgreSQL 保存 Run / Thread / memory / default checkpoints；Redis 用于 Worker 通信和临时元数据。 |
| D | Worker Lease 保证同 Thread 不并行执行多个 Run；Worker 中断后可从最后一个 Checkpoint 恢复。 |
| D | Redis Pub/Sub 输出不保存事件；目前文档描述的自动重试主要针对 transient PostgreSQL errors，最多 3 次。 |
| D | Self-hosted Agent Server 默认没有 authentication；自定义 AuthN 与 AuthZ 由部署者实现。 |
| I | async 模式在硬崩溃时可能回到较旧的持久化 checkpoint；外部副作用可能因 Node 重放而重复。 |
| I | Redis 是可重建协调层，不应成为 durable Run / Event / Operation 事实源。 |
| I | Server metadata owner filter 不是 Core checkpoint DB 的租户隔离；直接 DB 访问可绕过 API handler。 |
| U | Server Lease 的 heartbeat、TTL、owner token、epoch fencing、stale worker write rejection。 |
| U | Worker hard kill、Redis outage、Pending Run orphan recovery、stream event replay 与 cross-worker cursor 的完整合同。 |
| U | Agent Server 内部 Run 状态表、队列 claim SQL、事务隔离级别、checkpoint 与 Run status 的跨表原子性。 |
| U | 部署实际 SQLite runtime 版本、effective synchronous、底层磁盘/volume fsync 与断电恢复。 |

## 9. 对目标 Agent Kernel 的架构影响（研究建议，不是批准的 ADR）

### 9.1 必须分离的四类持久化对象

1. **Run Control Ledger**：Pending / Claimed / Running / Waiting / Completed / Failed / CancelRequested / Interrupted。
2. **Graph Checkpoint Store**：保存可恢复的模型上下文、节点状态、channel versions 与 task writes。
3. **Operation / Effect Ledger**：稳定 operationId、attemptId、effectKey、Host receipt、UNKNOWN、queryOutcome 与 reconciliation。
4. **Event Log**：持久化 eventSeq、cursor、snapshot consistency 与客户端 replay。

Checkpoint 只能证明 Graph state 被保存；不能证明外部 Tool effect 已完成。

### 9.2 Queue / Worker 合同

- Run admission 写入 durable queue / outbox。
- Worker claim 必须返回 lease + 单调递增 fencing epoch。
- 每次写 Run state / checkpoint metadata / effect receipt 都验证 owner epoch。
- Lease 过期不能只依赖 wall clock；必须防止 stale worker 在新 owner 接管后继续写入。
- Redis / NATS 只负责 wake-up / pubsub；丢失通知后可从 durable queue 重建。

### 9.3 Effect 与恢复

- Tool execute 前持久化 operation intent。
- 支持 idempotency key 的 Provider / Host 必须显式声明 dedup scope 与 retention。
- 不支持 queryOutcome 的 effect 在 ACK 丢失时进入 UNKNOWN，不能自动重发。
- CancelRequested、CancelAccepted、ProcessTerminated、EffectTerminal 是不同事实。
- Agent checkpoint、Tool receipt 与 Run terminal state 不应共享一个模糊的 success 标志。

### 9.4 Storage 与 Security

- SQLite 只作为单机开发 / 本地持久化 adapter；多主机 Worker 使用 PostgreSQL。
- Storage adapter 明确声明 A0–A3 commit ACK / fsync / replication guarantee。
- Self-hosted API 默认 deny；每个资源动作显式授权。
- tenant_id / owner_id 必须进入权威数据模型和数据库访问路径。
- Thread ID 只是资源 ID，不是授权凭证。
- 取消、权限撤销和 Host side effect 需要 last-mile enforcement。

## 10. 未决问题与下一步

1. 继续审计 Agent Server 的 Double-texting / multitask_strategy / interrupt / cancel / retry，明确同 Thread 的排队、拒绝、打断和旧 Run 终态语义。
2. 研究 v3 streaming protocol 的 event cursor、snapshot consistency、reconnect / replay 与跨 API / Worker 迁移。
3. 对 Worker Lease / heartbeat / fencing 做进一步官方资料审计；若仍无源码，明确保留为未知，不猜测私有实现。
4. 交叉核对 LangGraph JS 1.5.3 与 Python 1.2.19 在 Pregel durability、Pending Writes、Postgres transaction 与 Auth 的 parity。
5. 将 LangGraph 结果与 Temporal / Restate / DBOS / Pi Durable / Claude Host 的 Run queue、writer fencing、external effect receipt 对照，评估 v0.2 是否需要补充合同。
6. SQLite 本地模式若进入后续动态验证，必须先记录 sqlite3.sqlite_version、effective PRAGMA synchronous、文件系统、WAL sidecar、checkpoint 与 crash/power-loss 条件。

## 11. 验证状态

- 固定源码只读审计：完成。
- 官方文档阅读：完成。
- 上游测试定义阅读：部分完成。
- pytest / unit tests：NOT RUN。
- POC / benchmark：NOT RUN。
- Worker kill / Redis outage / DB failover：NOT RUN。
- SQLite multi-process / WAL-reset / power-loss：NOT RUN。
- Auth bypass / cross-tenant test：NOT RUN。
- 真实 Model / Tool / Provider / MCP 操作：NOT RUN。
- 业务代码、Kernel、开发测试、ADR：未修改。

**开发批准状态：未获得。继续研究不代表允许开发。**
