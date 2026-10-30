# 46 · Claude Transcript / Remote Agent 联合恢复状态矩阵

> 日期：2026-10-30  
> 样本：Claude Code CLI 2.1.304（build 2026-10-19，git SHA 17ab70404e5b632fe060207effb0b440788363ba）。  
> 方法：重新读取上传资料包中的发布版 JS，追踪 transcript reader、compact-boundary relink、Storage V5 read fallback、Agent resume，以及 Remote Agent sidecar / event poller / archive restore。**静态源码研究**；没有运行 CLI、Storage V5 backend、Cloud Session 或故障注入。  
> 前置：[报告 43：上下文压缩与 Subagent 恢复连续性](./43-Claude-CLI上下文压缩与Subagent恢复连续性-2026-10-30.md)、[报告 44：Remote Agent 云端 Session 生命周期与恢复](./44-Claude-Remote-Agent云端Session生命周期与恢复-2026-10-30.md)、[报告 45：Storage V5 Backend 来源与 Sidecar 持久化保证](./45-Claude-StorageV5Backend来源与Sidecar持久化保证-2026-10-30.md)。

## 0. 摘要

本轮把三条此前分开研究的链放进同一恢复模型：

1. **Transcript reader**：Storage V5 / JSONL 读取、损坏行容错、compact boundary replay、parentUuid 图重建。
2. **Local Agent resume**：等待 append queue、读取 Agent transcript、选择活跃 leaf、重建消息链、修复 parallel tool_result，再创建新 Agent loop。
3. **Remote Agent restore**：读取 remote-agent metadata、查询 Cloud Session 状态、恢复 event polling、追加本地 output；其 cursor、metadata、notification runId 是三个独立状态。

核心结论：

- 多次 compaction 时，reader 以**最新 compact boundary**为准；若最新 boundary 是 Full compact，之前 Reactive boundary 的 preserved tail 不会继续成为当前活跃链。
- preserved UUID 缺失时，hdo 会在修改 Map / prune 前提前退出，避免破坏性清理；但后续 parentUuid 重建仍可能得到 partial chain。
- parentUuid 缺失或 cycle 的 fallback 不是严格 lineage reconstruction，而是同一 isSidechain 内寻找最多早 5 秒的记录；Sdo 没有显式比较 agentId，这是需要动态验证的条件性风险。
- Storage V5 的 read→readRecords fallback 只针对特定失败：ByteViewUnsupported 与 EFBIG。分页大小 4 MiB，fallback 读取上限 256 MiB；权限失败返回 inaccessible，其他失败会抛出 transcript unreadable。
- JSONL parser 会保留可解析行并跳过不可解析行；torn-tail 标记不会自动恢复丢失字节。5 MiB 以上还有独立 scanner fast path。
- Remote Agent 恢复时，metadata list/read 错误可导致空恢复集合；event cursor 只在 poller 内存中，output file append-only；archived restore 分支删除 metadata 并跳过 terminal event replay。
- 本报告没有复现数据丢失、重复输出或恢复错误。所有风险均标注为源码可见的条件性风险或未决 API 语义。

## 1. Transcript 读取与 Storage V5 fallback

### 1.1 读取状态机

核心函数：`see()`（`chunk-4b60tdnk.js` @488,032）。

| 起始状态 | 源码行为 | 对 Agent resume 的影响 |
|---|---|---|
| V5 `read` 成功且 key found | 直接使用返回 bytes；读取 stat.tornTailBytes 供尾部状态处理 | 继续解析 |
| V5 `read` 成功但 key absent | 返回 `servedBy: absent`；不会因 absent 再调用 readRecords | `KRt` 标记 absent；`iee` 可尝试 on-demand hydration |
| V5 read 返回 ByteViewUnsupported | `Fzt` 命中后调用 `PRt`，用 readRecords 分页重建 bytes | 分页成功则继续解析 |
| V5 read 返回 EFBIG | `odo` 命中后调用 `PRt`，但要求 stat.size 不超过 256 MiB | 超限或 fallback 失败则读取失败 |
| V5 read permission failure | 返回空结果并标记 `servedBy: inaccessible` | `KRt` 标记 inaccessible；`iee` 会尝试 hydration |
| 其他 V5 read failure | 转成 `transcript unreadable via storage backend` 并抛出 | `KRt` 标记 load_threw；`iee` 不走其 on-demand hydration 分支 |
| 无 V5 key / direct file | 走本地文件 reader | 同样进入 JSONL parser 与 compact-boundary normalization |

重要边界：`read` 成功返回 absent 与 `read` 失败是不同状态。前者是 key 不存在；后者才可能触发特定错误 fallback。

### 1.2 readRecords fallback 的实际限制

`PRt(backend,key,maxSize?)`（@393,989）：

- 先执行 `stat(key)`；NotFound 返回 null。
- `readRecords` 按 `order:"forward"`、`maxBytes:4 MiB` 分页。
- 第一页不传 fromSeq；后续页使用上次 `nextSeq`。
- 如果 nextSeq 不前进（小于或等于上次 cursor），抛出 cursor did not advance，避免死循环。
- 累积 bytes 超过 256 MiB，抛出 EFBIG。
- 成功后返回 bytes、mtimeMs、storedBytes、tornTailBytes。
- 对 EFBIG fallback，若 stat.size 已超过 256 MiB，则不继续分页，返回 undefined，最终保留原始读取失败。
- readRecords 首次返回 NotFound 时视为 absent；分页中途的其他错误返回 failure。

错误分类来自 `chunk-x2vmny5t.js`：
- `Fzt(e)`：`code === "Failed"` 且 telemetryCode 为 `ByteViewUnsupported`。
- `odo(e)`：`code === "Failed"` 且 telemetryCode 为 `EFBIG`。
- fallback 上限 `TRs = 268435456` bytes，即 256 MiB（`chunk-ns649tzz.js`）。

因此不能把 readRecords 描述为“所有 read 失败时的通用恢复”。权限拒绝、其他 backend failure、cursor 错误及超大文件均有不同结果。

### 1.3 JSONL 损坏行与 torn tail

`BRt()`（`chunk-4b60tdnk.js` @463,529）调用 `HSt()` 解析 JSONL，再比较非空行数量与成功解析行数量。差异通过 `HCt()` 记录为 skipped unparsable lines。

`HSt()`（`chunk-pg0h3gn9.js` @20,137）：
- 优先使用 Bun.JSONL.parseChunk；
- 否则按换行切分并逐行 JSON.parse；
- 对无法解析的行 catch 后跳过，不会凭空重建该行。

V5 分支从 backend.stat / paged result 取得 tornTailBytes；direct-file 分支以文件是否以 newline 结束判断 tailTorn。此标记用于 artifact comment monitor / auto-react ledger 的中断恢复状态；源码没有显示它能恢复缺失的 JSON 字节或一般消息行。

因此：
- 有效 JSONL 行可以继续进入消息 Map；
- 损坏行被跳过并产生 telemetry；
- 如果丢失行恰好包含 preserved UUID，后续 hdo 会进入 preserved UUID 缺失分支；
- torn-tail 检测不是 transcript repair，也不是执行结果完整性证明。

### 1.4 大 transcript 的另一条解析路径

`Sre = 5,242,880` bytes（5 MiB，`chunk-1z2sthpn.js` @18,715）。

在未启用 `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` 且 transcript 超过该阈值时：
- V5 路径走 `BCt()` byte scanner；
- direct-file 路径走 `Ido()`；
- 这与小 transcript 的完整 `BRt()` parse 不同，包含 compact-boundary / ledger / final-line 等专门扫描处理。

因此，5 MiB 以下与以上的 transcript 不应只用同一条小文件 fixture 验证。大文件 scanner、keepAllLeaves 与 disable-precompact-skip 分支都需要独立测试。

## 2. Compact boundary 与 parentUuid 图恢复

### 2.1 多次 Compaction：最新 boundary 决定活跃历史

`hdo()`（`chunk-4b60tdnk.js` @418,403）扫描 reader Map，分别记住：
- 最新 compact boundary 的位置；
- 最近一个带 preservedMessages / preservedSegment 的 compact boundary 及其 metadata。

只有“最近 preserved boundary”就是“最新 compact boundary”时，才执行 preserved-tail relink。由此可得：

| 边界序列 | reader 采用的活跃历史 |
|---|---|
| Full → Full | 没有任何 preserved metadata 时，hdo 不做 relink/prune；活跃链由最新 summary / leaf 决定，旧 rows 可能仍留在 Map / 文件 |
| Reactive → Reactive | 最新 Reactive boundary 指定的 preserved UUID 集合；更早的 pre-boundary rows 按该集合清理 |
| Reactive → Full | 旧 Reactive boundary 的 metadata 不是最新 boundary；不恢复旧 tail，hdo 会清理最新 Full boundary 之前的 rows |
| Full → Reactive | 最新 Reactive boundary 的 preserved tail |
| 多次 Reactive | 不累加所有历史 preserved tail；按最新 boundary 的集合重建 |

这里的“删除”是 reader Map 的 pruning，不等于原始 JSONL 文件被物理截断。原文件仍可保留旧记录。另一个边界是：如果整份 transcript 从未出现带 preserved metadata 的 boundary，hdo 会直接 return，不会主动 prune；Full compact 后的活跃链依赖 summary / leaf 的 parentUuid 结构，而不是 hdo 删除所有旧 rows。

### 2.2 Reader normalization 先于 compact relink

`GCt.finish()` 的顺序是先执行 `dRt.finish(Map)`，再执行 `hdo(Map)`。因此 compact relink 前还有一层 row normalization：

- `dRt.admit()` 对 system rows 执行 schema repair；compact_boundary 的 compactMetadata 也在这里做字段规范化。
- 对 user/assistant rows 检查 message/content 形状；无法使用的 row 会被 drop，部分 malformed content blocks 会被过滤，assistant string content 会被包装成 text block。
- 被 drop 的 row 会暂存 uuid → parentUuid；finish 时将其 children 的 parentUuid 沿被 drop 的链向上重挂到最近的 surviving ancestor。
- 如果被 drop 的 parent 链自身形成 cycle，repair 会将该链收敛到 null，而不是继续无限遍历。

这只修复**已经成功 JSON parse、但消息结构不符合预期**的 row。JSONL 行本身无法解析时，前面的 HSt/BRt 已经跳过，dRt 没有原 row 可修复。

### 2.3 preservedMessages 与 preservedSegment

`ydo()`（@419,707）有两种恢复来源：

1. 有 `preservedMessages` 时直接使用 anchorUuid + UUID list。
2. 否则从 `preservedSegment.tailUuid` 沿 parentUuid 反向走到 headUuid，再 reverse 成正序 UUID list。

如果 walk 遇到缺失节点或循环，记录 `tengu_relink_walk_broken` 并返回 undefined；hdo 在任何 prune 前退出。

### 2.4 preserved UUID 缺失：先保护，不做破坏性 prune

若 preserved UUID list 中任意 UUID 不存在：

- 记录 `tengu_relink_walk_broken`；
- 直接 return；
- 不重写 preserved rows 的 parentUuid；
- 不删除 compact boundary 之前的非 preserved rows。

这是一个明确的 fail-safe：不完整的保留集合不能触发破坏性历史清理。

但它不保证后续恢复链完整。KRt 仍会选择 Agent leaf，RMt 仍会尝试 parentUuid walk；如果缺失节点位于活跃链上，可能只得到 partial chain。

### 2.5 anchor UUID 缺失

hdo 对 preserved UUID 做完整性检查，但没有把 `anchorUuid` 不存在作为直接 abort 条件；源码只将 `anchorInTranscript` 记录到 relink-broken telemetry。

若 anchor 不存在，第一条 preserved row 仍可能被设置为 parentUuid=anchorUuid。后续 RMt 遇到 missing parent 时会调用 Sdo 的时间 fallback。

这属于需要测试的风险边界：不能仅凭 preserved UUID 全部存在，就断言 summary anchor 与 preserved tail 的连接有效。

### 2.6 ParentUuid 缺失 / cycle 的 fallback

`RMt()`（@420,397）沿 parentUuid 向上重建链。若 parent 缺失或已经访问过，调用 `Sdo()`（@422,580）。

Sdo 的源码条件：
- candidate 不在已访问集合；
- candidate 的 isSidechain 与当前 row 相同；
- candidate timestamp 早于当前 row；
- 时间差不超过 5,000 ms；
- 选择时间上最近的候选。

若找不到候选，RMt 返回部分链并记录 cycle 错误。该机制是时间启发式，不是 parent lineage 的权威证明。

值得注意：Sdo 没有显式比较 agentId。如果 transcript Map 同时包含多个 Agent 的 sidechain rows，理论上可能选到其他 Agent 的候选；KRt 最终又按目标 agentId 过滤，因此可能留下更短的恢复链。这是条件性风险，输入 Map 是否包含多个 Agent 候选需动态验证。

### 2.7 Parallel tool_result 修复

`bdo()`（@423,822）在 parentUuid chain 构建后尝试恢复并行工具结果关联：
- 以 assistant message ID 聚合 rows；
- 读取 tool_use ID 与 tool_result.tool_use_id；
- 可用 sourceToolAssistantUUID 寻找原 assistant；
- 关联时要求 isSidechain 和 agentId 一致；
- 再按原始时间 / assistant block 顺序插入恢复后的 tool_result。

这比单纯按时间排序更强，但仍依赖 tool_use_id、sourceToolAssistantUUID 和 transcript rows 未丢失。缺少关键 assistant/tool_result row 时不能推导 exactly-once 或完整工具历史。

## 3. Agent Resume 的端到端恢复行为

`iee()`（@504,071）等待 Agent transcript append queue flush（除非 alreadyWaited），再调用 `KRt()`（@504,720）。

KRt 的步骤：
1. 计算 Agent transcript path / StorageKey；
2. 调用 see 读取并完成 compact-boundary normalization；
3. 过滤出目标 agentId 且 isSidechain 的 rows；
4. 计算 parent UUID 集合并选取最新 leaf（排除 compact_boundary）；
5. 调用 RMt 重建 leaf chain；
6. 调用 bdo 修复 parallel tool_result；
7. 最后按 agentId 过滤，去除 isSidechain / parentUuid / promptId 等内部字段；
8. 拼接 fork-context hydration rows（如果存在）。

读取异常的影响：
- absent / inaccessible / 没有可用内容等状态可进入 iee 的 on-demand hydration 条件；
- V5 read 的其他错误在 KRt 中成为 load_threw；iee 的条件明确排除 load_threw，不会走同一 hydration 路径；
- hydration 成功后会重新读取一次 KRt；否则返回 null / unresumable。

这说明“transcript 能打开”与“Agent 能恢复”是不同门槛：还必须有可用的 Agent sidechain rows、可选 leaf 和可重建 parent chain。

## 4. Remote Agent 恢复状态矩阵

本节复核 `chunk-4b60tdnk.js` 的 `Ylo / kTs / O8o / q3t / vTs / K3t`，以及 `chunk-ypk19ctb.js` 的 `dTe / YO`。

### 4.1 Metadata 写入与发现

- `vTs()`（@334,076）在 V5 路径用 `backend.write(..., {publishDiscipline:"inPlace"})`；文件 fallback 直接 writeFile。
- `q3t()`（@1,714,424）捕获 persist error 并记录 warning，不向上抛出。
- `nUe()` 调用 q3t 后启动 K3t；metadata write 不是 remote task launch commit gate。
- V5 restore 的 `Ylo()`（@335,482）通过 listEntries 分页列出 sidecar，再用 readText 批量读取并 schema-parse。
- listEntries 未完成 / 出错，或 readText 出错，会返回空 restore 集合；单条无效 metadata 被跳过。

因此，恢复丢失不只可能来自 write failure，也可能来自 list/read failure 或单条 schema parse failure。空 restore 集合不证明远端 Cloud Session 已停止。

### 4.2 Event cursor、output append 与 runId

`K3t()`（@1,725,911）：
- 每次启动时 cursor 初始化为 null；
- cursor 只保存在该 poller closure 的内存变量；
- dTe 按 sort_order=asc 拉取 events，以 sequence_num 更新 cursor；
- dTe 每轮最多读取 50 页，若仍有 next_cursor，下一轮继续从最后 sequence_num 拉取；
- K3t 将事件序列化后通过 bXe 追加本地 task output file。

`dTe()`（`chunk-ypk19ctb.js` @677,947）在 cursor 为 null 时不传 cursor 参数。当前源码没有证明服务端无 cursor 时从头返回、从最新位置返回或采用其他默认语义。

恢复后的 K3t 会重新以 null cursor 启动，而 output file 继续 append。故：
- 若 API 重放旧事件，可能重复追加；
- 若 API 默认只返回新事件，则不会产生该类重复；
- 如果 API 省略了旧事件或超过服务端分页保留范围，也可能存在历史观察缺口。

这是服务端 cursor contract 未知导致的条件性风险，不是已复现 duplicate-output bug。

runId 用于 notification claim/dedupe，不等于 event cursor，也不记录 output byte offset。当前源码没有显示 event ID 与 output file append 之间存在持久化去重事务。

### 4.3 Archived restore 与 terminal result

两条路径必须区分：

- **运行中的 K3t poller 收到 session_status=archived**：普通 remote-agent 分支将 task 标记 completed、发送 notification、flush output writer、删除 metadata。
- **Session resume 时 O8o 查询到 archived**：直接删除 metadata 并 continue，不启动 K3t，不拉 terminal events，不补 completion notification。

第二条路径存在结果通知缺口的可能，但取决于服务端 archived 语义和之前是否已投递 terminal event；本轮无 API contract / 动态证据。

### 4.4 TaskStop 与 archive 未确认

RemoteAgentTask.kill：
1. 本地 task 标记 killed；
2. 发停止通知；
3. 异步调用 Cloud Session archive，不 await 结果；
4. 停止 poller / flush 本地 output；
5. 删除 remote-agent metadata。

因此 local killed 与 remote worker acknowledged stop 不是同一个状态。archive 失败或超时时，远端是否继续运行未知；但本地 reattach metadata 已被删除。该路径需要保留在故障矩阵中。

### 4.5 Permission relay

K3t 中的 pending permission relay、request_id 去重集合和 AbortController 都是 poller 内存状态。恢复时会创建新的 K3t closure，不会从 remote-agent metadata 重建 pending relay controller。

源码可见 relay 默认限制严格：只有本地 canUseTool 明确 allow 才回传；ask / deny、无 request_id、MCP/skill/workflow/plan 工具及 input mismatch 等不进入自动 relay。远端是否重发 pending control_request、如何处理 CLI 重启时悬挂请求，仍需服务端协议或动态验证。

## 5. 联合故障矩阵

| 故障 / 时序 | 源码可证行为 | 恢复结果 / 风险 | 证据等级 |
|---|---|---|---|
| 最新 Full boundary 前有多个 Reactive boundary | hdo 以最新 boundary 为准；最新 Full 无 preserved tail | 旧 Reactive tail 不进入当前活跃链 | 静态源码事实 |
| 最新 Reactive boundary 的 preserved UUID 缺失 | hdo 在 relink/prune 前 return | 不破坏性清理，但后续 chain 可能 partial | 静态源码事实 + 恢复风险 |
| preservedSegment 的 head/tail 缺失或 walk cycle | ydo 记录 broken 并返回 undefined；hdo 不 prune | 保留旧 Map，不能保证活跃 chain 完整 | 静态源码事实 |
| anchor UUID 缺失 | hdo 不以 anchor missing 单独 abort | RMt 可能走 5 秒时间 fallback | 静态源码事实 + 条件性风险 |
| parentUuid 缺失 / cycle | RMt 调 Sdo；无候选则返回 partial chain | 可能丢失祖先上下文；时间 fallback 不是 lineage proof | 静态源码事实 |
| JSONL 中间行损坏 | HSt 跳过无法解析行；HCt 记录数量 | 该 row 不会由 parser 自动恢复 | 静态源码事实 |
| JSONL 最后一行 torn | parser 保留其他有效行；tailTorn 影响 artifact ledger 等状态 | 缺失消息内容无法由 tornTailBytes 自动重建 | 静态源码事实 |
| V5 read ByteViewUnsupported | PRt 用 4 MiB readRecords 分页 | 受 256 MiB fallback cap 和 cursor 进展约束 | 静态源码事实 |
| V5 read permission failure | see 返回 inaccessible | Agent resume 尝试 hydration；最终结果取决于 hydration | 静态源码事实 |
| V5 read 其他错误 | see 抛 unreadable；KRt load_threw | iee 不走同一 hydration 路径 | 静态源码事实 |
| Transcript 大于 5 MiB | 进入 BCt / Ido fast scanner | 必须与完整 parser 分开测试 | 静态源码事实 |
| Remote Agent metadata write failure | q3t 吞掉异常，当前 task 仍可启动 poller | 进程重启后可能找不到该 remote task | 静态源码事实 + 条件性风险 |
| Remote metadata list/read failure | Ylo 返回空 restore 集合 | 暂时无法恢复 task；不代表远端已停止 | 静态源码事实 |
| Remote Agent crash 后 cursor 丢失 | 新 K3t 从 null cursor 启动，output append | 取决于 API 默认 cursor 语义，可能重复或缺失 | 静态源码事实 + API 未知 |
| Remote session archived 后 CLI crash | O8o archived 分支删 metadata 并跳过 | terminal notification 是否丢失取决于 archived contract | 静态源码事实 + API 未知 |
| TaskStop archive timeout/failure | 本地 killed、停止 poller、删 metadata，不等 archive ack | 远端可能继续，但本地失去恢复入口 | 静态源码事实 + 条件性风险 |

## 6. 需要的动态验证，不是本轮已完成的测试

### 6.1 Transcript fixture matrix

在可控测试 harness 中建立真实发布版 reader 的只读 fixture（不修改 CLI）：

1. Full → Full、Reactive → Reactive、Reactive → Full、Full → Reactive。
2. preservedMessages 缺一个 UUID、缺 anchor UUID、重复 UUID、空列表。
3. preservedSegment head/tail 缺失、parentUuid cycle、anchor 缺失。
4. 活跃 Agent chain 缺 parent、parent cycle、同一 sidechain 不同 agentId 的近邻记录。
5. tool_use / parallel tool_result 的 parentUuid、sourceToolAssistantUUID、tool_use_id 三种关联缺失组合。
6. 中间坏 JSONL 行、尾部半行、无 newline 但 JSON 完整、V5 tornTailBytes 与实际 bytes 不一致。
7. 小于 / 大于 5 MiB scanner threshold；keepAllLeaves 与 CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP 两种开关。
8. V5 read success/absent/permission/ByteViewUnsupported/EFBIG/other failure；readRecords cursor 不前进、分页中途失败、NotFound 和超过 256 MiB。

断言不只看 parser 是否返回消息，还要看：
- 活跃 leaf；
- parentUuid 连通性；
- 保留的 tool_use/tool_result 配对；
- AgentId / isSidechain 隔离；
- compact boundary 前的历史是否被错误重新接入；
- 是否产生 unresumable / partial chain；
- 是否有明确 telemetry / error 分类。

### 6.2 Remote Agent 故障注入

需要真实 Cloud Session API contract 或隔离测试服务：

1. metadata write 失败、listEntries/readText 暂时失败、metadata JSON 截断。
2. poller 每页事件追加前/后退出；sequence_num 已更新但 output 未追加，及 output 已追加但 cursor 未持久化的边界。
3. null cursor 的服务端行为、50 页分页、event retention / cursor expiry。
4. archived 状态与 terminal result 的先后关系；resume 前后 crash。
5. archive endpoint 200、409、5xx、timeout、connection reset；分别观察 remote worker 是否停止。
6. permission control_request 在 poller crash/restart 后是否重放，pending request 如何超时/撤销。
7. output append 是否有服务端 event ID 去重或其他 offset reconciliation。

没有 API contract / 测试服务时，这些全部维持未知；不能拿本地 mock 的结果冒充 Anthropic Cloud Session 行为。

## 7. 对目标架构的非决策性启示

1. Transcript recovery 应显式区分 parse success、tail damaged、line skipped、lineage partial、unresumable；不能把“读到 Map”当作恢复成功。
2. Compaction boundary 应有完整性校验：summary anchor、preserved UUID、coverage range、Agent lineage、tool call/result pairing。
3. 缺失 preserved row 时应保留旧数据并将 session 标记为 partial / needs repair，而不是静默地让启发式时间排序承担唯一恢复责任。
4. Parent lineage fallback 应优先使用 agentId + sidechain + operation identity；时间相邻只能是可见的低置信度 fallback。
5. RemoteOperation 的 cursor、output offset、notification idempotency key、metadata generation 必须分开持久化。
6. Remote metadata list/read 失败应表现为 restore_deferred / reconciliation_required，而不是把空列表解释为没有远端任务。
7. TaskStop / archive 未确认时应保留可重连记录，直到获得 acknowledgement 或显式进入 outcome_unknown。
8. Storage provider 应定义 read fallback、record sequence、torn-tail、atomic visibility 和 durability 的独立契约。

**裁决：无。** 本报告只建立源码级恢复矩阵和动态验证清单；不批准任何目标架构，不修改旧 Kernel，不开始开发。

## 8. Evidence index

样本均来自上传资料包 CLI 2.1.304 发布版 JS；offset 为 UTF-8 解码后的 0-based 字符偏移。

| File | SHA-256 | Anchors |
|---|---|---|
| `chunk-4b60tdnk.js` | `c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb` | PRt @393,989；odo @393,771；HCt/BRt @463,311/@463,529；see @488,032；hdo/ydo @418,403/@419,707；RMt/Sdo/bdo @420,397/@422,580/@423,822；dRt normalization @319,074；iee/KRt @504,071/@504,720；vTs/kTs/Ylo @334,076/@334,799/@335,482；q3t/O8o/K3t @1,714,424/@1,723,714/@1,725,911 |
| `chunk-pg0h3gn9.js` | `753a30fcbe2a1df15fef75991aeed367c5d7872dec655c5016af82aca51d2bca` | HSt / Bun.JSONL.parseChunk / line-by-line JSON.parse @20,137 |
| `chunk-ns649tzz.js` | `237bd2a46506c6abae41ec86d98c0c4153c8955e11a737044f771b3b1a44729c` | TRs=268435456 (256 MiB) @89,708 |
| `chunk-x2vmny5t.js` | `3667233d41141b18e369634dee1143022783b247ef99cdb90156bc17047cbc44` | Fzt ByteViewUnsupported @1,150 |
| `chunk-1z2sthpn.js` | `b7a24f3d93a85d9df6b339320cdd8e749b16b73f6661a240a943f46cf3132df8` | Sre=5,242,880 @18,715 |
| `chunk-ypk19ctb.js` | `0b8728db10fddd3f2a922ff1387c4f0118bdf5a62a1f07300e50d2bf3c586960` | dTe event pagination @677,947；YO archive @679,272 |
| `chunk-fh15xze1.js` | `1a02bbc16c59a32f482e031ad6451afc223c28c897cdb3afa47cf75139193570` | bXe append writer @6,338；output writer flush/cleanup Bp @6,600 附近 |
| `chunk-q43h57v8.js` | `cdc33a0650592fab296e51dda091eb8c46b7d542e86f77c49a6963b0da85c2e0` | precompute reuse coverage validator r2r @49,712 |
| `chunk-k3djx6vq.js` | `1b4dc9236bf90b77cd9d9d13aa82f67c6a792920e9253d92ef402a2f6dd615fe` | Agent W7 / live compact-boundary handling @108,928 |

**证据等级：** 本报告为发布版 JavaScript 静态源码事实与条件性风险推导；没有动态验证 transcript 恢复、Storage V5 provider、Cloud Session cursor、archive acknowledgement 或 remote worker 副作用。
