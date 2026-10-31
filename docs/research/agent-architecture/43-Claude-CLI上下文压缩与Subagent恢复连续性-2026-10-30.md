# 43 · Claude CLI 上下文压缩与 Subagent 恢复连续性

> 日期：2026-10-30  
> 样本：Claude Code CLI 2.1.304 发布版 JavaScript（build 2026-10-19，git SHA 17ab70404e5b632fe060207effb0b440788363ba）。  
> 方法：直接复核发布包中的 main loop、compaction、Agent loop、transcript/metadata、precompute 与 context-management modules；**静态源码研究**，未运行模型请求、真实 Agent、Storage V5 backend 或 crash injection。  
> 前置：[报告 42：Subagent 生命周期、所有权、停止与恢复](./42-Claude-Subagent生命周期所有权停止与恢复-2026-10-30.md)。

## 0. 本轮结论

先纠正一个容易混淆的表述：Claude 的“上下文压缩”不只有一种 summary。CLI 2.1.304 至少有四种不同机制：

1. **Full compaction**：完整生成对话摘要，写入 compact boundary，旧消息不再作为当前活跃上下文；没有保留 tail。
2. **Reactive compaction**：遇到 prompt-too-long / 某些自动阈值路径时，按对话轮次分组，逐步扩大 summary 输入，同时保留最近若干完整轮次。
3. **Precomputed compaction**：在阈值前异步预生成 reactive summary；主 Session 可把 ready summary 持久化为 precompact.json sidecar，稍后严格校验是否仍适用。
4. **Microcompact / tool-result clearing**：不生成摘要，只清除旧 tool_result 内容；包括 server context-management edit 与 context_hint 被拒绝后的本地 fallback。

Subagent 使用同一套 compaction core（rkr → tkr / pUn → Nve / Gvr → Uve），并按 agentId 使用自己的 transcript、文件读取状态、plan、skills 和 task registry。Agent loop 在 compact boundary 到达时使用 wPe 按 UUID 恢复被保留消息的相对位置。因此，Agent compaction 不是一套完全独立的算法。

但它并非所有状态都对称：
- preCompactDiscoveredTools 可按 Agent 历史收集；
- preCompactArtifactReadVersions 的写入 helper 明确跳过 agentId !== undefined，这是主 Session Artifact 版本追踪，不是通用文件版本；
- precompact.json sidecar schema 和 rehydrate 明确限定 agentKey === "main"；常规 Agent post-turn arm path 对 subagent 只记录 arm-gate event，不调用主路径的 skr。
- Agent transcript resume 读取历史 transcript/metadata；reader 先按 compact boundary 做 preserved UUID relink/prune，再按 parentUuid 选择 leaf、重建链并修复 tool_result，最后启动新 W7 loop；它不是恢复原来的 stream、Promise 或 controller。

## 1. Compaction 在主 Loop 中的位置

### 1.1 每次模型请求前的自动检查

chunk-smbjjyps.js 的 su → iu 主执行路径在构造本轮 API 请求前调用 I.autocompact(q, y, Tt, cacheSafeParams, querySource, ...)（约 @143,000）。因此自动压缩不是单独的后台定时器，而是主 Loop 在下一次模型请求前的门禁。

chunk-4b60tdnk.js:rkr（@2,522,180）负责决策：
- 若已有 idle precompute ready，先尝试 Wlr 用它完成 compaction；
- 若最近模型回复请求的模型 context window 更大，且当前模型已 blocked，可尝试切换到更大 context model 后再检查；
- 检查 DISABLE_COMPACT、auto-compact feature、querySource 排除条件、classifier overflow、failure breaker；
- 检查 fixed prefix 是否已经大于阈值；若固定前缀本身太大，压缩可能无效；
- 检查 rapid-refill breaker：若多次压缩后在少于 3 turns 内迅速再次填满，停止自动压缩以避免 thrashing；
- 根据 threshold source / classifier overflow / model switch 决定走 Reactive pUn，否则走 Full tkr。

### 1.2 阈值计算

D9/q7/cVe/fVe/Vpe（chunk-4b60tdnk.js @1,484,360–1,490,922）：

- 有效窗口先扣除输出预算：window - min(maxOutputTokens, 20,000)。
- 默认自动压缩阈值为有效窗口减 13,000 tokens；CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 可设置百分比，但结果仍受默认阈值上限约束。
- 默认 blocking threshold 约为有效窗口减 3,000 tokens；CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE 可覆盖。
- warn threshold 在相应窗口/阈值前约 20,000 tokens。
- precompute arm threshold 另由有效窗口、precomputeBufferFraction 与自动压缩阈值共同决定；fraction 可由 scalar/table feature config 提供。

因此“达到上下文窗口 80% 就压缩”不是准确描述；实际阈值会受模型窗口、输出预算、autoCompactWindow 配置、percentage override、blocking override 与 precompute buffer 影响。

### 1.3 Full 与 Reactive 的分流

- Full path：rkr → tkr。用于常规 auto/manual compaction。
- Reactive path：rkr → pUn → Eho → Nve → Yir → Gvr。用于 prompt-too-long / 特定阈值或 classifier-overflow 路径。
- Main loop 在收到 prompt-too-long 后先调用 Mho(trigger:"ptl") 检查可复用的 precompute，再调用 pUn；若没有可复用 summary，才进行 Reactive compaction（chunk-smbjjyps.js @191,223–192,915）。

## 2. Full compaction：整段摘要 + 状态重新注入

### 2.1 生成摘要

tkr（chunk-4b60tdnk.js @2,492,295）：
1. 记录压缩前 token count；
2. 运行 PreCompact hook，允许附加 custom instructions 或阻止压缩；
3. 用 cun 发 summary request；
4. 若 summary request 自身 prompt-too-long，调用 aun 逐步从输入头部移除旧消息并重试，受 eZ 与 compactionApiAttemptsLeft 限制；
5. 要求有效 summary text；API error / no summary 会使 compaction 失败；
6. snapshot readFileState 后清空该 map，并清理 memory selector；
7. 调用 Uve 重建上下文附件；
8. 创建 compact_boundary 与特殊 summary user message；
9. 写入 preCompactDiscoveredTools、Artifact version metadata（若适用）、postTokens、duration；
10. 运行 PostCompact hook，返回新的活跃消息集合。

Full compact 的 messagesToKeep 是空数组。它不按固定条数保留最近消息；完整对话内容由 summary 承担，随后注入新的状态附件。

### 2.2 Summary request 不是普通 Agent Tool turn

Yir（@2,367,144）：
- querySource:"compact"；
- maxTurns:1；
- canUseTool:aXe()，工具使用一律 deny；
- skipTranscript:true、skipCacheWrite:true；
- 使用 Tve 选择 summary prompt arm，并附加 PreCompact custom instructions；
- 允许 fallback model；
- summary output 必须有 <summary> block，否则失败。

Summary prompt 本身要求保存用户明确提出的约束、决定、未完成工作、困难、下一步和可复原的具体细节；并区分用户原话、工具输出、system reminders 与 assistant 自己的表述。这是为了跨 context window 续接，不是只生成简短摘要。

XJ（@2,363,235）后处理摘要：
- 将 <summary> 转成 Summary:；
- 附加此前使用过的工具名（tools-used-before-summary）；
- 若 transcript 可用，提供完整 transcript path，允许下一 context window 回读精确代码、错误或生成内容；
- 若 reactive fallback 曾截断开头，明确提示摘要不覆盖最早一段，不允许猜测。

Summary 作为 isCompactSummary:true、isVisibleInTranscriptOnly:true 的特殊 user message。该 flag 控制 UI transcript 显示位置，不应误读为“summary 不进入后续模型上下文”。

### 2.3 Post-compaction attachments：恢复状态而非只恢复摘要

Uve（@2,512,911）负责重新注入当前 Session/Agent 需要的状态。它收到 compaction 前的 readFileState snapshot、当前 toolUseContext、要保留的消息与 querySource。

| Attachment | 来源/用途 |
|---|---|
| 文件读取恢复 | Clr 重新读取最近、仍相关且不已被其他 context 覆盖的文件；每文件和总 token 数都有上限 |
| local_agent task_status | Plr 从 task registry 收集未 retrieved、非 pending、非当前 Agent、未过期的其他 Agent task；包括状态、进度/错误、output file path、是否可继续 |
| local_bash task_status | Mlr 只收集当前 agentId 拥有、仍 running、isBackgrounded、且有 toolUseId 的 Bash task |
| peer handback queued_command | Olr 从最后一个有效 assistant turn 后找尚未消费的 peer handback command |
| plan_file_reference | xlr 读取当前 Agent 的 plan file 并注入引用/内容 |
| plan_mode | SXe 注入 plan reminder、isSubAgent、plan path/existence 与 custom instructions |
| invoked_skills | Alr 恢复当前 Agent 已调用的 skills；校验 MCP skill 来源并按预算截断内容 |
| 工具/MCP/系统附件 | 当前工具池、动态工具、MCP tools、skills、remote notice、上下文辅助信息 |
| active goal / workflow | CXe / AXe 恢复当前 active goal 与 workflow state |
| hook results | 非 isolated context 下运行 session_start hook，得到新的 hook context |

文件恢复 Clr 会：
- 排除当前 Agent 的 plan 文件、已由 CLAUDE.md/memory 管理的文件、已在保留消息中有完整读取结果的文件，以及不可恢复/不应恢复的路径；
- 按最近读取时间排序；
- 对单文件和全部附件分别设置 token 上限；
- 通过 RUn 重新读取文件，而不是盲目复制旧 tool_result。

这意味着 summary 负责语义连续性，附件恢复负责当前可执行状态。两者职责不同。

## 3. Reactive compaction：按完整轮次自适应保留

### 3.1 分组边界

Ls（chunk-4b60tdnk.js @155,554）先截取最后一个 compact boundary 之后的消息。Qdt（@2,344,343）再过滤 progress rows 并调用 ZK（@2,344,076）分组：

- 以 Assistant message ID 变化作为新 group 边界；
- 当前 Assistant message 与后续 user/tool_result rows 留在同一 group；
- 特殊 RC rows 被保留在当前 group；
- 不把 progress row 当成独立对话轮次；
- qks 以 group 数量判断是否还有可压缩空间；少于 2 组时 reactive compact 无法执行。

因此，普通 assistant tool_use message 与紧随其后的 tool_result user message 会作为同一轮保留/摘要，不会仅因消息条数截断而自然分离。

### 3.2 Nve：动态调整保留轮数

Nve（@2,371,130）是 Reactive Compaction 核心：
- 默认先保留最后 1 个 group；
- 如果收到 initialTokenGap，用每组 token estimate 推导初始保留数；
- 先摘要较早的 groups，保留尾部 groups；
- 若 summary request prompt-too-long，使用返回的 token gap 与 Xir/Cln 调整保留步长；gap 无法解析时每次增加 1 组；
- 若摘要部分没有 assistant message，可能使用 ear 找更合适的 summarize/keep split；
- 有 media-too-large 时先 strip media 再重试；
- round ladder 用尽后才进入 last resort：尝试 summarize_all + 保留尾部消息；必要时按 Dve 逐步从摘要输入头部截断；
- 只有启用 fallback 时才允许最后的 head truncation；precompute 明确传 allowFallback:false。

该算法的优化目标不是“固定保留最近 N 条消息”，而是根据每个 group 的 token 估计与服务端 token gap 动态选择保留边界。

### 3.3 Summary 与 preserved tail 的时间一致性

Reactive summary model 不会看到后续保留的 tail。Gvr 在有 preserved tail 时通过 wln 在 summary 后追加提醒：summary 未看到这些 tail rows，因此摘要中的“尚未发生”可能已经在 tail 中发生。

这解决了一个常见压缩错误：摘要说“尚未执行工具”，但保留的最新消息实际上已经执行并返回结果。

### 3.4 compact_boundary 的 UUID 元数据与消息重排

n2（@5,021,993）创建 system/compact_boundary，记录：
- trigger（auto/manual）；
- preTokens；
- userContext；
- messagesSummarized；
- logicalParentUuid。

fXe（@2,491,305）在存在 preserved tail 时额外记录：
- preservedSegment.headUuid / anchorUuid / tailUuid；
- preservedMessages.anchorUuid；
- preservedMessages.uuids（经 transcript-safe filter 后的 UUID）；
- preservedMessages.allUuids（完整保留集合）。

wPe（@2,391,410）在 compact boundary 到达时：
1. 根据 preservedMessages 的 UUID 从已有 transcript rows 或 fallback rows 找回原消息；
2. 将找到的 preserved rows 从原位置移出；
3. 在 anchor UUID 对应位置把它们重新插入；
4. 对被保留的 assistant rows 将 usage 归零，避免重算历史 token；
5. 若 boundary 与 anchor 不同，则暂存直到 anchor row 到达。

Agent W7 loop 在处理 stream rows 时调用 wPe（chunk-k3djx6vq.js @108,928）；fork/background session 路径也调用同一 helper。compact boundary metadata 因而不仅是 UI 标记，它承担活跃消息序列重建的结构信息。

### 3.5 动态工具知识如何跨压缩

两种工具知识分开保留：
- UJ（@2,344,965）收集历史中真实使用过的 tool_use/server_tool_use 名称，并从之前 summary 的 tools-used-before-summary 标签继续累计；摘要 prompt 后处理会携带它们。
- VZ（@2,337,011）从 deferred_tools_delta.surfacedNames 与之前 compact boundary 的 preCompactDiscoveredTools 恢复动态发现工具；新 boundary 写入排序后的 preCompactDiscoveredTools。

因此“工具用过”与“工具曾被动态发现/加载”不是同一份元数据。

## 4. Precomputed compaction：异步生成、sidecar 持久化、严格复用

### 4.1 Arm 与生成

- Oho（@2,539,647）在主 Loop 每次模型响应后判断是否需要预计算；排除已压缩、已尝试 reactive、pre-first-compact fork 和 precomputed swap 等状态。
- skr（@2,539,966）为 precompute 创建独立 AbortController、记录 coverage、启动异步任务。
- 它先运行 session.compact hook wrapper cfo（@1,479,567），再运行 PreCompact hook，随后以 Nve(..., allowFallback:false) 生成 summary。
- precompute 不在用户等待的关键路径上立即替换 messages；它将状态放在 session.precompute registry，之后由 idle 或 prompt-too-long 路径尝试消费。
- Mho（@2,547,487）负责等待/消费 ready entry；调用 xho 与 r2r 验证 summary 是否仍适用于当前消息，并重新估算是否 fit；不合适则 discard，回到普通 reactive compact。

session.compact hook 可以 skip core、替换输出或让 core 在 hook 下运行；这与普通 PreCompact / PostCompact hook 是不同扩展层。

### 4.2 Main session precompact.json sidecar

chunk-4b60tdnk.js @2,535,871 起：
- 文件名 precompact.json；
- sidecar schema version = 4；
- 最大 8,000,000 bytes；
- TTL = 7 days；
- payload 含 sessionId、agentKey=main、model、cliVersion、createdAt、precomputedAtUuid、preCompactTokens、readyDurationMs、preCompactHookDisplay、summaryText、summaryMessages、preserveUuids、attempt、groupsPreserved、totalGroups、forkAssistantMessageCount、totalUsage；
- Storage V5 sidecar 可用时走 sidecar backend，否则本地文件；
- BIt 只对 agentKey === "main" 尝试 rehydrate；
- rehydrate 检查 session mismatch、timestamp、TTL、是否已经被该 summary compact、boundary UUID 是否存在、transcript 是否异常缩小、所有 preserve UUID 是否都能找回、rows 是否可读；
- 不满足条件就删除 sidecar 并记录拒绝原因。

r2r（chunk-q43h57v8.js @49,712）还验证：
- boundary UUID 仍在当前 sent messages；
- 所有 precompute coverage rows 仍存在；
- preserved messages 未丢失；
- covered boundary 之前没有新的 unseen assistant reply；
- received rows 的 UUID prefix 与 sent rows 一致；
- PreCompact hook 没有改写历史；
- summary + tail + 新消息仍能 fit。

只有所有条件成立才 reuse；否则拒绝预计算摘要，走 reactive compaction。这是防止“旧摘要覆盖新对话/新工具结果”的关键机制。

### 4.3 Subagent 的不对称

- PLe(agentId) 会把 undefined 映射为 main，session.precompute 内存 registry 结构支持按 agentId 分 key。
- 但 sidecar writer adr 写死 agentKey:"main"；BIt rehydrate 也明确 if(agentKey !== "main") return。
- Main loop 常规 post-query arm 分支：To==="subagent" 时调用 okr(...,"subagent_estimate")，而不是 skr；最终 turn 同样记录 subagent_final_turn gate，而非调用主路径的 skr（chunk-smbjjyps.js @147,174/@182,560）。
- 因而源码证据支持：主 Session 有完整 precompute + sidecar rehydrate；常规 Subagent loop 没有同等的 post-turn precompute/sidecar 恢复路径。Reactive/full compaction 本身仍可用于 Subagent。
- sEs 另有 idle precompute helper，但它由 REPL/SDK session summarize callback 暴露；本轮没有找到它作为常规 subagent loop arm 的调用证据。

## 5. Agent-specific continuity：同一算法，不同状态空间

### 5.1 Agent 使用自己的 transcript 与 compact boundary

- Bve(toolUseContext) 在 agentId 存在时返回该 Agent transcript path；summary prompt 因而可提示从正确 Agent JSONL 回读。
- Agent loop W7（chunk-k3djx6vq.js @149,927）在处理 stream row 时维护自己的 transcript buffer；compact boundary 到达后调用 wPe。
- wPe 使用 compact boundary 中的 UUID metadata，把 preserved tail 从旧位置重排到 summary 后；这同样适用于 Agent transcript，而不只 main session。
- Agent resume Gn（chunk-xqhs6qqf.js @10,327）读取 Agent metadata 与 transcript，等待 append queue flush、检查 transcript 完整性和 stoppedByUser / forked-skill scoping，再创建新的 task record / AbortController 并启动新的 W7 loop。它不是恢复旧 stream 或 JS 执行栈。

### 5.2 Agent compact 后重新注入什么

Uve 接收 agentId 并使用对应的：
- readFileState；
- plan file 与 plan mode；
- invoked skills；
- Agent-owned background Bash task；
- 当前 taskRegistry 中其他 Agent task；
- peer handback queued command；
- active goal / workflow；
- Agent 当前 tool/MCP pool；
- 可用时的 hook results。

其中 Plr 注入其他 Agent task 状态；Mlr 只注入同一 agentId 的 running background Bash。父 Agent 与子 Agent 不共享一个无区分的 task 状态附件。

### 5.4 Resume reader 会重建 compact boundary 的 parentUuid 图

报告 42 已追到 Agent resume 的 Gn → iee，但当时没有闭合 transcript reader 对 compact boundary 的恢复处理。本轮进一步追到：

iee（chunk-4b60tdnk.js @504,071）
→ KRt（@504,720）
→ see（@488,032）
→ GCt.finish（@484,997）
→ hdo（@418,403）
→ RMt（@420,397）
→ bdo（@423,822）。

具体行为：

1. iee 等待 Agent transcript append queue flush（除非调用方声明 alreadyWaited），然后调用 KRt；若本地 transcript 不存在/不可读，可走 internal reader 的 on-demand hydration，再重试。
2. KRt 调用 see 读取 Storage V5 或 JSONL。see 的 GCt.finish 会先执行 reader row normalization / parent repair，再执行 hdo(n)；因此 compaction boundary replay 是 transcript reader 的正式完成步骤，不只是 Agent W7 收到新消息时的内存逻辑。
3. hdo 找到最新 compact boundary，以及最近一个带 preservedMessages / preservedSegment 的 boundary：
   - 优先使用 preservedMessages UUID list；
   - 若只有 preservedSegment，则从 tailUuid 沿 parentUuid 反向走到 headUuid，重建 UUID list；
   - 要求 preserved UUID 全部存在；若缺失，发出 tengu_relink_walk_broken 并提前返回，不继续破坏性 prune；
   - 将 preserved rows 的 parentUuid 串接到 anchorUuid（该 anchor 是 summary message UUID），并把 anchor 的其他 children 重挂到 preserved tail；
   - 对保留的 assistant rows 将历史 usage 置零；
   - 删除最新 compact boundary 之前不属于 preserved set 的 rows，并把这些已删除 rows 的直接 user/assistant children 重挂到 preserved tail。
4. 若最新 compact boundary 是 full compact（没有 preserved tail），它不重新附加 tail；compact boundary 作为新的 active branch root，旧 rows 不在随后 parentUuid leaf chain 中。reader Map 的 pruning/relink 不等于对原 JSONL 文件做物理截断。
5. KRt 从该 Agent 的 sidechain rows 中选择最新 leaf（排除 compact_boundary），再由 RMt 沿 parentUuid 向上重建 conversation chain。
6. RMt 遇到缺失 parentUuid / parent row 时，Sdo 可在相同 isSidechain 的 rows 中寻找 5 秒内最近的前序 timestamp 作为 fallback；发现 cycle 会记录错误并返回 partial chain。
7. RMt 的 bdo 还会修复 parallel tool_result 关联：优先利用 parentUuid、sourceToolAssistantUUID 与 tool_use_id 找到正确 assistant message；要求 isSidechain 与 agentId 一致，避免把其他 Agent 的 tool result 接到当前 Agent；重建后的 tool_result 按其原始时间/assistant block 顺序插入。

因此恢复时存在两层互补机制：
- live Agent W7 stream：wPe 在 boundary/summary 到达时把 preserved rows 重排到 summary 后；
- durable transcript reload：see → hdo → RMt 在重新加载 JSONL 时恢复 parentUuid 图，再通过 bdo 修复工具结果关联。

这闭合了报告 42/本报告此前的一个未知项：**Agent resume 并非把原始 transcript rows 原样交给新 W7；reader 会先执行 compact-boundary-aware normalization 与 lineage reconstruction。** 但仍未动态验证多次 compaction、UUID 缺失、torn tail 与 worker handoff 的组合故障。

### 5.3 Artifact version carry 是 main-session 专项

fQ（@1,782,147）有显式 guard：agentId !== undefined 时直接 return；只有 main session 且 MWe() feature 开启时，才将 preCompactArtifactReadVersions 写入 compact boundary。

N9t（@1,782,830）恢复 Artifact version/path pin 状态时：
- 扫描 compact boundary；
- 收集 preservedMessages UUID；
- 要求 summary message 已出现，且最后一个 preserved UUID 已重新出现；
- summary 不是 foreign/remote summary；
- 条件满足才把 preCompactArtifactReadVersions 合并回来，否则计为 dropped。

这里的版本是 Claude Artifact read/version tracking，不是对所有工作区文件生成通用版本快照。不能把它泛化为“Subagent compaction 会保留所有文件版本”。

## 6. Microcompact：清除旧 tool_result，不生成 summary

### 6.1 Server context-management edit

chunk-xnwgde04.js：
- Nn @142,091 配置 minIdleSeconds:3900（65 分钟）、keepToolUses:12、clearAtLeastTokens:20,000、triggerToolUsesBelowCount:3、minTriggerToolUses:27；触发数是在 clearable count 中扣除 3 后计算。
- xjs @142,340 规划 clear_tool_uses_20250919 edit；要求存在 idle gap、足够多可清理 tool results、token 节省量达标，并返回 keep.tool_uses=12、clear_at_least.input_tokens=20,000 与 exclude_tools。
- pr @143,198 计算 idle gap、clearable tool uses、server 已清除数量、被排除的 tool names 和预计 token 节省。
- Pjs @145,362 读取 API response 的 context_management.applied_edits，记录 server 实际清理的 tool uses / input tokens，并维护 idle tracking。

这是 server-assisted tool-result eviction，不是 summary compaction。

### 6.2 Context hint 被拒绝时的本地 fallback

chunk-wa7fj3rd.js 的 createContextHintController：
- 仅在 first-party beta 可用、querySource 以 repl_main_thread 开头时启用；
- 请求携带 context_hint；若服务端拒绝（特定 422/424）或特定 stream invalid-request fallback，执行本地 microcompact；
- Ajs（chunk-xnwgde04.js @141,192）保留最近 5 个 eligible tool uses，只有估算节省至少 20,000 tokens 才执行；
- 尝试把旧 tool_result 内容持久化到 output file，并把结果替换为 “Tool result saved to … Use Read to view”；持久化失败则使用清除占位符；
- image/document content 不走普通文本持久化路径，替换为通用 cleared marker；
- 更新 clearedIds / clearedContent 与 prompt-cache bookkeeping。

它不会生成对话 summary，也不等于删除整个 tool call record。其目标是腾出上下文空间，同时保留可重新读取的工具输出。

## 7. 事实、推断与未知

### 源码事实
- Main loop 每次模型请求前执行 autocompact gate。
- Full、Reactive、Precomputed、Microcompact 是不同机制。
- Reactive compaction 按 assistant message ID 形成的轮次组工作，默认保留最近 1 组并根据 token gap 动态调整。
- compact boundary 记录 preserved UUID metadata；Agent W7 使用 wPe 重建保留消息顺序。
- Full/reactive compaction 都通过 Uve 注入当前文件、task、plan、skills、tool/MCP、goal/workflow 等状态。
- Main session precompute sidecar 是 versioned、TTL-limited、coverage-validated 的 precompact.json。
- Agent 常规 loop 使用相同 compaction core，但 main-only precompute sidecar 与 artifact version carry 不对称。
- Microcompact 只清理旧 tool_result，不是摘要。

### 推断 / 风险
- 新 Agent 架构不应把 summary、message eviction、artifact state、tool output persistence 混为一个 compact() API；它们有不同恢复/审计语义。
- 只保存 summary 而不保存 boundary UUID / preserved message IDs，会使 tool_use/tool_result 关联、tail chronology 和 resume 重建变得脆弱。
- 只保存 ownerAgentId 而不保留 Agent-specific context state，可能在 child resume 后丢失其 plan/skills/task/file context。
- Artifact version carry 的 main-only guard 说明“Agent 的文件/Artifact 状态”还没有完全统一进同一持久化契约。

### 未知
1. 本轮没有运行 compaction / prompt-too-long / Agent resume 的动态测试；算法边界来自静态 JS。
2. 已追到 Agent resume 的 iee → KRt → see → GCt.finish → hdo → RMt → bdo，确认 reader 会按 compact boundary 重建 parentUuid 图并修复 tool_result 关联；多次 compaction 与 torn-tail 的动态组合行为仍未知。
3. Uve 清空 readFileState 后若 full compact attachment builder 失败，状态恢复是否有其他兜底；reactive path 有 nar fallback，full path直接 await，需故障注入。
4. Storage V5 sidecar 的真实原子性、fsync 与 crash durability 未验证。
5. Remote Agent/worker handoff 时 compact boundary metadata 的跨 Host 传输、旧 worker transcript linking 与新 W7 resume 的完整端到端链尚未动态验证。
6. 第三方 MCP tool result 被 microcompact 后，server/connector 是否仍可按引用重新读取，取决于 tool-specific persistence path，不能泛化。

## 8. 对新架构的启示（非决策）

- 建议将 Context Compaction 拆成至少四个独立能力：SummarizeHistory、PreserveConversationSegments、EvictToolArtifacts、RehydrateRuntimeContext。
- compact boundary 应是带版本的 journal event：trigger、pre/post token estimates、summary ref、preserved UUID ranges、tool registry snapshot、artifact version refs、agent lineage。
- Tool call 与 result 应通过稳定 operation ID 绑定；eviction 只能压缩 payload，不能删除 operation identity、execution state 或 idempotency key。
- Summary 要有 coverage range 与 transcript anchor；resume 必须验证 summary 覆盖边界、kept rows、unseen assistant reply 和 tool result pairing。
- 主 Agent / Subagent 应使用同一套 compaction algorithm，但各自持有 scoped transcript、read state、plan、skills、task ownership 和 artifact namespace。
- Precompute 是 speculative artifact，应可被拒绝/丢弃，不能把它当作唯一历史真相；它必须通过 coverage/fit validation 才能替换当前上下文。
- Microcompact 要有 payload locator、durable output storage 和明确的 re-read contract；“tool_result 被清除”不能等价于“工具执行结果不存在”。

**裁决：无。** 本报告只记录源码证据与架构启示，不修改旧 Kernel，不开发，不批准任何架构。

## 9. Evidence index

| File | SHA-256 | Key anchors (0-based character offset) |
|---|---|---|
| chunk-smbjjyps.js | 1e28512664e9ef8818c84e5c4f6b19ee48c8f0c832e6673f29ad1a7f0872a46d | su/iu main loop + pre-request autocompact @137,000–147,000; post-query precompute arm @147,174/@182,560; prompt-too-long → Mho/pUn @191,223–192,915 |
| chunk-4b60tdnk.js | c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb | transcript reader see/GCt.finish @488,032/@484,997; compact relink hdo/ydo @418,403/@419,707; Agent chain RMt/bdo/Sdo @420,397/@423,822/@422,580; iee/KRt @504,071/@504,720; artifact carry fQ/N9t @1,782,147/@1,782,830; session.compact hook cfo @1,479,567; tool grouping Qdt/ZK @2,344,343/@2,344,076; summary XJ/Yir @2,363,235/@2,367,144; Nve/Eho/Gvr @2,371,130/@2,383,085/@2,385,219; preserved UUID fXe/wPe @2,491,305/@2,391,410; full tkr @2,492,295; Uve/Clr/Plr/Mlr @2,512,911/@2,514,492/@2,516,626/@2,517,145; threshold/rkr @1,484,360/@2,522,180; precompute BIt/skr/Mho @2,535,871/@2,539,966/@2,547,487; compact boundary n2 @5,021,993 |
| chunk-ypk19ctb.js | 0b8728db10fddd3f2a922ff1387c4f0118bdf5a62a1f07300e50d2bf3c586960 | parent-turn forwarding excludes compact summaries / transcript-only messages in zf @508,500 |
| chunk-q43h57v8.js | cdc33a0650592fab296e51dda091eb8c46b7d542e86f77c49a6963b0da85c2e0 | precompute coverage reuse validator r2r @49,712; agentKey mapping PLe @49,571 |
| chunk-k3djx6vq.js | 1b4dc9236bf90b77cd9d9d13aa82f67c6a792920e9253d92ef402a2f6dd615fe | Agent W7 @149,927; stream row transcript + wPe @108,928; compact boundary wire metadata mapping @38,000 |
| chunk-xqhs6qqf.js | 2a164dbfa5570beb2e0c7af0b386ed519d0c74a51e98fe2d896819cb82ad60cf | Agent resume Gn @10,327 |
| chunk-xnwgde04.js | 5c144ee781413113ed1e967e1381eaab1f5e0f10124508c656668b3b3c40392c | local microcompact WMo/Ajs @140,217/@141,192; server edit planner xjs @142,340; idle analyzer pr @143,198; applied edit tracker Pjs @145,362 |
| chunk-wa7fj3rd.js | a8d940ce256e6ada34a7d6232c91b627a99b046350fba12b73f1c433a4f89722 | ContextHintController implementation G @17,082（module export @18,024） |
| chunk-8ztr1bzj.js | c1a706e2524cb80b508f811d528454c70d462b1655dd0124de4d3d7ca96ee4a9 | transcript UI uses Cbo to include transcript-only messages only in transcript view @176,945 |
| chunk-jf276d7h.js | 8804cf5160765e2d9ea07b4c7adc6b80d9b511116d8accbdb35104d02613b43d | Artifact feature gate MWe @20,585 |

