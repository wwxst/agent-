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

## 4. 研究覆盖率

| 子系统 | 状态 | 下一步 |
|---|---|---|
| 资料版本、分包和完整性入口 | 已初步盘点 | 核对核心文件与版本来源，建立可导航源码索引 |
| Claude CLI 入口与主循环 | **第一轮源码追踪完成，待继续核验** | 报告 33–34 已追入口→main/session driver→YL→su/iu→流式请求→ToolCall 调度→结果回填，并区分 session.append hook 与 transcript writer；已追 record/queue/flush/exit hook；直接文件路径使用 appendFile 或 open/write/close，本层未见 fsync；Storage V5 backend 保证未知。remote Host 路由/reconcile 已有报告；报告 36 新增 writer 失败 Promise/健康状态和流式 fallback 状态清理；报告 38 已补 remote cancel / call ledger / late correction；仍需核验 Storage V5 backend、Shell/MCP 实际取消及完整故障状态机 |
| Claude CLI 权限、并发和失败恢复 | **部分核验，Shell/MCP 取消链已追到 executor/协议层** | 报告 38/39 已确认 Bash foreground SIGTERM→约 1.5s 后 SIGKILL 尝试、background 移除 abort listener；MCP 使用 notifications/cancelled，Task 使用 tasks/cancel；第三方实际停止、副作用与 caller late-query 缺口仍需核验 |
| Claude CLI 上下文压缩与 Subagent | **初步定位，未完成** | 已确认每轮前 autocompact 与 prompt-too-long reactive 路径；subagent 父子状态和完整压缩转移待查 |
| Desktop / SDK 启动、Session、双向协议 | 有初步材料，未完整核验 | 逐一核对请求关联、消息方向、取消、idle/exit 与权限代理 |
| MCP、宿主工具桥接和安全边界 | **取消协议已部分核验** | 报告 39 已追 Client notifications/cancelled → Server handler AbortSignal，以及 tasks/cancel；继续核对第三方 server、task executor 和后台任务生命周期 |
| Pi Agent Core 完整源码审查 | 部分完成 | 从上游源码核对 API、loop、事件、工具、取消和上下文机制 |
| 横向架构比较 | 初步报告存在，未定案 | 统一比较维度；历史报告 32 需按报告 33 的新证据重审，不能以旧 Kernel 为前提 |
| 新目标架构 | 未开始 | 等源码研究与需求澄清完成后提出多方案 |
| 用户确认 | 未开始 | 完整方案交付后等待明确批准 |

## 5. 下一步任务（按顺序执行）

### A. Claude CLI 的完整执行链（进行中）

历史研究索引：[33：入口/Loop](./33-Claude-CLI执行链源码复核-2026-10-29.md)、[34：transcript/路由](./34-Claude-CLI会话持久化与工具路由复核-2026-10-29.md)、[35：remote Host/reconcile](./35-Claude-CLI远程工具Host与恢复状态机复核-2026-10-29.md)、[36：写入失败和 fallback](./36-Claude-CLI写入失败与流式Fallback收敛-2026-10-29.md)、[37：Storage V5 reader 与 WriterHealth](./37-Claude-StorageV5读取修复与WriterHealth证据-2026-10-29.md)、[38：远程工具取消与执行账本收敛](./38-Claude-CLI远程工具取消与执行账本收敛-2026-10-30.md)、[39：Bash 与 MCP 工具取消语义](./39-Claude-Bash与MCP工具取消语义-2026-10-30.md)。

报告 39 新增确认：

- Bash foreground 的 AbortSignal 到达 LFe；spawn 前已 abort 则不启动进程；spawn 后进入 kill；POSIX 尝试 SIGTERM，约 1.5 秒后尝试 process-group SIGKILL，Windows 使用 taskkill /T /F。
- Bash background() 会移除原 abort listener，后台命令脱离原 per-tool controller；命令完成后也会移除 listener。foreground kill 不回滚已提交副作用。
- MCP Client Protocol.request 发送 notifications/cancelled；SDK Server 将其转为 RequestHandlerExtra.signal abort。第三方 server 是否尊重 signal 未验证。
- MCP Task 取得 task handle 后会 best-effort 发 tasks/cancel；SDK handler 更新 task status、清空 task queue，不足以证明底层执行进程停止。
- Claude MCP adapter 对 timeout/connection/protocol error 提示“可能已运行并有副作用”，而不是一概声称未执行。

**下一轮优先：**

1. 追 background Bash task registry、output retrieval 和 task ID 在 fallback/turn abort/session restart 后的生命周期；核对后台进程是否可重新发现、停止和取回结果。
2. 追 MCP task registry、driveAbort、polling、tasks/cancel 与 attempt abandonment 的关系；明确 task status cancelled 与真实 executor 停止的区别。
3. 完成取消时序矩阵：Bash spawn 前/后、background 后；MCP request 发送/handler 开始/task handle 返回/task 完成/response 丢失；每个阶段列 caller、Host/server、journal、可恢复状态。
4. 继续核对 direct-cancel 是否存在其他 caller-side notice/query；动态行为未验证。
5. 然后研究 Subagent、context compaction、Desktop/SDK 与 Pi 完整源码，最后统一比较并提出独立目标架构。

### B. 再研究 Desktop / SDK
### B. 再研究 Desktop / SDK
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

本轮继续检查 CLI 2.1.304 的 Bash runner 与 MCP SDK/adapters，新增 [报告 39：Claude Bash 与 MCP 工具取消语义](./39-Claude-Bash与MCP工具取消语义-2026-10-30.md)。

**本轮已证实：**

- Bash foreground signal 到达 LFe；spawn 前 abort 返回“Command aborted before execution”；spawn 后尝试 SIGTERM，约 1.5 秒后对 process group 尝试 SIGKILL；Windows 使用 taskkill /T /F。
- Bash background() 会移除原 AbortSignal listener；后台任务不再受该 per-tool signal 管理。完成的命令同样移除 listener。
- MCP 普通 call 通过 notifications/cancelled 传 requestId/reason，SDK Server 将它映射为 request handler AbortController.abort。
- MCP Task 在拿到 task handle 后会 best-effort 发送 tasks/cancel；SDK 默认 handler 更新 task status 并清队列，但不证明底层 task process 已停止。
- Claude MCP adapter 对 timeout/lost connection/protocol failure 会提示可能已运行并产生副作用；明确 auth/consent refusal 才报告 did not run。

**下一次新对话第一任务：** 追 background Bash task registry 和 MCP task registry 在 fallback、turn abort、session restart 后的恢复/停止/结果取回；随后完成取消时序矩阵。报告 33–39 均为静态源码研究，不是最终架构裁决；不允许开始开发。
