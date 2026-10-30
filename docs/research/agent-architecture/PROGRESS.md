# Agent 架构研究进度与跨对话续接点

> 最后更新：2026-10-30（本轮研究）  
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

## 4. 研究覆盖率

| 子系统 | 状态 | 下一步 |
|---|---|---|
| 资料版本、分包和完整性入口 | 已初步盘点 | 核对核心文件与版本来源，建立可导航源码索引 |
| Claude CLI 入口与主循环 | **第一轮源码追踪完成，待继续核验** | 报告 33–34 已追入口→main/session driver→YL→su/iu→流式请求→ToolCall 调度→结果回填，并区分 session.append hook 与 transcript writer；已追 record/queue/flush/exit hook；直接文件路径使用 appendFile 或 open/write/close，本层未见 fsync；Storage V5 backend 保证未知。remote Host 路由/reconcile 已有报告；报告 36 新增 writer 失败 Promise/健康状态和流式 fallback 状态清理；报告 38–41 已补 remote cancel/call ledger、Bash/MCP executor、后台任务恢复与取消时序矩阵；报告 42–43 已补 Agent/Subagent lifecycle、compaction 与 transcript resume reader；报告 44 已追 Remote Agent Cloud Session create/poll/restore/archive；仍需核验 Storage V5 backend、真实进程/服务器取消及完整故障状态机 |
| Claude CLI 权限、并发和失败恢复 | **本地与远端任务路径已有静态状态机；动态验证未做** | 报告 38–41 覆盖 Remote Host/Bash/MCP 取消；报告 44 覆盖 Remote Agent Cloud Session create/poll/restore/archive 与 permission relay；仍需验证 event cursor replay、archived result recovery、archive ack、真实 Shell/MCP/cloud side effects |
| Claude CLI 上下文压缩与 Subagent | **第一轮源码链已追通；动态验证未做** | 报告 42–44 已追 Local Agent sync/async、owner/parent、keepalive、TaskStop、resume、worker adoption；Full/Reactive/Precomputed/Microcompact；compact boundary UUID relink；Agent resume reader 的 hdo/RMt/bdo；Remote Agent Cloud Session 作为独立 remote_agent task 的恢复/取消路径。仍需 multi-compact/torn-tail 与 remote worker 故障验证 |
| Desktop / SDK 启动、Session、双向协议 | 有初步材料，未完整核验 | 逐一核对请求关联、消息方向、取消、idle/exit 与权限代理 |
| MCP、宿主工具桥接和安全边界 | **协议取消与 SEP-2663 恢复路径已部分核验** | 报告 39–41 已追 notifications/cancelled、迟到 task handle 后 tasks/cancel、metadata/outcome sidecar、resume/reconnect；继续核对第三方 server 真正停止、cancel 未确认后的恢复义务 |
| Pi Agent Core 完整源码审查 | 部分完成 | 从上游源码核对 API、loop、事件、工具、取消和上下文机制 |
| 横向架构比较 | 初步报告存在，未定案 | 统一比较维度；历史报告 32 需按报告 33 的新证据重审，不能以旧 Kernel 为前提 |
| 新目标架构 | 未开始 | 等源码研究与需求澄清完成后提出多方案 |
| 用户确认 | 未开始 | 完整方案交付后等待明确批准 |

## 5. 下一步任务（按顺序执行）

### A. Claude CLI 的完整执行链（第一轮主路径已追通，继续补边界）

历史研究索引：[33：入口/Loop](./33-Claude-CLI执行链源码复核-2026-10-29.md)、[34：transcript/路由](./34-Claude-CLI会话持久化与工具路由复核-2026-10-29.md)、[35：remote Host/reconcile](./35-Claude-CLI远程工具Host与恢复状态机复核-2026-10-29.md)、[36：写入失败和 fallback](./36-Claude-CLI写入失败与流式Fallback收敛-2026-10-29.md)、[37：Storage V5 reader 与 WriterHealth](./37-Claude-StorageV5读取修复与WriterHealth证据-2026-10-29.md)、[38：远程工具取消与执行账本收敛](./38-Claude-CLI远程工具取消与执行账本收敛-2026-10-30.md)、[39：Bash 与 MCP 工具取消语义](./39-Claude-Bash与MCP工具取消语义-2026-10-30.md)、[40：后台 Bash 与 MCP Task 恢复边界](./40-Claude-CLI后台Bash与MCP任务恢复边界-2026-10-30.md)、[41：取消时序矩阵与结果回收边界](./41-Claude-CLI取消时序矩阵与结果回收边界-2026-10-30.md)、[42：Subagent 生命周期、所有权、停止与恢复](./42-Claude-Subagent生命周期所有权停止与恢复-2026-10-30.md)、[43：上下文压缩与 Subagent 恢复连续性](./43-Claude-CLI上下文压缩与Subagent恢复连续性-2026-10-30.md)、[44：Remote Agent 云端 Session 生命周期与恢复](./44-Claude-Remote-Agent云端Session生命周期与恢复-2026-10-30.md)。

报告 43 完成 compaction 与 Agent resume reader 闭环；报告 44 完成 Remote Agent cloud task 第一轮：

- Remote Agent Tool 创建独立 Cloud Session；本地 TaskRegistry type=remote_agent，不是 local_agent/W7。
- nUe 注册 remote task、写 remote-agents metadata sidecar、启动 K3t poller；metadata write 是 best-effort，未 await。
- K3t 用 dTe 按 cursor 拉取 event，bXe 通过 appendFile 写本地 output；permission relay 只把本地 canUseTool 的 allow 回传远端。
- MQt/O8o resume 从 sidecar 查 session_status，非 archived session 重建 task record 并重新 poll；这是 reconnect，不是恢复远端 Agent loop。
- TaskStop 本地先标记 killed，YO 异步 archive，不等待确认；随后停 poller、删 sidecar。
- metadata 有 runId 用于 notification dedupe，但不保存 lastEventId；恢复时 cursor 从 null 开始。output writer append-only，存在 event replay/重复输出风险。
- O8o 对 archived session 直接删除 metadata，不拉 terminal event、不补 notification；若远端已完成而本地未消费结果，可能出现结果通知缺口，需动态验证 archived 语义。

**CLI 剩余优先：**

1. 核对 Storage V5 backend provenance 与 sidecar durability；明确 consumer 的 inPlace/atomic publish discipline 到底由哪个 backend 实现，能否证明 fsync/crash behavior。
2. 对 transcript/remote task reader 做状态矩阵：多次 compact、preserved UUID 缺失、parentUuid cycle、torn JSONL tail、remote event cursor replay、archived terminal result。
3. 仅在可获得真实服务/API contract 或隔离环境时验证 Cloud Session archive、event cursor 与 remote permission relay；否则保持未知，不推断。
4. 完成上述 CLI 静态证据后，转入 Desktop/SDK Host session lifecycle 与 Pi Core 完整源码研究。
5. 统一比较成熟方案后，才提出独立目标架构与备选方案。

### B. 再研究 Desktop / SDK

从 Desktop 如何创建宿主进程开始，跟踪双向协议、request correlation、Session/Process 生命周期、权限 broker、MCP 桥接、取消与关闭语义。

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

本轮新增 [报告 44：Claude Remote Agent 云端 Session 生命周期与恢复](./44-Claude-Remote-Agent云端Session生命周期与恢复-2026-10-30.md)。

**本轮已证实：**

- Agent Tool 的 remote branch 创建 Cloud Session；本地 task 类型为 remote_agent，与 local_agent/W7/Agent transcript resume 分离。
- remote task metadata sidecar 记录 sessionId/runId/task details；nUe 写入后立即启动 K3t，metadata write failure 不阻止当前 task 运行。
- K3t 用 dTe 按 sequence cursor 拉取 event，通过 append-only task output writer 写入本地 output file；permission relay 仅转发本地 canUseTool 的 allow。
- MQt/O8o 在 session resume 时查询 remote session status，重建 task record 并重启 poller；不是重新创建 Cloud Session。
- RemoteAgentTask.kill 先更新本地 killed 状态，再异步 archive Cloud Session，不等待确认；随后停止 poller并删除 metadata。
- runId 用于通知去重，不是 event cursor；sidecar 未持久化 lastEventId，恢复从 null cursor 开始，存在历史 event 重放/重复 output 风险。
- O8o 对 archived session 直接删 metadata 并跳过，不补发 terminal result；远端 archived 的确切语义未知。

**下一次新对话第一任务：** 核对 Storage V5 backend provenance 与 sidecar durability，尤其 inPlace/atomic publish discipline 的实际实现和 crash guarantee；然后完成多次 compaction/torn-tail/remote event replay 状态矩阵，再进入 Desktop/SDK Host session lifecycle。报告 33–44 都是静态源码研究，不是最终架构裁决；不允许开始开发。
