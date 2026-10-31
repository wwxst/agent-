# 45 · Claude Storage V5 Backend 来源、发布策略与 Sidecar 持久化保证

> 日期：2026-10-30  
> 样本：Claude Code CLI 2.1.304（build 2026-10-19，git SHA 17ab70404e5b632fe060207effb0b440788363ba）；Claude Desktop 3.1623.1。  
> 方法：复核 CLI 启动/初始化、Storage V5 keyspace、transcript/journal/Agent/MCP/precompute sidecar consumers、Desktop SDK logger 与随包 native binaries。**静态源码研究**；没有取得可运行的 Storage V5 backend，没有运行 backend、断电模拟、进程崩溃注入或并发压力测试。  
> 前置：[报告 37：Storage V5 读取恢复与 WriterHealth](./37-Claude-StorageV5读取修复与WriterHealth证据-2026-10-29.md)、[报告 43：上下文压缩与 Subagent 恢复连续性](./43-Claude-CLI上下文压缩与Subagent恢复连续性-2026-10-30.md)、[报告 44：Remote Agent 云端 Session 生命周期与恢复](./44-Claude-Remote-Agent云端Session生命周期与恢复-2026-10-30.md)。

## 0. 结论摘要

本轮进一步追踪后，Storage V5 的真实 backend provenance 仍无法从 CLI/Desktop 发布包闭合，但现在可以把边界说得更准确：

1. CLI 2.1.304 提供 Storage V5 的**注入/接纳 seam**：外部可以向 main/init 提供 storageV5EnvPin，随后内部模块通过 withStorageV5 取得 backend。
2. CLI entry 的默认 pin factory 是 hFr；当前发布版 hFr 不返回 backend。标准 CLI entry 调用 pinStorageV5FromEnv 时没有传入其他 factory。因此，不能声称 CLI entry 自己构造了 Storage V5 backend。
3. adoptStorageV5EnvPin 会校验 configHome；backend 若是在另一个 CLAUDE_CONFIG_DIR 下创建，CLI 不会继续使用它。
4. Desktop 3.1623.1 的 JS 代码只看到 SDK logger 对可选 init.storageV5 的消费，没有找到 Desktop 主进程创建或传入 concrete backend 的路径。随包 native addon / cowork service 的有限字符串扫描也没有发现 Storage V5 特定 API 名称；这只是弱负面证据，不等于完整反汇编。
5. 消费者确实区分 publishDiscipline=atomic 与 inPlace，但调用者侧没有 Storage V5 backend 的实现或完整契约。调用 atomic 不能单独证明 provider 的 fsync、目录同步、事务提交或断电恢复保证。
6. Sidecar 写入策略并不统一：Agent metadata 和 precompact sidecar 没有指定 publishDiscipline；Remote Agent metadata 与 MCP metadata 使用 inPlace；MCP outcome 使用 atomic。各自的本地 fallback 也不同。
7. 本地文件 helper 的 atomicWrite 会尝试 temp-file + rename，但只有显式 flush:true 才调用 FileHandle.sync；其 On wrapper 没有传 flush。transcript compaction 的另一条专用本地路径则明确 sync 临时文件后再 rename，但没有发现父目录 fsync。
8. 当前可以证明 API consumer 有写入成功/失败、版本 precondition、torn-tail 检查和 publish-phase 错误处理；**不能证明 Storage V5 backend 在何种崩溃模型下承诺 durable commit**。

因此，本轮不再使用“Storage V5 已经持久化”这种笼统说法。准确表述是：CLI 有一个 host-injected logical storage capability，并按不同数据类型请求不同写入发布策略；provider 的物理提交和 crash guarantee 仍未知。

## 1. Storage V5 backend 的来源与注入链

### 1.1 CLI entry 的默认路径没有创建 concrete backend

CLI 2.1.304 的 entry module：

- 读取 process.env.CLAUDE_CODE_HOVER_REST；
- 只有该环境值为 truthy 且不是 preload/background-spare 路径时，才动态导入 pinStorageV5FromEnv；
- 随后把返回值作为参数传给 main。

入口路径为：

cli → pinStorageV5FromEnv() → main(storageV5EnvPin)。

但 pinStorageV5FromEnv 在 chunk-ats1064w.js 中只是导出 HNo。HNo 的默认 factory 是 hFr。chunk-zbam8cnm.js 中的 hFr 函数只检查 G()，没有返回 backend；其返回值为 undefined。

HNo 的行为是：
- 读取 CLAUDE_CODE_HOVER_REST；
- 要求 gFr 判断该值已被 pin；
- 返回 {backend: G() ? factory() : undefined, configHome: Dp()}。

所以默认 entry 路径即使产生 env pin，也不等于得到 backend。当前 bundle 没有在 hFr 中创建 SQLite、文件数据库、HTTP client 或其他具体存储实例。

这里保留一个边界：HNo 接受自定义 factory 参数，main 也接受 storageV5EnvPin 参数。外部 host 若通过非标准的 in-process 调用提供 factory/backend，理论上可以走这条 seam；但本轮没有找到该外部 provider 的实现。

### 1.2 init 只接纳已经存在且 configHome 匹配的 backend

chunk-9r3j64pk.js 的 init V(e)：

1. 读取 e.storageV5EnvPin；
2. 若 pin 中已有 backend，但 qre(configHome) 检查失败，则把 backend 清空并记录警告；
3. 若没有 pin，才调用 HNo()；
4. 只有 G() 且 backend !== undefined 时，才执行 tNr(backend)、O_t(backend)、GDo(backend, ...) 等 backend 初始化/预热路径；
5. 之后通过 dq(i) 接纳 backend；dq 最终调用 adoptStorageV5EnvPin；
6. 将结果作为 storageV5 传入后续配置、凭证、日志与功能初始化。

adoptStorageV5EnvPin（chunk-zbam8cnm.js 中的 $No）再次检查 configHome。若当前 CLAUDE_CONFIG_DIR 与 backend 创建时的 configHome 不一致，就不返回 backend，日志明确表示该进程继续使用 direct file access。

这是一个重要的安全/隔离约束：Storage V5 backend 的配置目录归属不能在启动后随意改变。

### 1.3 main 将 backend 作为 capability 传递，而不是在 Agent Loop 中创建

chunk-9b0nx8jt.js 的 main Ru(n) 把 n 传入 Ji；Ji 调用 X5o({storageV5EnvPin:n})；chunk-m2k93t9z.js 的 X5o 在 preAction 中调用 tJr，传入 storageV5EnvPin。

X5o 随后构造 withStorageV5 wrapper。它将已初始化的 storageV5 绑定到 command handler，使内部命令可以取得 backend，而不是让每个工具自己创建存储连接。

由此可以确认：
- backend 的生命周期属于 CLI startup/host initialization；
- Agent/Session/Tool 子系统拿到的是一个已接纳的 capability；
- 这不是每个 Agent 单独创建一份 SQLite connection 的结构；
- 具体 backend 的创建者、进程边界和物理存储位置仍没有从当前发布包中查明。

### 1.4 Desktop 3.1623.1 没有显示 concrete provider

对整个 Desktop ASAR JS tree 检索 storageV5 / StorageV5：

- index.chunk-J7YnW_mh.js：出现于 SDK logger 的可选 storageV5 dependency；
- index.chunk-CBDjn27r.js：同一 logger 代码的另一份 bundle；
- file-index-worker/fileIndexWorker.js：worker 内的同类 logger 代码；
- 没有发现 Desktop main-process module 创建 backend、设置 storageV5EnvPin 或将 concrete backend 注入 CLI 的路径。

SDK logger 会把 init.storageV5 作为可选参数，并在 configHome 匹配时使用；这证明 SDK 支持接收它，不证明 Desktop 自己创建了它。

随原始上传包另外提取了：
- @ant/claude-native/claude-native-binding.node；
- cowork-svc.exe。

对这两个二进制做了有限 strings 检索，没有发现 StorageV5、publishDiscipline、readRecords 等特定接口名。该结果只能作为弱负面证据：native binary 可能包含不以这些字符串命名的实现，不能据此断言二进制绝对没有相关功能。

Desktop source-only split archive 与 SPLIT_MANIFEST 之间还存在 binary entries 缺失；本轮的有限 native strings 检查直接使用原始上传 ZIP 提取出的二进制，而不是把 split ZIP 的缺失误当成“原始资料没有文件”。

**结论：** 当前证据支持“Storage V5 是可由 host 注入的 capability”，不支持“Desktop Native Binding 实现了 Storage V5”，也不支持“CLI 默认 entry 自建 Storage V5 backend”。

## 2. Storage V5 的逻辑 keyspace 与 Host Files 边界

### 2.1 它不是单一 transcript 文件接口

chunk-r8xw8ewt.js 定义 je key builders。可见 namespace 包括：

- transcript：projectKey、sessionId、可选 agentId / agentRelPath；
- journal：transcript namespace 下的 journal key；
- sessionJournal；
- sidecar：projectKey、sessionId、relPath；
- task、memory、settings、globalConfig、pluginCache、marketplaceCache；
- history、identity、log、recording、sessionLog、mailbox、scratch、job 等。

因此，Storage V5 consumer 使用的是结构化逻辑 keyspace，不是简单地把任意磁盘路径直接传给一个 file API。

### 2.2 Host Files 是另一项能力

chunk-36jhgfkd.js 的 DDt 使用 e.hostFiles.realPath(...,{native:true}) 解析 workspace 路径；VC 将 hoverRestOn 与 realPath 包成 transcript-path helper。

sf / rIs 只允许满足特定目录布局和 segment 校验的 transcript 路径映射为 StorageKey。chunk-8ryf2d0d.js 的 KWt 则只把符合规则的 .meta.json 路径映射到 sidecar namespace。

由此至少能区分两层：
- backend：对逻辑 StorageKey 执行 read/write/append/replaceRecords/list 等；
- hostFiles：向 Host 请求真实 workspace path 等文件系统信息。

不能把 hostFiles.realPath 当成 Storage V5 的持久化实现；它只参与路径解析/归属。

## 3. 关键写入调用点与 publishDiscipline 矩阵

| 数据 | Storage V5 调用 | discipline / precondition | 本地 fallback |
|---|---|---|---|
| Transcript stream append | backend.append(key, records) | 未指定 publishDiscipline | createWriteStream，等待 finish |
| Transcript stream replace | backend.replaceRecords | inPlace | 本地 writer 重新写流 |
| Transcript compaction | backend.replaceRecords | atomic；ifUnchangedThrough version/seq；parent mustExist | 临时文件、校验、FileHandle.sync、rename |
| Transcript tombstone removal | backend.replaceRecords | inPlace；ifMatch version | 本地 JSONL 改写路径 |
| LocalFileJournal | backend.append | 未指定 discipline；stat 检查 tornTailBytes | appendFile；检测 torn tail 后补 newline/marker |
| Agent .meta.json | backend.write | 只传 mode，未指定 discipline | On：临时文件 + rename，可能 fallback inPlace；未请求 flush |
| Remote Agent .meta.json | backend.write | inPlace | fs/promises.writeFile，直接覆盖 |
| MCP task metadata | backend.write | inPlace | fs/promises.writeFile |
| MCP task outcome | backend.write | atomic | atomicWrite → On；未请求 flush |
| precompact.json | backend.write | 只传 mode，未指定 discipline | On：临时文件 + rename，可能 fallback inPlace；未请求 flush |

这个矩阵说明：sidecar 并不存在统一的“全部 atomic”策略。即使在 Storage V5 路径，不同 sidecar 的调用者也提出不同要求，或根本没有显式指定 publishDiscipline。

## 4. 各类 sidecar 的实际恢复含义

### 4.1 Agent metadata

chunk-4b60tdnk.js：

- GZt 读取 Agent .meta.json；Storage V5 路径通过 backend.read 读取对应 sidecar key；
- iCt 合并原 metadata 中必须保留的字段，再调用 backend.write；
- Storage V5 write options 只有 mode，没有 publishDiscipline；
- 本地 fallback 调用 On(path, serializedMetadata)，即通用原子写 helper。

这份 metadata 被 Agent resume 使用，因此它不是纯 UI cache。若 metadata 缺失或损坏，resume 的可恢复信息会受到影响。

### 4.2 Remote Agent metadata

vTs 将 remote-agent-<taskId>.meta.json 映射到 sidecar namespace。Storage V5 路径显式使用 inPlace；本地 fallback 是 fs/promises.writeFile。

q3t 捕获并记录 persistRemoteAgentMetadata 的错误，不向上抛出；因此 metadata write failure 不一定阻止当前 remote task 继续运行。

kTs/Ylo 在恢复时列出 sidecar metadata 并解析 JSON/schema；无效记录被跳过。Storage V5 list/read 失败时也可能返回空恢复集合。

这形成一条静态风险链：
- Cloud Session 已创建并继续运行；
- 本地/逻辑 sidecar 写入失败或内容不完整；
- 当前运行仍可继续；
- 后续 resume/list 无法发现或解析对应 metadata；
- 远端工作可能仍存在，但本地恢复入口丢失。

这不是动态复现的故障，只是由写入错误处理与恢复过滤分支共同导出的风险。

### 4.3 MCP task metadata 与 outcome

chunk-0apzc5fh.js 把两种 sidecar 分开：

- kLn 写 metadata：Storage V5 使用 inPlace；本地 fallback 用 hn().write，即 fs/promises.writeFile；
- dhs 写 outcome：Storage V5 使用 atomic；本地 fallback 用 hn().atomicWrite。

outcome sidecar 用于恢复尚未被消费的完成通知，因此比普通 metadata 更接近 terminal result record。源码确实为它请求了更强的 publish discipline，但没有提供 provider 的 fsync/transaction 证据。

### 4.4 precompact.json

chunk-4b60tdnk.js 的 Pun：
- 将 payload 限制在 8 MB；
- Storage V5 路径调用 backend.write(key, json, {mode:384})；
- 没有指定 publishDiscipline；
- 本地 fallback 调用 On(path, json, 384)；
- 读取时检查 JSON/schema/version/TTL/UUID coverage，损坏或过期就拒绝并清理。

这是 speculative cache，不是唯一历史真相。它的设计允许被丢弃并重新执行 Reactive compaction，因此不应与 Agent metadata / terminal task outcome 使用相同的 durability priority。

## 5. atomic 与 inPlace 到底能证明什么

### 5.1 Storage V5 provider 侧：只有调用者请求，没有实现证据

CLI consumer 可见：
- publishDiscipline: "atomic"；
- publishDiscipline: "inPlace"；
- replaceRecords 的 ifMatch / ifUnchangedThrough precondition；
- stat 的 witness/version；
- readRecords 的 seq / endSeq / nextSeq；
- publish phase 错误和 telemetryCode。

这证明 API 具有版本前置条件、记录分页和发布阶段错误模型。

但当前包中没有找到 Storage V5 backend 的 concrete implementation 或完整接口文档。因此尚不能证明：
- atomic 是通过临时对象 + rename、数据库 transaction、CAS pointer swap，还是其他方式实现；
- inPlace 的部分失败会不会留下可见半写内容；
- backend.write 成功返回前是否已持久化到本地盘、远端盘或复制 quorum；
- append 成功是否等于 durable append；
- provider 是否执行 file sync、directory sync、WAL checkpoint 或远端 quorum ack；
- backend restart 后是否会自动修复 torn record；
- read-after-write 是否强一致；
- publish 返回成功后发生机器断电，记录是否仍存在。

特别注意：atomic visibility 与 power-loss durability 是两个不同维度。一个写入可以对并发 reader 原子可见，但尚未保证在断电后留存。

### 5.2 本地通用 On / VQ helper 的可证行为

chunk-70hyy8a7.js：

- On(e,t,n,r) 调用 VQ(e,t,{mode:n,renameFn:r})；
- VQ 优先创建 exclusive temporary file，写入内容，close 后 rename 到目标；
- 在特定 rename/create 错误下可能 fallback 到 in-place 写入；
- VQ 只有在 options.flush === true 时才调用 FileHandle.sync()；
- On wrapper 没有传 flush；
- 未发现父目录打开并 sync 的步骤。

因此，Agent metadata / precompact sidecar 的本地 On fallback 虽然尝试 temp + rename，但调用点没有请求 file sync，也没有目录 fsync 证据。不能把它描述为 power-loss durable atomic commit。

chunk-3en886nm.js 的 Lzr facade 进一步确认：
- write → fs/promises.writeFile；
- append → fs/promises.appendFile；
- atomicWrite → On；
- writeExclusive / writeBytesExclusive → exclusive create。

这些是本地 fallback 的具体实现，不是 Storage V5 provider 的实现。

### 5.3 本地 transcript compaction 是一个更强但仍不完整的特例

chunk-4b60tdnk.js 的本地 performCompactTranscript 路径：

1. 读取原 transcript 的 size/ino 与首、中、尾 snapshot；
2. 写入 .compact.tmp 文件；
3. 检查源文件未变化，并处理并发追加；
4. 显式调用临时文件 handle.sync()；
5. 检查 staged size；
6. 再次验证 source；
7. close 临时文件并 rename 到原 transcript。

它比通用 On fallback 多了显式 temp-file sync 与 source-change checks。

但是仍未发现父目录 fsync，因此不能仅凭这一段代码宣称满足所有文件系统/操作系统的 power-loss durability guarantee。

Storage V5 transcript compact 路径则调用 replaceRecords(..., publishDiscipline:"atomic", precondition:ifUnchangedThrough, parent:"mustExist")。它的版本/发布契约比普通 append 更明确，但 backend 的物理实现未知，不能直接说它等同于本地 temp-file sync + rename。

## 6. 事实、推断与未知

### 源码事实

- CLI entry 通过 CLAUDE_CODE_HOVER_REST 与 pinStorageV5FromEnv 进入可选路径；默认 hFr factory 不返回 backend。
- main/init 接受外部 storageV5EnvPin；adoptStorageV5EnvPin 校验 configHome。
- Desktop SDK logger 接收可选 storageV5；Desktop 主 JS 未找到 concrete provider 创建路径。
- Storage V5 使用结构化 namespace/keyspace，包含 transcript、sidecar、task、settings 等。
- Agent metadata / precompact sidecar write 没有显式 publishDiscipline。
- Remote Agent metadata 和 MCP metadata 使用 inPlace；MCP outcome 使用 atomic。
- Transcript compaction V5 使用 atomic + version precondition；transcript append 与 LocalFileJournal append 没有显式 discipline。
- 本地通用 On/VQ helper 只有 flush:true 才调用 file sync；On wrapper 不传 flush。
- 本地 transcript compaction 的专用路径明确 sync 临时文件后 rename。
- Storage V5 consumer 代码没有调用 backend.sync / backend.flush / backend.fsync 这类方法。

### 推断与工程风险

- V5 sidecar 的 durability 不能从 write promise resolved 推导；必须由 provider contract 定义成功 ack 的确切语义。
- Agent/Remote Agent metadata 是恢复依赖，不能只按普通 cache 处理。
- Remote Agent metadata 写入失败后仍继续执行，若没有其他权威索引/远端发现机制，可能造成远端任务仍运行但本地失去 resume 入口。
- MCP outcome 使用 atomic 而 metadata 使用 inPlace，体现了作者按数据用途区分发布策略；但真实 durability 强度仍未证明。
- Atomic visibility 与 crash durability 必须在新架构中作为两个独立契约维度。

### 未知

1. Storage V5 backend 的 concrete implementation、部署位置、所有者和运行边界。
2. atomic/inPlace 在 provider 中的精确定义，以及 default discipline 的默认值。
3. append/write/replaceRecords 的成功 ack 是否代表 WAL durable、local fsync、remote quorum 或仅服务进程已接收。
4. provider 的 file sync、directory sync、WAL/checkpoint、replication 和 crash-recovery 行为。
5. Storage V5 在 configHome 不匹配、Host 重启、backend 迁移时的具体 recovery protocol。
6. Agent/Remote Agent metadata 与 transcript 是否有独立的双写事务、generation/version fence 或可重建索引。
7. 断电后 tornTailBytes 是否由 provider 自动修复，还是只报告给 consumer。
8. Desktop 本地安装是否通过未暴露的 native/remote host 提供其他存储 capability；当前 JS 与有限 binary string scan 不足以排除。

## 7. 对新架构的启示（非决策）

1. **拆开 publication 与 durability。** 写 API 应分别定义 visibility/atomicity 与 durability level，例如 process-crash durable、OS-crash durable、power-loss durable、remote-quorum durable；不要用一个 atomic boolean 代替全部保证。
2. **成功 ack 必须有明确定义。** 每种 backend operation 应明确返回成功意味着数据到达哪个边界，以及重启/断电后是否必须可读。
3. **Canonical journal 与 sidecar 分级。** Transcript / operation ledger 是 canonical record；Agent metadata、remote task metadata、task outcome、precompute summary 应声明是 authoritative、rebuildable 还是 speculative。
4. **恢复依赖 metadata 必须可重建。** Remote Agent metadata 写入失败时，应有远端 task discovery / idempotent lookup / durable launch record，不能仅依赖一份可能丢失的 sidecar。
5. **Atomic publish 必须绑定 version fence。** 对 transcript rewrite、terminal outcome、session pointer swap 等操作，建议使用 version/precondition，避免旧 worker 覆盖新结果。
6. **Sidecar 不能与主记录无协调双写。** 如果 metadata 与 transcript/remote session 是两个独立写操作，应记录 generation、owner、operationId 与 reconciliation state。
7. **验证应覆盖写入每个阶段。** 对 temp creation、partial write、file sync、publish/rename、ack 返回、metadata cleanup、backend restart 分别注入进程崩溃；对断电持久性还需要可控的 VM/block-device fault test，而不能用普通单元测试代替。
8. **错误模型要暴露不确定状态。** 如果网络断开时无法确认 write 是否提交，返回 outcome_unknown 并允许按 idempotency key 查询，不应简单重试可能重复产生副作用的写入。

## 8. 下一步

按当前 PROGRESS 的顺序：

1. 构建多次 Full/Reactive compaction、preserved UUID 缺失、parentUuid cycle、torn JSONL tail、Storage V5 readRecords fallback 的 transcript recovery 状态矩阵。
2. 将 Remote Agent event replay 的 null cursor、runId 去重、metadata loss、archived session 与 duplicate output 放入同一故障矩阵。
3. 完成 Desktop/SDK Host session lifecycle：启动/关闭、双向协议、request correlation、permission broker、MCP bridge 与 cancellation。
4. 再完成 Pi Core 源码研究与统一横向比较；此时才提出独立目标架构。

**裁决：无。** 本报告没有确认 Storage V5 的 crash durability，也没有批准任何架构或开发。

## 9. Evidence index

所有 JS offset 为对应发布包文件中的 0-based character offset。CLI 文件 SHA-256：

| File | SHA-256 | Key anchors |
|---|---|---|
| cli | c453d96fa77039686a89ba718ac4cb6dda3d86663e116e1d4ae5c3b846b8055b | env pinStorageV5FromEnv @5,017；main(storage pin) @25,192 |
| chunk-ats1064w.js | b2edc162e237b3791eba8d154ef81d4dffe3e4427b88290e18b7aab86ad223e8 | exports pinStorageV5FromEnv/adoptStorageV5EnvPin/tryCreateV5Backend @1,416 |
| chunk-zbam8cnm.js | fd879225791e2164f6df2718576cc20f0650063ad2926f4bbca4109cf3b96d4e | HNo @808；$No configHome guard @955；hFr default factory @1,721 |
| chunk-84za6xb8.js | 78a8e991d11f7fce9a8c8e0f6844d23b393872ea66090ac3cec5f081afdfc033 | dq env/feature gate and adoption @809 |
| chunk-9r3j64pk.js | ffc0d5e8255edebf6b8974a8817406fce1d6f44a56240d07187e6ca653ee0ac2 | init V/storageV5EnvPin/configHome guard @6,066；dq adoption @7,546 |
| chunk-9b0nx8jt.js | 97f30ab9ae24c927933e9845edca09f72a897c1df120b620cf96088c3bbecbbe | main Ru @39,908；Ji passes storageV5EnvPin to X5o @40,838 |
| chunk-m2k93t9z.js | b50bf4fb07747138175b19d06f14c660d9581aeaf313cbd6f91fa874ce87e946 | X5o init injection @29,951；withStorageV5 wrapper @60,610 |
| chunk-r8xw8ewt.js | dd8290080563a6fa0849e3d62d314ecbb85025d92226b15704b8d5a4356b8ab6 | logical key builders je @1,902 |
| chunk-36jhgfkd.js | 60bd48cd7d9787338dc3f61618ca83173b8f3299259da9e8d76f7ef80ea1a947 | hostFiles.realPath @1,057；transcript path mapping sf/rIs @1,344/@1,664；backend capability wrapper Oj @2,213 |
| chunk-8ryf2d0d.js | f2edeea014d62c39b8f3244ac2112208c6c5826866627b0d15977118acb397fb | .meta.json sidecar path mapping KWt/MR @42,045 |
| chunk-4b60tdnk.js | c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb | Agent metadata read/write GZt/iCt @330,179/@330,578；Remote Agent metadata vTs @334,070；precompact sidecar Pun @2,529,810；local transcript compact @367,102; file sync @369,141; V5 compact @370,095; atomic publish @371,505 |
| chunk-0apzc5fh.js | 2c82188019d384af7a250a35fbc202dcab7418d28daa0911dc1c14ebea4d02b4 | MCP task metadata kLn @3,111；outcome dhs @3,510 |
| chunk-f32nr6wa.js | bf7616c537b7e2f4beb8265ab0530356edbf34a6c5ff66b393978d2d8017b662 | LocalFileJournal torn-tail check @32,085；append @32,533 |
| chunk-1z2sthpn.js | b7a24f3d93a85d9df6b339320cdd8e749b16b73f6661a240a943f46cf3132df8 | transcript V5 append / inPlace replaceRecords @3,894 |
| chunk-70hyy8a7.js | ef4d2e87e89346a8c3e6e15420835819d2f49aa53cfa612b9594533f6f9766eb | On wrapper @8,017；VQ temp/rename writer @8,079；flush-gated FileHandle.sync @9,095 |
| chunk-3en886nm.js | 618fe16da390a0835b5bb5ce37cb0e2c110e93a4f53c8f8c8bd6798e315160fe | local FS facade Lzr @17,812；write/append/atomicWrite methods @18,021 |

Desktop evidence:

| File | SHA-256 | Scope |
|---|---|---|
| index.chunk-J7YnW_mh.js | 80d308de49d2eacee72a561734b05e32209783de7772881036e5608cfd725a42 | SDK logger accepts optional init.storageV5; no provider creation found |
| index.chunk-CBDjn27r.js | 0c1a091026181016fcc2afa8000a49fb0788824e870aa8180339e86f86d62427 | duplicated logger implementation |
| fileIndexWorker.js | abad4e7f6f1a6d85e4bfeb5b4e221ee0e2237b108df026d1a2f435d6ad6af3e9 | worker logger copy |
| claude-native-binding.node | d2b365f576f2ec69d50bff712e47dddbbf0d69bf545023fd96012cd85dce2557 | limited strings scan; no V5-specific identifiers found |
| cowork-svc.exe | 0645c6e37ecb08261eb8fed2b07036f59752ec648e4d4136323ac3a5fe2d01ff | limited strings scan; no V5-specific identifiers found |

