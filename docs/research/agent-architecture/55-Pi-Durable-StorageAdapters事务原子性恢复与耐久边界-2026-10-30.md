# 55：Pi Durable 1.4.0 Storage Adapters：事务原子性、恢复和持久性边界（2026-10-30）

> **阶段**：架构研究，仅针对上游发布源码和既有测试用例进行静态核验；没有编写/执行新测试，没有修改 Kernel 或业务代码。  
> **源码基线**：earendil-works/pi tag v1.4.0，release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。  
> **目标**：核验报告 53–54 遗留的 Storage.commit atomic batch、SQLite/JSONL/IndexedDB/Memory/Cloudflare 写入、故障与恢复语义，并区分“源码事实”“上游测试覆盖”“尚未验证”。  
> **前提**：pi-durable 定义 Storage / Session / Task；Chord 1.4.0 只提供 SQLite portable database facade、delta、Host/RPC 等原语，不是 Durable Store。参阅报告 53–54。

## 1. 核心结论

**原子性 ≠ 进程崩溃恢复 ≠ 断电持久性 ≠ 跨进程唯一写入权 ≠ 外部工具 exactly-once。**

| 后端 | 可证实的提交线性化点 | 主要依赖 / 风险 |
|---|---|---|
| MemoryStorage | prepareCommit 完成验证和克隆后，同步 apply 内存状态，推进 nextSeq | 进程退出全部丢失；不能证明跨线程/进程所有权 |
| SqliteStorage + NodeSqliteDatabase | 单个 SQLite BEGIN IMMEDIATE ... COMMIT，把数据、document revision 与 next_seq 更新放在同一事务 | 默认 PRAGMA journal_mode=WAL、synchronous=NORMAL；进程崩溃恢复与主机断电后最新提交保留是不同等级 |
| SqliteStorage + Cloudflare DO facade | DO ctx.storage.transaction callback settle；同一 storage object 的 adapter queue | 平台事务语义 / 对象生命周期依赖平台；绕过 facade 的直接 storage 调用不在 queue 内 |
| IndexedDbStorage | 一个覆盖 ALL_STORES 的 IDB readwrite transaction complete | 浏览器实际持久性策略、cross-tab ownership / Web Lock 不由 adapter 保证；测试使用 fake-indexeddb |
| JsonlStorage | Sidecar append（可选 flush）→ main.jsonl commit marker append → MemoryStorage prepared.apply → best-effort reclaim | 即使 fsync=true，普通 commit 返回前并不 flush main commit marker；完整主 marker 是否在断电后存在不能保证 |

以上保证只覆盖实现中可见的本地机制；**没有端到端验证外部工具效果与 Receipt 原子一致。**

## 2. Storage / Session 合同与责任边界

来源：packages/durable/src/types.ts、packages/durable/src/session/session.ts（报告 53 已追踪）。

- Storage.commit(writes) 接受一个 StorageWrite batch，承诺原子持久化并返回 Seq；成功返回后后续 read 可见该批写入。
- SessionImpl 用 Promise #tail 串行 commitWith / readOnLine，并在 Storage.commit 成功后 adopt document tracker、发布 CommitPublication。
- Storage 提交进行中不会因为提交请求的 AbortSignal 被取消，防止事务结果不明时的“取消即回滚”错觉；具体 adapter 仍可能失败。
- Storage commit / mintId error 会使 Session 进入 failed latch；不会在 Harness 内盲目 retry。
- Session line 是同一实例的序列化协议，不是分布式租约 / fencing token，也不是跨进程独占锁。

如果多个 Session / Process 同时操作同一 backend，不应仅凭 SQLite 的 SQL 事务或 IndexedDB 的 object-store lock 推断上层 TaskScheduler 有安全的单一执行所有权。

## 3. MemoryStorage：preflight / detach / apply

来源：packages/durable/src/storage/memory.ts，约 L263–430、L720–865。

- commit() 直接调用 prepareCommit(writes).apply()。
- prepareCommit() 对输入 clone、resolve document.copy、freeze detached writes，checkGlobalIds、prepareDocumentActions、checkDocumentActions；不会改变 observable state。
- apply() 单次调用后通过 applied flag 防重复；写入 conversations / entries / tasks / submissions / document revisions 的 Map / indexes，同时推进 nextSeq。
- 对 rewindable documents 保留 revision history；current-only 的新 base 取代旧 revisions；document.retire 移除 current-only revisions。
- mintId() 在内存中递增 nextId；commit() / close() 无磁盘保证。

**限制**：这是应用内存层的原子提交策略，不是进程故障耐久性或多进程 ID 分配器。MemoryStorage 还被 JsonlStorage 用作 preflight / recovery materialized state，而非独立可靠持久化 backend。

## 4. SQLite：单事务原子写入与 revision replay

### 4.1 SqliteStorage.commit

来源：packages/durable/src/storage/sqlite/storage.ts，L152–215。

commit() 先准备 document actions / candidateNextId，再调用 db.transaction：

1. 读取 durable_metadata.next_id、next_seq；
2. 计算 committedSeq；
3. 核验全局 ID 与 document action；
4. 应用 conversation / entry / task / submission table writes；
5. 应用 document.create / copy / change / retire 的 revision/base/delta writes；
6. **在同一事务**更新 durable_metadata.next_id、next_seq；
7. transaction settle 后返回 seq；本地 nextId=max(local,candidate)。

这保证同一个 SQLite 事务内普通记录与 seq 变化一起 commit 或 rollback。历史 entry 保留 commit_seq；document() 为避免 record 与 revisions 跨 commit 读到不一致快照，自己再用事务读 record + base + delta tail。

### 4.2 Base / Delta 与回收

来源：SqliteStorage.materializeDocument / applyDocumentActions（L620–955）、migrations.ts。

- 读取 at=current 或历史 Seq，查找不晚于目标 Seq 的最近 base，然后按 seq 顺序 replay delta；
- 缺少 required base 或跨 version boundary 没有 base 会抛错，不静默假装恢复；
- current-only document 写新 base 后可删除旧 revisions，retire 后删除 revisions；
- rewindable document 保留历史，不允许用 current-only reclaim 规则破坏 fork/asOf 回放；
- SQLite schema 建立 record_ids、conversations、entries、tasks、submissions、documents、document_revisions 和查询索引；迁移 v2 重建 tasks 表以加入 sleeping status；
- Chord applySqliteMigrations 在一个 database.transaction 内运行所有 pending migrations、更新 durable_schema 版本；新版本 metadata 超过支持版本时拒绝打开；
- 可选 prefix 预先校验 SQLite identifier，旧 migration history 不随意更名。

### 4.3 Chord NodeSqliteDatabase 的实际 driver

来源：packages/chord/src/sqlite/node.ts、database.ts。

- node:sqlite DatabaseSync；
- database access / transaction 经 SerialOperationQueue 排队；
- transaction：BEGIN IMMEDIATE，callback 使用 transaction handle，callback settle 后 handle 标记 invalid，COMMIT；异常时尝试 ROLLBACK；rollback 失败会 AggregateError；
- 事务内再次调用 database facade（而不是 transaction handle）会排在当前事务后，形成自等待：是明确文档约束；
- 默认 busy_timeout=5000ms，wal_autocheckpoint=1000 pages；
- open 执行 PRAGMA journal_mode=WAL、synchronous=NORMAL、wal_autocheckpoint；
- close 执行 PRAGMA wal_checkpoint(TRUNCATE)，随后 DatabaseSync.close；
- prepared statements 按 SQL text 缓存在连接上，close 时清空。

**耐久性边界**：synchronous=NORMAL 在 WAL 模式的 SQLite 提供事务一致性与进程崩溃后的恢复条件，但主机故障/断电可能丢失最近的 committed WAL frames；不得将 await commit resolve 写成“断电后必然存在”。没有运行 power-loss / kill -9 注入。

### 4.4 mintId 与多 owner

SqliteStorage.mintId 从实例本地 nextId 分配数字；直到 commit 中才用 metadata next_id 追进最大 ID。两个独立 SqliteStorage/Session 同时打开同一文件，可能拿到相同候选 ID；SQL PK / record_ids 可将冲突变为失败，但并不提供跨 owner 唯一调度权或自动重试。还可能发生未提交的 mint ID 在 reopen 后重新分配。

**这是从读取实现得到的风险推断，不是已执行的多进程并发复现。** SQLite transaction 保护的是一个 commit batch，不是上层跨进程 Task lease。

### 4.5 现有上游测试覆盖（测试源码，未在本轮运行）

packages/durable/test/sqlite-storage.test.ts：

- reopen 后恢复 records、seq、已使用的 global ID；
- 不合法 prefix/损坏 metadata 拒绝；
- required base 缺失 / corrupt delta 拒绝；
- 故意制造 circular JSON 导致事务中后段失败，验证 SQL rows 与 seq 一起回滚；
- rewindable history 的 ancient/recent point replay；
- 用 EXPLAIN QUERY PLAN 断言索引使用；
- current-only base / retire revision reclaim；
- 自动 WAL checkpoint / close truncate；page reuse 与代表性规模验证。

这些是源码中存在的测试，不是本轮测试结果，也不证明突然断电及跨进程调度安全。

## 5. JSONL：sidecar + commit marker 双阶段 publication

### 5.1 文件布局与写入协议

来源：packages/durable/src/storage/jsonl/storage.ts，L1–95、L250–535。

- main.jsonl 保存有 Seq 的 commit markers、简单 records 和 sidecar 引用；
- doc-{id}.jsonl 保存文档 base/delta；task-{id}.jsonl 保存 non-terminal task state；terminal task record 写回 main marker；
- 每个 sidecar record 带 seq、ordinal；同一 commit 多次写同一 task 由 ordinal 定序；
- fsync option 默认 false；若为 true，先 flush 每个受影响 sidecar，再 append main marker；
- 只有 main marker 写入成功后才执行内存 prepared.apply()，此后以 best-effort 方式回收旧 sidecar。

具体顺序：
1. 在 MemoryStorage prepareCommit 全量验证 / clone writes，构造全部 JSON 字符串；
2. 顺序 append 所有 affected sidecars；
3. fsync=true 时逐个调用 fs.flushFile(sidecar)，NodeExecutionEnv.flushFile 通过 file.sync() 实现；
4. append main.jsonl commit marker；
5. apply memory state、采纳 sidecar visibility；
6. 对 current-only base、retired documents、terminal task 做 best-effort reclaim。

Sidecar append / flush / main append 如果返回错误，该 JsonlStorage 实例 poison，直到关闭/重开；若 main marker 已真正写入而 append 报错，结果可能未知，必须 reopen/reconcile。

### 5.2 重要发现：fsync=true **不表示每个 commit 已 flush main marker**

源码普通 commit path 是：

sidecar.flush（可选）→ main.append → memory.apply → reclaimSidecars。

只有发生 sidecar reclamation 时，reclaimSidecars 才尝试 fs.flushFile(mainPath)，目的是确认主 marker 可安全授权后续 sidecar 删除/替换；如果无回收动作，这一步根本不会发生。

因此：
- 普通 entry-only commit 即使 fsync=true，也只有 main.append，没有 main.flush；
- sidecar commit 即使 fsync=true，也只同步 sidecar，主 marker 未必同步；
- 即使触发 reclaim，也要确认 main flush 成功才进入回收；flush 失败只跳过 best-effort 回收，不把已经发布的 commit 回滚；
- NodeExecutionEnv.flushFile file.sync() 同步已打开文件，但新建文件/rename 后目录项的断电持久性、跨平台文件系统保证本轮未验证；代码没有独立父目录 fsync 协议。

**结论：不能向上层承诺 JSONL fsync=true 提供每次 successful commit 的 power-fail durability。** 这是源码结论；并非断言该实现一定会丢数据，是否真正丢失依赖 OS/filesystem/power failure 的具体时序。

### 5.3 重开恢复与损坏检测

来源：jsonl/storage.ts L535–847。

- readLines 只接受完整以 LF 结尾的记录；最后 torn tail 在字节级截断至最后一个换行，UTF-8 fatal 解码完整行；
- main markers 的 seq 必须严格递增；完整非法 JSON、非法 write 格式拒绝；
- 扫描全部 sidecars，对每条 record 按 (file,seq,ordinal) 建索引，要求 sidecar 顺序递增；
- 只有被 main marker 引用的 sidecar 才是 confirmed；未确认 sidecar 尾部截断；
- 缺失的 confirmed sidecar 通常 fail-open；current-only 已退休/已被新 base 覆盖的旧记录、terminal task 旧 sidecar 允许已被回收；
- 若 unconfirmed sidecar 后又出现 confirmed record，拒绝恢复而非静默跳过；
- 依次将 main-confirmed writes 用 MemoryStorage.prepareCommit(writes, seq).apply 重建内存状态；
- 对已退休、被新 base 覆盖或 terminal tasks 的文件执行 best-effort reclamation。

该协议的线性化 marker 是一个文件记录的可恢复存在性，不是每次 commit 已完成设备 flush 的证明。

### 5.4 上游测试证据（未在本轮运行）

packages/durable/test/jsonl-storage.test.ts 约 L318–1157：

- sidecar 先于 marker 发布、reclaim 后置；
- 同 commit 多条 sidecar record 的 ordinal；
- append before/after/short 失败及 poison/reopen；
- flush 失败时不写 marker；
- fsync false/true 对 append/flush 调用顺序的精确断言；
- reclaim write/rename/remove 失败恢复；
- torn UTF-8 和 complete-but-unconfirmed tail 截断；
- confirmed sidecar 缺失 / non-increasing Seq / malformed complete line fail-open；
- rewindable history 不回收。

尤其是 “orders publication flushes exactly ...” 测试明确断言普通 main-only 写入只触发 append:main.jsonl，即使配置 fsync=true；这进一步支持 5.2 的源代码结论。

### 5.5 额外风险

- JsonlStorage 持有一份完整 MemoryStorage；open/recover 必须遍历 main 与 sidecars，历史增长对启动时间/内存有成本；
- 没有跨进程 lock 或可靠的 inter-process writer coordination；两个 writer 会破坏单调 Seq / marker / sidecar 协议；
- reclaim 是独立于 publication 的维护步骤，可以失败后下次补回；不要把“回收成功”当成事务成功条件；
- 若 sidecar 写入成功、主 marker 未写成，则该 sidecar 是 unconfirmed；它应被移除，不应被误当 task outcome。

## 6. IndexedDB：单事务跨 stores 与浏览器所有权

来源：packages/durable/src/storage/indexeddb.ts，约 L1–180、L378–455、L774–817。

- DATABASE_VERSION=1；Schema 包含 meta、recordIds、conversations、entries、tasks、submissions、documents、documentRevisions；
- commit 在 database.transaction(ALL_STORES, "readwrite") 中读取 nextSeq、check global IDs、apply all writes、update metadata.nextSeq/nextId；
- 返回 Promise 等待 IDBTransaction.complete，不仅等待最后一条 request success；
- 异常时尝试 transaction.abort，再等待 done settle；
- mintId 单独使用 meta store readwrite transaction 更新 nextId，和 SQLite 实例本地计数器的语义不同；
- record / revision 联合读取使用同一 readonly transaction，保证 snapshot 对齐；
- close 等待 adapter 自己 admitted operations，然后 database.close；
- 没有内置 navigator.locks、跨 tab lease、leader election、versionchange 交接或掉线恢复协议。

上游测试 packages/durable/test/indexeddb-storage.test.ts 使用 fake-indexeddb，覆盖 minted ID reopen、后段 document copy 失败导致整 batch rollback、fork entry/head、40 组混合写入同一 readwrite transaction。未证明真实浏览器清理策略、quota、跨窗口单 owner、tab freeze、power failure 后持久性。

## 7. Cloudflare Durable Object SQLite：共享 queue 与平台语义

来源：packages/chord/src/sqlite/cloudflare.ts、packages/durable/src/storage/sqlite/cloudflare.ts。

- openDurableObjectSqliteStorage(storage, options) 只把 DO ctx.storage 包装为 DurableObjectSqliteDatabase，再复用 SqliteStorage；
- 同一个 DO storage 对象的包装器通过 WeakMap 共享 SerialQueue；
- transaction 在 queue.hold 里调用 ctx.storage.transaction(async () => callback(transactionHandle))；
- 事务 handle settle 后 invalid，避免在 callback 生命周期之外继续执行 SQL；
- DO SQL API 不接受任意精度 bigint，adapter 在 safe integer 范围外抛 RangeError；BLOB 在绑定/读取时转换 ArrayBuffer 与 Uint8Array；
- adapter.close() 只等待 queue，不关闭 DO 平台持有的 storage；
- 通过原始 ctx.storage.sql 绕过 facade 的调用不受同一 JS queue 保护。

该实现依赖平台事务接口做原子提交；**本轮没有实际部署 DO，也没有模拟平台驱逐/重启/多请求并发**，不能从 TypeScript wrapper 推出所有 Cloudflare 运行时保证。

## 8. 跨后端对比：请求结果与未知提交

| 场景 | SQLite | JSONL | IndexedDB | Memory | DO SQLite |
|---|---|---|---|---|---|
| Batch 内原子性 | SQL transaction | marker-confirmed replay 协议 | IDB transaction | prevalidate + sync apply | DO platform transaction |
| Sequence | 同 SQL transaction 更新 next_seq | main marker Seq，reopen 按顺序重放 | meta 同 readwrite transaction 更新 | in-memory nextSeq | 同 portable SqliteStorage |
| 提交失败后实例 | 错误交给 Session failure latch | Poison until reopen | 错误交给 Session failure latch | 错误交给调用方/Session | 错误交给 Session failure latch |
| 故障恢复入口 | WAL / SQL rows reopen | scan markers + confirm sidecars + truncate tail | reopen IDB | 无 | DO platform storage reopen |
| 开箱单写者保证 | 无跨进程 Task lease | 无跨进程 writer lock | 无 Web Lock / leader | 同实例内存 | DO 对象模型/平台 |
| Device power-fail 保证 | NORMAL 不保证最新 WAL commit | main marker 未逐 commit flush | 浏览器依赖 | 无 | 平台依赖，未验证 |
| 外部工具 exactly-once | 不提供 | 不提供 | 不提供 | 不提供 | 不提供 |

“提交返回错误”与“写入一定未生效”不能画等号：JSONL main append 的 after-error 明确存在 marker 实际已写入的测试分支；数据库事务 / network-facing wrapper 的中断也需要按 backend 合同处理不确定结局。上层 Session fail latch 是安全的 fail-closed 起点，但恢复流程仍必须重新读取 durable state，不允许未经核验重复产生外部副作用。

## 9. 对目标 Agent 的工程启示（非最终架构决定）

1. 将 **atomic commit、process-crash recoverability、power-loss durability、single-writer ownership、external effect outcome** 分成不同验收维度，不能使用“durable”一个形容词覆盖全部。
2. Tool Intent checkpoint 与 side effect 不在同一原子事务：需要操作 ID、幂等/去重协议、Receipt 与 OutcomeUnknown 结算；工具声明 replay=safe 只是输入，不保证实际安全。
3. Session / TaskScheduler 要有明确的 owner / epoch / fencing；存储事务不能替代执行所有权。
4. 选择 SQLite 时按预期故障模型确定 PRAGMA synchronous 与 WAL checkpoint 策略；不能照搬默认 NORMAL 却承诺强断电不丢数据。
5. 选择 JSONL 时若需求包括每条 Intent/Receipt 的 power-fail durability，需要重新审视主 marker 的 sync、文件创建/rename 目录项 flush、写入后读验证、磁盘满/部分写入故障以及跨进程 writer ownership。
6. IndexedDB 适合浏览器本地持久化，但需要单 owner 或明确并发协议、quota/eviction handling、schema upgrade/versionchange 与 tab lifecycle。
7. 严格把 commit-derived UI events 与实际 Storage commit sequence 区分；UI 接收事件不代表设备 flush，系统恢复应以存储重放为准。
8. 测试矩阵必须包含 operation boundary 的注入：preflight→I/O→marker/COMMIT→ack→reopen→effect→receipt，并验证结果只能在可辨识状态内收敛，无法辨识必须标记 unknown 而非假成功或重试。

## 10. 事实、推断、未知

### 已由源码直接证实

- SqliteStorage 使用 portable SqliteDatabase.transaction 包裹整批记录、文档 revision 与 metadata.next_seq。
- Node SQLite 使用 BEGIN IMMEDIATE / COMMIT / ROLLBACK，默认 WAL + synchronous NORMAL。
- JSONL 先写 sidecars 后写 main marker；fsync 仅预先同步 sidecars，主 marker 只在 reclaim 时有 flush。
- JSONL recovery 以 main marker 引用确认 sidecar，截断 torn/unconfirmed tail，缺失 required confirmed data 时拒绝恢复。
- IndexedDB commit 使用一个 ALL_STORES readwrite transaction，等待 transaction complete；mintId 使用持久 meta 更新。
- Cloudflare facade 使用 DO storage.transaction，按 storage object 共享队列；直接调用原始 storage 不进入该队列。
- MemoryStorage 使用 prepareCommit / apply 并在内存推进 seq，退出后没有恢复渠道。

### 上游测试已有覆盖、但本轮未实际执行

- SQLite：transaction rollback / seq, reopen, historical revision, WAL checkpoint, query plans。
- JSONL：sidecar / marker order, append/flush/reclaim 故障, poisoned recovery, torn UTF-8, corrupt confirmed state。
- IndexedDB：fake-indexeddb multi-store atomic rollback, reopen minted ID, fork ancestry, mixed writes。

### 未证实的结论，不得声称

- SQLite/JSONL/IndexedDB/DO 在真实断电或 OS crash 后的 commit 保留百分比与精确边界。
- 多进程或多窗口同时运行 Harness 时的单 owner / fencing / replay 收敛。
- 真实外部工具 side effect 的 exactly-once、权限失效即时终止、跨进程 outcome reconciliation。
- SQLite BEGIN/COMMIT 失败边界与 rollback failure 在生产操作系统上的不确定结果。
- IndexedDB 真实浏览器 persistence/eviction/quota 与 Web Lock / tab freeze 配合。
- Cloudflare DO 平台的并发和存储保障。
- 直接测试 npm tarball dist 与 release source 字节级构建一致性。

## 11. 下一步研究

1. 继续追 Chord Node HostManager / processLock / forkDriver：多进程拥有者、IPC/root/ref lease、child crash 与重连。
2. 深入 pi-durable CompactionTask + context range / stale summary、prefix/section context ownership。
3. 追 pi-coding-agent 组合层：实际使用 Core 还是 Durable，以及 MCP、extension、permission、TUI、Session/RPC 的落点。
4. 在不修改任何业务代码的隔离研究环境中，**研究验证计划**（尚未执行）：SQLite fault/kill-9/power model、JSONL marker/fsync/reopen、IndexedDB real browser、TaskScheduler crash/recovery、Host side effect unknown。动态实验也要遵守用户阶段门禁，不在研究 PR 放开发代码。
5. Pi 完整性闭环后，按 Claude CLI / Desktop / SDK / Pi 同场景横向比较；最终独立提出目标架构，提交用户审阅；批准前不得开发。

## 12. 本轮修改边界

只新增本研究报告并更新 PR #49 的 PROGRESS.md、README、研究评论。未修改 Kernel、业务代码、依赖、测试实现、运行时或开发 PR。

## 13. 固定证据索引

| 上游源码 / 测试 | Git blob SHA | 关键位置 |
|---|---|---|
| packages/durable/src/storage/memory.ts | 7f379cc29d8f2c7ad108eba47f3162e1676a2242 | prepareCommit L263–303 / apply / revision lifecycle |
| packages/durable/src/storage/jsonl/storage.ts | 4b03fd5beff465841ec3dc069d32fd90241604eb | commit L278–310 / reclaim L508–535 / recover L535–847 |
| packages/durable/src/storage/indexeddb.ts | 6b21214447b10b14ab210412b83b56f398d8b403 | commit L420–442 / mintId / transaction L791–817 |
| packages/durable/src/storage/sqlite/storage.ts | 7dc5903828740fe278fdc692ef9f40dbf68982c7 | commit L187–215 / document L549–555 / revision L620–955 |
| packages/durable/src/storage/sqlite/schema.ts | b807ba52910cb370426dc21d7dc40c9b2495e85e | fixed schema names, safe prefix |
| packages/durable/src/storage/sqlite/migrations.ts | a5ee244ae9e206d8b9a2e911dee5ca0749036d9c | v1/v2 schema, sleeping, indexes |
| packages/chord/src/sqlite/database.ts | fc5a814c6141a18e519c4a461377c4068eb044ac | portable SQL transaction contract |
| packages/chord/src/sqlite/node.ts | b156477e8749c5b0315f0444396e82b8ee79a5bf | BEGIN IMMEDIATE, WAL/NORMAL, queue, close |
| packages/chord/src/sqlite/cloudflare.ts | 897a660b7c3caf1f39f38e30822835f6459c3d25 | DO queue, transaction, bigint bounds |
| packages/chord/src/sqlite/migrations.ts | d4dc7efe88c2142af3ff281bebf56df72c87e1fb | atomic schema migration |
| packages/durable/src/storage/sqlite/node.ts | 210478ae58d23e3b97acb48029295b325332a7cd | wrapper open / validated prefix |
| packages/durable/src/storage/sqlite/cloudflare.ts | 3bce64417c1685a6f66e218cdce417394809a60c | wrapper open / shared storage queue |
| packages/durable/src/env/node.ts | fe93ce4edd44b83b7d2ce331e4c9e3bff4425609 | flushFile file.sync L1068–1085 |
| packages/durable/test/jsonl-storage.test.ts | cebfb0a69ec892669e3a03cdecbac489d5873a35 | append/flush/recover/reclaim faults |
| packages/durable/test/sqlite-storage.test.ts | c3db82ab2ad851feb6a4fbc3adfba16b8ced2ccd | rollback/reopen/history/WAL/indexes |
| packages/durable/test/indexeddb-storage.test.ts | 40109deaf21664482a7856e1e77475e1e4381ffa | fake-indexeddb atomicity / reopen |

**证据等级**：固定 v1.4.0 上游源码和已有测试文件的静态分析；没有新动态运行，也没有真实 power-failure / process-crash / multi-owner / external effect 测试。