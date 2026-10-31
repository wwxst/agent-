# 报告 74：Python Deep Agents Harness、Code、ACP 与 Sandbox Provider 生命周期源码研究

> 日期：2026-10-31  
> 研究阶段：只读源码审计；未批准开发  
> 证据基线：langchain-ai/deepagents 固定 commit `3a217cec7183b601f2b33e0144e09bb50ad44f01`  
> 包版本：deepagents 0.7.32；deepagents-code 0.2.2；deepagents-acp 0.0.13  
> Python：核心 Harness 要求 >=3.11；deepagents-code 要求 >=3.14  
> 证据等级：S = 固定源码事实；T = 上游测试定义（只读、未运行）；I = 基于源码控制流的推断；U = 现有资料不能证明

## 0. 研究范围与边界

本轮将 Python Monorepo 拆成三个不同系统审计，避免把 Harness、终端产品和 Agent Protocol server 混成同一个执行引擎：

1. **deepagents Python Harness**：基于 LangChain Agent abstraction 与 LangGraph runtime，负责默认 middleware、backend、filesystem、permissions、subagents、context management。
2. **deepagents-code**：Claude Code 类终端产品，包含 Textual TUI / headless CLI、独立 LangGraph Server 子进程、RemoteAgent HTTP+SSE client、本地 SQLite checkpoint、thread ownership、workspace binding、remote sandbox provider。
3. **deepagents-acp**：Agent Client Protocol server，把 graph streaming / HITL / session replay 映射为 ACP 事件与请求。

本轮只读固定 commit 的源码、仓库架构文档、Threat Model 和上游测试定义；没有运行 pytest、benchmark、POC、crash/race injection、真实 LLM / MCP / Shell / Sandbox / ACP 请求。测试定义只能证明项目试图覆盖哪些场景，不能视为本轮运行结果或生产保证。没有修改业务代码、Kernel、开发测试或 ADR。

## 1. 固定版本与架构定位

### 1.1 固定基线

| 包 | 版本 | Python 约束 | 主要依赖 / 作用 |
|---|---:|---|---|
| deepagents | 0.7.32 | >=3.11 | LangChain >=1.4.7；Agent Harness |
| deepagents-code | 0.2.2 | >=3.14,<3.15 | deepagents 0.7.32；LangGraph SQLite checkpoint / SDK / CLI；终端 Coding Agent |
| deepagents-acp | 0.0.13 | >=3.11 | Agent Client Protocol adapter |

来源：[core pyproject](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/pyproject.toml)、[code pyproject](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/pyproject.toml)、[ACP pyproject](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/acp/pyproject.toml)。

### 1.2 Harness 不是 runtime

仓库架构文档把三层明确分开：

- LangGraph：图执行、state、checkpoint、streaming、interrupt。
- LangChain create_agent：model + tools + middleware 的 Agent loop。
- Deep Agents：在 create_agent 之上组装 planning、filesystem、subagent、skills、memory、summarization 等 Harness。

create_deep_agent() 最终调用 LangChain create_agent()；它没有另造一个 Durable Execution Engine。执行时 LangGraph 推动 graph，middleware 在 model/tool/state 边界改变行为。默认 backend 是 StateBackend。

证据：[libs/ARCHITECTURE.md](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/ARCHITECTURE.md)、[graph.py L670-L845](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/graph.py#L670-L845)、[graph.py L989-L1015](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/graph.py#L989-L1015)。

**架构判断：** Deep Agents 的主要价值在 Harness 组装与产品功能，不在底层 durable runtime。它适合作为 middleware/backend/subagent 设计样本，不能拿它替代 Temporal / Restate / DBOS 级别的 durable execution 比较。

## 2. Python Harness：权限与文件系统

### 2.1 FilesystemPermission 语义

Python 版 FilesystemPermission 提供三种效果：

- allow：直接放行。
- deny：返回权限错误。
- interrupt：通过 HumanInTheLoopMiddleware 暂停，请求用户 approve / edit / reject。

规则按声明顺序匹配，first-match-wins；没有命中规则时返回 allow。权限模式本身不是默认 deny。路径要求以 / 开始，拒绝 .. 和 ~。对 FilesystemBackend，规则同时检查请求路径和符号链接解析后的真实目标。

来源：[middleware/filesystem.py L395-L490](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/filesystem.py#L395-L490)。

Python 相比此前固定 JS 版本有一个重要改进：权限结果过滤的 _is_denied() 在 backend path 无法解析时按 denied 处理；不能解析的路径不会被默默放行。删除操作还会分析递归删除是否覆盖被 deny 的后代路径。

来源：[middleware/filesystem.py L450-L545](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/filesystem.py#L450-L545)。

**注意：** fail-closed 是 middleware 权限检查的行为，不代表 backend 文件操作与授权检查是一个原子操作。源码静态阅读不能证明并发 symlink replacement / TOCTOU 已被彻底消除。

### 2.2 Execute 不属于路径权限域

FilesystemMiddleware._set_permissions() 明确检查 backend 是否支持执行。如果 backend 支持 execute，而 permissions 不是全部约束在 CompositeBackend 路由上，则初始化抛 NotImplementedError，并明确说明 execute tool-level permissions 尚未实现。

来源：[middleware/filesystem.py L1980-L2020](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/filesystem.py#L1980-L2020)。

因此：

- read/write path permission 不能约束 shell command 内部访问的文件。
- 对 shell 的约束必须由独立 shell policy 或 OS/container boundary 执行。
- 把 filesystem permission 配置解释为 Agent 的完整文件访问边界是错误的。

### 2.3 LocalShellBackend 是宿主执行，不是 Sandbox

LocalShellBackend 的类文档明确声明：直接在 host system 上执行，没有 sandboxing、process isolation 或 security restrictions；命令以用户身份执行，可访问任意文件、执行任意程序、建立网络连接、修改系统配置和派生进程。执行使用 subprocess.run(shell=True)。

来源：[backends/local_shell.py L27-L50](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/backends/local_shell.py#L27-L50)、[L220-L245](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/backends/local_shell.py#L220-L245)。

deepagents-code 本地模式构造 LocalShellBackend 时显式使用 virtual_mode=False；这意味着文件 backend 允许绝对路径，virtual_mode 只影响 filesystem API 的路径解析，不能约束 shell。远程 sandbox 模式则把 SandboxBackendProtocol 实例直接交给 Agent，不使用本地 ShellMiddleware。

来源：[code/agent.py L3185-L3215](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/agent.py#L3185-L3215)、[backends/filesystem.py L91-L205](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/backends/filesystem.py#L91-L205)。

LocalShellBackend 设置了 start_new_session（POSIX），并使用 subprocess.run(timeout=...)；但 TimeoutExpired 分支只返回 exit code 124，没有显式的 process-group kill 逻辑。**I/U：** 不能仅凭 start_new_session 推断 timeout 时所有后代进程都被杀死；需要后续进程树实验或 Python subprocess 语义专项核验。

来源：[backends/local_shell.py L280-L365](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/backends/local_shell.py#L280-L365)。

### 2.4 Threat Model 对非交互模式的明确说明

deepagents-code 的 Threat Model 明确承认：

- 非交互模式不会请求人工工具审批。
- 非 shell 工具（包括文件修改、允许的网络请求）默认可无人值守执行。
- shell 默认禁用，只有配置 shell allow-list 才开启。
- 禁用 shell 不代表只读，也不代表文件访问被限制在项目目录；本地 backend virtual_mode=False，绝对路径和逃逸路径仍受 OS 权限约束。
- human approval、permission hooks、shell policy、HTTP URL protection、sandbox isolation 是不同控制，不能相互替代。
- Threat Model 假设 CLI 由单一已认证本地开发者运行；sandbox provider 被视为可信第三方，CLI 不负责证明 provider 内部隔离。

来源：[THREAT_MODEL.md L46-L68](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/THREAT_MODEL.md#L46-L68)、[L220-L236](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/THREAT_MODEL.md#L220-L236)。

**架构判断：** Deep Agents Code 的默认本地产品安全模型是“单用户开发者 + tool approval / allow-list + 用户机器信任”，不是多租户服务端安全模型，也不是默认 OS sandbox。

## 3. Subagent：权限继承与状态投影

### 3.1 权限与工具的继承语义

graph.py 在构造声明式子代理时：

- permissions 未配置：继承父 Agent 的 permissions。
- permissions 显式配置：整体替换父 Agent permissions。
- 显式空数组：等价于没有权限规则，middleware 默认 allow。
- tools 未配置：继承父 Agent 的工具集合。

来源：[graph.py L700-L810](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/graph.py#L700-L810)、[subagents.py L150-L171](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/subagents.py#L150-L171)。

这不是 Capability Ceiling：子代理声明可以替换父规则，而不是只能在父权限之内缩小范围。对目标内核应采用 delegation intersection：child effective capabilities 必须是 parent grant 的子集，child 不能通过空数组、middleware replacement 或新工具集合扩大权限。

### 3.2 PrivateStateAttr 与 fork 模式差异

Python 版引入 PrivateStateAttr，并在 graph assembly 时从 state schema 计算 private_state_keys，再传给 SubAgentMiddleware。普通子代理与 opaque compiled subagent 的输入/输出投影会排除 _EXCLUDED_STATE_KEYS 与 private_state_keys。

来源：[graph.py L989-L996](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/graph.py#L989-L996)、[subagents.py L647-L662](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/subagents.py#L647-L662)、[L404-L435](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/subagents.py#L404-L435)。

但 forked declarative subagent 是另一条路径：它为了让同形 graph 重建自己的 middleware context，继承 state 时只排除 _FORK_EXCLUDED_STATE_KEYS，并保留其余 private channels；源码注释明确解释这是 fork 设计意图。普通 compiled/non-fork 路径则会排除 private_state_keys。

来源：[subagents.py L52-L75](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/subagents.py#L52-L75)、[L804-L840](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/subagents.py#L804-L840)。

**架构判断：** PrivateStateAttr 比 JS 固定 denylist 更有结构化表达力，但不能概括为“所有 subagent 模式都自动隔离 private state”。fork 是刻意保留 state 的特殊模式，必须在 threat model 中单独说明。

### 3.3 Async Subagent 的 launch crash window

同步子代理在父进程内调用 runnable；异步子代理则调用远端 LangGraph API。当前启动顺序为：

1. threads.create(metadata=parent_thread_id/subagent_name)；
2. runs.create(thread_id, assistant_id, input...)；
3. 得到 thread_id/run_id；
4. 返回 Command，把 AsyncTask 状态写入父 graph state。

远端 Thread/Run 创建与父 checkpoint 写入不是同一事务。进程在第 2 步成功、第 4 步之前崩溃，可能留下远端已运行但父 Agent 不知道其 task_id 的孤儿任务。metadata 可以辅助查找父子关系，但不等于 idempotent launch/outbox。

来源：[async_subagents.py L791-L845](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/async_subagents.py#L791-L845)。

取消工具在 runs.cancel() 返回后立即将父状态更新为 cancelled；这段路径没有在写入 cancelled 前重新读取远端 Run terminal status。远端 API 的 cancel 返回究竟代表请求接受还是执行终止，需要结合 Agent Server 合同核验。

来源：[async_subagents.py L1269-L1305](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/async_subagents.py#L1269-L1305)。

## 4. Deep Agents Code：Client / Server / Session 架构

### 4.1 双进程拓扑

deepagents-code 把终端交互与 Agent 执行拆成两个进程：

- Terminal Client：Textual TUI / headless CLI，输入、审批、呈现事件、维护会话交互。
- Agent Server：独立 langgraph dev subprocess，负责 graph、model、tools、MCP、sandbox、checkpoint。
- 通信：RemoteAgent HTTP + SSE。
- Server 默认监听 127.0.0.1，端口 0 由 OS 分配 ephemeral port；每次 CLI session 启动和停止。
- 配置通过 DA_SERVER_* 环境变量传递。

来源：[THREAT_MODEL.md L64-L68](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/THREAT_MODEL.md#L64-L68)、[client/launch/server.py L46-L67](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/client/launch/server.py#L46-L67)、[server_manager.py L302-L516](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/client/launch/server_manager.py#L302-L516)。

这是产品进程隔离与职责分离，不是安全边界。Threat Model 明确记录 LANGGRAPH_AUTH_TYPE=noop、没有 auth backend；任何本机 localhost process 都可能访问这个 ephemeral API。该假设适合本机单用户 CLI，不能直接迁移为共享多租户服务端。

来源：[THREAT_MODEL.md TB10 L230-L233](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/THREAT_MODEL.md#L230-L233)、[client/launch/server.py L236-L261](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/client/launch/server.py#L236-L261)。

### 4.2 Server 生命周期与进程树清理

ServerProcess 使用 lifecycle lock / state lock / generation counter 防止并发 stop 与 restart 互相复活。POSIX 启动时 start_new_session=True，停止时面向专属 process group 发信号；优先 graceful SIGTERM，超过 grace 后升级 SIGKILL。Windows 使用独立 console process group 与 Ctrl+Break 路径。

启动失败或调用方取消时，server_manager 使用 finally 清理 server；注释特别指出 asyncio.CancelledError 是 BaseException，不能只用 except Exception 清理。Sandbox startup 则使用 shielded _open_sandbox：如果外层 coroutine 被取消，仍等待后台 enter 完成，再关闭刚创建的 context，避免 sandbox startup orphan。

来源：[client/launch/server.py L511-L535](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/client/launch/server.py#L511-L535)、[L1247-L1350](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/client/launch/server.py#L1247-L1350)、[server_manager.py L430-L516](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/client/launch/server_manager.py#L430-L516)、[server_graph.py L84-L103](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/server_graph.py#L84-L103)。

### 4.3 Thread ownership：本地跨进程 writer fencing

这是 Python Code 最值得借鉴的机制之一。

thread_ownership.py 为每个 thread 创建 OS file lock 资源：

- client reservation lock：保证同一 thread 同时只有一个客户端持有。
- writer gate：序列化新 owner 获取、token rotate 与 checkpoint mutation。
- owner token：写入 .owner 文件并通过配置/HTTP header 传给 Server。
- writer_guard：拿到 gate 后重新验证 token 与 client reservation。
- token rotate：不释放 client reservation 的情况下，使旧 server writer 立即失效。
- 不支持 SoftFileLock；明确要求 operating-system file locks。
- OwnedSqliteSaver 包装 aput、aput_writes、adelete_thread，所有 checkpoint mutation 必须经过 writer_guard。
- _finish_mutation 通过 shield 延迟传播 cancellation，确保已经进入的 DB mutation 先 settle 再退出。

来源：[thread_ownership.py L1-L180](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/thread_ownership.py#L1-L180)、[L180-L348](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/thread_ownership.py#L180-L348)。

上游测试定义包括：
- client crash 后 orphan server 的写入被 fencing；
- in-flight writer 阻止 takeover；
- saver 对 checkpoint writes / deletion 做 ownership 检查；
- token rotate 等待 in-flight write；
- cancellation during lock acquisition / DB mutation；
- failed server restart 仍 fencing old writer。

来源：[tests/unit_tests/test_thread_ownership.py](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/tests/unit_tests/test_thread_ownership.py)。本轮未运行。

**边界：** 这是共享本机数据库路径上的跨进程 lease/fencing，不是跨主机、跨可用区的分布式 lease；它保护的是 checkpoint writer，不是 shell/MCP/HTTP/provider external effect。

### 4.4 Workspace Binding：thread 与资源策略绑定

WorkspaceBinding 是 server-authoritative、immutable per-thread workspace/resource policy。SQLite 表 dcode_thread_workspaces 以 thread_id 为主键，保存 workspace_id、cwd、project_root、resource_key、config_fingerprint、workspace_config_json，以及后续 schema 增加的 policy_fingerprint/runtime_fingerprint。

绑定时原子 create-or-verify；后续 run 必须通过 require_thread_workspace 验证客户端 context 与服务端持久绑定。workspace_id 或 durable policy fingerprint 改变会拒绝；仅 runtime fingerprint（例如模型配置）变化可触发 runtime rebuild，而不重新绑定 workspace。

来源：[workspace.py L59-L80](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/workspace.py#L59-L80)、[L270-L294](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/workspace.py#L270-L294)、[L433-L475](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/workspace.py#L433-L475)、[L711-L790](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/workspace.py#L711-L790)。

**架构判断：** thread 的会话身份不应隐式决定 workspace、权限或资源策略。应保存不可变的 workspace claim，并由 server 端权威校验 policy fingerprint；模型升级与 workspace policy 变更必须分开处理。

## 5. Deep Agents Code：取消、恢复与 Context Offload

### 5.1 Pending work recovery

RemoteAgent 对 pending work 有统一判定：StateSnapshot 的 next、tasks 或 interrupts 任一非空即表示 unfinished graph work。

aupdate_state 遇到 HTTP 409（server 仍认为 thread busy）时，会取消该 thread 的 pending/running runs，使用 wait=True 等待，并重试 state update 一次；每个 run 的等待有上限。

aabandon_pending_work 执行更明确的恢复流程：

1. cancel active runs；
2. 读取当前 checkpoint；
3. 找出 trailing turn 中尚无 ToolMessage 回答的 tool calls；
4. 为这些调用补 terminal error ToolMessages；
5. 通过 as_node=__end__ 清除 pending graph work；
6. 重新读取状态，验证 next/tasks/interrupts 已清空，否则抛 RuntimeError。

源码注释解释了为什么只处理 trailing turn：更早的 dangling tool call 可能由 interrupt recovery 形成 partial AIMessage，乱序补 ToolMessage 会破坏 provider 要求的 tool_use/tool_result 邻接顺序，并导致后续 summarizer 请求失败。

来源：[remote_client.py L211-L260](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/client/remote_client.py#L211-L260)、[L1015-L1165](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/client/remote_client.py#L1015-L1165)。

这是一个值得吸收的模式：恢复不仅清理 graph next/task，也要修复 conversation protocol 的未配对工具调用。但 cancel API 的 best-effort 成功不能等价于外部进程/请求已终止；仍需独立的 effect evidence。

### 5.2 Context Offload：比普通工具多一层操作协议

deepagents-code 的 offload route 已经实现若干可靠性模式：

- client 生成稳定 operation_id，hook resume round 复用同一个 ID。
- 同一 operation_id 的活跃请求会被拒绝重复注册；终态 outcome 暂存用于处理 cancel/request race。
- hook interrupt 后没有保留 suspended coroutine；下一轮从 operation 顶部重新执行，并从 hook_responses 重放已回答的 hook。
- 读取 checkpoint_id，执行摘要后再次读取 thread，只有 checkpoint_id 未变化才提交。
- commit 对可写 state channel 使用 allowlist，拒绝写 messages，防止 compaction 在并发 run 后覆盖新消息。
- _settle 在 commit 中途收到 cancellation 时先让 commit settle，再重新传播 cancellation。
- cancel_offload 等待服务端 task 到 terminal，并返回 cancelled 或 finished。

来源：[offload_api.py L95-L110](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/offload_api.py#L95-L110)、[L477-L512](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/offload_api.py#L477-L512)、[L1094-L1291](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/offload_api.py#L1094-L1291)、[L1294-L1427](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/offload_api.py#L1294-L1427)。

**重要限制：** _active_operations 与 _operation_outcomes 是模块级内存 Map，终态保留最多 1024 条。稳定 operation_id 的 dedupe/cancel race 保护仅在该 server process 生命周期内成立，不是跨 server restart 的 durable operation ledger。不能把它提升为目标架构的持久操作账本。

## 6. Sandbox Provider：接口、生命周期与超时语义

### 6.1 通用接口没有表达关键安全合同

SandboxBackendProtocol 增加 id 和 execute(command, timeout)，并继承 filesystem read/write/upload/download；SandboxProvider 层负责 get_or_create / delete。该接口没有统一表达：

- cancel/kill command 与 terminal acknowledgement；
- egress/network policy、DNS、metadata service access；
- sandbox identity / credential scope；
- CPU/memory/process/pid limits；
- snapshot consistency、volume durability；
- retention / delete receipt / backup purge；
- isolation level / attestation / tenant boundary；
- effect receipt / queryOutcome。

来源：[backends/protocol.py L892-L932](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/backends/protocol.py#L892-L932)、[sandbox_provider.py](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/integrations/sandbox_provider.py)。

因此 SandboxBackendProtocol 是执行适配器接口，不是安全隔离保证书。Threat Model 把 sandbox backend 当作 trusted third-party service，CLI 责任仅到正确构造与派发请求为止。

### 6.2 Sandbox ownership 放在 Client 而不是 Server

server_graph 原先在 server 子进程里 create_sandbox，并通过 atexit 删除。Client 停止 server 时发送 SIGTERM，进程退出不保证执行 atexit，于是 sandbox 可能一直存在直到 provider 自己回收。

owned_sandbox() 将可按 ID 复用的 sandbox 创建/删除生命周期移到 Client 控制流：Client 创建，传 sandbox ID 给 Server，Client finally 删除。对于不支持 ID 的 provider 或显式复用 sandbox_id，仍交给 Server 原路径管理。

来源：[sandbox_factory.py L1545-L1605](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/integrations/sandbox_factory.py#L1545-L1605)、[server_graph.py L502-L535](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/server_graph.py#L502-L535)。

这是一条非常值得吸收的原则：资源所有权应放在真正控制生命周期的 supervisor，而不是依赖 worker 的正常退出 hook。

### 6.3 Provider 的超时语义不一致

固定源码中的适配器展示了明显差异：

| Provider | 源码中的执行/超时路径 | 静态证据边界 |
|---|---|---|
| Modal | sandbox.exec(..., timeout) 后 wait()、读取 stdout/stderr | adapter 没有自己的统一 kill/queryOutcome 协议 |
| Daytona | 创建 per-command session，异步启动 command，轮询 exit code，timeout 后用共享 cleanup budget 取 partial logs 并 delete session | 删除 session 是 best-effort cleanup，不应直接解释为 command terminal receipt |
| Runloop | devbox.cmd.exec(command, timeout) | timeout 由 SDK 承担，adapter 没有独立 kill/reconcile |
| Vercel | detached command、等待结果；超时尝试 current.kill()，失败时日志明确警告命令可能仍运行并继续计费 | kill 失败会留下 running/charging 的不确定性 |

来源：[Modal adapter](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/partners/modal/langchain_modal/sandbox.py)、[Daytona adapter L146-L360](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/partners/daytona/langchain_daytona/sandbox.py#L146-L360)、[Runloop adapter](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/partners/runloop/langchain_runloop/sandbox.py)、[Vercel adapter L90-L180](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/partners/vercel/langchain_vercel_sandbox/sandbox.py#L90-L180)。

**架构判断：** timeout 是等待预算，不是终止证明。目标 Host contract 应分别表达 cancel requested、cancel accepted、process terminated、effect terminal evidence、output retrieved；不应把一个 timeout 参数塞进统一接口就声称取消语义一致。

### 6.4 Credential identity fail-closed

Provider factory 中存在值得借鉴的凭据隔离策略：

- Modal 若 workspace 只覆盖 token pair 的一半，会拒绝启动，而不是让 SDK 回退到 server 进程更宽的 ambient identity。
- Vercel 若 workspace override 了部分 credential set，却没有提供完整集合，会拒绝让 SDK 使用 server identity。
- OpenShell 绑定 active gateway/workspace。
- Runloop 要求 API key。

来源：[sandbox_factory.py L650-L850](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/integrations/sandbox_factory.py#L650-L850)、[L1120-L1210](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/integrations/sandbox_factory.py#L1120-L1210)、[L1370-L1495](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/integrations/sandbox_factory.py#L1370-L1495)。

这说明“凭据缺失时自动回退到默认 SDK auth”可能造成 privilege substitution。目标架构应把 credential provenance / effective identity 放进 Capability Manifest，并在 Host 启动时验证。

### 6.5 Provider 测试的证据边界

unit tests 覆盖：
- sandbox context exit 只删除本次创建的 sandbox；
- setup/readiness 失败清理新创建的 sandbox；
- Modal / AgentCore 不完整 credential pair 拒绝；
- Vercel workspace credential partial override fail-closed；
- provider missing ID / not found 的错误映射。

这些测试值得作为未来 contract suite 的候选，但多处 provider SDK 被 mock；不能证明真实供应商的网络隔离、snapshot、delete、kill、retention 或数据擦除合同。本轮未运行。

来源：[tests/unit_tests/test_sandbox_factory.py](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/tests/unit_tests/test_sandbox_factory.py)、[tests/integration_tests/test_sandbox_factory.py](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/tests/integration_tests/test_sandbox_factory.py)。

## 7. ACP：协议取消与 session persistence

ACP server 保存 session cwd/mode/model、plan、MCP servers、allowed execute commands 等内存映射。prompt() 若 graph 没有 checkpointer，会注入 MemorySaver。session/load 则要求 checkpointer 存在，并且必须能跨 server restart 存活；load 时校验 session 是否由本 ACP server 创建、cwd 是否匹配，然后从 checkpoint history 重放用户消息、assistant 消息和 tool calls。

来源：[acp/server.py L220-L350](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/acp/deepagents_acp/server.py#L220-L350)、[L753-L948](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/acp/deepagents_acp/server.py#L753-L948)、[L970-L1060](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/acp/deepagents_acp/server.py#L970-L1060)。

ACP cancel() 只把 session_id 加入 _cancelled_sessions。prompt() 在开始和每个 stream_chunk 之间检查该集合；没有看到将 cancellation signal 直接传入 graph runner、Shell subprocess 或 MCP request 的路径。因此如果当前 stream iteration 被一个不再产出 chunk 的长工具阻塞，取消标记可能要等到下一个 chunk 才被观察。**I：** 这是控制流推断，不是本轮动态复现。

来源：[acp/server.py L508-L510](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/acp/deepagents_acp/server.py#L508-L510)、[L970-L1060](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/acp/deepagents_acp/server.py#L970-L1060)。

ACP 上游 load_session 测试创建 first_server / restarted_server，但复用同一个 MemorySaver 对象。因此它证明同一进程内更换 server wrapper 后可以 replay，不证明独立进程退出再启动后的持久化恢复。**T/I：** 测试定义已读，未运行；fixture 的共享内存 saver 不能作为跨进程 durability 证据。

来源：[acp/tests/test_agent.py L475-L750](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/acp/tests/test_agent.py#L475-L750)。

## 8. Python / JS parity 与架构评价

| 主题 | Python 0.7.32 | JS 1.16.2（报告 73） | 对目标内核的结论 |
|---|---|---|---|
| Permission mode | allow / deny / interrupt | allow / deny；HITL 需另配 | 将 policy decision 与 human approval 分层 |
| Path resolution | symlink target 双重检查；无法 resolve 按 denied | 已发现结果过滤的 fail-open 分支 | 统一 fail-closed canonicalization；仍需 TOCTOU 原子性 |
| Child permissions | 未配置继承；配置后替换；空数组清空父规则 | 同样存在显式空配置清除父规则的风险 | parent capability ceiling + child intersection |
| Child state | PrivateStateAttr + 排除字段；fork 是特殊继承路径 | 主要是固定 denylist | schema allowlist / typed projection；fork 单独建模 |
| Async subagent | 先创建远端 Thread/Run，再更新 parent state | 类似的远端 launch / parent tracking gap | Outbox + launch intent + reconciliation |
| Local shell | 明确 unrestricted host execution | 同样不能把 virtualMode 当 shell confinement | Mandatory Host + OS sandbox |
| Durable runtime | LangGraph checkpoint / pending graph recovery | LangGraph JS graph checkpoint | checkpoint 不是 effect receipt |
| Session owner | OS file lock + owner token + checkpoint writer fence | 不可据 JS Harness 推断具备同样机制 | 保留 owner lease / epoch fencing，但升级为部署适配器 |
| Sandbox contract | Provider registry / adapter；无统一 kill/effect evidence | Deno/Modal/Daytona adapters | Capability manifest 必须描述 provider 实际保证 |
| ACP cancel | session flag，在 stream chunk 间检查 | 不适用 | CancelRequested != CancelledConfirmed |

## 9. 对目标 Agent v0.2 的建议

以下是研究建议，不修改现有 ADR，也不构成批准决策。

### 值得吸收

1. **Harness 与 runtime 分层**：Agent loop、graph runtime、domain kernel 不应混成一个大类。
2. **Client / Server 生命周期分离**：UI 不拥有模型 loop；supervisor 对 server 和 sandbox 资源有明确 cleanup 责任。
3. **Thread owner fencing**：client lease + server writer token + checkpoint mutation guard，避免旧进程继续写。
4. **Workspace immutable binding**：thread 绑定 workspace identity 与 durable policy fingerprint；runtime/model 变更单独处理。
5. **恢复时修复消息协议**：对未配对 tool calls 写入明确 terminal message，再清理 pending graph state，并复核状态。
6. **Provider credential provenance**：workspace 指定身份不完整时 fail closed，禁止静默回退到 server ambient identity。
7. **Sandbox resource ownership 在 supervisor**：不要依赖 worker atexit 释放外部资源。

### 不应照搬

1. 不把 filesystem permission 当作完整权限 Authority；它不能覆盖 shell 内部访问。
2. 不允许 child 用自己的 permissions 替换 parent ceiling。
3. 不允许 fork 模式无条件转发所有 state channel；应为 fork 声明 context projection policy。
4. 不把远端 Thread/Run 创建成功视为 parent Task 已可靠登记；需要 launch intent/outbox。
5. 不把 runs.cancel / sandbox timeout / ACP cancel flag 视为外部进程已终止。
6. 不把内存 operation outcome map 作为跨重启 durable idempotency。
7. 不把 SandboxBackendProtocol 视为 isolation attestation；必须单独描述网络、凭据、资源、数据保留和删除保证。
8. 不把 localhost + no-auth server 作为多用户部署方案。

### 建议加强 v0.2 的合同

- Parent Capability Grant 是不可扩张上限；Subagent / MCP / Hook / tool delegation 只能取交集。
- Operation 必须有 durable intent、stable operationId、attemptId、workerEpoch、Host instance、effect receipt、UNKNOWN reconciliation。
- Cancel 分为 requested / accepted / process-terminated / effect-terminal；UI 不得提前显示 confirmed。
- Sandbox manifest 增加 egress、credential provenance、volume durability、snapshot consistency、resource quota、kill/query、delete/retention、provider attestation。
- Workspace binding 保存不可变 workspace identity + policy revision；每次执行 server-side revalidate。
- Context projection 采用字段分类与 allowlist；forked child 也要明确列出允许继承的 state keys。
- ACP/CLI/HTTP API 的 cancellation 必须向 Host 执行器传播，而不只是给 UI 一个标志。

## 10. 未决问题与下一步

1. **供应商安全合同**：逐一研究 Modal、Daytona、Runloop、Vercel、AWS AgentCore、NVIDIA OpenShell 官方文档和合同：network egress、metadata endpoint、secret injection、VM/container 隔离、volume/snapshot consistency、data retention、delete receipt、hard kill。
2. **LangGraph Server 部署边界**：本地 SQLite checkpointer 的 journal/WAL/fsync、进程恢复、并发 writer、server auth、multi-worker ownership 与共享 storage 需要独立核验。
3. **ACP cancellation**：确认 Agent Client Protocol 的 cancel 请求在 server、graph、tool、process 层应如何传播；补真实长时间阻塞工具的故障验证规格。
4. **Python/JS parity**：继续审计 Python/JS 的 QuickJS / Deno / MCP / Hook / filesystem backend 具体差异，避免只按 README 推断。
5. **Claude Desktop 资料包**：本轮同时检查了用户提供的 Claude Desktop 3.1623.1 / Claude Code 2.1.304 reverse-kit 清单和 local-agent evidence 文档。其 Client→SDK→CLI 双向 JSONL / Host topology 与报告 47–51 已有研究方向一致；后续应把该资料包的 manifest / evidence 文件纳入统一证据索引，不把逆向文档视为原始运行时证明。

本轮没有运行任何测试、POC、benchmark、crash/race injection 或真实 provider 操作。所有动态验证均为 NOT RUN。

## 11. 源码索引

固定源码 commit：`3a217cec7183b601f2b33e0144e09bb50ad44f01`

- [Deep Agents architecture](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/ARCHITECTURE.md)
- [Deep Agents Code architecture](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/ARCHITECTURE.md)
- [Deep Agents Code threat model](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/THREAT_MODEL.md)
- [Core graph assembly](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/graph.py)
- [Filesystem permission middleware](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/filesystem.py)
- [Subagent middleware](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/subagents.py)
- [Async subagent middleware](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/middleware/async_subagents.py)
- [Local shell backend](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/backends/local_shell.py)
- [Sandbox backend protocol](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/deepagents/deepagents/backends/protocol.py)
- [Code CLI Agent](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/agent.py)
- [Thread ownership / SQLite saver fence](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/thread_ownership.py)
- [Workspace binding](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/workspace.py)
- [RemoteAgent recovery](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/client/remote_client.py)
- [Offload API](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/offload_api.py)
- [Sandbox provider factory](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/code/deepagents_code/integrations/sandbox_factory.py)
- [ACP server](https://github.com/langchain-ai/deepagents/blob/3a217cec7183b601f2b33e0144e09bb50ad44f01/libs/acp/deepagents_acp/server.py)

---

**阶段门禁：开发批准未获得。** 本报告只增加源码研究证据与架构建议；不得据此开始实现、修改 Kernel、运行开发测试或提交开发 PR。
