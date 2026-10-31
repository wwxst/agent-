# 56：Chord 1.4.0 HostManager、ProcessLock、ForkDriver 与子 Host 生命周期（2026-10-30）

> **阶段**：固定 release tag v1.4.0 源码静态研究；上游已有 Node 真实子进程测试的源文件复核，**本轮没有实际运行测试**。  
> **样本**：earendil-works/pi tag v1.4.0，release commit 4a080252f06caf63a525d7873c5d94d3c23887e0。  
> **边界**：只新增研究证据，未修改 Kernel、业务代码、测试实现或应用程序。研究报告 55 的 Storage 事务不能等同于进程 ownership，本报告研究 Chord 是否补上该边界。

## 1. 职责定位：Node Host 进程管理，不是 Durable Task Scheduler

packages/chord/src/node.ts re-export：

- createHostManager / HostManager / HostManagerOptions；
- forkDriver / Driver / Instance / Exit；
- childControl / ControlMessage；
- processLock；
- nodeLoader。

该机制管理的是一个 **Chord child-host process** 的启动、就绪、IPC link、空闲回收、停机与进程组 kill；没有持久化 TaskRecord、Execution Intent、tool effect receipt 或业务 checkpoint。

相关协作层：

- Chord Host：对象、RPC、root leases、hot reload、principal；
- HostManager：运行 child Host 的 Node process lifecycle；
- processLock：按名称互斥独占某份 host-owned data；
- pi-durable Harness/TaskScheduler：独立保存 Task / checkpoint / run ownership 的持久化任务执行引擎。

这四层可以组合，但源码**没有证明** v1.4.0 产品必然完成上述四层整合。

## 2. ForkDriver / Control channel

### 2.1 ForkDriver

forkDriver({ entry, args?, env?, execArgv?, init?, lock?, onOutput?, onMessage? })：

1. 从父进程 env clone 一份，删除继承的 CHORD2_LOCK，再合并 options.env；仅 options.lock 配置时设置自己的 CHORD2_LOCK。
2. 使用 Node child_process.fork(entry, args, { detached:true, stdio: ["ignore", stdout, stderr, "ipc"] })。
3. 若 onOutput 启用，捕获 stdout/stderr 并同时回显到父进程标准输出。
4. 创建 IpcLink（Chord protocol frame）；控制消息复用同一 Node IPC channel，但使用 chord2control 字段与 Chord frames 区分。
5. 对新子进程发送可选 init；Instance 返回 pid、link、exited Promise、send、killTree、onControl。
6. 子进程 exit 时尝试 killGroup，以免它 spawn 的 descendants 继续存活（POSIX 进程组机制）；killTree 在 kill(-pid) 失败时 fallback child.kill("SIGKILL")。

**边界**：process-group kill 是进程强制终止，不是工具副作用撤销；对子进程派生的非同一进程组、远端 MCP/HTTP 或平台特定 Windows 行为，本轮没有验证。

### 2.2 ControlMessage

manager/child 使用以下消息：

| 消息 | 方向 | 语义 |
|---|---|---|
| init(value) | parent→child | 子进程初始化参数 |
| ready | child→parent | 可服务标志，HostManager.start 的 success gate |
| fatal(message, reason?) | child→parent | 子进程启动失败 |
| shutdown | parent→child | 请求 graceful exit |
| status(activeCalls?, viewers?, durableTasks?) | child→parent | liveness / keepAlive 决策输入 |

childControl() 返回 init Promise、lock()、ready()、fatal()、report()、onShutdown()。onShutdown 触发 handlers，但实现并不 await 全部 handler Promise，也不发送独立 shutdown ack；Manager 靠 child.exited 判定真正停机。开发者要让 child 自己在关闭 Host/Storage 后退出。

**启动必须约束**：childControl().lock() 要由 child entry 显式调用，并且在打开由其独占的 Storage 之前执行；否则 lock 设置在 forkDriver 配置中也不形成实际存储隔离。上游 fixture 正确执行了 lock → createHost → serve → ready。

## 3. ProcessLock 实现：锁随真正 owner 进程存活

### 3.1 地址及持有机制

processLock(name)：

- 对 lock name 做 SHA-256，截取前 32 hex chars 作为 socket/pipe key；
- Linux、Android：abstract Unix domain socket，地址以 NUL 前缀，进程终止后由内核释放；
- Windows：named pipe，按 pipe address 互斥；
- macOS / BSD / 其他 Unix：socket file，尝试 bind；如 EADDRINUSE 则 probe accepting；若无人接受，移除 stale path，再尝试 listen；
- long TMPDIR socket path 会落到 /tmp/chord2-{uid}/ 中，目录要求本用户拥有且权限不能对 group/other 开放；
- 返回 async release() 关闭 server；文件 socket 平台注册 process exit unlink。

成功 listen 即为持有 lock；另一个进程 bind 同一地址失败时抛 ChordError unavailable，reason=locked。

### 3.2 两个重要边界

- **按进程 owner，不按父 manager**：forkDriver 不在 parent 获取 lock；childControl().lock() 在 child 持有。父进程 replace 必须等旧 child exit 后 spawn；两个不同 manager 争相启动同名锁时，只有一个 child 可以成功获取（受下面的 Unix 文件 socket 例外）。
- **stale socket race 是已知限制**：Chord docs/spec.md 第 12 节明确写出：非 Linux Unix 上，两个进程几乎同时发现同一 stale file socket 时，可能都尝试接管。单 manager 的 serialized start 不能代替跨 manager 原子 stale-owner fencing。

该实现是 OS socket ownership 的基础策略，不是持久化 epoch/fencing token。如果两个实例持有不同 lock name 指向同一存储文件、未调用 child lock、或平台发生 stale-socket takeover race，数据库层仍可能出现多 owner 执行竞争。

### 3.3 锁与 fork 环境继承

forkDriver 显式删除 inherited CHORD2_LOCK，防止“子 Host 又 fork 子 Host”时把父 Host 的 lock name 继承下去，导致无意的 unavailable/locked。上游 regression test 专门覆盖该行为。

## 4. HostManager 状态与操作序列化

### 4.1 状态机

HostManager.status ∈ stopped / starting / running / stopping。

- start()：serial queue 中执行 doStart()；若已 running 返回同一 Instance；否则 spawn 新 child、等待 ready/fatal/exit/timeout（默认 readyTimeout 30 秒）；失败时 killTree 并 await exited。
- stop()：serial queue 中执行 doStop()；发送 shutdown，等待 child exit 或默认 5 秒 grace；超时 killTree，然后 await exited，清空 Instance 置 stopped。
- replace()：同一 serialized queue 先 doStop、await old exited，再 doStart；不能同 manager 内并发替换出重叠 live instance。
- child.exited handler 会清空当前 instance/status、停止 timer、调用 onExit。
- start/stop/replace 都通过 Promise tail 序列化；失败也让 queue 继续 drain。

**重要：没有看见 child crash 后自动 spawn 新 child 的内部循环。** exited handler 只把状态改为 stopped、调用 onExit；下次要由宿主或业务控制器再次调用 start/replace。Chord spec.md 也将自动重启列为已知限制。不能把“可以重新 start”描述成“Crash 自动恢复”。

### 4.2 子进程就绪与异常

- ready 是明确定义的启动 ACK，而不是 fork() 成功就认为 ready。
- fatal 使 start() reject；exited before ready 使 start() reject；readyTimeout 也使启动失败并 killTree。
- shutdown 没有独立完成协议；真实完成以 process exit 为准，grace 超时强杀整个进程组。
- send() 在 Node IPC 已 disconnected 时不再发送；对 EPIPE 的 write callback 错误采取忽略策略，独立的 child exit/disconnect 才是收敛依据。

该控制面只处理进程生命期；**对于 IPC 断开前已进入远端 tool.execute 的调用**，是否已产生副作用由真实 Host/tool ledger 决定，不因 child exit 自动恢复为未执行。

### 4.3 Liveness / idle stop

Manager 维护：

- booting；
- activeCalls；
- viewers；
- durableTasks；
- idleFor：从最后一次 busy→idle 过渡算起，booting 与工作中的 idleFor 为 0。

childControl.report(status) 报送三个计数。Manager 根据 keepAlive(liveness) 回调按 checkInterval（默认 1000ms）决定是否 stop。没有默认 idle stop policy：不配置 keepAlive 就不会因为空闲停止。

注意：
- liveness 只是 child 发送的 telemetry，不是从 SQLite TaskRecords 实时查询所得；
- 若业务没有正确 report durableTasks，manager 就无法凭这一统计保证活跃 DurableTask 不会因 idle policy 被终止；
- 可作为优化和资源调度信号，不能作为 Durable Task checkpoint 或恢复事实。

## 5. 上游真实子进程测试：覆盖与边界

来源：packages/chord/test/manager.test.ts 和 test/fixtures/worker.ts。测试源文件使用 Node fork、实际 IPC、Echo contract、processLock；**本轮只读测试代码，没有执行**。

| 上游 case | 源码中验证的性质 |
|---|---|
| deep TMPDIR processLock | 路径过长时仍只能有一个 holder；release 后可再次 acquire |
| inherited lock | child 无显式 lock 时不继承 parent CHORD2_LOCK |
| start → RPC → stop | child Host IPC link、Echo RPC、ready/exit |
| two managers same lock | 第二个 lock owner 的 child startup reject unavailable/locked |
| replace | 旧 pid 退出后才 spawn 新 pid |
| graceful exit + grandchild | child exit 后强杀进程组 descendants |
| idleFor | busy→idle 过渡后开始计数 |
| ignored shutdown | 超过 grace 后 SIGKILL process group |
| fatal startup | child fatal 导致 start 失败 |
| keepAlive | child idle 后停止 |

**未覆盖**：父进程突然崩溃、断电、跨 manager stale socket race、Windows 进程树完整清理、真实 SQL owner fencing、外部 MCP/HTTP tool side effect outcome、Host root lease / subscription 的断链重放。

## 6. 与 Chord Host/RPC 和 Durable Storage 的边界

### 6.1 Link crash 不代表 call 未执行

报告 54 已确认 Chord Link/Connection 的 cancel、root_end、state reset/resync 语义。Chord docs/spec.md 第 12 节明确说明：

- Links 不支持 resume；Link 断开后，provider 会释放通过该 link 持有的对象；
- in-flight call 断链返回 unavailable，但 **whether they ran is unknown**；
- 重连后 re-hold 的对象是新的 reference，不是之前引用的同一 runtime lease；
- cluster hot-reload 的 commit decision 本身不持久化，跨进程 crash 会影响版本同步。

因此重启 child 只重建进程/Link，不具备工具结果 exactly-once 与任意 RPC 方法 side-effect reconciliation。对于真实 Agent Tool 结果，需要 Durable Task state / Host operation ID / Receipt ledger 独立收敛。

### 6.2 进程互斥锁不等于任务租约

processLock(name) 可以作为单 host 的 OS 级排他入口，但不能独立保障：

- 业务存储名与 lock name 强制一一绑定；
- 应用代码在打开 Storage 前确实执行 lock；
- 旧 runtime 的远端外部 effect 已结算；
- 网络 partition / 多机器共享数据库的 fencing；
- 同进程多个 executor 重复执行同一 Task；
- 持久化 ownership epoch、TASK_RUNNING lease 与恢复 checkpoint 一致性。

**目标 Agent 应同时独立建模存储 owner、task owner、operation owner 与外部 effect outcome**，不能让一个 socket lock 覆盖所有边界。

## 7. 源码事实、推断和未知

### 已确认事实

- Node entrypoint export createHostManager、forkDriver、childControl、processLock。
- processLock 使用内核 socket/pipe 保持进程持有，Unix file socket 存在 stale takeover 路径；上游 docs 已承认竞争风险。
- forkDriver 清理继承锁，提供 child IPC 与进程组 kill。
- HostManager 序列化 start/stop/replace，启动等待 ready，停止等待 exit，grace 超时 killTree。
- liveness 依赖子进程 status reported fields；keepAlive 可选。
- childControl.lock 是子进程调用方必须显式执行的步骤。
- HostManager 没有实现持久化 Task/Receipt 或内部自动 respawn。
- Chord spec 已声明 Links do not resume，in-flight call 断线可能已执行但未知。

### 静态风险推断

- parent crash 后是否仍有 child/orphan owner：与 Node IPC disconnect、child host 自己的 exit handler、实际平台有关，不能仅凭 forkDriver/HostManager 认为被清理。
- processLock 只能约束使用同一名字并遵循 lock-before-storage 的进程；错配 lock name 或无锁 Host 仍可并发执行。
- liveness 的 durableTasks 上报如果过时，keepAlive 可在实际 Task 未结算时停止 child。
- 热更新 / crash / IPC 断开中未完成 Host RPC 的外部 side effect 仍可能未知。

### 仍未知

- Pi 产品层 v1.4.0 是否实际采用 Node HostManager 以及 child storage lock-before-open 约定；本轮搜索未获得可信完整调用链。
- 真正多进程、跨平台、故障/断电下的锁释放、parent crash、stale socket takeover、child reconnect 行为。
- ToolTask / external tool operation 在 child crash 后的 reconciliation、权限撤销和幂等性。
- Chord cluster reload 已知的非持久 commit decision 在 parent crash 中如何被产品层处理。
- processLock 与 pi-durable SqliteStorage 多 owner 竞争如何形成端到端约束；仍未接真实 Host。

## 8. 对独立目标架构的启示（未作决策）

1. **进程层**：每个实际 DB/Host owner 明确锁或 lease，不能只用 parent 内存 boolean；启动时要证明 lock-before-open。
2. **任务层**：持久化 owner epoch、checkpoint、abort marks、task result / unknown status；进程结束后要有 re-admission/reconciliation。
3. **外部副作用层**：每次工具请求有 stable operation ID、execution intent、receipt、unknown-outcome policy，且工具执行端做幂等或可查询结果。
4. **RPC 层**：Link 断开不应当推导 call rollback；reconnect 需要重新认证、重新 acquire、重建 subscriptions 与未完成 effect 对账。
5. **关闭/重启**：清理进程树是资源 containment，不是事务 rollback；stop grace 与 AbortSignal 的协作取消不能替代 Receipt。
6. **可观察性**：liveness 指标可驱动 idle 优化，但是否允许停机必须结合 durable task / commit barriers。
7. **部署与多平台**：socket lock、Windows named pipe、Unix stale file race、OS parent crash、多个 HostManagers 与跨机器共享卷需要单独验证。

## 9. 下一步

1. 研究 pi-durable CompactionTask：模型 context cut、summary、background compaction、staleness、task recovery。
2. 研究 pi-coding-agent v1.4.0 产品组合层，找到真正调用 Core 或 Durable 的路径，以及 MCP/permission/extension/session/RPC/host 的实际组装。
3. 整合 Claude CLI / Desktop / SDK 与 Pi 的同场景执行、工具、权限、上下文、持久化与恢复差异。
4. 先形成目标架构方案与风险/动态验证计划交用户审阅；没有明确批准前不进入开发。

## 10. 本轮边界

只新增本研究文档并更新 PR #49 的进度/README/研究评论；未更改 Kernel、业务代码或运行时。

## 11. Evidence index

| 固定 v1.4.0 上游路径 | Git blob SHA | 关键锚点 |
|---|---|---|
| packages/chord/src/manager.ts | 149f5e454094543cfab662af7fa198a81b419778 | processLock L83–162；forkDriver L165–236；HostManager L238–385；childControl L387–444 |
| packages/chord/src/node.ts | 89462cfc808dbe87528ad7560202ee9ea8007297 | Node-only public API exports |
| packages/chord/test/manager.test.ts | 4e48ebe85701817113d16a400cb1c37fa5addf76 | real-child tests L26–184 |
| packages/chord/test/fixtures/worker.ts | 6fffdcc6ab0b464391d3a794ac8e1f2b30d10770 | lock-before-host / ready / shutdown |
| packages/chord/docs/spec.md | ca9c93b383cb45902ab5c63539efb3fbcd8a58cc | known limitations: no resume, stale socket race, non-durable cluster reload decision |
| packages/chord/README.md | v1.4.0 root package | @earendil-works/chord/node entry and HostManager purpose |

**证据等级：** 固定 release source + 上游已有测试源码静态分析，未在本轮执行测试。真实多进程故障、网络、外部 tool、Power failure 尚未验证。