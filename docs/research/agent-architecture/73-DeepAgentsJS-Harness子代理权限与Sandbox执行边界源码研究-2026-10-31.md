# 73：Deep Agents JS Harness、子代理权限委派与 Sandbox 执行边界源码研究（2026-10-31）

> **研究状态：静态源码研究；未获开发批准。** 本报告把 Deep Agents JS 作为 LangGraph 之上的 Agent Harness 参考，不将其视为独立 Durable Runtime、可信 Permission Authority 或最终 Tool Host。只读取固定源码、测试定义与仓库文档；未运行测试、POC、真实 sandbox/provider、MCP、Shell 或外部副作用。
>
> **固定基线**：langchain-ai/deepagentsjs @ commit 26f190d40f44a2bb498db73e9e98b002bb8554fe（2026-10-30T22:52:51Z）；libs/deepagents/package.json version 1.16.2，MIT。其 peer dependency 声明 @langchain/langgraph ^1.4.10、@langchain/langgraph-sdk ^1.9.23、langchain ^1.5.10 等；因此该包源码版本可固定，但消费者实际解析的 LangGraph runtime 仍由部署 lockfile 决定，不能从 peer range 推断唯一版本。
>
> **证据标记**：F=固定 commit 源码事实；T=上游测试定义（本轮未运行）；D=仓库 README / package 文档；I=架构推断；U=未知。引用路径均指向固定 commit，行号是该 commit 中的文件行。
>
> **阶段门禁**：本轮只研究并更新研究文档/PR 进度；没有修改业务代码、Kernel、开发测试或 ADR。

## 0. 执行摘要

Deep Agents JS 是一个建立在 LangChain Agent Middleware + LangGraph 上的高层 Agent Harness。它把 filesystem、subagents、summarization、skills、memory、HITL、async remote tasks 和可插拔 backend 组合成可用的 Agent 产品框架。它最值得借鉴的是模块化 Harness、上下文模式、同步/异步子代理分层、工具结果管理和可插拔 Sandbox adapter。

但它不是本项目目标内核的安全/持久化底座。固定源码显示出以下关键边界：

1. **默认 workspace 是 StateBackend，不是 OS 文件系统**：文件映射进入 LangGraph state channel；真正的文件系统、shell 和远程 sandbox 是可选 backend。
2. **filesystem permissions 是路径级 middleware policy，不是全局 Permission Authority**：只覆盖 read/write 路径规则；规则默认 allow、first-match-wins；shell execute 不受路径规则控制。
3. **子代理权限不是不可覆盖的父级上限**：未配置时继承父权限，但子代理可通过 permissions: [] 清空继承规则，或用自己的规则替换父规则；上游测试明确验证这一行为。
4. **同步子代理默认可能继承父工具集合**：SubAgent.tools 未指定时回退到 defaultTools；默认 general-purpose 子代理使用父 Agent 的 effectiveTools。它是便利默认值，不是 least-privilege 默认值。
5. **子代理上下文隔离采用固定 denylist，不是严格 allowlist**：隔离模式只替换 messages 为委派任务，但其他未列入排除表的自定义 state 字段仍会传入子代理。
6. **异步子代理存在 remote-create/local-checkpoint gap**：先远程 create thread/run，再将 AsyncTask 通过 Command 写入父状态；崩溃窗口可能留下未被父状态记录的远程任务。
7. **LocalShellBackend 明确不是 sandbox**：它以 shell:true 在宿主用户权限下执行命令；virtualMode 只约束文件 API，不约束 shell 命令。上游测试明确验证虚拟文件根之外的 shell 路径仍可访问。
8. **QuickJS WASM 是受限代码执行环境，不是完整 Agent Host**：不暴露 process/require/fetch/文件系统全局，但可以通过 PTC bridge 调用显式注入的宿主工具。REPL heap 位于进程内 static Map，JSON 序列化只保存 session id；它不是跨 worker 重启的 durable VM snapshot。
9. **远程 sandbox 的真实隔离来自外部供应商**：Deep Agents 适配 Deno microVM、Modal container、Daytona sandbox 等 SDK；provider 单元测试使用 mock SDK，不能证明供应商的实际隔离、网络策略、终止和多租户保证。

**总体判断**：Deep Agents 是值得参考的 Domain Harness，不应替代 v0.2 的 Permission Authority、Operation/Effect Ledger、Host Capability Manifest、OS sandbox 和 Durable Runtime。最重要的设计原则是：Harness 负责组合能力，可信 Host 负责决定并证明能力如何被执行。

## 1. 固定样本与源码地图

### 1.1 发布基线

- Repository: [langchain-ai/deepagentsjs](https://github.com/langchain-ai/deepagentsjs)
- Commit: [26f190d40f44a2bb498db73e9e98b002bb8554fe](https://github.com/langchain-ai/deepagentsjs/tree/26f190d40f44a2bb498db73e9e98b002bb8554fe)
- Commit message: feat(quickjs): allow disabling the per-call executionTimeoutMs
- Commit time: 2026-10-30T22:52:51Z
- Package: deepagents 1.16.2, MIT
- LangGraph peer range: ^1.4.10；不是本仓库固定到某个唯一 runtime 版本。

### 1.2 核心源码入口

| 层 | 文件 | 关键职责 |
|---|---|---|
| Harness 入口 | libs/deepagents/src/agent.ts | createDeepAgent、middleware stack、backend/checkpointer/store、subagent 组装 |
| Filesystem tools | libs/deepagents/src/middleware/fs.ts | ls/read/write/edit/delete/glob/grep/execute、路径权限、结果裁剪/offload |
| Permission rules | libs/deepagents/src/permissions/types.ts、enforce.ts | read/write、glob、first-match-wins、path validation |
| Backend contract | libs/deepagents/src/backends/protocol.ts、v2/protocol.ts | BackendProtocol、SandboxBackendProtocol、runtime/factory |
| State backend | libs/deepagents/src/backends/state.ts | 文件映射进入 LangGraph state channel |
| Local filesystem | libs/deepagents/src/backends/filesystem.ts | rootDir、virtualMode、symlink/realpath、fs 操作 |
| Local shell | libs/deepagents/src/backends/local-shell.ts | 宿主 spawn(shell:true)、超时、输出截断 |
| Composite backend | libs/deepagents/src/backends/composite.ts | 路由不同路径到不同 backend |
| 同步子代理 | libs/deepagents/src/middleware/subagents.ts | task tool、isolated/fork、状态过滤、工具/权限继承 |
| 异步子代理 | libs/deepagents/src/middleware/async_subagents.ts | Agent Protocol Thread/Run、状态、通知、更新、取消 |
| QuickJS | libs/providers/quickjs/src/middleware.ts、session.ts | WASM REPL、PTC tool bridge、subagent bridge、session map |
| Sandbox adapters | libs/providers/deno/src/sandbox.ts、modal/src/sandbox.ts、daytona/src/sandbox.ts | 外部 sandbox SDK 适配 |
| 测试定义 | fs.permissions.test.ts、subagents.permissions.test.ts、local-shell.test.ts、quickjs/session.test.ts、provider sandbox tests | 规则、路径、会话和 adapter 测试；本轮未执行 |

关键源码链接：
- [agent.ts](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/agent.ts)
- [filesystem middleware](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/fs.ts)
- [permission enforcement](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/permissions/enforce.ts)
- [backend protocol](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/backends/v2/protocol.ts)
- [filesystem backend](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/backends/filesystem.ts)
- [subagents](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/subagents.ts)
- [async subagents](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/async_subagents.ts)
- [QuickJS session](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/quickjs/src/session.ts)
- [Deno sandbox adapter](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/deno/src/sandbox.ts)

## 2. Harness 组装与 Middleware 顺序

### 2.1 createDeepAgent 默认值

**F：** agent.ts 的 createDeepAgent() 默认：
- model 为 anthropic Claude Sonnet profile；
- tools 默认空数组；
- backend 默认 factory，构造 StateBackend；
- permissions 默认空数组；
- skills、memory、interruptOn、async subagents 等按配置启用；
- checkpointer/store 由调用方传入 createAgent()。

因此默认“filesystem”是 StateBackend，而非直接访问宿主磁盘。StateBackend 从 LangGraph state 的 files channel 读取文件，并通过 PREGEL_SEND_KEY 发送文件 state updates。文件内容进入图状态/检查点体系，而不是自动成为外部文件系统。

源码：[agent.ts L140–230](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/agent.ts)、[state.ts L170–220](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/backends/state.ts)。

### 2.2 Root middleware stack

**F：** 固定源码构造的核心顺序：

1. ParentNotifierMiddleware；
2. FilesystemMiddleware；
3. SubAgentMiddleware；
4. SummarizationMiddleware；
5. PatchToolCallsMiddleware；
6. 有 asyncSubAgents 时加入 AsyncSubAgentMiddleware；
7. Tail 包含 profile extra middleware、skills、provider prompt cache、memory、可选 Human-in-the-loop middleware；
8. custom middleware 通过 mergeMiddlewareStack 合并；profile exclusion 在合并后生效。

Subagent 也有自己的默认栈：Filesystem、Summarization、PatchToolCalls，之后合并 spec middleware、profile、skills、cache、fork memory 和可选 HITL。

源码：[agent.ts L250–420、L470–590](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/agent.ts)。

**I：** 这是很好的 Harness 组合方式：能力以 middleware 模块注入，顺序和覆盖行为显式化。但安全控制不能只存在于可被 custom middleware 替换/排除的层；本项目的最后执行 gate 必须在 Host/Operation boundary，而不是仅在 Agent middleware stack。

### 2.3 官方安全立场

**D：** 固定 commit 的 README Security 段落明确：Deep Agents 采用 trust-the-LLM 模式，Agent 可以执行其工具允许的任何事情；边界应由工具和 sandbox 强制，而不是期待模型自我约束。

来源：[README.md L133–135](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/README.md)。

**架构结论：** 这与本项目“模型不是权限主体、Prompt 不是安全边界”的方向一致。但“把限制放在工具层”仍不足以自动构成可信系统；工具层必须具有身份、授权、参数绑定、执行隔离、幂等和可核验 Receipt。

## 3. Filesystem Permissions：实现能力与安全边界

### 3.1 Rule contract

**F：** FilesystemPermission 只建模：
- operations: read / write；
- paths: 绝对 glob path；
- mode: allow / deny；
- path 在创建 middleware 时校验，不允许相对路径、..、~；
- decidePathAccess() 按规则声明顺序 first-match-wins；没有匹配时默认 allow；空规则数组也等于允许所有路径。

源码：[permissions/types.ts L1–41](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/permissions/types.ts)、[enforce.ts L8–93](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/permissions/enforce.ts)。

### 3.2 Path and symlink checks

**F：** fs.ts 的 checkPermission()：
1. validatePath() 规范化输入；
2. 检查 lexical canonical path；
3. backend 有 realpath hook 时，解析 symlink 目标；
4. 对 canonical path 和 resolved path 分别执行 rule decision；
5. 任一形式被 deny 即拒绝；
6. 返回 canonical path 给 backend 执行。

ls/glob/grep 还会对返回条目进行 post-filter。delete 有专门的递归子树检查：如果目标可能是目录，任何与待删除子树重叠的 deny-write pattern 都会阻止删除；确认是 leaf file 时才按 first-match-wins 规则判断。

源码：[fs.ts L696–753、L900–975、L1050–1110、L1590–1680](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/fs.ts)。

### 3.3 Shell execute 不受路径权限规则控制

**F：** FilesystemMiddleware 的 permissions 文档明确：规则适用于路径型文件工具；execute 不执行路径 ACL，因为 shell 可以访问任意路径。若启用 execute 且 backend 实现 SandboxBackendProtocol，配置时会拒绝与路径权限规则不兼容的组合；factory backend 则在运行时再次检查。例外是 execute 被禁用，或 CompositeBackend 中所有 permission paths 都严格落在 route prefix 内。

上游测试定义覆盖：
- sandbox backend + permissions 通常抛配置错误；
- 禁用 execute 后可使用 permissions；
- factory backend 在运行时拒绝；
- CompositeBackend 路由前缀边界被检查。

源码：[fs.ts L1900–1967、L2010–2115、L2229–2290](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/fs.ts)、[fs.permissions.test.ts L883–1030](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/fs.permissions.test.ts)。

**I：** 这是正确承认 Shell 与路径 ACL 不同层次的设计：不能声称对 write_file 的路径检查也能限制任意 shell 命令。但该保护只是配置拒绝；真正的 shell 限制仍取决于执行 backend 的 OS / VM / container 安全边界。

### 3.4 两个需要独立评审的风险

**F：结果过滤存在 fail-open 分支。** filterByPermissions() 对 backend 返回的 entry path 执行 validatePath；若路径无法解析，catch 分支返回 true，即将该 entry 纳入结果。对无法解析的 backend entry，listing filter 因而不是 fail-closed。该行为来自固定源码注释和实现；本轮未运行恶意自定义 backend 测试。

**I：路径授权与文件操作之间仍需检查 TOCTOU。** middleware 先 realpath/检查权限，再调用 backend；FilesystemBackend 自身也在文件操作前解析路径。write/edit 对最终 leaf 使用 O_NOFOLLOW（平台支持时），但 upload/download 在 root/symlink 检查后分别调用普通 fs.writeFile/readFile。当前实现没有在所有路径操作中展示基于 dirfd/openat2 的单次原子“解析并操作”合同。恶意并发 symlink 替换是否可利用，本轮未验证；应作为安全评审和未来隔离测试项，而不是宣称已确认漏洞。

## 4. Backend 与 Sandbox：不要混淆文件 API、命令执行和隔离

### 4.1 Backend protocol 很薄

**F：** BackendProtocolV2 暴露 ls/read/readRaw/write/grep/glob/delete 等文件能力；SandboxBackendProtocolV2 额外增加 execute(command)、uploadFiles、downloadFiles。协议没有 operationId、argsHash、idempotency key、PermissionGrant、EffectReceipt、queryOutcome、cancel handle 或 Worker fencing 字段。

源码：[v2/protocol.ts L1–140](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/backends/v2/protocol.ts)、[protocol.ts L620–677](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/backends/protocol.ts)。

**I：** 该接口适合作为 Agent workspace adapter，不足以作为本项目的可信 Operation Host contract。它只统一“怎样读写/执行”，没有统一“谁授权、以何身份执行、执行到哪一步、是否产生外部效果、如何查询或确认取消”。

### 4.2 FilesystemBackend

**F：**
- 默认 virtualMode=false；
- rootDir 默认 process.cwd()；
- 非 virtual mode 下，绝对路径直接原样使用，rootDir 主要影响相对路径；
- virtualMode=true 才将输入视为 rootDir 下的虚拟绝对路径，执行词法 containment 和 realpath/symlink 检查；
- write/edit 在平台支持时使用 O_NOFOLLOW 保护最终路径组件；
- uploadFiles/downloadFiles 在 root 检查后调用普通 fs.writeFile/readFile。

源码：[filesystem.ts L80–240、L527–700、L1048–1131](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/backends/filesystem.ts)。

**架构结论：** rootDir 不应被误认为 sandbox；virtualMode=false 的绝对路径可以访问进程权限允许的其他路径。virtualMode 是文件 API 层的路径限制，不是 OS namespace/container boundary。

### 4.3 LocalShellBackend

**F：** LocalShellBackend 继承 FilesystemBackend 并实现 SandboxBackendProtocolV2，但源码注释明确说明：execute 使用 spawn(command, { shell: true }) 在宿主系统执行，没有 sandbox/isolation/security restrictions，命令具有当前用户权限。超时路径调用 child.kill(SIGTERM)；close() 只将 initialized 标志置为 false。

上游测试定义专门验证：virtualMode=true 时，文件 API 拒绝 root 外路径，但 shell execute("cat /etc/passwd") 仍能运行并返回执行结果对象。

源码：[local-shell.ts L139–220、L345–410](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/backends/local-shell.ts)、[local-shell.test.ts L364–420](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/backends/local-shell.test.ts)。

**架构结论：** LocalShellBackend 适合开发机上的可信本地使用，不应被当作生产不可信代码 sandbox。timeout 对直接 child 发送 SIGTERM，也不能自动证明 shell 的全部后代进程已经终止。

### 4.4 Remote sandbox providers

**F：**
- Deno adapter 调用 @deno/sandbox SDK，创建和连接供应商 sandbox；源码文档将其描述为 Linux microVM。
- Deno options 暴露 memory、timeout/lifetime、root/volume、allowNet、secrets、SSH 等配置。
- Deno allowNet 文档明确：不指定时不施加网络限制；secrets 可按 host 配置，在 HTTPS 请求时由平台注入真实值，而不直接暴露给 sandbox 代码。
- Modal adapter 调用 ModalClient 创建 Sandbox，并传入 image、volumes、secrets 等 SDK 参数。
- Daytona adapter 调用 Daytona SDK，支持 image/snapshot、resources、envVars、autoStop/autoArchive/autoDelete 等生命周期配置。

源码：[Deno types.ts L100–295](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/deno/src/types.ts)、[Deno sandbox.ts L150–285、L400–460](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/deno/src/sandbox.ts)、[Modal sandbox.ts L180–380](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/modal/src/sandbox.ts)、[Daytona sandbox.ts L180–500](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/daytona/src/sandbox.ts)。

**T：** Deno / Modal / Daytona provider 单元测试分别 mock 对应 SDK；这些测试可验证 adapter 的参数映射、错误处理和生命周期调用，但不能证明供应商真实 VM/container 隔离、网络 egress、数据擦除、kill latency 或多租户隔离。本轮没有运行测试或真实 provider。

**I：** Sandbox provider 必须按 capability profile 逐项验收，而不能只凭“sandbox”名称授予信任。网络默认策略、volume mount、secret injection、snapshot retention、终止和 reconnect 语义都应进入 HostCapabilityManifest。

## 5. Subagent：上下文、工具和权限的实际继承规则

### 5.1 同步子代理

**F：** createSubAgentMiddleware 提供 task tool，runTask() 选择配置好的子图并执行 subagent.invoke()。

- isolated（默认）：子 Agent 的 messages 被替换成单条 HumanMessage(description)，只收到委派任务文本；
- fork：从父 state.messages 提取有效对话，追加 fork preamble，继承父对话历史；
- 两种模式都先调用 filterStateForSubagent()/filterStateForFork()；
- fork 有额外递归防护，并可镜像父级 system prompt、skills 和部分 middleware；
- subagent result 经 Command 更新父 state，并以 ToolMessage 关联原 toolCallId。

源码：[subagents.ts L78–113、L403–490、L531–580、L854–965](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/subagents.ts)。

### 5.2 状态过滤是 denylist

**F：** EXCLUDED_STATE_KEYS 包含 messages、todos、structuredResponse、skillsMetadata、pinnedSkills、memoryContents、model/tool call counters、summarization metadata 等；filterState() 将不在排除列表的 state key 原样复制。

**I：** isolated 模式虽然不继承父 messages，但它不是严格的数据 allowlist。新增的自定义 state 字段默认会传给子代理；若这些字段包含 tenant secret、用户 PII、授权 token 或内部凭据，不能假定 isolated 自动隔离这些数据。安全默认应是按 schema/field classification 构造 child context，而不是只维护 denylist。

### 5.3 默认工具集合与权限替换

**F：**
- SubAgent.tools 的类型注释说明未提供时默认使用 defaultTools；
- getSubagents() 将 agentParams.tools ?? defaultTools 作为 resolved tools；
- 默认 general-purpose 子代理配置使用父 Agent 的 effectiveTools；
- buildSubagentMiddleware() 为子代理创建 filesystem middleware，effectivePermissions = input.permissions ?? parent permissions；
- 因此未指定子代理 permissions 时继承父规则；显式 [] 或自定义数组会完全替换父规则，而非与父规则求交集。

**T：** subagents.permissions.test.ts 明确测试：
- undefined 继承父 deny；
- [] 覆盖父 deny 并允许读取父规则禁止的路径；
- 非空子代理规则替换父规则；
- 子代理专属 deny 可以比父规则更严格。

源码：[agent.ts L280–335、L400–500](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/agent.ts)、[subagents.ts L200–290、L620–780](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/subagents.ts)、[subagents.permissions.test.ts L98–230](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/subagents.permissions.test.ts)。

**架构结论：** 子代理权限配置在产品层允许 override，但这不适合作为全局安全边界。目标内核应将 parent grant 作为不可扩张的 ceiling：effective child capabilities = parent granted capabilities ∩ child requested capabilities ∩ tenant/policy constraints。子代理声明只能收窄，不能取消父级 deny 或扩大工具/网络/文件范围。

### 5.4 HITL

**F：** SubAgent.interruptOn 可按工具配置 humanInTheLoopMiddleware；root createDeepAgent 也可通过 interruptOn 添加 HITL middleware。它需要 checkpointer，并将工具调用暂停/等待恢复。

**I：** 这是一种工具控制流审批/暂停机制，不等于 Permission Authority。core middleware 的 interruptOn 配置本身不证明 caller identity、tenant scope、grantId、argsHash、policyRevision、审批者授权和有效期。执行 Host 仍须独立验证 grant。

## 6. Async Subagents：远程 Thread/Run、通知与恢复边界

### 6.1 数据模型

**F：** AsyncTaskState 使用 ReducedValue reducer，将 asyncTasks map 以浅合并方式更新。AsyncTask 记录 taskId、agentName、threadId、runId、status、createdAt、updatedAt、checkedAt 和可选 supersededRunIds。taskId 与 threadId 相同；runId 表示该 thread 当前跟踪的最新 run。

源码：[async_subagents.ts L1–250](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/async_subagents.ts)。

### 6.2 启动顺序与崩溃窗口

**F：** start_async_task 执行顺序：
1. client.threads.create(metadata)；
2. client.runs.create(threadId, graphId, input/options)；
3. taskId = thread.thread_id，记录 run.run_id；
4. 返回 Command，更新父 Agent 的 asyncTasks state。

thread metadata 记录 subagent_name、parent_thread_id、parent_assistant_id；有助于追踪父子关系，但启动流程没有在远程创建之前先提交本地 SubagentLaunchIntent，也没有在此 middleware 内展示由本地 operationId 驱动的远程 idempotency key。

源码：[async_subagents.ts L737–828、L1180–1305](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/async_subagents.ts)。

**I：** 若 thread/run 已在远端创建，而父图尚未持久化 Command state update 就崩溃，父 Agent 可能丢失 task tracking。parent_thread_id metadata 是可用于人工/后台 reconciliation 的线索，但不是幂等创建合同，也不能保证远端任务只创建一次。

### 6.3 状态与通知

**F：**
- status 包含 pending/running/waiting/success/error/cancelled/timeout/interrupted；
- run.status=success 不一定代表子 Agent 最终完成：若 thread.status=interrupted，taskStatus 映射为 waiting；
- beforeAgent / beforeModel 会 pull unfinished tasks；afterModel 在 final answer 后再检查一次；
- pull 的单任务检查有 5 秒 AbortSignal timeout，失败时跳过并等待下一轮；
- 子任务完成时 notifyParent 只在父 thread idle/error 时 best-effort 创建通知 run；父 thread busy 或 waiting 时不唤醒，依靠后续查询；
- updateStrategy 可选 interrupt 或 enqueue；enqueue 跟踪 supersededRunIds；
- cancel_async_task 调用远程 runs.cancel() 后立即把本地 task status 更新为 cancelled；cancel earlier runs 的失败只记录 warning。

源码：[async_subagents.ts L337–413、L560–610、L737–865、L1180–1320、L1420–1610、L1892–1994](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/deepagents/src/middleware/async_subagents.ts)。

**I：**
- notification 是加速路径，pull/check 才是恢复路径；通知不能成为唯一任务状态来源。
- API cancel 返回与 sandbox/process tree 已终止不是同一个证据；本地 cancelled 应区分 CancelRequested / RemoteCancelAccepted / CancelledConfirmed / OutcomeUnknown。
- update enqueue 的“后续 run 已排队”与“当前 run 结束”是不同事实；如果当前 run 正在等待人工输入，文档明确 queued follow-up 仍会启动并丢弃该等待请求，需要产品层清晰呈现。

### 6.4 Async subagent 权限与上下文

**F：** AsyncSubAgent 是远程 Agent Protocol server 配置，具有 graphId、url、headers、webhook、notifyParent、updateStrategy、mode。isolated 模式只发送任务描述；fork 模式发送父 conversation history，但文档明确远程 Agent 使用自己的 system prompt、tools 和 runtime，不自动继承父工具集合。父 thread id/assistant id 可作为 callback metadata。

**I：** 远程 Agent 的实际权限由远端 graph/server 配置决定。父 Agent 的 filesystem permissions、Host grants 和 tool allowlist 不会因为委派关系自动成为远端的强制上限。跨服务委派必须传递受签名/受验证的 Capability Delegation，而不是只传 prompt、thread id 或普通 context。

## 7. QuickJS：受限代码解释器与宿主工具桥

### 7.1 Runtime 隔离

**F：** @langchain/quickjs 使用 QuickJS-NG WASM。默认参数：
- memoryLimitBytes = 64 MiB；
- maxStackSizeBytes = 320 KiB；
- executionTimeoutMs = 5 秒；
- maxPtcCalls = 256；
- maxSubagentConcurrency = 32；
- maxResultChars = 4000。

测试定义验证 sandbox 内 process、require、fetch、readFile、writeFile 不作为全局变量暴露；工具必须通过明确注入的 PTC helper 调用。

源码：[session.ts L42–90、L230–322、L421–505](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/quickjs/src/session.ts)、[session.test.ts L294–370](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/quickjs/src/session.test.ts)。

### 7.2 PTC 是宿主能力桥

**F：** CodeInterpreterMiddleware 可通过 ptc 选项选择注入工具；ptc=true 表示解析并注入 Agent 的工具集合（排除 js_eval 自身）。每个 JS host function 从 QuickJS dump 参数，再在宿主 Node 进程中调用对应 LangChain tool.invoke()。subagent bridge 通过 task tool dispatch，并使用 PQueue 限制并发。

源码：[middleware.ts L395–520、L542–584](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/quickjs/src/middleware.ts)、[session.ts L571–620、L638–735](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/quickjs/src/session.ts)。

**架构结论：** QuickJS 可以限制任意模型生成代码的直接 Node/OS 访问，但如果 PTC 暴露了 shell、HTTP、filesystem 或业务工具，代码仍可通过这些宿主工具行使能力。真正的授权点仍是每个 host tool 的 last-mile gate，而不是 WASM 沙箱本身。

### 7.3 REPL 状态不是 Durable VM Snapshot

**F：**
- ReplSession.sessions 是 process-local static Map；
- middleware 使用 threadId + middlewareId 作为 session key；
- toJSON() 只返回 { id }；
- fromJSON() 如果 map 中没有现有 session，只创建一个新的空 ReplSession；
- CodeInterpreterMiddleware.afterAgent 会 deleteSession()，释放 runtime/context；
- sharedEvalQueue 串行化进程内所有 evalCodeAsync 调用，以满足 QuickJS asyncify 的单并发约束。

源码：[session.ts L230–265、L366–421、L507–530](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/quickjs/src/session.ts)、[middleware.ts L490–584](https://github.com/langchain-ai/deepagentsjs/blob/26f190d40f44a2bb498db73e9e98b002bb8554fe/libs/providers/quickjs/src/middleware.ts)。

**I：** 变量跨 js_eval 调用可在同一进程 session 中保持，但这不等于 heap 可跨 worker migration/process restart 恢复；序列化对象只是 session handle。afterAgent 清理还意味着该实现的 session 生命周期受 Agent invocation hook 管理，而不是无限期 conversation storage。若产品需要跨重启恢复 REPL，应将可恢复状态建模为版本化 cell log / serializable state，而不是依赖进程内 WASM heap。

## 8. 与目标架构 v0.2 的对照

| 维度 | Deep Agents JS | 目标架构 v0.2 候选 |
|---|---|---|
| 产品层 | Opinionated Harness + Middleware | Agent Domain Coordinator / Harness |
| 执行图 | LangGraph createAgent / subgraph | 可选 graph/state machine adapter |
| 默认 workspace | StateBackend（图状态） | Session workspace projection + external workspace adapter |
| 文件权限 | read/write path glob middleware | Permission Authority + Host last-mile enforcement |
| 子代理权限 | 默认继承，可被 child override 替换 | parent grant 是不可扩张 ceiling，child 只能取交集 |
| 同步子代理 | subagent.invoke()，isolated/fork | Child Task / delegated context projection |
| 异步子代理 | remote Thread/Run + parent asyncTasks map | SubagentLaunchIntent + outbox + remote mapping + reconciliation |
| Shell | LocalShellBackend 或 SandboxBackend | 强制可信 ToolHost + OS isolation + capability manifest |
| Sandbox | provider SDK adapter | Host capability profile + sandbox lease/identity/receipt |
| REPL | process-local QuickJS WASM session | ephemeral compute sandbox + serializable/replayable state |
| HITL | interruptOn middleware | PermissionGrant + identity/scope/argsHash/policyRevision |
| 副作用事实 | tool/backend result | OperationIntent / HostStarted / Receipt / UNKNOWN |
| 取消 | SDK cancel call + local status | CancelRequested / HostAck / CancelledConfirmed / UNKNOWN |
| 持久化 | LangGraph checkpointer + external provider state | Event Journal + Task checkpoint + Operation/Effect ledger |

### 8.1 值得吸收

1. Middleware composition：能力模块化，栈顺序显式、可测试。
2. StateBackend / FilesystemBackend / CompositeBackend：区分 checkpointed workspace、外部文件系统和多 backend 路由。
3. Isolated / fork context：显式定义子代理拿到的上下文，而不是默认复制整个 transcript。
4. Sync / async subagent 双模型：当前调用内的子图与远程后台任务使用不同生命周期。
5. AsyncTask status refresh：缓存状态不能冒充 live state；通知失败后仍可 pull/check。
6. QuickJS + PTC：把计算与宿主工具调用分离，工具通过显式 bridge 暴露。
7. Deno allowNet / secrets / volumes 等 adapter options：将网络和凭据注入纳入 sandbox 配置面。

### 8.2 不应照搬

1. 不把 middleware path rules 当作唯一 Permission Authority。
2. 不允许 child permissions 覆盖/清空 parent grant ceiling。
3. 不默认把父 Agent 全部 tools 授予 general-purpose subagent。
4. 不使用 denylist state filter 作为跨信任域的安全隔离。
5. 不将 remote Thread/Run create 与 parent checkpoint 分开后忽略 orphan window。
6. 不将 API cancel ack 直接当作进程树已停止。
7. 不将 LocalShellBackend 或 FilesystemBackend 当作 sandbox。
8. 不把 QuickJS session id serialization 当作跨进程 durable runtime state。
9. 不允许 Deno network egress 默认无限制进入高风险执行 profile。
10. 不允许工具/backend 返回字符串或普通 ToolMessage 作为唯一副作用证据。

## 9. 对目标架构的具体研究提议（未决策）

1. **Capability Delegation**：定义不可变 ParentCapabilityCeiling；child request 只能申请子集。由 Authority 计算 parent ∩ child request ∩ tenant policy ∩ host profile，签发 scoped grant。
2. **Subagent Context Projection**：按字段分类建立 allowlist；明确是否允许 fork transcript、skills、memory、文件引用、用户数据和 secret。默认不透传未分类的自定义 state。
3. **ToolHost boundary**：filesystem、shell、HTTP、MCP、provider、remote Agent Protocol 都必须先提交 OperationIntent，再经过 Permission Authority 和 HostCapabilityManifest gate。
4. **Remote task launch**：先持久化 SubagentLaunchIntent（稳定 local taskId / idempotencyKey / argsHash / policyRevision），再经 Outbox 创建远端 thread/run；保存 remote IDs，支持 query/reconcile 和 orphan discovery。
5. **Cancel semantics**：把 CancelRequested、RemoteCancelAccepted、CancelledConfirmed、LateCompletion、OutcomeUnknown 分开；未确认终止前不宣称 sandbox/process 已停止。
6. **Filesystem security**：默认 root-scoped；fail-closed path filtering；对真实文件操作使用原子 no-follow/dirfd/openat2 方式避免 check/use race；upload/download/delete 都纳入同一权限与审计合同。
7. **Sandbox profile**：默认 deny network egress；按 host allowlist 注入短期 secret；明确 CPU/memory/disk/time、volume persistence、snapshot retention、process-tree kill、network policy 和 data wipe。
8. **QuickJS lifecycle**：将 REPL 定义为可丢弃计算环境；跨恢复需要 serializable cell log/state，不依赖 WASM heap。PTC 每次调用仍使用同一 Host gate，并设置 capability allowlist、预算和审计。
9. **Middleware hardening**：安全 middleware 不应被一般 custom middleware 以名称替换/排除；Host-side gate 独立于 Agent stack，防止绕过。

以上均为待审阅提议，不是 ADR 或实现授权。

## 10. 证据边界与未执行事项

### F：固定源码事实

- Deep Agents 1.16.2 是 LangGraph/ LangChain 之上的 Agent Harness；默认 backend 为 StateBackend，permissions 默认空数组。
- README 明确采用 trust-the-LLM 立场。
- path permission first-match-wins、默认 allow；execute 不受 path rules 管理。
- LocalShellBackend 文档声明宿主权限执行且无 sandbox；virtualMode 不约束 shell。
- SubAgent tools 默认回退到父 tools；child permissions 可替换 parent rules。
- isolated state filter 是固定 denylist；异步 remote thread/run 在本地 Command state update 前创建。
- QuickJS 的进程内 session map、工具 bridge、默认限制和 afterAgent cleanup 可从固定源码核验。
- Deno/Modal/Daytona 是供应商 SDK adapter；Deno allowNet 不配置时无网络限制。

### T：上游测试定义（本轮未运行）

- fs.permissions.test.ts：无规则默认允许、path validation、deny path、recursive delete、sandbox backend guard、CompositeBackend route prefix、symlink target。
- subagents.permissions.test.ts：继承/替换权限规则，含 permissions: [] 清空父 deny 的断言。
- local-shell.test.ts：virtualMode 限制文件 API，但不限制 shell command。
- quickjs/session.test.ts：process/require/fetch 不暴露、memory session dedup、session serialization、PTC bridge。
- Deno/Modal/Daytona provider tests：使用 mock SDK 测试 adapter 参数、错误映射和生命周期；不是供应商安全隔离测试。

### I：架构推断

- Deep Agents path middleware 不能替代全局 Permission Authority。
- 默认 child tool inheritance 与 child permission override 需要不可覆盖的父级授权上限。
- Async remote task create 与 parent checkpoint 之间存在可导致 orphan remote task 的崩溃窗口。
- LocalShellBackend 不适合不可信代码；remote sandbox 的实际安全保证取决于供应商和部署配置。
- QuickJS session handle 不等于 durable heap snapshot。
- Filesystem path check/use 分离应进一步做 adversarial race 评估。

### U：未知

- Deno/Modal/Daytona 真实供应商 VM/container 的逃逸、内核隔离、网络 egress、secret injection、volume mount、snapshot retention、kill latency 和数据擦除保证。
- Agent Protocol server 的真实身份认证、tenant ACL、thread/run owner fencing、remote create 幂等、跨 worker reconciliation。
- provider adapter 的实时 timeout/cancel 语义与 process tree termination。
- 自定义 backend 对 malformed paths 的实际返回形态，以及 fail-open listing filter 是否形成可利用数据泄漏。
- FilesystemBackend 在并发 symlink 替换下的可利用性；本轮没有 race test。
- Deep Agents Python 与 JS 在 permissions、subagent、async task、sandbox provider 上的逐项 parity；本轮只审计 JS。
- 实际消费者 lockfile 解析的 LangGraph 版本；package.json 仅声明 peer range。

### 未执行

- 没有运行任何测试；
- 没有运行 LocalShellBackend、QuickJS、Deno、Modal、Daytona；
- 没有执行 filesystem race / symlink swap / process-tree kill / network egress / sandbox escape 测试；
- 没有创建真实远程 Agent Protocol thread/run；
- 没有运行模型、MCP、HTTP、Shell 或业务 API；
- 没有 benchmark、POC、chaos、crash injection 或跨 worker failover；
- 没有修改业务代码、Kernel、开发测试或 ADR。

## 11. 下一步研究

1. 固定 langchain-ai/deepagents Python 仓库 commit，按相同矩阵比较 Python/JS 的 permission inheritance、state filtering、sync/async subagent、HITL、sandbox backend 与恢复语义。
2. 审计 Deno/Modal/Daytona 官方安全模型和数据保留合同；把供应商声明与 adapter 源码分别标记，不把 SDK mock test 当作安全证明。
3. 深入追踪 Agent Protocol server 的 Thread/Run 创建幂等、worker ownership、interrupt/resume、cancel 和 webhook delivery。
4. 将本报告发现与 v0.2 报告 64–71 做交叉审阅；只提出架构合同修订，不修改已提交 ADR。
5. 只有在用户明确批准验证阶段后，才设计隔离环境 crash/race/egress/kill 测试；当前全部 NOT RUN。

**研究阶段门禁保持：先完成研究报告与独立架构方案，交用户审阅并取得明确批准，之后才进入开发。**
