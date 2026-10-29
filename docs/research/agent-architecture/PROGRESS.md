# Agent 架构研究进度与跨对话续接点

> 最后更新：2026-10-29  
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

## 4. 研究覆盖率

| 子系统 | 状态 | 下一步 |
|---|---|---|
| 资料版本、分包和完整性入口 | 已初步盘点 | 核对核心文件与版本来源，建立可导航源码索引 |
| Claude CLI 入口与主循环 | **第一轮源码追踪完成，待继续核验** | 报告 33–34 已追入口→main/session driver→YL→su/iu→流式请求→ToolCall 调度→结果回填，并区分 session.append hook 与 transcript writer；已追 record/queue/flush/exit hook；直接文件路径使用 appendFile 或 open/write/close，本层未见 fsync；Storage V5 backend 保证未知。remote Host 路由/reconcile 已有报告，仍需核验 MCP Host 分支和完整错误状态机 |
| Claude CLI 权限、并发和失败恢复 | **部分核验** | 已确认 class vs 并发合同、wG/AYr 权限路径、remote Host 的 call-state/reconcile/delivery_unknown 路径；下一步核验 backend 写入语义、本地工具失败语义及全分支副作用边界 |
| Claude CLI 上下文压缩与 Subagent | **初步定位，未完成** | 已确认每轮前 autocompact 与 prompt-too-long reactive 路径；subagent 父子状态和完整压缩转移待查 |
| Desktop / SDK 启动、Session、双向协议 | 有初步材料，未完整核验 | 逐一核对请求关联、消息方向、取消、idle/exit 与权限代理 |
| MCP、宿主工具桥接和安全边界 | 未完成 | 确认调用链、审批点和信任边界 |
| Pi Agent Core 完整源码审查 | 部分完成 | 从上游源码核对 API、loop、事件、工具、取消和上下文机制 |
| 横向架构比较 | 初步报告存在，未定案 | 统一比较维度；历史报告 32 需按报告 33 的新证据重审，不能以旧 Kernel 为前提 |
| 新目标架构 | 未开始 | 等源码研究与需求澄清完成后提出多方案 |
| 用户确认 | 未开始 | 完整方案交付后等待明确批准 |

## 5. 下一步任务（按顺序执行）

### A. Claude CLI 的完整执行链（进行中）

入口/Loop 见 [报告 33](./33-Claude-CLI执行链源码复核-2026-10-29.md)，transcript 与路由见 [报告 34](./34-Claude-CLI会话持久化与工具路由复核-2026-10-29.md)，remote Host 执行/恢复见 [报告 35](./35-Claude-CLI远程工具Host与恢复状态机复核-2026-10-29.md)。均基于 CLI 2.1.304 发布版 JS 静态检查。

下一轮按以下顺序继续：

1. 追踪 `appendToFile → pue` 的底层 backend 写入语义，区分 queue resolved、writer drained、backend completion 与 fsync 证据；检查非正常进程崩溃路径。
2. 追踪本地工具的执行事实/失败语义，并完成 MCP Host 路由分支的核验。
3. 补齐 streaming retry、non-streaming fallback、model/refusal fallback、abort、tombstone 和已启动工具收敛的状态机。
4. 追踪 interrupt/turn abort/shutdown 与 tool interruptBehavior，确认取消不等同于副作用回滚。
5. 再研究 subagent 父子状态、预算、权限、后台运行和恢复。
6. 每个关键结论都记录路径、符号、字符 offset/hash 和证据等级；静态分析与动态验证分开标注。

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

本轮完成了**Claude CLI 执行链、transcript 写入与 remote Host 恢复的静态源码复核**，详见报告 33–35。已确认 transcript 有独立异步写队列、显式 drain/flush 与 exit flush；remote Host 路径存在 call-state、reconnect reconcile 和 delivery_unknown/gaveUp/answeredLate 处理。仍未确认底层 backend 的 fsync/crash guarantee，也未证明 runtime ledger 跨进程持久化。

**当前续接点：** 继续核验 Storage V5 `r.append` 的持久化保证与非正常进程崩溃时未完成写队列的处理；随后核验本地工具失败语义和 MCP Host 路由，之后补齐 stream retry/fallback/abort/tombstone 状态机。当前所有结论仍为静态源码证据；未运行 CLI，未动态验证实际分支。
