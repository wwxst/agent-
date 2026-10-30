# Agent 架构研究进度与跨对话续接点

> 最后更新：2026-10-30（报告 49：Desktop 本地进程与冷恢复）  
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

## 4. 研究覆盖率

| 子系统 | 状态 | 下一步 |
|---|---|---|
| 资料版本、分包和完整性入口 | 已初步盘点 | 核对核心文件与版本来源，建立可导航源码索引 |
| Claude CLI 入口与主循环 | **第一轮源码追踪完成，待继续核验** | 报告 33–34 已追入口→main/session driver→YL→su/iu→流式请求→ToolCall 调度→结果回填，并区分 session.append hook 与 transcript writer；已追 record/queue/flush/exit hook；直接文件路径使用 appendFile 或 open/write/close，本层未见 fsync；Storage V5 backend 保证未知。remote Host 路由/reconcile 已有报告；报告 36 新增 writer 失败 Promise/健康状态和流式 fallback 状态清理；报告 38–41 已补 remote cancel/call ledger、Bash/MCP executor、后台任务恢复与取消时序矩阵；报告 42–43 已补 Agent/Subagent lifecycle、compaction 与 transcript resume reader；报告 44 已追 Remote Agent Cloud Session create/poll/restore/archive；报告 45 已追 Storage V5 default injection seam、configHome guard、keyspace 与 sidecar write discipline；报告 46 已建立 reader/Agent resume/Remote Agent 联合恢复矩阵；仍需核验 provider physical durability、真实进程/服务器取消及完整故障状态机 |
| Claude CLI 权限、并发和失败恢复 | **本地与远端任务路径已有静态状态机；动态验证未做** | 报告 38–41 覆盖 Remote Host/Bash/MCP 取消；报告 44 覆盖 Remote Agent Cloud Session create/poll/restore/archive 与 permission relay；仍需验证 event cursor replay、archived result recovery、archive ack、真实 Shell/MCP/cloud side effects |
| Claude CLI 上下文压缩与 Subagent | **第一轮静态源码链与状态矩阵已完成；动态验证未做** | 报告 42–46 覆盖 Local Agent ownership/keepalive/TaskStop/resume、worker adoption、Full/Reactive/Precomputed/Microcompact、compact-boundary relink、dRt row normalization、hdo preserved UUID、RMt/Sdo parent fallback、bdo tool_result 修复、Storage V5 readRecords/torn-tail，以及 Remote Agent metadata/cursor/archive 恢复矩阵。多次 compact、坏 transcript、跨 Agent fallback、真实 provider 与 remote worker crash 仍未动态验证 |
| Desktop / SDK 启动、Session、双向协议 | **三轮主要生命周期静态追踪已完成；callback 与动态验证仍未闭环** | 报告 47–49 已追 host startup、SDK query / 双向协议、RemoteProcess adoption、MCP / permission / EIPC、local spawn 与 SSH custom spawn、interrupt / stop / close、Idle / pause、app quit、Session / Waiting Input 冷恢复与 auto-resume。继续闭环 canUseTool / Hooks / hook_callback 的所有类型与 abort/timeout/cleanup、renderer reload/pending request replay；native process job / SSH helper server-side 与真实 crash 行为未知 |
| MCP、宿主工具桥接和安全边界 | **协议取消与 SEP-2663 恢复路径已部分核验** | 报告 39–41 已追 notifications/cancelled、迟到 task handle 后 tasks/cancel、metadata/outcome sidecar、resume/reconnect；继续核对第三方 server 真正停止、cancel 未确认后的恢复义务 |
| Pi Agent Core 完整源码审查 | 部分完成 | 从上游源码核对 API、loop、事件、工具、取消和上下文机制 |
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
3. Desktop/SDK 已完成报告 47–49 的主要生命周期静态追踪；继续闭环 canUseTool / Hooks / hook_callback 的全 callback 类型、abort/timeout/cleanup，以及 renderer reload / pending request replay。native process job 和 SSH helper server-side 语义若无法取得，保留未知。
4. 随后固定 Pi Core 上游 commit 与实际发布包，核对源码 / 包一致性后逐模块研究 loop、event、tool、context、session、extension、cancel 与错误恢复。
5. CLI、Desktop/SDK、Pi 完成同场景对照后，再提出独立目标架构与备选方案。

### B. Desktop / SDK（报告 47–49 已完成三轮主要生命周期静态追踪，仍有 callback / native 边界）

[报告 47：Desktop / SDK Session 启动与双向协议第一轮](./47-Claude-Desktop与SDKSession启动双向协议及宿主生命周期-2026-10-30.md)；[报告 48：Desktop SSH 进程接管、MCP 拓扑与权限事件链](./48-Claude-Desktop-SSH进程接管与MCP权限事件链复核-2026-10-30.md)；[报告 49：Desktop 本地进程关闭、Idle 与 Session 冷恢复状态机](./49-Claude-Desktop本地进程关闭Idle与Session恢复状态机复核-2026-10-30.md)。

报告 47 追踪 Desktop host startup、SDK query/session 启动、RemoteServerController、双向 control RPC 和 canUseTool 入口；报告 48 追踪 RemoteProcess replay / persisted adoption、MCP 多拓扑、ToolPermissionBroker 与 EIPC；报告 49 补齐 local spawn 与 SSH custom spawn、Turn interrupt / Session stop / Query.close / OS process exit、WarmLifecycle / Idle pause、app quit、Local / SSH Waiting Input reconciliation 与 quit auto-resume。

**仍需完成：** 逐一闭环 canUseTool / Hooks / hook_callback 的 callback 类型、AbortSignal、timeout、late response 与 cleanup；renderer reload / pending request replay；若可获得，核验 native process job 和 SSH helper/daemon server-side。服务端源码不可得时，replay ring buffer、stdin 去重、killAndWait、process tree/job object 语义必须保持未知；静态结果不能替代真实 crash / side-effect 验证。

### C. 再研究 Pi Core

阅读固定上游源码和实际使用的发布包；分别记录 loop、事件契约、工具、扩展机制、流式、并发、取消、上下文和错误处理。发布包与源码未核验一致前，不混用两者结论。

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

本轮新增 [报告 47：Desktop / SDK Session 启动与双向协议第一轮](./47-Claude-Desktop与SDKSession启动双向协议及宿主生命周期-2026-10-30.md)、[报告 48：Desktop SSH 进程接管、MCP 拓扑与权限事件链](./48-Claude-Desktop-SSH进程接管与MCP权限事件链复核-2026-10-30.md) 和 [报告 49：Desktop 本地进程关闭、Idle 与 Session 冷恢复状态机](./49-Claude-Desktop本地进程关闭Idle与Session恢复状态机复核-2026-10-30.md)。

**报告 49 本轮新增源码证据：**

- SDK ProcessTransport 默认通过 child_process.spawn 创建 local CLI；Desktop SSH backend 注入 spawnClaudeCodeProcess / RemoteProcess。Local 使用 CLI session ID cold resume，SSH 可 hot reattach 同一 process identity。
- Desktop 将 local onProcessSpawned PID 交给 native createProcessJob（若 binding / feature gate 支持），Session initialize 后保存 job handle；teardown 调用 endProcessJob。native 实现不可读，不能从 JS 参数推断 job object 的完整 kill / detach 语义。
- SDK Query.interrupt 发送 subtype=interrupt，支持 cancel_queued 并返回 still_queued / cancelled；它与 Query.close、Session stop、OS process exit 是不同操作。
- Desktop interruptSession 优先 soft interrupt；ack timeout / error 才升级 stop。SSH host down / replaying / busy / ping 不确定时保留 queued interrupt，不贸然 kill 远端进程。
- Query.close 只启动 cleanup，不返回 cleanup Promise；cleanup 关闭 MCP / control request / input stream，waitForExit 最多约 2 秒。ProcessTransport.close 结束 stdin 后延迟 TERM / KILL；Desktop teardownQuery 不 await Query.close，因此 Query object teardown 不构成 OS process exit acknowledgement。
- Desktop watchLocalCliTeardown 是 telemetry watcher，不负责 kill；轮询 root PID / descendants，app_quit / appQuitting 路径跳过该 watcher。
- WarmLifecycle 的 idle timer 受可见性与后台工作影响。类本身默认 15 分钟，但 LocalSessionManager 传入 Xf：unattended 固定 15 分钟，普通 Session 使用 setting 4041267332，缺失 / 非法 / <=0 时不 arm，正值 clamp 至少 60 秒。
- local backend shouldKillOnIdlePause=true；SSH / WSL 为 false。普通 SSH / WSL idle timeout 不杀远端 CLI；credential_revoked 是不同的强制 teardown 路径。CliGovernor 的 memory-pressure eviction 与 idle timeout 分离。
- stopAllOnQuit 将 local sessions 交 stopSession(app_quit)，而 SSH sessions 走 markSshSessionAtExit / waiting-input preservation，不进入 local stop list；随后 flush SessionPersistence 与 WaitingInput。
- loadSessionRecords active-first、每批 8 并发、单个 Session JSON 10 MiB 上限，恢复时标记 processGoneReason=app_relaunch。Runtime Query / inputStream / OS process 不从 Session JSON 直接复原。
- Local Waiting Input 通过 UUID / mergedSendUuids / text-prefix 与 CLI transcript 对账；transcript 不可读时延迟一个 launch 再恢复。SSH cleanShutdown=false 则丢弃无法确认是否已送达的 waiting input，偏向避免重复远端副作用，存在输入丢失 tradeoff。
- quit auto-resume 分为 warm Session / process 和后续决定是否 send auto-continuation 两阶段，不会无条件重放旧 prompt。

**报告 49 的未决问题：**

- Native createProcessJob / endProcessJob 的平台语义、进程树继承、wait / terminate / detach 行为未知。
- Query.close fire-and-forget 与 app quit、OS process exit、CLI shutdown hook、MCP/Bash child process 的实际时间线尚未动态验证。
- Local queue 的 text-prefix fallback 在重复 prompt 下可能歧义；SSH unclean shutdown discard 可能丢失输入。均为待验证风险，不是已复现 bug。
- canUseTool / Hooks / hook_callback 的全部 callback 类型、AbortSignal、timeout、late response 和 cleanup 仍需逐一闭环；renderer reload / pending request replay 也未完成。
- SSH helper / daemon server-side source 不在可读 bundle 中；sequence ring buffer、stdin offset 去重、killAndWait、process tree 与 daemon identity 语义继续保持未知。

**下一轮顺序：** 先闭环 Desktop SDK hooks / canUseTool / hook_callback 及 renderer pending request recovery；若 native / helper server-side source 不可得，明确保留未知。随后固定 Pi Agent Core 上游 commit 与实际发布包，完成 loop、event、tool、context、session、extension、cancel 和错误恢复研究。完成 CLI / Desktop / Pi 同场景对比后再设计目标架构。未获得用户明确批准前，禁止进入开发。
