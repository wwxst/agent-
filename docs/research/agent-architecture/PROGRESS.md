# Agent 架构研究进度与跨对话续接点

> 最后更新：2026-10-30（报告 56：Chord HostManager / ProcessLock / Child Lifecycle）  
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
| 报告 55 | Pi Durable 1.4.0 Memory / JSONL / SQLite / IndexedDB / Cloudflare DO Storage；atomic batch、seq、ID、schema migration、delta/base/reclaim、poison/recovery；Node WAL/NORMAL、JSONL sidecar→marker 与 fsync 缺口；上游故障测试证据 | 固定 v1.4.0 源码 + 既有测试文件静态分析；本轮未执行测试；真实 power failure、multi-owner fencing、external effect exactly-once 未验证 |
| 报告 56 | Chord 1.4.0 Node HostManager start/stop/replace/ready/fatal/idle；forkDriver IPC/process group；childControl.lock-before-storage；processLock Linux abstract socket / Windows named pipe / Unix socket file stale race；root/Link in-flight outcome unknown；上游真实子进程测试源码 | 固定 v1.4.0 源码和既有 tests 静态复核，未执行；没有内部 crash auto-respawn；父进程崩溃、跨平台锁、multi-owner DB 与外部工具效果未动态验证 |

## 4. 研究覆盖率

| 子系统 | 状态 | 下一步 |
|---|---|---|
| 资料版本、分包和完整性入口 | 已初步盘点 | 核对核心文件与版本来源，建立可导航源码索引 |
| Claude CLI 入口与主循环 | **第一轮源码追踪完成，待继续核验** | 报告 33–34 已追入口→main/session driver→YL→su/iu→流式请求→ToolCall 调度→结果回填，并区分 session.append hook 与 transcript writer；已追 record/queue/flush/exit hook；直接文件路径使用 appendFile 或 open/write/close，本层未见 fsync；Storage V5 backend 保证未知。remote Host 路由/reconcile 已有报告；报告 36 新增 writer 失败 Promise/健康状态和流式 fallback 状态清理；报告 38–41 已补 remote cancel/call ledger、Bash/MCP executor、后台任务恢复与取消时序矩阵；报告 42–43 已补 Agent/Subagent lifecycle、compaction 与 transcript resume reader；报告 44 已追 Remote Agent Cloud Session create/poll/restore/archive；报告 45 已追 Storage V5 default injection seam、configHome guard、keyspace 与 sidecar write discipline；报告 46 已建立 reader/Agent resume/Remote Agent 联合恢复矩阵；仍需核验 provider physical durability、真实进程/服务器取消及完整故障状态机 |
| Claude CLI 权限、并发和失败恢复 | **本地与远端任务路径已有静态状态机；动态验证未做** | 报告 38–41 覆盖 Remote Host/Bash/MCP 取消；报告 44 覆盖 Remote Agent Cloud Session create/poll/restore/archive 与 permission relay；仍需验证 event cursor replay、archived result recovery、archive ack、真实 Shell/MCP/cloud side effects |
| Claude CLI 上下文压缩与 Subagent | **第一轮静态源码链与状态矩阵已完成；动态验证未做** | 报告 42–46 覆盖 Local Agent ownership/keepalive/TaskStop/resume、worker adoption、Full/Reactive/Precomputed/Microcompact、compact-boundary relink、dRt row normalization、hdo preserved UUID、RMt/Sdo parent fallback、bdo tool_result 修复、Storage V5 readRecords/torn-tail，以及 Remote Agent metadata/cursor/archive 恢复矩阵。多次 compact、坏 transcript、跨 Agent fallback、真实 provider 与 remote worker crash 仍未动态验证 |
| Desktop / SDK 启动、Session、双向协议 | **可读发布版源码范围内主要宿主 / callback / MCP 生命周期静态追踪完成；hosted renderer / native / 动态边界未闭环** | 报告 47–51 已追 host startup、SDK query / 双向协议、RemoteProcess adoption、MCP 多拓扑、Agent 权限 / Hooks / pending redelivery、local spawn、interrupt / stop / close、Idle / pause、app quit、Session / Waiting Input 冷恢复、custom3p-mcp URL elicitation 与 utility host shutdown。剩余：hosted renderer reload hydrate、native process job / SSH helper server-side、MCP server reconnect / elicitation recovery 与真实 crash / side-effect 验证 |
| MCP、宿主工具桥接和安全边界 | **协议取消与 SEP-2663 恢复路径已部分核验** | 报告 39–41 已追 notifications/cancelled、迟到 task handle 后 tasks/cancel、metadata/outcome sidecar、resume/reconnect；继续核对第三方 server 真正停止、cancel 未确认后的恢复义务 |
| Pi Agent Core / Durable / Chord | **Core、Durable Task runtime、Chord Host/RPC、Storage Adapters、Node HostManager 首轮静态研究完成；Compaction / coding-agent 未完成** | 报告 52–56 pin v1.4.0：Core 与 Durable 两引擎；TaskScheduler checkpoint/recovery；Chord Host/RPC/hot reload；各 Storage atomicity/power-loss 边界；HostManager processLock child ownership、ready/stop/replace、idle policy 与 Link 不可恢复/断线结果未知。下一轮 CompactionTask、pi-coding-agent 组合层，后续统一 Claude 同场景对照 |
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
4. Pi Core、Durable、Chord、Storage adapters、Node HostManager 首轮源码研究见报告 52–56；Core 与 Durable 是独立执行引擎，Chord HostManager 的进程锁不是 Task fencing。下一步优先追 CompactionTask 与 pi-coding-agent 组装层；真实 crash/断电/工具副作用测试仍未完成。
5. CLI、Desktop/SDK、Pi 完成同场景对照后，再提出独立目标架构与备选方案。

### B. Desktop / SDK（报告 47–51：可读发布版源码主要生命周期追踪完成）

[报告 47：Desktop / SDK Session 启动与双向协议第一轮](./47-Claude-Desktop与SDKSession启动双向协议及宿主生命周期-2026-10-30.md)；[报告 48：Desktop SSH 进程接管、MCP 拓扑与权限事件链](./48-Claude-Desktop-SSH进程接管与MCP权限事件链复核-2026-10-30.md)；[报告 49：Desktop 本地进程关闭、Idle 与 Session 冷恢复状态机](./49-Claude-Desktop本地进程关闭Idle与Session恢复状态机复核-2026-10-30.md)；[报告 50：Desktop SDK Hooks 与 Pending 请求重交付](./50-Claude-Desktop-SDKHooks与Pending请求重交付复核-2026-10-30.md)；[报告 51：custom3p-mcp URL Elicitation 与 Utility Host 生命周期](./51-Claude-Desktop-custom3pMCP-URL-Elicitation与UtilityHost复核-2026-10-30.md)。

报告 47–49 追踪 host startup、SDK query / 双向协议、RemoteProcess adoption、MCP 多拓扑、ToolPermissionBroker / EIPC、local spawn、interrupt / stop / close、Idle / pause、app quit、Session / Waiting Input 冷恢复；报告 50 闭环 canUseTool / onUserDialog / SDK-host Hooks、hook_callback generation、timeout / AbortSignal / cancel / late response、CLI reinitialize pending request redelivery 与 snapshot recovery；报告 51 单独追 custom3p-mcp HTTP/SSE utility host、stdio MCP、URL elicitation native consent、MessagePort seq / elicitationId、complete notification、port drain 和 shutdown。

**剩余边界：** hosted claude.ai renderer 的实际 reload hydrate 不在 source-only package；native process job 与 SSH helper/daemon server-side 语义不可从客户端 JS 推断；MCP server reconnect / elicitation recovery、native dialog 与 utility crash 未动态验证。没有额外证据时保持未知，不虚构服务端保证。

### C. Pi / Chord 子系统（报告 52–56 已完成首轮源码研究）

- [52：Pi Agent Core v1.4.0 / Agent Loop / Tool dispatch](./52-Pi-Agent-Core-1.4.0发布基线Loop与工具调度复核-2026-10-30.md)
- [53：Pi Durable / Harness / TaskScheduler / Generation / ToolTask](./53-Pi-Durable-HarnessTaskScheduler与GenerationToolTask状态机复核-2026-10-30.md)
- [54：Chord v1.4.0 Host / Object / RPC / ReplicatedState / Hot Reload](./54-Chord-1.4.0HostObjectRPC与ReplicatedState热更新协议复核-2026-10-30.md)
- [55：Storage Adapters 原子性、恢复与耐久性边界](./55-Pi-Durable-StorageAdapters事务原子性恢复与耐久边界-2026-10-30.md)
- [56：Chord HostManager / ProcessLock / 子 Host 生命周期](./56-Chord-HostManager进程锁重启与子Host生命周期-2026-10-30.md)

固定上游 earendil-works/pi tag v1.4.0、release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。报告 30–31 动态实验所用 pi-agent-core@1.4.0 的核心 TypeScript 源码与 release tag blob SHA 一致；npm tarball dist 字节级 build parity 未验证。

**已确认架构边界：** pi-agent-core 是内存 Loop；pi-durable 不依赖 pi-agent-core，而是直接基于 pi-ai + Chord 自行实现 Harness / GenerationTask / ToolTask / TaskScheduler；Chord 1.4.0 提供 Host/Contract/RPC/ReplicatedState/delta/SQLite portable facade，不是 Durable Store。当前 main 上未发布的 chord/src/next 不得用于解释 v1.4.0。

**报告 55 发现：** SqliteStorage 把 record/document/meta next_seq 放进一个事务，Node driver 默认 WAL + synchronous=NORMAL；JSONL 先写 sidecar（fsync=true 时 flush sidecar）再 append main marker、后做 best-effort reclaim，但每次成功 commit 并不确保 main marker flush；IndexedDB 使用单个 ALL_STORES readwrite transaction，Cloudflare DO 使用平台 storage.transaction，Memory 只在进程内有效。事务原子性不能替代 power-loss durability、single-writer fencing 或 external tool exactly-once。

**报告 56 发现：** Chord Node HostManager 采用 serial start/stop/replace、ready/fatal/exit 与 graceful shutdown + process group kill。真正的 processLock 在 child 中显式 lock-before-storage；Linux/Android abstract socket、Windows named pipe、其他 Unix socket-file stale takeover。进程锁互斥不等于 Durable Task ownership/lease/fencing；Link 断线 in-flight calls 是否已经产生副作用未知。manager 自身无 crash auto-respawn。

**下一轮顺序：**
1. Pi Durable CompactionTask / context range / summary staleness / background compaction 与 checkpoint。
2. pi-coding-agent 1.4.0 产品组合层：究竟运行 Core 还是 Durable，MCP / permission / extensions / TUI / RPC / Session 如何接线。
3. 汇总动态故障注入的设计与未覆盖矩阵；当前不写业务代码或 Kernel，不把计划说成执行结果。
4. 完成与 Claude CLI 2.1.304、Desktop 3.1623.1、SDK wrapper 0.3.304 的同场景横向比较，再独立提出目标架构与实施路线图供审阅，未批准前禁止开发。

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

**最新报告 56：** [Chord HostManager、ProcessLock、ForkDriver 与子 Host 生命周期](./56-Chord-HostManager进程锁重启与子Host生命周期-2026-10-30.md)。前置研究报告 [55：Storage Adapters](./55-Pi-Durable-StorageAdapters事务原子性恢复与耐久边界-2026-10-30.md)、[54：Chord Host/RPC](./54-Chord-1.4.0HostObjectRPC与ReplicatedState热更新协议复核-2026-10-30.md)、[53：Durable Task runtime](./53-Pi-Durable-HarnessTaskScheduler与GenerationToolTask状态机复核-2026-10-30.md)、[52：Core Loop](./52-Pi-Agent-Core-1.4.0发布基线Loop与工具调度复核-2026-10-30.md)。

### 已核验的 HostManager 机制

- 固定 v1.4.0 release source：packages/chord/src/manager.ts、node.ts、test/manager.test.ts、test/fixtures/worker.ts、docs/spec.md。
- ForkDriver spawn detached Node child、IpcLink 与独立 chord2control channel；明确清除继承 CHORD2_LOCK，只为主动配置锁的 child 设置环境变量。child exit 尝试 kill process group，stop 超过 grace 时强杀。
- processLock(name) 由 childControl().lock() 在子进程中显式获取，调用方必须在打开 Storage 前运行。Linux/Android abstract socket、Windows named pipe、macOS/BSD socket file；对 stale socket 的接管存在 docs/spec.md 明确列出的竞争条件。
- createHostManager 通过 Promise queue 串行 start、stop、replace；start 必须等 ready（默认超时 30s）；stop 请求 shutdown，最多默认 5s grace 后 killTree，await old exited；replace 等待旧子进程退出后再 spawn。
- Manager liveness 基于 child status(activeCalls/viewers/durableTasks)，keepAlive 可选；并不查询 Durable TaskRecords，也不自动进行 crash respawn。
- Chord docs/spec.md 明确：Link 不 resume，断开后旧 references 释放，in-flight call 是否已经执行未知；cluster hot reload decision 不持久化。HostManager 重启不等于 Tool Receipt recovery。
- 上游已有真实子进程 tests（lock 争用、replace、IPC Echo、强杀进程树、idle、fatal、深 TMPDIR）；本轮**只读测试文件，未运行新测试**。

### 与报告 55 的联系及未决问题

- Node SQLite WAL/NORMAL、JSONL 主 marker 不逐 commit fsync、IndexedDB/browser durability 仍限制 power-fail guarantees；processLock 无法补全存储层物理持久性。
- OS process lock 保护的是正确使用同一锁名且 lock-before-storage 的 owner。它不提供持久化 task owner epoch、跨机器 fencing、外部工具 operation idempotency / outcome reconciliation。
- 父进程突然崩溃、子进程残留、Windows 进程树、非 Linux socket stale race、真实跨进程 Storage / Tool effects 未运行。
- Pi Durable CompactionTask 与 pi-coding-agent composition 未研究；真实 Provider / Host / DB / crash 检验缺口仍存在。

**下一轮顺序**：CompactionTask / context boundary → pi-coding-agent runtime composition → Claude/Pi 同场景矩阵 → 独立架构方案与风险验证计划。只允许研究证据/进度更新，未获批准不得开发。
