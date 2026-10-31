# Agent 架构研究进度与跨对话续接点

> 最后更新：2026-10-31（报告 65：可靠性 capability vector、SQLite/PostgreSQL ACK、Outbox 与 Event Cursor 合同）  
> 当前阶段：**源码比较首轮完成；独立架构 v0.2 + Storage/EventHub 合同已提交审阅；A/W/E/X capability profile 与产品需求仍待确认**  
> 开发批准：**未获得；禁止开始实现开发。**

## 1. 当前目标

重新确认我们需要的 Agent 架构。现有 Kernel 可以舍弃或重写。研究成熟实现后，再从目标需求出发设计，不先假设要保留现有模块，也不先决定采用 Claude 或 Pi。

## 2. 已核对的仓库状态

- 本研究 PR 从 `main` 独立分支建立，只保存研究计划与进度，不放实现代码。
- [PR #48：Pi Agent Core adapter spike](https://github.com/wwxst/agent-/pull/48) 仍是实验性分支，包含隔离原型和报告 30–32；它不是新架构批准，也不应据此继续开发。
- [PR #47：parallel tool-result context ordering](https://github.com/wwxst/agent-/pull/47) 是旧 Kernel 的独立修复，不代表新架构必须沿用旧 Kernel。
- PR #48 的旧报告已记录：Pi 动态 loop 4 项实验通过，适配原型共 11/11 测试通过；测试使用确定性 fake stream、fake Host / in-memory Journal，不能证明真实数据库事务、生产权限、崩溃恢复或外部副作用安全。
- 报告 32 对 Claude CLI 2.1.304、Desktop 3.1623.1、SDK wrapper 0.3.304 做过静态对照，明确没有运行 Claude CLI/Desktop，也没有真实模型请求。该报告仍偏向与旧 Kernel 对照，需重审。
- 已检索到上传资料包的 `README.md` 与 `SPLIT_MANIFEST.json`。资料包按 CLI 引擎、Desktop/SDK 宿主、旧版源码参考、分析证据、工具和完整性清单分组。**组件已整理不等于每条执行链都已研究完成。**

## 3. 现有研究材料（初步，不是最终结论）

| 材料 | 已有内容 | 局限 / 后续核验 |
|---|---|---|
| 报告 30 | Pi Core 动态 loop 的 4 项隔离实验 | 核对发布包与上游源码一致性；补足未覆盖行为 |
| 报告 31 | Pi Core 注入 Journal/Host 的边界原型，11/11 测试 | 未接真实 EventStore/Host；不证明事务、恢复和安全边界 |
| 报告 32 | Claude CLI / Desktop SDK 与旧 Kernel 的初步对照 | 静态分析；不能把旧 Kernel 的约束当成新设计要求 |
| 报告 33 | CLI 2.1.304 入口→Loop→模型流→工具调度→结果回填 | 静态源码；持久化/Host/完整失败状态机仍需继续 |
| 报告 34 | session.append hook、transcript writer/flush、local/remote tool route | 已追 queue drain 与 exit flush；未证明底层 fsync/crash guarantee |
| 报告 35 | remote ToolHost 路由、权限 gate、call state、reconnect reconcile 与 delivery_unknown | 静态源码；未运行真实 Host；ledger 跨进程持久化保证未知 |
| 报告 36 | transcript 写入失败的 Promise/健康状态语义；stream fallback/refusal/model fallback 的消息撤回与工具停止机制 | 静态源码；Storage V5 backend 保证、错误恢复全路径及已产生副作用尚未动态验证 |
| 报告 37 | Storage V5 reader 的 read→readRecords fallback、torn tail/无效 JSONL 容错；writerHealth 降级/恢复和 session UUID dedupe 依赖 | 直接复核发布版 JS；尚无 V5 backend 物理持久化或崩溃注入证据 |
| 报告 38 | fallback abort → session control_cancel_request → Host tool pipeline；call_id/request_id/worker_epoch；Host call ledger、disowned tombstone、outcome query 与 correction | 静态源码；发现 direct cancelled 分支不进入 caller m_e given-up 队列的风险点 |
| 报告 39 | Bash foreground 进程终止、background listener detach；MCP notifications/cancelled、server handler signal、tasks/cancel 与错误副作用分类 | 静态源码；未运行真实 Shell/MCP server；后台 task 恢复与第三方 MCP 是否响应取消仍未知 |
| 报告 40 | Bash task registry/output file 分离；普通 MCP auto-background 与 SEP-2663 Task 区分；metadata/outcome sidecar、resume/reconnect/poll、TaskStop 取消确认边界 | 静态源码；local Bash process restart/reattach、Storage V5 sidecar 物理耐久性、第三方 MCP Task cancel 均未动态验证 |
| 报告 41 | Bash / MCP ordinary / SEP-2663 / Remote Host 的取消时序矩阵；task handle 迟到时补发 tasks/cancel；按阶段比较 caller、执行端、sidecar/ledger 与结果回收 | 静态源码综合；未运行故障注入；local Bash restart、第三方 MCP cancel、Storage V5 durability 仍未知 |
| 报告 42 | Agent Tool sync/async launch；parentAgentId/ownerAgentId；keepalive/notification；TaskStop ownership/cascade；metadata+transcript resume；worker adoption 与 Shell PID reattach | 静态源码；remote Agent Host、worker crash/reconnect、Storage V5 sidecar durability 和部分 parent-stop 时序未动态验证 |
| 报告 43 | Full/Reactive/Precomputed compaction 与 Microcompact 区分；按 assistant message ID 保留完整轮次；compact boundary UUID relink；Agent Uve 状态附件；precompute main-only 边界；Agent resume reader 通过 hdo/RMt/bdo 重建 parentUuid 与 tool_result | 静态源码；未运行 compaction/resume；多次 compact + torn tail、remote worker handoff 与 Storage V5 durability 未动态验证 |
| 报告 44 | Remote Agent Tool → Cloud Session create → remote_agent task/metadata sidecar → K3t event poll + permission relay → MQt/O8o resume → TaskStop/archive；区分 cloud task restore 与 local Agent W7/adoptedPrefill | 静态源码；event cursor replay、archived terminal replay、archive ack、Storage V5 durability 与真实 cloud worker 行为未动态验证 |
| 报告 45 | Storage V5 注入链：default factory hFr 不提供 backend、main/init 外部注入与 configHome guard；逻辑 keyspace/hostFiles 边界；Agent/Remote Agent/MCP/precompact/transcript 写入 discipline 矩阵；本地 On/VQ atomic rename、flush gate 与 transcript compaction sync 对照 | 静态源码 + 有限 binary string scan；具体 V5 provider、atomic/inPlace 精确定义、fsync/目录同步/远端提交保证、断电恢复均未知 |
| 报告 46 | Transcript / Agent resume / Remote Agent 联合恢复矩阵：read→readRecords 条件、4 MiB 分页与 256 MiB cap、JSONL invalid/torn tail、5 MiB fast scanner、dRt row normalization、hdo 多次 compact / preserved UUID / anchor、RMt/Sdo parent fallback、bdo parallel tool_result、Remote Agent cursor/metadata/archive 故障矩阵 | 静态源码；未运行真实 Storage V5 provider / Cloud Session；null cursor 服务端语义、archived 语义、crash 时序和启发式跨 Agent 影响仍未知 |
| 报告 47 | Desktop 3.1623.1 / SDK host startup、RemoteServerController、Session query lifecycle 与双向协议第一轮追踪 | 静态源码；helper server-side、完整权限收敛和进程恢复仍需核验 |
| 报告 48 | RemoteProcess sequence replay / stdin offset / orphan reaper；persisted adoption policy；MCP 多拓扑；ToolPermissionBroker；EIPC event 与 snapshot recovery | 静态源码；SSH helper 服务端、动态 crash/side-effect、Desktop 全生命周期仍未知 |
| 报告 49 | Local spawn vs SSH custom spawn；Turn interrupt / Session stop / Query close / OS process exit；WarmLifecycle / Idle pause；app quit；Local / SSH Waiting Input 恢复与 quit auto-resume | 静态源码；native process job 语义、真实 process exit、queue 对账歧义与故障恢复仍需动态验证 |
| 报告 50 | SDK canUseTool / onUserDialog / Hooks 注入；hook_callback generation、timeout、AbortSignal、cancel 与 late response；CLI reinitialize pending request redelivery；PermissionBroker / UserDialogBroker 等待语义；renderer snapshot recovery 边界 | 静态源码；hosted renderer reload 行为、MCP elicitation、native / helper 语义与动态故障验证仍未知 |
| 报告 51 | custom3p-mcp HTTP/SSE utility host 与 stdio 路径；URL elicitation consent、MessagePort seq / elicitationId、complete notification、port drain、host shutdown | 静态源码；MCP server reconnect / elicitation recovery、native dialog 与 utility crash 行为未动态验证 |
| 报告 52 | Pi Agent Core v1.4.0 release commit pin；旧动态实验 source blob parity；Agent / low-level Loop；event barrier；steering/follow-up；context transform；parallel tool ordering；abort/error/truncation；Core vs Durable package boundary | Core 源码静态复核 + 既有 fake-based 11/11 实验；npm tarball dist 字节级校验、真实 Provider/Host/DB/crash 未做；pi-durable / Chord / coding-agent 待研究 |
| 报告 53 | pi-durable 独立 Agent runtime；SessionImpl serialized commit line；Conversation / Entry / Document / Task / Submission；TaskScheduler restart / reserve / phase / ownership / abort cascade；GenerationTask retry / deferred / compaction / tool round；ToolTask intent / safe replay / nested calls；commit-derived watchEvents | 固定 release 源码静态追踪；SQLite/JSONL/IndexedDB adapter、Chord transaction、真实 crash / external side effect、CompactionTask 动态验证仍未完成 |
| 报告 54 | Chord 1.4.0 Host / Facet / Contract / Object / Ref；root / principal / cancellation；Protocol v4 / Link / Connection / ack flow control / resync；ReplicatedState 100-event overflow；strict JSON delta / immutable tracker；local / cluster hot reload 与 code-version retirement；排除未发布 src/next | 固定 release 源码静态追踪；多进程 / WebSocket / reload / revoke 动态验证未做；Chord 不是 Durable Store，pi-durable backend adapters 待研究 |
| 报告 55 | Pi Durable 1.4.0 Memory / JSONL / SQLite / IndexedDB / Cloudflare DO Storage；atomic batch、seq、ID、schema migration、delta/base/reclaim、poison/recovery；Node WAL/NORMAL、JSONL sidecar→marker 与 fsync 缺口；上游故障测试证据 | 固定 v1.4.0 源码 + 既有测试文件静态分析；本轮未执行测试；真实 power failure、multi-owner fencing、external effect exactly-once 未验证 |
| 报告 56 | Chord 1.4.0 Node HostManager start/stop/replace/ready/fatal/idle；forkDriver IPC/process group；childControl.lock-before-storage；processLock Linux abstract socket / Windows named pipe / Unix socket file stale race；root/Link in-flight outcome unknown；上游真实子进程测试源码 | 固定 v1.4.0 源码和既有 tests 静态复核，未执行；没有内部 crash auto-respawn；父进程崩溃、跨平台锁、multi-owner DB 与外部工具效果未动态验证 |
| 报告 57 | Durable CompactionTask select/summarize/retry checkpoint；ContextView head/tail/edits 与 tool result projection；blocking/background/overflow；Submission stale 规则；SQLite reopen 和中断摘要重发；并发应用 edit 被旧 summary 遮蔽的显式上游测试 | v1.4.0 源码与上游测试静态核验；本轮未运行测试，真实 provider billing、脱敏/删除一致性、断电故障未验证 |
| 报告 58 | pi-coding-agent 1.4.0 实际依赖 pi-agent-core 而非 pi-durable；CLI→SDK→AgentSession→SessionManager；JSONL session tree/compaction；extension tool hooks；内置 MCP exposure/connection；project trust 与默认 tool approval；TUI/Print/RPC 受理/事件边界 | 固定发布版源码和 security docs 静态核验；no CLI/MCP/Provider/crash tests；JSONL 无 Task execution intent/recovery 与独立 Durable Harness 不能混淆 |
| 报告 59 | Claude CLI/Desktop/SDK vs Pi Core/Coding/Durable/Chord 的 12 个相同场景：并行 tool、远端 effect unknown、权限等待、取消、恢复、event/commit、compaction、MCP、subagent、API ack、power loss、owner fencing；最佳实践/缺口对照 | 来源于既有报告 33–58 的固定源码证据、上游测试定义；本轮未运行动态故障测试，未知明确保留 |
| 报告 60 | 独立 Agent 执行内核候选架构 v0.1：小 Loop + durable Run/Task/Operation Journal + Tool Host/Gateway + Permission Authority + Context/Session/EventHub；状态机、IDs、3 条时序、技术选择和风险 | **设计提案，不是已有实现或开发授权**；R0–R4 保证等级、API/invariant 及部署选择待用户审阅 |
| 报告 61 | 方案评审选择、10 条关键不变量、FI-01–16 故障验证计划、性能/可维护性评估、未来阶段路线图与未决问题 | **未来验收计划未执行**；阶段 1–6 仅在用户明确批准开发后可启动 |
| 报告 62 | Operation UNKNOWN 回收协议：稳定 operationId/attemptId、Control owner vs effect owner、四轴状态、Host capability/prepare/execute/queryOutcome、可信旧 epoch late receipt、provider idempotency 边界 | 固定 Claude 35/38/41/48/50 和 Pi ToolTask/Scheduler/Chord v1.4.0 源码复核；协议为目标架构提案，未执行故障注入 |
| 报告 63 | 权限/沙箱/数据安全设计：Project Trust vs tool approval vs OS sandbox、OperationGrant、nested/MCP/Subagent delegation、revoke TOCTOU、summary redaction lineage、物理删除冲突；A/B/C 架构替代方案与 ADR | 引用 Pi Coding official security.md/ToolHooks/Chord principal、Claude Desktop SDK；最终选型未批准，动态安全试验未做 |
| 报告 64 | v0.2 整合设计：Hybrid C 默认候选与 Task-native B fallback；控制面事务/Intent/Receipt；stream-local eventSeq/snapshot consistency/provisional streaming；真实 Host effect evidence 及 recovery；7 项扩展故障门槛 | 设计合同，不是业务实现；未执行 CI/故障测试；报告 60/61 原简化表述已经加修订说明 |
| 报告 65 | 可靠性保证 capability vector：A0–A3 commit ACK、W0–W2 writer authority、E0–E2 event delivery、X0–X4 effect evidence；Pi SQLite/JSONL 源码与 SQLite/PostgreSQL 官方事务/同步语义；per-stream cursor、snapshot consistency、transactional outbox 重复投递与 client replay | 固定 Pi v1.4.0 源码 + SQLite/PostgreSQL 官方文档 + AWS/Debezium outbox 指南；报告是设计合同，未执行目标环境 crash/HA/outbox tests |

## 4. 研究覆盖率

| 子系统 | 状态 | 下一步 |
|---|---|---|
| 资料版本、分包和完整性入口 | 已初步盘点 | 核对核心文件与版本来源，建立可导航源码索引 |
| Claude CLI 入口与主循环 | **第一轮源码追踪完成，待继续核验** | 报告 33–34 已追入口→main/session driver→YL→su/iu→流式请求→ToolCall 调度→结果回填，并区分 session.append hook 与 transcript writer；已追 record/queue/flush/exit hook；直接文件路径使用 appendFile 或 open/write/close，本层未见 fsync；Storage V5 backend 保证未知。remote Host 路由/reconcile 已有报告；报告 36 新增 writer 失败 Promise/健康状态和流式 fallback 状态清理；报告 38–41 已补 remote cancel/call ledger、Bash/MCP executor、后台任务恢复与取消时序矩阵；报告 42–43 已补 Agent/Subagent lifecycle、compaction 与 transcript resume reader；报告 44 已追 Remote Agent Cloud Session create/poll/restore/archive；报告 45 已追 Storage V5 default injection seam、configHome guard、keyspace 与 sidecar write discipline；报告 46 已建立 reader/Agent resume/Remote Agent 联合恢复矩阵；仍需核验 provider physical durability、真实进程/服务器取消及完整故障状态机 |
| Claude CLI 权限、并发和失败恢复 | **本地与远端任务路径已有静态状态机；动态验证未做** | 报告 38–41 覆盖 Remote Host/Bash/MCP 取消；报告 44 覆盖 Remote Agent Cloud Session create/poll/restore/archive 与 permission relay；仍需验证 event cursor replay、archived result recovery、archive ack、真实 Shell/MCP/cloud side effects |
| Claude CLI 上下文压缩与 Subagent | **第一轮静态源码链与状态矩阵已完成；动态验证未做** | 报告 42–46 覆盖 Local Agent ownership/keepalive/TaskStop/resume、worker adoption、Full/Reactive/Precomputed/Microcompact、compact-boundary relink、dRt row normalization、hdo preserved UUID、RMt/Sdo parent fallback、bdo tool_result 修复、Storage V5 readRecords/torn-tail，以及 Remote Agent metadata/cursor/archive 恢复矩阵。多次 compact、坏 transcript、跨 Agent fallback、真实 provider 与 remote worker crash 仍未动态验证 |
| Desktop / SDK 启动、Session、双向协议 | **可读发布版源码范围内主要宿主 / callback / MCP 生命周期静态追踪完成；hosted renderer / native / 动态边界未闭环** | 报告 47–51 已追 host startup、SDK query / 双向协议、RemoteProcess adoption、MCP 多拓扑、Agent 权限 / Hooks / pending redelivery、local spawn、interrupt / stop / close、Idle / pause、app quit、Session / Waiting Input 冷恢复、custom3p-mcp URL elicitation 与 utility host shutdown。剩余：hosted renderer reload hydrate、native process job / SSH helper server-side、MCP server reconnect / elicitation recovery 与真实 crash / side-effect 验证 |
| MCP、宿主工具桥接和安全边界 | **协议取消与 SEP-2663 恢复路径已部分核验** | 报告 39–41 已追 notifications/cancelled、迟到 task handle 后 tasks/cancel、metadata/outcome sidecar、resume/reconnect；继续核对第三方 server 真正停止、cancel 未确认后的恢复义务 |
| 完整源码比较与独立架构研究 | **首轮源码和 12 同场景对比完成，架构 v0.2 与协议/安全修订已提交待审阅；真实故障验证未执行** | 报告 59 提供比较；60–61 是初版架构/验收；62 定义 Host Operation/UNKNOWN 和 late receipt；63 审查权限/沙箱/历史删除及 Hybrid/Task-native 取舍；64 整合 v0.2 事务、UI event cursor、Task/Host 状态与崩溃恢复。报告 60/61 原断言已注明修订；**未获开发批准** |
| 横向架构比较 | **报告 59 已完成首轮 12 场景对照，待真实故障证据** | 在 v0.2 中验证 external effect/permission/fencing 的边界；旧报告 32 不作为最终结论 |
| 新目标架构 | **报告 60–65 已形成 v0.2 + Storage/EventHub 合同候选，待用户审阅，不是已批准设计** | 评审 Hybrid C/Task-native B，选择 A/W/E/X capability profile、Host/sandbox、Context erasure、实际工具幂等能力，并补充待证据 |
| 用户确认 | **未获开发批准；等待对 v0.2 和决策项的明确评审** | 用户可要求只修订设计；“继续”不能解释为准许进入开发 |

## 5. 下一步任务（按顺序执行）

### A. Claude CLI 的完整执行链（第一轮主路径已追通，继续补边界）

历史研究索引：[33：入口/Loop](./33-Claude-CLI执行链源码复核-2026-10-29.md)、[34：transcript/路由](./34-Claude-CLI会话持久化与工具路由复核-2026-10-29.md)、[35：remote Host/reconcile](./35-Claude-CLI远程工具Host与恢复状态机复核-2026-10-29.md)、[36：写入失败和 fallback](./36-Claude-CLI写入失败与流式Fallback收敛-2026-10-29.md)、[37：Storage V5 reader 与 WriterHealth](./37-Claude-StorageV5读取修复与WriterHealth证据-2026-10-29.md)、[38：远程工具取消与执行账本收敛](./38-Claude-CLI远程工具取消与执行账本收敛-2026-10-30.md)、[39：Bash 与 MCP 工具取消语义](./39-Claude-Bash与MCP工具取消语义-2026-10-30.md)、[40：后台 Bash 与 MCP Task 恢复边界](./40-Claude-CLI后台Bash与MCP任务恢复边界-2026-10-30.md)、[41：取消时序矩阵与结果回收边界](./41-Claude-CLI取消时序矩阵与结果回收边界-2026-10-30.md)、[42：Subagent 生命周期、所有权、停止与恢复](./42-Claude-Subagent生命周期所有权停止与恢复-2026-10-30.md)、[43：上下文压缩与 Subagent 恢复连续性](./43-Claude-CLI上下文压缩与Subagent恢复连续性-2026-10-30.md)、[44：Remote Agent 云端 Session 生命周期与恢复](./44-Claude-Remote-Agent云端Session生命周期与恢复-2026-10-30.md)、[45：Storage V5 Backend 来源与 Sidecar 持久化保证](./45-Claude-StorageV5Backend来源与Sidecar持久化保证-2026-10-30.md)、[46：Transcript 与 Remote Agent 联合恢复状态矩阵](./46-Claude-Transcript与RemoteAgent联合恢复状态矩阵-2026-10-30.md)。

报告 43 完成 compaction 与 Agent resume reader 闭环；报告 44 完成 Remote Agent cloud task 第一轮：

- Remote Agent Tool 创建独立 Cloud Session；本地 TaskRegistry type=remote_agent，不是 local_agent/W7。
- nUe 注册 remote task、写 remote-agents metadata sidecar、启动 K3t poller；metadata write 是 best-effort，未 await。
- K3t 用 dTe 按 cursor 拉取 event，bXe 通过 appendFile 写本地 output；permission relay 只把本地 canUseTool 的 allow 回传远端。
- MQt/O8o resume 从 sidecar 查 session_status，非 archived session 重建 task record 并重新 poll；这是 reconnect，不是恢复远端 Agent loop。
- TaskStop 本地先标记 killed，YO 异步 archive，不等待确认；随后停 poller、删 sidecar。
- metadata 有 runId 用于 notification dedupe，但不保存 lastEventId；恢复时 cursor 从 null 开始。output writer append-only，存在 event replay/重复输出风险。
- O8o 对 archived session 直接删除 metadata，不拉 terminal event、不补 notification；若远端已完成而本地未消费结果，可能出现结果通知缺口，需动态验证 archived 语义。

报告 45 核对 Storage V5 backend provenance 与写入持久化边界：

- CLI entry 在 CLAUDE_CODE_HOVER_REST 启用时调用 pinStorageV5FromEnv；默认 factory hFr 不返回 backend。main/init 支持外部 storageV5EnvPin 注入，adoptStorageV5EnvPin 还会校验 configHome。
- Storage V5 consumers 使用逻辑 namespace/keyspace（transcript、sidecar、task 等）；hostFiles.realPath 是独立 Host 文件能力。
- Desktop JS 只找到 SDK logger 对可选 init.storageV5 的消费，未找到 Desktop 主进程创建/传递 concrete backend 的路径；有限 native strings scan 也未找到 V5 特定符号，但不能据此排除二进制隐藏实现。
- Agent metadata 与 precompact sidecar 的 V5 write 未指定 publishDiscipline；Remote Agent metadata、MCP metadata 使用 inPlace；MCP outcome 与 transcript compact 使用 atomic；append 默认无 discipline。
- 本地 On/VQ 尝试 temp + rename，但只有 flush:true 才 FileHandle.sync，On wrapper 未传 flush；本地 transcript compact 专用路径显式 sync temp file 后 rename，但未发现父目录 fsync。
- 因 provider 实现未包含在可读源码中，atomic/inPlace 的精确定义、backend ack、WAL/fsync/目录同步、远端复制与断电恢复均未知。Storage V5 consumer 成功返回不能直接等同于 power-loss durable。

**CLI 本轮静态矩阵已完成（报告 46）；剩余动态验证受环境约束：**

1. 仅在可获得真实 Storage V5 provider、Cloud Session API contract 或隔离环境时，验证 V5 durability、Cloud event cursor、archive acknowledgement、permission relay 与真实副作用；否则维持未知，不以 mock 代替服务端事实。
2. 报告 46 已将多次 Full/Reactive compact、preserved UUID / anchor 缺失、parentUuid cycle、JSONL torn tail、V5 readRecords fallback、Remote Agent null cursor / metadata loss / archived terminal result 放入统一状态矩阵；矩阵中的所有 crash 结果仍需动态测试。
3. Desktop/SDK 报告 47–51 已覆盖可读发布版主要宿主、callback、MCP 生命周期。hosted renderer reload、native process job、SSH helper server-side、MCP reconnect / elicitation recovery 与真实 crash 行为保留为未知；不再把不可读服务端路径当作当前可推进源码任务。
4. Claude/Pi 固定发布版源码首轮比较已经汇成报告 59；独立目标架构设计草案和验收/实施路线图在报告 60–61。下一步审阅架构选择、可靠性等级与实际工具需求，并按证据缺口计划隔离动态测试。任何实现均需明确开发批准。
5. 研究阶段已有首版可审阅交付；未把报告 59–61 当成已批准决策。所有实际故障保证、Provider/Cloud/SSH helper 服务端和用户产品需求仍保留未决。

### B. Desktop / SDK（报告 47–51：可读发布版源码主要生命周期追踪完成）

[报告 47：Desktop / SDK Session 启动与双向协议第一轮](./47-Claude-Desktop与SDKSession启动双向协议及宿主生命周期-2026-10-30.md)；[报告 48：Desktop SSH 进程接管、MCP 拓扑与权限事件链](./48-Claude-Desktop-SSH进程接管与MCP权限事件链复核-2026-10-30.md)；[报告 49：Desktop 本地进程关闭、Idle 与 Session 冷恢复状态机](./49-Claude-Desktop本地进程关闭Idle与Session恢复状态机复核-2026-10-30.md)；[报告 50：Desktop SDK Hooks 与 Pending 请求重交付](./50-Claude-Desktop-SDKHooks与Pending请求重交付复核-2026-10-30.md)；[报告 51：custom3p-mcp URL Elicitation 与 Utility Host 生命周期](./51-Claude-Desktop-custom3pMCP-URL-Elicitation与UtilityHost复核-2026-10-30.md)。

报告 47–49 追踪 host startup、SDK query / 双向协议、RemoteProcess adoption、MCP 多拓扑、ToolPermissionBroker / EIPC、local spawn、interrupt / stop / close、Idle / pause、app quit、Session / Waiting Input 冷恢复；报告 50 闭环 canUseTool / onUserDialog / SDK-host Hooks、hook_callback generation、timeout / AbortSignal / cancel / late response、CLI reinitialize pending request redelivery 与 snapshot recovery；报告 51 单独追 custom3p-mcp HTTP/SSE utility host、stdio MCP、URL elicitation native consent、MessagePort seq / elicitationId、complete notification、port drain 和 shutdown。

**剩余边界：** hosted claude.ai renderer 的实际 reload hydrate 不在 source-only package；native process job 与 SSH helper/daemon server-side 语义不可从客户端 JS 推断；MCP server reconnect / elicitation recovery、native dialog 与 utility crash 未动态验证。没有额外证据时保持未知，不虚构服务端保证。

### C. Pi / Chord 子系统（报告 52–58 首轮固定发布版源码研究完成）

- [52：Pi Agent Core v1.4.0 / Agent Loop / Tool dispatch](./52-Pi-Agent-Core-1.4.0发布基线Loop与工具调度复核-2026-10-30.md)
- [53：Pi Durable / Harness / TaskScheduler / Generation / ToolTask](./53-Pi-Durable-HarnessTaskScheduler与GenerationToolTask状态机复核-2026-10-30.md)
- [54：Chord v1.4.0 Host / Object / RPC / ReplicatedState / Hot Reload](./54-Chord-1.4.0HostObjectRPC与ReplicatedState热更新协议复核-2026-10-30.md)
- [55：Storage Adapters 原子性、恢复与耐久性边界](./55-Pi-Durable-StorageAdapters事务原子性恢复与耐久边界-2026-10-30.md)
- [56：Chord HostManager / ProcessLock / 子 Host 生命周期](./56-Chord-HostManager进程锁重启与子Host生命周期-2026-10-30.md)
- [57：Pi Durable CompactionTask / Context / Recovery / Edit staleness](./57-Pi-Durable-CompactionTask上下文边界重放与失效风险-2026-10-30.md)
- [58：Pi Coding Agent 产品组合、Session JSONL、MCP、权限与 RPC](./58-Pi-CodingAgent产品组合CoreSessionMCP权限与RPC-2026-10-30.md)

固定上游 earendil-works/pi tag v1.4.0、release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。报告 30–31 动态实验所用 pi-agent-core@1.4.0 的核心 TypeScript 源码与 release tag blob SHA 一致；npm dist 字节级 build parity 未验证。

**重要架构分界**：pi-agent-core 是内存 Loop；pi-durable 不依赖 pi-agent-core，自行实现 Harness/GenerationTask/ToolTask/TaskScheduler；Chord 1.4.0 是 Host/RPC/ReplicatedState/SQLite primitives，不是 Durable Store。**pi-coding-agent v1.4.0 的真正执行路径依赖 Core + AgentSession + JSONL SessionManager，不直接调用 Durable Harness。** 不能用 Durable 的 Task checkpoints、Storage atomicity、Tool replay 证明 Coding Agent 产品有同样保证。

**研究新增风险**：报告 57 显示 Durable 的摘要 Task 在 provider 请求中断后可重新发送且无法保证 provider exactly-once；并发 application edit 在摘要仍处理旧历史时可以被新 head boundary 遮蔽。报告 58 显示 Coding Agent JSONL session append 无逐条 fsync、内存索引更新先于磁盘写入；message_end 向 UI emit 先于对应 JSONL append；官方 security.md 明确 project trust 非 sandbox，默认不逐工具审批。Coding Agent MCP 使用直接/间接/动态工具曝光与可选 tool_call hooks。

**待研究与交付**：
1. Claude CLI / Desktop / SDK 与 Pi Core / Coding / Durable / Chord 按同一故障和产品场景作横向比较，整理可借鉴实践、缺口与冲突。
2. 构建带证据等级的动态验证计划（Storage durable ack / crash, external effect unknown, permission revoke, compaction edit, Host reconnect），**尚未执行这些实验**。
3. 独立设计目标 Agent 架构：需求/非目标、执行状态机、Task/Journal/Host/Permission/Context/Session/Storage/Recovery/RPC、部署方案、技术选型、风险和实施路线图。
4. 将完整研究和架构方案提交用户审阅；未明确批准前禁止开发。

### D. Claude/Pi 比较与独立架构：v0.2 方案待审阅

前置证据：
- [59：Claude / Pi 12 场景对比](./59-Claude与Pi同场景执行权限恢复矩阵-2026-10-30.md)
- [60：独立 Agent v0.1 草案（已加修订优先级提醒）](./60-独立Agent执行内核目标架构草案-2026-10-30.md)
- [61：故障验证与未来实施路线（已修正 late receipt/双 owner 验收）](./61-目标Agent架构验收矩阵风险与实施路线-2026-10-30.md)

本轮新增：
- [62：Operation stable ID、Host effect evidence 与 UNKNOWN 对账协议](./62-Operation执行协议未知结果对账与多Owner恢复合同-2026-10-30.md)
- [63：Mandatory Permission Authority、OS 沙箱、Context 安全失效与架构 A/B/C 备选](./63-权限沙箱上下文脱敏与独立架构选型评审-2026-10-30.md)
- [64：v0.2 事务、Event Stream、Task/Operation/Host 恢复集成合同](./64-目标Agent架构v0.2事务事件与恢复协议整合-2026-10-30.md)、[65：可靠性保证向量、Storage ACK 与 Event Cursor 合同](./65-可靠性保证向量存储ACK与事件游标合同-2026-10-31.md)

**本轮修正：**
1. Intent-before-effect、控制面 DB CAS/Worker epoch 仅是必要条件，不可推断任意外部 effect exactly-once。Host ledger/queryOutcome 的 not-found 若不能排除并发执行，也不能证明 never-started。
2. 旧 owner 不得提交新 Task transition/越权执行，但可信旧 owner late Receipt 仍应作为 operation effect evidence 被接纳并对账。
3. Tool Operation 应分为 Control Task phase、Dispatch/Admission、Effect Evidence 和 Cancellation/Policy 四个正交状态域，不能用简单 RUNNING/COMPLETED 单线性状态表达。
4. Pi Coding Project Trust 和 extension tool_call 并非 mandatory sandbox；任意 shell 获准后内部文件/网络动作需 OS/container 限制，不能逐项由高层审批自动拦截。
5. Context summary 必须校验 SecurityRevision/redaction lineage；active model omit 与物理删除、派生 summary/索引/备份清理、第三方 Provider 保留完全不同。
6. EventSeq 不可简单等于 CommitSeq。需要 conversation/stream-local 序列、同一事务分配、同一 snapshot barrier 读取 cursor；provisional tokens 不占权威 EventSeq。
7. 建议 Hybrid C（小型 TurnEngine + Durable Coordinator + mandatory Host）为默认研究候选；若 Loop 无法在真实 side effect 前 await commit/permission，或要求完整 phase recovery，应采用 Task-native B。

**未来验证仍未执行**：报告 61 FI-01–16 与报告 64 的 FI-02b/04b/05b/07b/10b/13b/16b；不能据静态源码声称真实故障安全。

**审阅门禁**：待用户确认首发部署、本地/多节点与 R1/R2/R3/R4 等级、工具幂等能力、默认权限与沙箱、物理删除需求、UI 多客户端一致性、旧 Kernel 数据迁移。此前不得开发。

## 6. 每次新对话的恢复步骤

1. 阅读本文件和同目录 `README.md`。
2. 查看本 PR 的最新 commit 和评论，确认最近新增的证据与结论。
3. 重新检查相关源码文件，不把摘要代替源码核验。
4. 从“下一步任务”中未完成的最早一项继续。
5. 本轮结束时更新本文件的最后更新时间、已核实路径/符号、结论、证据等级、未决问题和下一步，并提交到本研究 PR。

## 7. 禁止事项

- 未经用户明确批准，不实现 Agent Loop、适配器、工具执行、会话或其他代码。
- 不修改旧 Kernel 来证明它可继续使用；不因已有 PR 而默认保留其设计。
- 不把报告 30–32 的裁决当成架构定案。
- 不把静态分析说成动态验证，不把 fake Host/Journal 测试说成生产安全验证。
- 不在证据不足时声称“研究完成”。

## 8. 本轮续接标记

**最新研究/设计修订：** [62：Host Operation 对账](./62-Operation执行协议未知结果对账与多Owner恢复合同-2026-10-30.md)、[63：权限/沙箱/架构选型](./63-权限沙箱上下文脱敏与独立架构选型评审-2026-10-30.md)、[64：目标内核 v0.2 集成协议](./64-目标Agent架构v0.2事务事件与恢复协议整合-2026-10-30.md)。

### 已核验的源码事实

- Claude CLI 2.1.304 Host ledger/ranNothing/late outcome correction、Desktop 3.1623.1 PermissionBroker/SSH process adoption 仅有固定发布 JS 静态证据；真实 Host/V5 backend/SSH helper durability 仍未知（报告 35/38/45/48/50）。
- Pi Durable v1.4.0 ToolTask 源码 packages/durable/src/harness/tool.ts blob 52bc4a3ada1892645aca5a35f4d90b875edda4ca L103–213：在 run() 前提交 execute checkpoint，恢复只有 stored/current safe 才 rerun，否则 interrupted/may-have-run；settle L637–704 同一 commit 处理 ToolResult/Task。Scheduler blob 23951e89934a6214329e7511f3fc8bca2d23f921 L374–423 恢复 running→pending，L545–624 abort/owner 等待分层。
- Chord Connection/HostManager 不提供持久 Link replay / 外部 effect fencing（报告 54/56）。
- Pi Coding 1.4.0 default no per-tool approvals，Project Trust 不是 sandbox，Tool Hooks 可选；MCP exposure 只是工具声明/发现策略（报告 58）。
- Pi Durable CompactionTask 上游 test 明确展示并发 application redact edit 可被新 summary head 遮蔽（报告 57）；测试本轮未执行。

### v0.2 已提交但仍是待审阅候选

- 不使用线性 Tool 状态来伪装事实；分离 Task control、Operation dispatch、Effect evidence、cancel/revoke，多版 operationId/attemptId/worker epoch 和 Host capabilities。
- 概念 Host prepare/execute/queryOutcome 保持 same operationId，不把 prepare/execute 叫成可原子提交外部 API 的 2PC；late completion 进入审计/对账，旧 owner 不得篡改新 Task。
- Mandatory Permission Authority + 实际执行 Host gate + OS sandbox；历史安全编辑增加 Summary SecurityRevision fence；物理删除另定。
- v0.2 订正 EventHub：stream-local eventSeq + snapshot consistent cursor，token streaming 只是 provisional。
- 报告 65 将旧 R0–R4 标量分解为 A/W/E/X capability vector；SQLite WAL NORMAL 仅为 A1 候选、WAL FULL 为 A2 候选；Postgres 同步副本配置可评估 A3；所有这些都不自动提升 Tool effectEvidence。
- Outbox 允许重复投递；dispatcher 必须按 stream 保序，客户端 eventId 幂等；Submit ACK 返回实际 ackProfile，丢 ACK 用 clientRequestId 查重。
- Hybrid C 是研究推荐，Task-native B 备选；首发环境与具体协议/技术栈未批准。

### 未决与下一步

1. 用户审阅报告 59–65，明确首发 A/W/E/X capability profile、是否多主机、默认权限/sandbox、历史物理删除、Tool/Provider 幂等与兼容性。
2. 如用户要求继续研究而不批准，仍只可深化证据或修订架构研究文档，不能启动 FI 实施测试/修改业务代码/Kernel 或开发 PR。
3. 若外部服务端、Provider/Host 和真实持久存储证据不可得，明确保持未知，不伪造证明。

**开发批准状态：未获得。** 用户“继续”仅表示继续研究。
