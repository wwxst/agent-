# Agent 架构研究进度与跨对话续接点

> 最后更新：2026-10-30（报告 54：Chord 1.4.0 Host / Object / RPC / ReplicatedState）  
> 当前阶段：**源码研究与证据盘点**  
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

## 4. 研究覆盖率

| 子系统 | 状态 | 下一步 |
|---|---|---|
| 资料版本、分包和完整性入口 | 已初步盘点 | 核对核心文件与版本来源，建立可导航源码索引 |
| Claude CLI 入口与主循环 | **第一轮源码追踪完成，待继续核验** | 报告 33–34 已追入口→main/session driver→YL→su/iu→流式请求→ToolCall 调度→结果回填，并区分 session.append hook 与 transcript writer；已追 record/queue/flush/exit hook；直接文件路径使用 appendFile 或 open/write/close，本层未见 fsync；Storage V5 backend 保证未知。remote Host 路由/reconcile 已有报告；报告 36 新增 writer 失败 Promise/健康状态和流式 fallback 状态清理；报告 38–41 已补 remote cancel/call ledger、Bash/MCP executor、后台任务恢复与取消时序矩阵；报告 42–43 已补 Agent/Subagent lifecycle、compaction 与 transcript resume reader；报告 44 已追 Remote Agent Cloud Session create/poll/restore/archive；报告 45 已追 Storage V5 default injection seam、configHome guard、keyspace 与 sidecar write discipline；报告 46 已建立 reader/Agent resume/Remote Agent 联合恢复矩阵；仍需核验 provider physical durability、真实进程/服务器取消及完整故障状态机 |
| Claude CLI 权限、并发和失败恢复 | **本地与远端任务路径已有静态状态机；动态验证未做** | 报告 38–41 覆盖 Remote Host/Bash/MCP 取消；报告 44 覆盖 Remote Agent Cloud Session create/poll/restore/archive 与 permission relay；仍需验证 event cursor replay、archived result recovery、archive ack、真实 Shell/MCP/cloud side effects |
| Claude CLI 上下文压缩与 Subagent | **第一轮静态源码链与状态矩阵已完成；动态验证未做** | 报告 42–46 覆盖 Local Agent ownership/keepalive/TaskStop/resume、worker adoption、Full/Reactive/Precomputed/Microcompact、compact-boundary relink、dRt row normalization、hdo preserved UUID、RMt/Sdo parent fallback、bdo tool_result 修复、Storage V5 readRecords/torn-tail，以及 Remote Agent metadata/cursor/archive 恢复矩阵。多次 compact、坏 transcript、跨 Agent fallback、真实 provider 与 remote worker crash 仍未动态验证 |
| Desktop / SDK 启动、Session、双向协议 | **可读发布版源码范围内主要宿主 / callback / MCP 生命周期静态追踪完成；hosted renderer / native / 动态边界未闭环** | 报告 47–51 已追 host startup、SDK query / 双向协议、RemoteProcess adoption、MCP 多拓扑、Agent 权限 / Hooks / pending redelivery、local spawn、interrupt / stop / close、Idle / pause、app quit、Session / Waiting Input 冷恢复、custom3p-mcp URL elicitation 与 utility host shutdown。剩余：hosted renderer reload hydrate、native process job / SSH helper server-side、MCP server reconnect / elicitation recovery 与真实 crash / side-effect 验证 |
| MCP、宿主工具桥接和安全边界 | **协议取消与 SEP-2663 恢复路径已部分核验** | 报告 39–41 已追 notifications/cancelled、迟到 task handle 后 tasks/cancel、metadata/outcome sidecar、resume/reconnect；继续核对第三方 server 真正停止、cancel 未确认后的恢复义务 |
| Pi Agent Core / Durable / Chord | **Core、Durable Task runtime、Chord 1.4.0 Host/RPC 首轮源码研究完成；Storage adapters / coding-agent 未完成** | 报告 52–54 已 pin v1.4.0；追 Core Loop、独立 Durable Generation/ToolTask、Session commit line、TaskScheduler recovery、Chord Host/Object/Contract、root/principal、Protocol v4、ack flow control、ReplicatedState/delta 与 hot reload。关键边界：Chord 1.4.0 是 Host/RPC/state replication runtime，不是 Durable Store；下一步核验 pi-durable Storage adapters 与 Chord SQLite drivers / HostManager |
| 横向架构比较 | 初步报告存在，未定案 | 统一比较维度；历史报告 32 需按报告 33 的新证据重审，不能以旧 Kernel 为前提 |
| 新目标架构 | 未开始 | 等源码研究与需求澄清完成后提出多方案 |
| 用户确认 | 未开始 | 完整方案交付后等待明确批准 |

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
4. Pi Core 与 Durable 首轮研究见报告 52–53：Core loop 与 Durable task runtime 是两套独立执行引擎。下一步深入 Chord transaction / delta / storage、各 backend adapter 与 crash semantics，再研究 compaction / pi-coding-agent composition。
5. CLI、Desktop/SDK、Pi 完成同场景对照后，再提出独立目标架构与备选方案。

### B. Desktop / SDK（报告 47–51：可读发布版源码主要生命周期追踪完成）

[报告 47：Desktop / SDK Session 启动与双向协议第一轮](./47-Claude-Desktop与SDKSession启动双向协议及宿主生命周期-2026-10-30.md)；[报告 48：Desktop SSH 进程接管、MCP 拓扑与权限事件链](./48-Claude-Desktop-SSH进程接管与MCP权限事件链复核-2026-10-30.md)；[报告 49：Desktop 本地进程关闭、Idle 与 Session 冷恢复状态机](./49-Claude-Desktop本地进程关闭Idle与Session恢复状态机复核-2026-10-30.md)；[报告 50：Desktop SDK Hooks 与 Pending 请求重交付](./50-Claude-Desktop-SDKHooks与Pending请求重交付复核-2026-10-30.md)；[报告 51：custom3p-mcp URL Elicitation 与 Utility Host 生命周期](./51-Claude-Desktop-custom3pMCP-URL-Elicitation与UtilityHost复核-2026-10-30.md)。

报告 47–49 追踪 host startup、SDK query / 双向协议、RemoteProcess adoption、MCP 多拓扑、ToolPermissionBroker / EIPC、local spawn、interrupt / stop / close、Idle / pause、app quit、Session / Waiting Input 冷恢复；报告 50 闭环 canUseTool / onUserDialog / SDK-host Hooks、hook_callback generation、timeout / AbortSignal / cancel / late response、CLI reinitialize pending request redelivery 与 snapshot recovery；报告 51 单独追 custom3p-mcp HTTP/SSE utility host、stdio MCP、URL elicitation native consent、MessagePort seq / elicitationId、complete notification、port drain 和 shutdown。

**剩余边界：** hosted claude.ai renderer 的实际 reload hydrate 不在 source-only package；native process job 与 SSH helper/daemon server-side 语义不可从客户端 JS 推断；MCP server reconnect / elicitation recovery、native dialog 与 utility crash 未动态验证。没有额外证据时保持未知，不虚构服务端保证。

### C. Pi Agent Core 与 Durable / Chord（报告 52–53 已完成 Core 与 Durable 首轮）

[报告 52：Pi Agent Core 1.4.0 发布基线、Loop 与工具调度](./52-Pi-Agent-Core-1.4.0发布基线Loop与工具调度复核-2026-10-30.md)；[报告 53：Pi Durable Harness、TaskScheduler 与 Generation / ToolTask 状态机](./53-Pi-Durable-HarnessTaskScheduler与GenerationToolTask状态机复核-2026-10-30.md)。

已固定上游仓库 earendil-works/pi、release tag v1.4.0、release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。报告 30–31 的动态发布包为 1.4.0；本轮验证 agent.ts / agent-loop.ts / types.ts / README 的 blob SHA 与 release tag 完全一致，package.json 仅 devDependency vitest 版本不同。npm tarball dist 字节级校验仍未完成，不能声称二进制构建可复现。

Core 首轮已追 Agent 单活动 Run、内存 transcript、steer/followUp queue、high-level awaited event barrier 与 low-level EventStream observational 区别、Loop 两层调度、context transform/conversion、tool preflight/parallel completion ordering、abort/error/truncation。

Durable 首轮已追 SessionImpl serialized commit line、Conversation / Entry / Document / Task / Submission 数据模型、TaskScheduler open/resume/restart/reserve/phase/ownership/abort cascade、GenerationTask prepare/request/retry/poll/tools、ToolTask execute intent / safe replay / nested calls、requestId 幂等 admission 与 commit-derived watchEvents。

**关键边界：** pi-durable 不依赖 pi-agent-core；它直接基于 pi-ai + Chord 实现自己的 GenerationTask / ToolTask Agent runtime，不是 Core Agent 的存储 adapter。两套执行引擎必须并列研究。

**下一步：**
1. 核验 pi-durable SQLite / JSONL / IndexedDB / Memory / Cloudflare adapters 的真实 commit 原子性、序列分配、WAL、fsync、migration、single-owner / lock 语义。
2. 研究 Chord portable SQLite interface、Node driver、Cloudflare Durable Object driver、schema migration；另查 Node HostManager / processLock / forkDriver。
3. 动态验证 TaskScheduler crash/reopen、restart limit、waiting/failFast、completing/ownership、abort cascade、safe/unsafe ToolTask replay。
4. 闭环 CompactionTask 与 context range / stale summary。
5. 研究 pi-coding-agent 如何组合 Core / Durable、MCP、extensions、permissions、TUI / RPC。
6. Pi 子系统完成后再与 Claude CLI / Desktop 做同场景矩阵对比。

### D. 最后统一比较并提出全新架构

在完成前述证据后，定义目标需求和非目标，比较自研、复用、集成和重写的成本/风险，形成模块图、接口、时序、持久化/恢复、安全模型、技术选型与验收计划。交用户确认前不写实现。

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

本轮新增 [报告 53：Pi Durable Harness、TaskScheduler 与 Generation / ToolTask 状态机](./53-Pi-Durable-HarnessTaskScheduler与GenerationToolTask状态机复核-2026-10-30.md)，承接报告 52 的 Core v1.4.0 基线与 Loop 研究。

本轮新增 [报告 54：Chord 1.4.0 Host / Object / RPC / ReplicatedState 与热更新协议](./54-Chord-1.4.0HostObjectRPC与ReplicatedState热更新协议复核-2026-10-30.md)，固定在同一 v1.4.0 release tag。

**报告 53 本轮新增源码证据：**

- pi-durable 是独立 Agent runtime，不依赖 pi-agent-core；package dependencies 为 chord、pi-ai、pi-codemode、pi-telemetry 等；其 harness/agent.ts、generation.ts、tool.ts 实现独立 Agent / GenerationTask / ToolTask。
- Conversation 是无状态 handle；Entry immutable；Document 是 typed JSON state；Task 是 versioned checkpoint state machine；Submission 是 request admission / settlement receipt。
- SessionImpl 通过 #tail 把 commitWith / readOnLine 串行化；#runCommit stage Transaction，再一次 Storage.commit atomic batch；Storage 成功后 adopt documents 并发布 CommitPublication。
- Internal listener throw 会 fail Session；public observer throw 只 report；Storage commit / mintId error fail Session，Harness 不自动 retry。
- TaskScheduler.open 将 persisted running task 改 pending 并增加 restart count；Harness.open 不自动 resume；graceful close 的 join 会 abort invocation 并把 running 写回 pending，不增加 crash restart。
- TaskDefinition 以 phase checkpoint 驱动；phase 无 durable progress 会 fault；reserve 在 commit 内，phase code 在 commit 外；wait graph 检查 DAG；terminal owner 有 child work 时先 completing；abort cascade bottom-up。
- Submission requestId 在 conversation 内幂等；Inbox 在 boundary 应用 steer / follow-up / write；busy 默认 follow-up。
- GenerationTask 的 prepare/request/retry/poll/tools phase 保存 cutoff、partial、retry、deferred handle 与 tool-round state；partial 每默认 100ms 节流 commit，final flush await。
- ToolTask 在执行前 commit phase=execute + final arguments + replay policy；恢复只在 stored 与 current tool policy 都 safe 时重放；unsafe / changed policy 以 interrupted may-have-partially-run 结算。
- Nested tool call 是 parent-owned child ToolTask，NestedCallDoc 按 stable key 保存结果；不是简单函数嵌套。
- watchEvents 在 Session line 上原子取得 snapshot + commit subscription；每 commit 一个 event batch；CommittedWatch 最多保留 100 pending frames，溢出后以最新 snapshot 替代。
- Chord 1.4.0 的真实定位是 Host / Contract / Object / RPC / ReplicatedState / delta；root export 没有通用 Durable Store。固定 v1.4.0 tag 不包含 packages/chord/src/next，不能拿 main 上后续 next Store 源码解释该 release。
- Chord Protocol v4 使用 hello/hold/release/call/cancel/sub/unsub/resync、shape/gone/result/state、root_end/ack 与 reload prepare/vote/commit/abort/retire frames；Connection 默认 256 KiB ack window、4-window pending cap，state backlog 超限以 reset/resync 恢复。
- Host root 携带 codeVersion / principal / AbortSignal 并跟踪跨 host object leases；hot reload 有 candidate prepare、gate、state/resource migration、stage listeners、同步 publish、旧版本 root retirement；cluster reload 通过 prepare/vote/commit/abort 协调。

**报告 53 的未决问题：**

- pi-durable SQLite / JSONL / IndexedDB / Cloudflare backend 的 fsync / WAL / multi-owner / crash semantics 尚未逐源码验证；Chord 1.4.0 replicatedState 是内存 publication，不提供 Durable Store transaction。
- Chord Node HostManager / processLock / child host IPC lifecycle 未研究；多 host reload / revoke / flow-control 尚未动态验证。
- Scheduler 同时 abort / close / storage failure / child completion / registry replacement 的 race 未动态故障注入。
- CompactionTask / summary staleness / context range 未闭环；pi-coding-agent composition 未研究。
- ToolTask safe replay 是否真正幂等取决于外部 tool / host，未做真实副作用验证。

**下一轮顺序：** 先固定并逐模块研究 Chord 1.4.0 的 replicatedState / transaction / delta / storage；再核验 pi-durable 的 SQLite / JSONL / IndexedDB / Cloudflare adapters；然后做 TaskScheduler / ToolTask recovery 动态矩阵。最后研究 CompactionTask 与 pi-coding-agent composition。明确批准前不进入开发。
