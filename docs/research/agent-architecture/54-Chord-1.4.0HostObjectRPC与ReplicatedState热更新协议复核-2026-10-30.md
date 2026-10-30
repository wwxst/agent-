# 54：Chord 1.4.0 Host / Object / RPC / ReplicatedState 与热更新协议复核（2026-10-30）

> 研究阶段：固定 release tag v1.4.0 的源码静态追踪；未执行真实多进程、WebSocket、权限撤销或 hot-reload crash test。  
> 样本：@earendil-works/chord@1.4.0；上游 earendil-works/pi；release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。  
> 本报告承接报告 53；重点是核验 Pi Durable 所依赖的 Chord 真实发布版，而不是当前 main 上未发布的 next 目录。

## 1. 发布版边界：Chord 1.4.0 不是 Durable Store

### 1.1 package / exports

packages/chord/package.json：

- package @earendil-works/chord@1.4.0；
- description：typed host runtime for plugins, contracts, replicated state and RPC over JSON links；
- Node >=22.19.0；
- runtime dependencies 只有 pi-telemetry 1.4.0 与 typebox 1.3.27；
- exports：root、context、output、delta、node、telemetry-sqlite、sqlite、sqlite/node、sqlite/cloudflare；
- publish files 为 dist、docs、README、CHANGELOG 与 delta README；
- 不提供通用持久化 Document / Task Store API。

Chord root export 包含 createHost / defineFacet / defineRegistry、local/remote contract、replicatedState、JSON delta、link / wire / context 类型。

### 1.2 必须排除未发布的 next 源码

本轮固定 v1.4.0 tag 读取 packages/chord/src/next/store/store.ts 与 packages/chord/docs/next/store/index.html 均返回 404；package exports / publish files 也没有 next 子路径。

当前 main 搜索结果可见 packages/chord/src/next、docs/next 等后续开发内容，但它们不是 v1.4.0 release tag 的源码，不得拿它们解释 @earendil-works/chord@1.4.0，更不能把后续 Store 设计误当成 pi-durable 1.4.0 的底层实现。

### 1.3 与 pi-durable 的关系

pi-durable 1.4.0 自己定义 Storage interface 与 Memory / JSONL / SQLite / IndexedDB adapters；Chord 提供 JSON value、delta tracker、Context、SQLite portable interface / migration helper 等基础设施。Chord 的 replicatedState 是内存态 publication primitive，不是 Durable Conversation / Task storage。

## 2. Chord 对象模型：Host / Facet / Contract / Object / Ref

### 2.1 Contract 是运行时协议，不是 TypeScript interface 的隐式约定

Contract 使用 TypeBox schema 声明：

- local contract：host 内部对象接口；
- remote contract：可通过 link 暴露的远程对象；
- variants：对象当前暴露的成员集合；
- method(args, result)：RPC 方法输入 / 输出 schema；
- state(schema)：可订阅状态成员；
- opaque：类型携带但不经 JSON wire 的资源句柄；
- host placement：按 contract + input 决定对象位于哪个 host。

Provider factory 返回 implementation 后，Chord 会校验 variant、成员集合、method 类型、state source 和 opaque 成员；调用方的 contract token 在 hold 时传给 provider，provider 重新校验其是否被服务端 contract 覆盖。

### 2.2 Host / Facet

createHost(options) 创建 HostImpl。Host 负责：

- 维护对象、code versions、facets、host-lifetime objects；
- serve / install / load facets；
- get / hold remote or local refs；
- accept / connect links；
- routes、principal、registry；
- invalidatePrincipal；
- reload / close。

Facet 是一个命名模块，setup(api) 在 host 上声明 serve；FacetApi 提供 serve、root、registry 和本次 facet run 的 AbortSignal。模块 URL 通过 FacetLoader 动态 import；host.load 会先安装所有 facets，再等待 host-lifetime objects ready。

### 2.3 Ref 与对象生命周期

- get(type, input) acquire reference 并 await ready；ready 后状态成员可用；
- hold(type, input) 同步返回可能 loading 的 Ref；适合 UI 先渲染 status，再观察 ready；
- Ref 必须 release；最后一个 reference 释放后对象按 lifetime / linger 策略 dispose；
- lifetime=referenced 是默认，第一次 get 创建对象，最后一个 ref release 后可 linger；
- lifetime=host 创建该 type 的唯一 host object，由 Host 自己持有，直到 reload / host close；
- 只有 host-lifetime object 可以 register registry entries；
- host.close 按 holders-before-held objects 的顺序 dispose，保证 holder resource.close 期间其依赖仍存活。

对象 factory 必须同步返回 implementation；async factory 被拒绝。异步初始化放到资源 open、reference ready、state init、task/listener lifecycle 中完成。

## 3. Object factory 的声明与 activation 顺序

Factory 接收 input、principal、self；self 可声明：

- state(name, schema, initial / async init, {version, migrate})；
- get(type, input)：声明并持有其他对象；
- resource(name, {version, deps, exclusive, open, close})；
- on(name, source, select?, handler)：订阅状态 / resource / source；
- task(fn)：该对象存活期间运行的长任务；
- derive(sources, fn)：同步派生 Readable；
- expose(resource)：将 resource value 作为 local contract opaque member；
- register(registry, entries)：仅 host-lifetime objects 可用。

对象 activation 的源码顺序：

1. 同步执行 factory 并校验 implementation；
2. 解析资源依赖，dependencies first 打开 resources；
3. 等待 factory 获取的 references ready；
4. 等待 implementation 暴露 / 派生的 state hydrated；
5. 对新 state cell 执行 async init；init 在独立 root 中运行；
6. listener 先订阅但暂不 deliver，避免半激活对象接收事件；
7. 对象变为 live 后打开 listener gate，开始 deliver；
8. startTasks 启动对象级长任务。

资源关闭按 reverse open order；对象 dispose 会拒绝新 call、abort 当前 invocations、stop tasks / listeners、等待 invocation settle，再关闭 resources、释放 refs。该生命周期是进程内对象管理，不是持久化 task scheduler。

### 3.1 State cell 与 schema

Cell 是带 schema 的可写 JSON state：

- change(ctx, draft => ...) 是同步 mutation callback；
- WriteGuard 根据 Ctx codeVersion / object status / principal 决定是否可写；
- state version 升高时 reload 可 migrate；降低 version 拒绝；
- 同版本 schema 变化拒绝，必须显式 version bump；
- cell value 的变化产生 StateEvent / delta revision。

### 3.2 Resource

Resource 有 version、deps、exclusive、open、close：

- deps 可指向同对象的 refs 或 resources；
- resources 按依赖先后 open；
- close 按 reverse open order；
- reload 中相同 version、exclusive 与 deps 的 resource 可以 adopt 新 close callback 而保持实例；
- exclusive resource 替换必须进入 reload gate，避免旧、新资源同时持有独占能力。

## 4. Root / Context / Principal：跨对象、跨 host 的调用所有权

### 4.1 Root 是代码版本与对象 lease 的边界

Host.root() 为每次 root 生成包含 host name、host incarnation、sequence 的 rootId；Ctx 携带：

- rootId；
- codeVersion；
- principal；
- linked AbortSignal；
- telemetry / Context values。

root 访问对象时会记录 touched objects，并在 root 结束时释放 lease。一个 root 的调用跨出本 host 再返回时仍属于同一个 root；跨 host 的 root_end 帧通知沿途 host 结束 lease。foreign root 只有在所有带它进入的 link 都结束后才释放；若 root 仍在本 host 运行，则等最后一个 call settle。

因此 root 不只是请求 trace ID，而是 reload retirement 与对象 lease 的生命周期身份。

### 4.2 Principal / authorization

- accept(link, {principal, kind, name, restamp}) 由接入方指定 peer principal，不能信任 peer 自报身份；
- connect(link, {principal}) 指定 parent 的本地请求 principal；
- hold / relay 可携带 principal，provider factory 与 method ctx 获得它；
- route.authorize 在 route.resolve 前后都执行；authorization generation 在 await 后再次检查，principal 被 revoke 时不能继续 forward；
- invalidatePrincipal 可按 predicate 在本 host 强制 dispose，也可按 pattern 传播到 child host；
- revoke 时 relay cancel 下游 calls、release downstream hold、拒绝 waiters。

这为多租户 / 浏览器 client / worker host 提供身份边界，但真正的身份认证仍由 application 接入层负责。

## 5. Wire / Link / Connection 协议

### 5.1 Protocol v4 frame families

packages/chord/src/wire.ts 的 PROTOCOL_VERSION = 4。主要 frame：

| 方向 | Frames | 职责 |
|---|---|---|
| consumer → provider | hold / release / call / cancel / sub / unsub / resync | 引用、RPC、取消、订阅、重同步 |
| provider → consumer | shape / gone / result / state | 对象形状、失效、调用结果、状态快照 / delta |
| 双向 | hello / ping / pong / bye / root_end / ack | 握手、心跳、关闭、root lease、flow control |
| parent → child | invalidate / prepare / commit / abort / retire | principal revoke 与 cluster reload |
| child → parent | vote | reload prepare 成败与 report |

所有收到的 frame 都经 TypeBox FrameSchema 校验；payload 在实际使用点再按 contract / delta schema 校验。未知 frame / op 不能静默忽略。

### 5.2 Link 传输层

Link 是有序 FIFO、双向 frame channel。BaseLink：

- handler 安装前到达的 frames 先排队；
- 乱序异步解压通过 deliverLater Promise tail 串行；
- close 双向发送 bye，shutdown / close handlers 只触发一次；
- payload JSON 超过 64 KiB 时，Node zlib 可 deflateRaw；relay 可转发 Packed bytes 而不 inflate，浏览器在接收端解压。

传输有 memory、Node IPC、WebSocket 等实现；Connection 只依赖 Link contract。

### 5.3 Hold / Call / Cancel

Connection.call：

- 为每个 RPC 生成本 link 独立 ID；
- signal abort 时删除本地 pending、发送 cancel frame、reject caller Promise；
- server 收到 call 后创建 AbortController；
- host peer 可携带 rootId + codeVersion，server join 原 root；client 不携带 root，由 server 创建新 root；
- call settle 后发送 result，移除 incoming map；
- maxCalls 可限制同时执行的 incoming calls，超限直接回 unavailable/too_many_calls；
- RelayCall 维护 origin/downstream 两套 call IDs，cancel / close 会向下游转发并 settle origin。

Abort 是协作式传播；真正外部副作用是否停止由 method/tool 实现决定。

### 5.4 Ack flow control 与 state recovery

Connection 默认：

- window = 256 KiB；
- pendingCap = 4 × window；
- 只有双方 hello 宣告 acks 且 Link.send 能报告 encoded frame size 时才启用 window；
- state ops 超过 pendingCap 时，最旧 waiting streams 被替换为当前 reset；relay 不持有 state value，则发 resync 请求 provider reset；
- 一个大 snapshot frame 仍可能超过 window；
- 首次非 re-hold unit、result、shape、gone、reload control、ping 可立即发送，不被 state window 阻塞。

因此有一个明确顺序例外：此前 state 变更仍在 window queue 等待时，后发 result 可能先到；同一 state member stream 内仍保持顺序。UI / consumer 必须以 snapshot + state stream 处理，而不能假设跨 member / RPC 的全局 FIFO。

## 6. ReplicatedState：内存发布，不是持久化

replicatedState(initial) 创建 MutableReplicatedState：

- 初始值必须是 alias-free strict JSON；Chord 接管 immutable root；
- change(context, mutate) 同步、不可 reentrant；draft callback 返回后 draft 失效；
- 每次有效变更 prepare immutable revision + ops，再 adopt 并 publish；
- subscriber 每个订阅独立 serial drain，先 hydrate 再 update；
- listener Promise 会被 await；每订阅最多 100 pending deliveries，overflow 丢中间更新只保留最新待投递值；listener error 隔离并 report；
- unsubscribe 丢弃 pending work，不 abort / join 当前 callback。

replicatedState(source) 是外部 revision source 的只读 publication view：

- attach() 必须原子取得 snapshot + 注册后续 frames；
- frame cursor 必须连续；gap 会 fail/dispose attachment；
- Chord 只发布 source 的 immutable values / ops，不 apply 或 re-diff。

不要将 ReplicatedState 误认为数据库。它不负责 WAL、fsync、durable commit 或跨进程恢复。

## 7. Delta：strict JSON immutable revision 与安全操作协议

Chord delta operation vocabulary：

| Op | 作用 |
|---|---|
| r | 替换整个 root |
| s / d | set / delete path |
| a / t | string append / truncate |
| p | array splice |
| m | array permutation / reorder |

关键机制：

- tracker 通过 overlay draft 捕获 mutation，prepare 计算 immutable next revision + operation batch，adopt 后推进 revision；
- diff 默认最多 4096 operations；超过时退化为 root replacement；若 delta JSON cost 不比 snapshot 更小，也选择 root replacement；
- apply / applyImmutable / applyImmutableBatches 分别提供原地 apply、copy-on-write immutable replay、跨 batch final-result replay；
- path 禁止 __proto__ / constructor / prototype，防止 model/plugin/tool 回显数据触发 prototype pollution；
- array index 不允许跨 length 稀疏写入，防止 JSON roundtrip 产生不同状态与超大稀疏数组 DoS；
- wire encoder 对 path 做 ID interning / omitted path compression；decoder 按 wire grammar 校验，未知 op verb 拒绝。

delta 是 Chord state replication 与 pi-durable document/storage 的基础数据格式，但不等于 transaction log 的完整 durability contract。

## 8. Hot Reload：候选版本、gate、同步 publish、旧版本 retirement

### 8.1 Local reload 两阶段

runReload 串行占用 reload slot；第二个并发 reload 返回 reload_running。

prepare 阶段：

1. waitForRetirement：先处理上一代 codeVersion；
2. load：构建 candidate service table 与 pending codeVersion；
3. checkProviders：检查相同 contract version 是否发生不兼容变更、facet uses 是否能 bind；
4. prepareAll：对 changed types 的 live / activating objects 以 fixpoint 运行新 factory，记录候选 declarations；
5. checkRefs：确保新 provider 能满足保留引用的 contract；
6. build candidate registry tables；
7. gate：对需要 state migration / exclusive resource replacement 的对象停止 tasks、阻止新 call、等待 grandfathered roots drain（默认 5 秒）；
8. close replaced exclusive resources、open candidate resources、init cells、migrate versioned state、dry-run derivations；
9. stage listeners，先订阅但不 deliver。

任何 prepare error 都 rollback：abort candidate signals、discard staged publications、unwind new resources / refs、尝试重新打开被关闭的旧 exclusive resources、openGate 并重启旧 tasks；新类型对象销毁。

### 8.2 Commit / retirement

commit 在 holdPublications() 内同步发布：

- current codeVersion 切到 next；
- 更新 object implementations / declarations / schemas / migrated cell values；
- activate staged listeners；
- 更新 registry tables / facets；
- 处理 removed objects；
- 新代码 tasks / host object activation 在 install 后按排定顺序启动；
- observer notifications 在整个同步 publish 后释放。

Host 最多保留 current + previous 两个 code versions。previous roots 正常 drain 后 retire；默认 retireDeadline 5 秒，超时 abort previous roots，再给最多 1 秒 grace，随后 retire implementation。旧 root 后续 call 会 superseded；子 host 还要等 parent retire frame 才能安全退休。

### 8.3 Cluster reload

有 child host 时走 runClusterReload：

- server coordinator 分配同一 codeVersion；
- parent 给每个 child 发 prepare；
- child 独立准备并返回 vote + ReloadReport；
- 任何 child vote failure / timeout 会 abort 整个 cluster reload；
- 全部 prepare 成功后 coordinator 先 publish parent，再发 child commit；child 根据 commit frame 安装；
- retire frame 协调旧版本 root 的跨 host drain。

该机制不是全分布式事务：prepare / vote / commit 协调代码版本与 host object compatibility，不回滚任意外部 side effect。

## 9. 与 pi-durable 的真实关系

- Chord 1.4.0 提供 Host / Contract / Object / RPC / ReplicatedState / delta / context / SQLite primitives；
- pi-durable 自己定义 Conversation / Entry / Document / Task / Storage；
- pi-durable SQLite adapter 使用 Chord portable SQLite interface 与 delta apply；
- pi-durable 的 TaskScheduler / GenerationTask 并不运行在 Chord Host object 的 Task 上；
- Chord object self.task 是对象生命周期内的 in-memory background work，reload 时 stop / restart；Durable Task 是带 checkpoint、restart count、ownership 与 terminal receipt 的持久化状态机。

两者的 task 不能因为名称相同就视为同一语义。

## 10. 事实 / 推断 / 未知

### 源码事实

- Chord 1.4.0 root exports Host / Contract / Link / ReplicatedState / delta / Context 等；没有通用 Durable Store API。
- v1.4.0 tag 不包含 packages/chord/src/next。
- PROTOCOL_VERSION = 4；PACK_THRESHOLD = 64 KiB；Connection 默认 window 256 KiB、pending cap 4 windows。
- ReplicatedState 每订阅最多 100 pending deliveries；overflow 保留最新值并允许 sequence skip。
- Host roots 携带 codeVersion / principal / AbortSignal，并跟踪 object leases；root_end 跨 link 释放 lease。
- Hot reload 有 prepare / gate / stage / synchronous publish / rollback / old-version retirement；cluster reload 使用 prepare / vote / commit / abort / retire。
- delta 有 strict operation validation、prototype path protection、array sparse-write guard、4096 op cap 与 snapshot fallback。

### 推断 / 风险（未动态验证）

- Link 若不提供 frame byte size，ack window 不会限制 state backlog；需要核验 IPC transport 是否提供 size。
- state backlog overflow 会跳过中间 revisions；消费者必须把 reset/snapshot 当作重新同步，不可仅增量 apply。
- reload 的 prepare rollback 只能恢复 Chord 管理的 object / resource / listener；factory / hook / resource open/close 的外部副作用仍需业务补偿。
- code version retirement deadline 到期会强制 abort old roots；如果 method 忽略 signal，资源 close 与旧调用收敛仍需验证。

### 未知 / 资料缺口

- 多进程 HostManager / child process spawn / processLock 的真实崩溃恢复与 IPC size reporting。
- WebSocket / IPC transport 的 backpressure 与 close races。
- Cluster reload 在 child disconnect、partial commit、parent crash 下的真实行为。
- ReplicatedState publication 与 Host reload publication 的 reentrant listener / subscriber race。
- pi-durable SQLite / JSONL / IndexedDB adapters 的 transaction / fsync / WAL / ownership；下一报告逐源码核验。
- 没有真实 multi-host / reload / revoke / crash injection。

## 11. 对目标架构的非决策性启示

1. **Contract-first RPC：** 跨进程能力应有 schema、placement、principal、version 与运行时 validation，不只依赖静态 TS interface。
2. **Reference lease + root context：** 远程对象生命周期需要明确 hold/release、root lease、cancel 与 close，不要让 UI object reference 永远存活。
3. **Bounded state replication：** ack window + pending cap + reset/resync 是慢消费者场景的基础；中间 delta 可丢，snapshot 必须可恢复。
4. **Hot reload 需版本隔离：** candidate prepare / gate / publish / old-code retirement 比直接替换 function map 安全；但只保护 host-owned state，不自动事务化外部 side effect。
5. **分开 in-memory lifecycle task 与 durable task：** 一个负责 object lifetime，另一个负责 crash recovery；命名相似不代表语义可复用。
6. **Delta 不是 journal：** delta 解决 immutable revision diff / replication / apply；durability 还需要 transaction, commit sequence, storage atomicity, fsync 与 ownership。
7. **身份必须在 host boundary 注入：** peer 自报 principal 不可信；route resolve 前后都复核授权，revoke 需要传播到 relay / child host。

以上是研究输入，不是已批准架构决策。

## 12. 下一步

1. 研究 pi-durable v1.4.0 的 SQLiteStorage / JsonlStorage / IndexedDbStorage / MemoryStorage 实际 commit 原子性、序列分配、事务边界、fsync、WAL、multi-owner 与 recovery。
2. 研究 Chord sqlite portable interface、Node driver、Cloudflare Durable Object driver 与 schema migration。
3. 研究 Chord Node HostManager / processLock / forkDriver 与 IPC lifecycle。
4. 动态验证 ReplicatedState / Connection overflow、RPC cancellation、Host reload gate / rollback / cluster commit。
5. 之后研究 CompactionTask 与 pi-coding-agent composition。

## 13. 本轮边界

只新增研究文档与进度记录。没有修改业务代码、Kernel、PR #48 原型或任何运行时实现；没有提交开发 PR。

## 14. Evidence index

| 文件 | Blob SHA | 关键锚点 |
|---|---|---|
| packages/chord/package.json | 9845c75949f069d4021a6b4fb4d21edf590882a9 | v1.4.0 exports / dependencies / publish files |
| packages/chord/src/index.ts | 6fb71ae101b9e28adbdbdbdb73ac2c19dadf8a5a | public API exports |
| packages/chord/src/host.ts | 9f96a4909ba97c42d7b2f69326c565de1aa0f9ef | HostImpl / get / hold / root / accept / connect / reload / close |
| packages/chord/src/object.ts | 6bd1ee24f1edde31d638550ff3358b37526bd42e | SelfImpl declarations / ObjectImpl activation / resource / task / dispose |
| packages/chord/src/connection.ts | 0d1efa974a4f6e5463408a3ea84d7f4d891825a3 | protocol / RPC / cancellation / relay / flow control / state resync |
| packages/chord/src/link.ts | 029bd7dc2c9da6b9ad832bf3f44856cdbe0ac92d | FIFO Link / payload packing / IPC / WebSocket |
| packages/chord/src/wire.ts | b9271f130b37a09a089467641954d10ce1cadd69 | protocol v4 frame schemas |
| packages/chord/src/state.ts | 08b4ed107890a2061ee98220d021a6588b8a27c0 | ReplicatedState / 100-delivery overflow / source cursor |
| packages/chord/src/delta/index.ts | ad4ed57d621039cf45e58b84882386a32ea25969 | op schema / safe apply / immutable batches |
| packages/chord/src/delta/tracker.ts | 8e01705fa45212a3e680fba2e49f7dac20410096 | Tracker / overlay / prepare / adopt |
| packages/chord/src/delta/diff.ts | 774ad1b59176692173f0b30192b44900e1c6d58e | 4096 op cap / delta-vs-snapshot cost |
| packages/chord/src/reload.ts | 38e9b4c1ecd0809360b13cf6ede0cba99bf308b5 | prepare / gate / migrate / rollback / publish / retirement |
| packages/chord/src/contract.ts | c2ebd6b962d6386d0ff32e85f4c00c5daea3f3ad | local/remote contract schema / placement / method |
| packages/chord/src/context/index.ts | 7e8da66887cc2d6eb9a59f85f2e8384281a15b92 | invocation Context / cancellation / telemetry |
| packages/chord/CHANGELOG.md | 0eeae64b00cd159028f8ee37f951004b216d9b15 | v1.4.0 release and SQLite primitives |

**证据等级：** 固定 v1.4.0 release source 静态追踪。没有真实多进程、WebSocket、reload / revoke / crash injection；Chord 不提供 pi-durable 的 durable store。
