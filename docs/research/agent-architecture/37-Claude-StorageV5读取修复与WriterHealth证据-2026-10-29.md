# 37 · Claude CLI Storage V5 读取恢复与 WriterHealth：从可读性到执行恢复的证据边界

> 日期：2026-10-29；阶段：源码研究，不构成目标架构批准。
> 样本：Claude Code CLI 2.1.304、Desktop SDK wrapper 0.3.304（Desktop 3.1623.1）。
> 方法：直接读取已上传 source-only ZIP 中的发布版 JavaScript，定位符号与字节 SHA-256；无运行、无故障注入、无真实外部工具调用。

## 0. 摘要与本轮新增事实

本轮沿报告 34、36 的 `enqueueWrite → drainQueuesOnce → appendToFile → pue` 继续追踪 writerHealth 错误分类、Storage V5 reader 和 session message dedupe。主要发现：

1. 写入错误不是简单布尔失败。`qb` 记录失败序号、每文件连续失败次数、失败窗口与可恢复的 `degradedStore` 状态，并按来源、平台、错误码决定何时进入降级。
2. 同文件后续成功 append 调用 `nRt`，会清除对应文件的失败记录与降级状态；该路径**没有可见的丢失记录自动重建证明**。因此 writer health recovered 不能直接等同于历史完整。
3. V5 reader `see` 在读失败的特定类别会用 `PRt` / `readRecords` 分页读取；reader 支持 torn-tail 标记与无法解析 JSONL 行的跳过。它解决的是可访问性/解析容错的一部分，不是权威的执行结果恢复证明。
4. `sessionMessages` 在 `J0e` 加载失败时捕获异常、记录错误并继续返回已能获得的 UUID 集合；因此“UUID dedupe 索引成功生成”的完整性也依赖底层加载结果。
5. 当前 source-only JS 展示了 V5 backend 的 `append/read/readRecords/stat` 接口消费者和传入/使用路径，但未从已检查入口追到可证明 fsync/掉电保证的 backend 实现。不能据此肯定或否定底层 V5 的持久化能力。

## 1. WriterHealth 的具体状态机

关键源码：`01-cli-engine/cli-2.1.304/modules/chunk-4b60tdnk.js`。

### 1.1 状态结构

- `class s0e` @325882：`failuresByFile: Map`、`failureSeq`、`abandonedPaths`、`abandonedPrefixes`、`abandonedPendingPaths`、`latchingEnabled`、`liveServing`、`degradedStore=Ts(null)`。
- `qb(e, source, error, path, now)` @313835：记录一次写入失败并更新每文件连续失败窗口；若路径没有进入 abandoned 或其他排除状态且允许 latch，会判断是否将 `degradedStore` 从 null 转成 `{code,source,filePath}`。
- 只有来源集合 `mlo = new Set(['drain','materialize','adopt'])` 才允许通过此路径设置 degradedStore；`enqueue` 错误会被记录，但其本身不在这个 latch 来源集合内。
- 时间常量：`dlo=3`、`ulo=60000` 毫秒、`clo=300000` 毫秒。连续失败超过 5 分钟间隔会重置窗口；普通错误需满足至少 3 次且最初至当前失败相隔至少 60 秒才满足 sustained 分支。
- 特殊错误码集合：`ENOSPC`,`EROFS`,`EDQUOT`,`ENAMETOOLONG`，以及在非 Windows 分支的 `EACCES`,`EPERM`，可触发更直接的 degraded 条件；不能用“所有写入失败必立刻降级”概括。

### 1.2 恢复并不等于重建过去丢失的内容

- `nRt(e,path)` @314728 在一次 appendToFile 成功后清除该 path 的 `failuresByFile`；如果当前 degradedStore 的 filePath 与之相同，会清空降级并发送 writer-recovered telemetry。
- `drainQueuesOnce` @352373 对失败批次调用 `qb`、`forgetLinesThatNeverLanded`，并在特定错误类别设置 `storeFence`；对其余未 settle 的入队 Promise 仍调用 `resolve()`。
- `forgetLinesThatNeverLanded` @3499xx 在相关 replay source 存在时重新建立 replay 索引，并清理 `queuedToolResults`。这是缓存/索引重置，不等同于重新执行丢失的工具调用或自动补写所有未落盘的会话行。
- 由此可知，`degradedStore` 被恢复标记清空，只表示**新的一次写入完成并修复了当前失败状态**；没有证明缺失的历史条目被补齐或可完全重建。

### 1.3 非正常终止

- `Pni()` @343160 是 normal-exit drain 路径，尝试 exitDrains、project.flush、re-stamp；它在 finally 中检测 writer degradation 并明确警告 failure window 内 transcript entries 可能缺失。
- 程序被 SIGKILL、OS 崩溃或断电时，不能预设这些正常退出 hook 会运行。本文没有故障注入实验证据。

## 2. V5 读取、torn tail 与损坏 JSONL

### 2.1 `see` 的 V5 分支

`see(e, opts)` @488032 在启用 V5 且传入 backend/key 后，先执行 `backend.read([key])`。

- 如果读取成功，使用返回的 bytes/metadata 生成消息图；会用 `backend.stat(key).tornTailBytes` 或 records fallback 的 `tornTailBytes` 识别尾部破损。
- 如果读取失败，只有符合 `Fzt(error)` 或 `odo(error)` 的错误才会进入 `PRt` 记录分页读取路径；未成功 fallback 的错误一般会转换为“transcript unreadable via storage backend”异常。
- **特殊的权限拒绝**：`Failed + failureClass='permission'` 会返回 `servedBy:'inaccessible'` 的空结果，而不是保证历史数据完整。
- 这种读失败后分页回退不是任意异常都适用；`PRt` 也可能返回 failure、null 或抛出过大/游标异常。

### 2.2 `PRt` 分页恢复

`PRt(backend,key,maxSize?)` @393989：

- 先 `stat` 并检查 `NotFound`、大小限制；之后循环 `readRecords(key,{order:'forward',maxBytes:4194304,fromSeq})`，把 records 拼入 buffer。
- 根据 `nextSeq` 继续分页；若序号不前进，则抛出 cursor did not advance 错误，避免无限读取。
- 最终返回 `{bytes,mtimeMs,storedBytes,tornTailBytes}`，供 `see` 继续解码。

### 2.3 解析器的容错范围

- `BRt` @463529 先解析可解析的 JSONL 行；对于有内容但没有进入解析结果的行，`HCt` @463139 会记录 skipped unparsable lines telemetry，提示可能存在 torn 或 corrupt write。
- `see` 在 direct-file 分支用文件末尾是否有换行设置 `setTailTorn`，在 V5 分支使用 backend stat/tornTailBytes；但能识别损坏行或 torn tail 不等于能恢复丢失的内容。
- 会话最终由 `GCt(...).processEntry` 构建消息图。读取有效行的能力，不能从源码直接上升为执行状态无缺口、工具 outcome 已知或侧效应可安全重放的保证。

## 3. Session UUID dedupe 的容错特征

`F0e` session-store 结构中的 `sessionMessages = ro(async(sessionId,storageV5)=>...)` @约3400xx：通过 `J0e` 读取会话和消息键；当读取失败时捕获异常、记录 getSessionMessages loadSessionFile failed，仍以当前已获得的 UUID 加上 filelessResumeUuids 集合返回。

`qk` @387527 用这个 UUID set 判断哪些待写 message chain 条目已经存在，再调用 `insertMessageChain`。因此这条流程依赖读到的 UUID 集合的正确性；在 read 故障、文件缺失或截断时，**不能仅凭 `qk` 的去重逻辑就断定跨崩溃 Exactly-once 记录**。

目前没有动态构造损坏文件后执行 resume，因此上述是读写依赖关系的静态风险分析，而不是经过运行复现的错误。

## 4. V5 Backend 实现位置：已经确认与尚未找到的内容

- `pue` @391653 在 V5 路径通过 `r.stat(key)`、`r.append(key,Jlo(text),precondition)` 接口写入，直接文件 fallback 用 `appendFile` 或 `open/write/close`。
- `see`、`PRt` 和其他组件使用 `r.read`、`r.readRecords`、`r.listEntries` 等 V5 接口。
- 对当前解压的 2,705 文件 CLI source-only JS 作了全文件方法名检索：`readRecords(` 出现在 9 个 JS 文件、17 个调用位置，未检索到字面 `readRecords:` 或 `readRecords=` 的 JS 成员赋值形式。此为**限定语法形态的负面检索**，不能证明整个包不存在动态/原生 backend 实现。
- Desktop 3.1623.1 `index.chunk-J7YnW_mh.js` 同样存在 `storageV5` 依赖注入以及 `readRecords` 消费调用；未在本轮从依赖注入入口追到一个具有可验证物理持久化契约的 backend 实现。
- source-only 包按整理规则排除了部分原生模块、二进制和 desktop helper；其余 CLI JS 在此也只是静态发布物。因此 Storage V5 的具体持久化保证维持**未知**，不得写成“确定没有 fsync”或“确定具备 ACID”。

## 5. 证据索引

| 文件与版本 | SHA-256 | 关键锚点（UTF-8 解码后 0 基字符偏移） |
|---|---|---|
| CLI 2.1.304 `chunk-4b60tdnk.js` | `c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb` | `s0e` 325882; `qb` 313835; `nRt` 314728; `Pni` 343160; `drainQueuesOnce` 352373; `pue` 391653; `PRt` 393989; `BRt` 463529; `HCt` 463139; `see` 488032; `J0e` 491518 |
| Desktop 3.1623.1 `index.chunk-J7YnW_mh.js` | `80d308de49d2eacee72a561734b05e32209783de7772881036e5608cfd725a42` | `storageV5` 注入约 323443；`readRecords(` 消费约 382028、552399 |

## 6. 事实 / 推断 / 未知

**事实（静态源码）：** writerHealth 对不同错误类别和失败来源采用差别化降级；恢复信号与成功 append 有关；reader 支持部分 V5 read failure 的 record paging、torn tail 识别和 JSONL 畸形行跳过；session dedupe 依赖成功读出的 UUID 集合。

**推断（待验证）：** 这些设计提高了面对局部文件损坏/后端错误时继续操作的可能性，但无法独立保证持久化执行事实、跨故障一致性与工具结果完整。

**未知：** V5 backend 的实际实现与 fsync/原子性保证；正常/异常退出后 reader 与 write queue 是否能够重建所有已启动 ToolCall；WriterHealth degraded/clear 后历史缺口是否会显式暴露；Remote Host ledger 与 session replay 的端到端关联。

## 7. 下一步

1. 在当前资料中继续定位 V5 backend 的来源与可见方法实现；若实现仅在原生/Host 组件，则明确证据边界，不进行无依据猜测。
2. 追踪 `abandonAttempt → discardAndAbortInFlight → hosts.runToolUse` 与远端 call-state ledger 的共同 callId/取消/late-result 语义，确认模型尝试失败时副作用的实际状态。
3. 研究本地 Shell/MCP 工具的 abort 处理与远端路径差异；再进入 Subagent、上下文和 Desktop/SDK 生命周期研究。
4. 全部研究完成前不确定新 Agent 架构，也不修改生产/旧 Kernel。