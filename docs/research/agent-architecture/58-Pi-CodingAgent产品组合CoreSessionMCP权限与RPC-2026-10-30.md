# 58：Pi Coding Agent 1.4.0 产品组合：Core Agent、Session JSONL、Compaction、MCP、权限与 RPC（2026-10-30）

> 研究阶段：固定 v1.4.0 上游源码静态追踪；未运行真实 CLI/MCP/Provider、浏览器或进程故障注入。  
> 上游：earendil-works/pi，tag v1.4.0，release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。  
> 本轮只新增 PR #49 研究报告/进度，不修改 Kernel、业务代码或开发 PR。

## 1. 核心纠偏：Coding Agent 实际采用 Core，不采用 Durable Harness

packages/coding-agent/package.json 明确：

- package：@earendil-works/pi-coding-agent@1.4.0；
- dependencies：pi-agent-core、pi-ai、pi-codemode、pi-mcp、pi-tui，以及其它 Node/CLI 依赖；
- **没有依赖 pi-durable，也没有依赖 Chord 的 Durable Harness**；
- Node >=22.19.0；CLI bin 为 dist/bundle/cli.js，RPC entry 为 dist/bundle/rpc-entry.js。

实际类型及构造路径：

- src/cli.ts → setupCli() → main(argv)；
- src/main.ts 解析 flags/settings/session/trust，构建 session runtime，按 mode 跳转：
  - interactive：InteractiveMode；
  - rpc：runRpcMode；
  - print/json：runPrintMode；
- src/core/sdk.ts createAgentSession()：
  - SessionManager.create()（或用户注入 inMemory/existing manager）；
  - buildSessionContext() 重建 messages/model/thinking；
  - modelRuntime 解析授权/模型；
  - new Agent() 来自 pi-agent-core；
  - new AgentSession() 注入 Agent、SessionManager、SettingsManager、resourceLoader、modelRuntime、extensions；
- src/core/agent-session-runtime.ts AgentSessionRuntime 在 new/resume/fork/switch 时 teardown/recreate runtime、rebind mode / extensions。

因此 Pi monorepo 当前 release 存在至少两个不同 Agent execution runtime：

| 运行时 | 产品/包中的实际用途 |
|---|---|
| pi-agent-core Agent Loop | pi-coding-agent 实际调用；内存单 run / event / tool pipeline |
| pi-durable Harness + GenerationTask/ToolTask | 独立 package 的持久化 Agent/Task engine；coding-agent 1.4.0 没有直接集成 |

**不能把报告 53–57 关于 pi-durable 的 Task checkpoint / Storage atomicity / ToolTask replay 结论套在 pi-coding-agent CLI 上。**

## 2. AgentSession：宿主编排层

src/core/agent-session.ts AgentSession 是所有 mode 共用的业务编排对象，持有：

- pi-agent-core.Agent；
- SessionManager；
- model runtime、SettingsManager、ResourceLoader；
- ExtensionRunner 与 Tools loadout；
- retry、compaction、bash、nested tools、queue、session switch/branch 等状态。

constructor：

1. 订阅 Agent events（internal _handleAgentEvent）；
2. 安装 beforeToolCall/afterToolCall；
3. 安装 next-turn refresh、request projection、boundary hooks、hidden tool declarations 和 forced prompt projection；
4. build runtime/tools；
5. 如果使用默认工具，从 transcript 恢复 tool selections。

### 2.1 Agent event 与 JSONL 持久化的精确顺序

_handleAgentEvent() 大体：

1. 处理 queue / nested call metadata；
2. await extension event handlers；
3. 向 AgentSession 外部 listeners emit 当前 event；
4. **随后**在 message_end 分支调用 SessionManager.appendMessage / appendCustomMessageEntry；
5. turn_end 时 flush pending custom messages。

因此用户侧看到 message_end event 不代表对应 JSONL append 已完成。它只是在 high-level Agent awaited subscriber 的运行期间；同一个 internal listener 后续的同步 append 会发生，但 UI 事件是先发的。宿主不能以收到 UI event 作为磁盘提交/权威 receipt。

对 tool call 的 preflight，_beforeToolCall → ExtensionRunner.emitToolCall；tool result 可由 afterToolCall hooks 改写并做 image normalization。Tool API 的 nested executeTool 经 NestedToolCallRunner 回到相同 Core runToolCall pipeline，但嵌套调用的执行生命周期仍与运行进程耦合，不是 Durable ToolTask child state machine。

### 2.2 prompt / steer / followUp / abort

- AgentSession.prompt() 在已有 streaming run 时要求明确 streamingBehavior=steer/followUp；否则 reject；
- prompt 前会处理 extension slash commands、input transforms、skills/templates、model/auth validation；
- queued steer/followUp 通过 Agent core 的内存队列运行，不是 Durable Submission with requestId；
- AgentSession.abort() 会取消 retry/compaction/branch summary、调用 agent.abort() 并 await waitForIdle()；
- Core tool AbortSignal 是协作式，不能保证 Bash/MCP/远端 side effect 已终止。

## 3. SessionManager：本地 JSONL 会话树，不是 Durable Storage

### 3.1 数据模型

src/core/session-manager.ts CURRENT_SESSION_VERSION=3：

- Session header：session id、timestamp、cwd、optional parentSession；
- append-only entries：每条 id + parentId + timestamp 形成树；
- leafId 指向当前分支的末端；
- branch/tree navigation 通过 current leaf 追 parentId；
- message、model_change、thinking_level_change、compaction、branch_summary、context_edit、usage、custom_message 等不同 entry types；
- buildSessionProjection() 产生 source-entry-preserving 模型上下文，并处理 compaction/branch/custom/edit。

createAgentSession() 以 buildSessionContext() 从已保存分支恢复 Agent 初始 messages/model/thinking；这属于**对话重建**，不是恢复被中断的 ToolTask / Provider stream / external side effect。

### 3.2 JSONL 写入协议与故障边界

- 新 session 先在内存添加 header / model/thinking metadata；首次 user/assistant message 才创建真实文件；
- _persist() 首次真实写入 openSync(file, "wx")，把现有 entries 整批写入；以后 appendFileSync(file, one JSONL line)；
- _appendEntry() **先**更新 fileEntries / byId / leafId，**再**执行 _persist(entry)；
- _rewriteFile() openSync(file, "w") + writes + close，没有新文件 temp/rename；
- 此处没有看到每条 append 的 fsync/目录 fsync 或数据库事务、执行意图 ledger；
- loadEntriesFromFile() 用 1MiB buffer + StringDecoder UTF-8 逐行读取，malformed JSON line 直接 skip；最后非 LF 结束的 pending text 也尝试 parse；
- 完整已有文件没有合法 header 时拒绝，而不是默默把它当新 session。

**风险推断**：

1. memory state 先推进、磁盘 append 后执行：append 失败可能令内存 branch 位置与磁盘状态不一致；不能把 _appendEntry 当成 atomic commit。
2. 同一个 JSONL file 由两个进程同时 append 没有在该方法展示 writer ownership / durable fencing；其它系统可能保护路径，但不能擅自宣称安全。
3. 无 per-entry fsync + rewrite truncate，不能承诺设备断电后完整历史。
4. 错误工具调用的 side effect 先于最终 ToolResult JSONL append，崩溃后 tool outcome 可能未知；不存在 Core/Durable ToolTask 一样的 execute intent checkpoint。

这些是实现逻辑推断；本轮没有运行 crash/multi-owner injection。

## 4. Coding Agent 自有 Compaction != Durable CompactionTask

coding-agent/src/core/compaction/compaction.ts 实现独立的 prepareCompaction/compact，依赖 AgentSession/SessionManager，而非报告 57 的 Durable Task。

关键机制：

- prepareCompaction() 根据当前 JSONL session leaf 的 canonical projection 和 keepRecentTokens 选 firstKeptEntryId；
- 支持 split turn：除已总结的旧历史外，可另做 turnPrefixSummary，避免模型续写时缺少一个长工具轮次前缀；
- 保留 previousSummary、fileOps，摘要末尾附读/写文件记录；
- SessionManager.appendCompaction 写入一个带 firstKeptEntryId、tokensBefore、usage 和 systemMessage 的顶层 compaction Entry；
- AgentSession._refreshFinalizedContext() 再把投影消息重装回 Core Agent；
- Manual compaction 先 abort 当前 run，创建独立 AbortController，支持 session_before_compact hook 的 cancel/custom summary，再持久化；
- Auto compaction 处理 threshold/overflow，extension 同样可拦截，成功后依据 willRetry 或 queued inputs 决定 continue；
- 没有在上述 Coding Agent API 中构造 Durable CompactionTask、persist phase select/summarize/retry、owning GenerationTask 或写入 durable Submission；
- 当前正在进行的 compaction 如果进程消失，JSONL 只可能保存已 append 的最终 summary 与此前 history，未见可恢复的模型摘要 request checkpoint。

两个实现共享“保留原始历史 + summary head/projection”的思想，但不能把 Durable 的后台写入竞态与 Coding Agent 的单进程编排行为混为一谈。

## 5. MCP：内置 Extension 管理多种工具曝光方式

src/extensions/mcp/index.ts 内置扩展：

- 读取 mcp.json 与扩展动态 registerMcpServer()；同名时 mcp.json 优先；
- 默认 exposure=codemode：MCP tools 不直接出现在模型声明中，由 codemode script 经搜索/namespace 调用；
- exposure=deferred：通过 tool_search 动态加载后再声明给模型；
- exposure=direct：立即声明为普通模型 tool；
- exposure=hidden：不可达；toolExposure 可按单个 tool 覆盖；
- 工具命名 mcp__<server>__<tool>；有命名 collision 处理；
- stdio / streamable HTTP transports、OAuth sign-in、资源读取工具和 reconnect manager；
- 对 direct tools，第一次 prompt 等待连接完成，但只到 startupWaitMs（默认 10s）；codemode/search/resource tool 在调用时等待需要的 server；
- Session 级 AbortController + pending backgroundActions 跟踪 connect/disconnect/signin；session_shutdown abort 并 await closings；
- 所有 MCP calls 经过普通 tool_call/tool_result hook pipeline，包括权限扩展。

**含义**：工具声明、实际可执行/可见、动态连接、授权/扩展审批在不同层；不能只从 LLM 的 tool list 推断工具策略已被执行端强制实施。

## 6. 安全边界：Project Trust 和 per-tool permission 不同

coding-agent/docs/security.md 明确写道：

- Pi 以启动它的 OS 用户权限读写执行文件；
- **默认不会在每个 tool call 前请求人工批准**；
- extensions / package installers / language servers / child processes 可获得同一 OS 权限，除非另有容器/VM/OS 边界；
- project trust 控制项目提供的设置、MCP/extensions/skills/prompts/themes 等启动资源是否自动加载，**不**限制已启用工具能访问的路径；
- .pi/project sessionDir 在 trust 决策之前读取是文档明确提到的例外；
- AGENTS/CLAUDE 等上下文说明即使拒绝信任项目仍可能加载（除非禁用上下文加载），必须按不可信 prompt input 处理。

工具可经 tool_call hooks 添加权限检查：

- AgentSession._beforeToolCall 在执行前调用 ExtensionRunner.emitToolCall；
- Runner 按注册顺序 await handlers，第一项 block=true 即停止；
- 例子 examples/extensions/permission-gate.ts 在 Bash 命令匹配危险正则时询问用户；无 UI 时 deny；
- **示例扩展不等于默认内建所有工具都有强制审批**。

因此产品的安全默认主要依赖 OS sandbox/容器/最小权限与 project trust；若目标 Agent 需要强制 permission broker、持久授权收敛与可审计审批，必须设计为宿主强制执行边界，不能只复制可选扩展 hooks。

## 7. RPC / TUI / Print：模式共享业务 AgentSession，I/O 语义不同

- main.ts 按 mode 选择 InteractiveMode / runRpcMode / runPrintMode；每个 mode 使用同一 AgentSessionRuntime/AgentSession；
- RPC mode 基于 stdin/stdout JSONL command/response/event，command 带可选 id；
- prompt 的 response 在 preflightSucceeded 后回报 disposition=handled/queued/...，这是**受理回执**，不是模型完成结果或 Tool side-effect receipt；
- 同步响应 steer/follow_up/abort/new_session 等命令；runtimeHost 切 Session 时重新 bind extensions、重新订阅事件与输出背压 observer；
- RPC extension UI request 用独立随机 id 与 pending in-memory Map，支持 AbortSignal 与 timeout 默认值；进程退出不能按 Durable Submission 恢复这些 pending UI requests；
- agent event 流发送到 stdout，Agent.subscribe 的 awaited observer 使用 waitForRawStdoutBackpressure 避免无限输出缓冲；
- RPC shutdown dispose runtime、detach input、尝试 flush stdout，再退出；SIGTERM 与 SIGHUP 的处理不同，不等同持久化工具完成协议；
- InteractiveMode 负责 TUI 表现、用户输入和交互；PrintMode 单次 prompt 输出后退出。

RPC 的 request correlation 不等于防重复 requestId admission；断线/重启后是否重复执行需由调用方与 Agent Host 的独立协议处理。

## 8. 两套 Pi 执行架构的关键差异

| 维度 | pi-coding-agent (Core Agent + SessionManager) | pi-durable (Harness + TaskScheduler) |
|---|---|---|
| Agent engine | pi-agent-core 内存 Loop | 独立 GenerationTask + ToolTask 引擎 |
| Session | 本地 JSONL append-only tree、leafId | Durable Conversation / Entry / Document / Task / Submission |
| 持久化写入 | sync appendFileSync；无逐条 fsync/atomic batch | Storage.commit atomic batch contract；后端保证各异 |
| 中断后恢复 | 重建会话分支/context/model/thinking | Task checkpoint、restart count、wait graph 与 durable receipts |
| Tool effect intent | 未见 execute-before journal | ToolTask 先 commit execute intent |
| Queue | Agent Core 内存 steer/followUp | Durable Submission + Inbox + requestId |
| Compaction | AgentSession 单进程协调，自有 compaction module | CompactionTask select/summarize/retry + Task owner & Submission |
| Permission | OS user + project trust + 可选 tool_call hooks | Tool hooks / tool registration，强制 Host 权限层仍需另设计 |
| UI / RPC | TUI、Print、stdin/stdout RPC | commit-derived watchEvents + host 应用可自主接 UI |

**产品层的可用性与 Durable runtime 的理论恢复能力不可相互借证。**

## 9. 事实 / 推断 / 未知

### 源码/官方文档事实

- Coding Agent 1.4.0 package 依赖 pi-agent-core，不依赖 pi-durable。
- sdk.ts 实际 new Agent()，AgentSession constructor 挂 internal event listener 与 tool hooks。
- message_end 对外 event 在 SessionManager appendMessage 前 emit。
- SessionManager._appendEntry 更新内存 index/leaf 后再 append JSONL；普通 append 未 fsync。
- Coding Agent compaction module 独立于 Durable CompactionTask，append JSONL summary + refresh model projection。
- MCP 内置 extension 默认 exposure=codemode，支持 deferred/direct/hidden，tool hooks 在调用时运行。
- 官方 security.md 明确无默认 per-tool approval，project trust 非 sandbox。
- RPC prompt response 是 preflight acceptance、UI requests 只有内存 pending map。

### 推断（未动态验证）

- Coding Agent JSONL 可能在磁盘写入失败时与内存投影分叉；真实异常是否传播为 Agent error 需动态复现。
- 通知先于同步 append：如果 UI 已收到事件而随后写入失败，UI/磁盘状态会暂时不一致。
- 普通 JSONL Session resume 不能恢复进程退出前已产生但未记录结果的 Tool side effect。
- RPC command correlation 无跨进程 idempotency ledger；调用方需要明确对账协议。

### 未知

- 真实 Coding Agent CLI crash / OS power failure / JSONL torn-tail / concurrent multi-process 对同一 Session 写入的完整收敛。
- project trust 与扩展安装器 / MCP credentials 的生产威胁模型动态验证。
- 真实 MCP reconnection、OAuth、permission hook failure 与 user dialog response race。
- MCP 外部副作用、Bash 工具 subprocess 完整强制终止和恢复。
- npm 发布 dist 与 v1.4.0 TypeScript build byte parity。

## 10. 独立架构启示（尚未定案）

1. 同样的 Pi monorepo 同时提供轻量 Core 与 Durable 引擎，证明“执行循环”和“可恢复执行内核”不一定能无代价互换；先明确目标产品必须达到的故障级别。
2. 若要求强恢复/审计，不能仅依赖 JSONL transcript；必须独立记 Tool Intent、Task owner epoch、Receipt、Unknown outcome / external idempotency。
3. Event to UI 的可观察顺序与 Durable commit ack 必须分层；不能把 event emit 当作提交事实。
4. Project trust / tools exposure / permission broker / OS sandbox 是不同防护域，最小权限和强制执行不能委托模型或可选 extension。
5. MCP 默认可采用间接曝光减少模型 tool 列表，但真正 gate 在工具执行 Host 与权限决策边界。
6. Session branch、compaction marker、provenance、context edits 值得借鉴，但不能继承弱持久化或无边界重放缺陷。
7. 目标架构需独立选择：是否一个 Durable engine 承接 CLI/TUI/RPC，或者轻量 Loop + durable coordinator 的拆分，并以真实故障验证评价，而不是先决定继承现有 Kernel/Pi。

## 11. 下一步

1. 对照 Claude CLI 2.1.304、Desktop 3.1623.1、SDK wrapper 0.3.304 与 Pi Core/Coding/Durable/Chord 1.4.0，按完整场景矩阵比较 Loop、工具、权限、MCP、Host、Context、Task、Session、Storage、Recovery、Crash semantics。
2. 在相同前提下提炼成熟方案最佳实践和设计不足，区分源码事实、推断、未知。
3. 给出不受旧 Kernel 约束的独立目标架构备选方案、模块职责/接口/时序、技术选型、恢复与权限模型、风险和实施路线图。
4. 先提交完整研究与架构报告供用户审阅，收到明确批准前不得开发。

## 12. Evidence index

| v1.4.0 上游文件 | Git blob SHA | 关键锚点 |
|---|---|---|
| packages/coding-agent/package.json | e0955b0e7827d5c119a7dc96bbac70bc8a11e9c5 | dependencies, exports, entrypoints |
| packages/coding-agent/src/cli.ts | bdb184edf76d5f3129fd4206cf1b9c61cb799268 | CLI entry |
| packages/coding-agent/src/main.ts | 51df447c540ecb34a0c7ab9bf1edef1d337225a1 | mode dispatch, session/trust setup |
| packages/coding-agent/src/core/sdk.ts | 0bf874fff7817d1e13e93d6af53285b019ba19c5 | createAgentSession L191–480, new Agent L403, new AgentSession L453 |
| packages/coding-agent/src/core/agent-session.ts | 3a9174cf6ea4cdce791c08a84f6ac25b95b6fb01 | tool hooks L645–750; event persistence L1103–1170; prompt/abort; compaction L2828–3305 |
| packages/coding-agent/src/core/session-manager.ts | df5281a0a4258462b14faa7d055efa09783ea6aa | buildContextEntries L476, buildSessionProjection L543; JSONL load L627, _persist L1172, appendCompaction L1260 |
| packages/coding-agent/src/core/compaction/compaction.ts | 07a58ac6cf6e2141fc07133677583ab18bb97298 | prepareCompaction L859, compact L952, split turn, file ops |
| packages/coding-agent/src/core/extensions/runner.ts | 77712e677f91dde65d4d4db906a26b16bbd9de9c | emitToolCall L1249, emitToolResult L1190 |
| packages/coding-agent/src/core/agent-session-runtime.ts | c1d7655dcc9888fd0bbb70304e6a62b84d3b22fc | new/switch/fork/resume and rebind |
| packages/coding-agent/src/core/mcp-servers.ts | 1f6414928f37c1ed2b96f51a4918ec17a01a6ae5 | registration vs connection / naming |
| packages/coding-agent/src/extensions/mcp/index.ts | v1.4.0 source | exposure modes, connect, lifecycle, tool_call waiting |
| packages/coding-agent/src/modes/rpc/rpc-mode.ts | 1c0995d36ec752155f1d13b019728f9343bb263c | JSONL RPC request/response, UI pending, stdout backpressure |
| packages/coding-agent/docs/security.md | v1.4.0 source | OS permissions, project trust, no default per-tool approval |
| packages/coding-agent/examples/extensions/permission-gate.ts | ce29f7eb5cf925a1449cfdfde3a5b8bc9137e530 | optional tool_call confirmation extension |

**证据等级：** 固定 release source 和官方文档静态复核；没有真实 CLI / MCP / provider / OS crash 动态测试。