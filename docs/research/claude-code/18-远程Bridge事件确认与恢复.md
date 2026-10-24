# 18 · Claude Code 远程 Bridge、事件投递确认与恢复的一致性边界

> 2026-10-24 · 源码研究范围：用户旧仓库 Claude Code **2.1.88**，包括 RemoteIO、CCRClient、SSETransport、Bridge、sessionRunner。  
> 本轮没有访问 Anthropic 服务端实现，没有启动真实远程会话，也没有对 2.1.304 的相同路径做动态复核。因此以下是**客户端静态实现事实与自研推导**，不是云端 SLA 说明。

## 一、旧版确实有“本地 CLI + 远程控制平台”的多层结构

从 [sessionRunner.ts](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/sessionRunner.ts#L248-L343) 直接看到，Bridge 能启动 Claude CLI 子进程：

- 参数带 `--print --sdk-url ... --session-id ... --input-format stream-json --output-format stream-json --replay-user-messages`；
- 把 CLI 的 stdin、stdout、stderr 接成管道；
- 采用子进程环境变量提供短期 session access token；明确不把 Bridge 的 OAuth token 直接透传给子进程；
- 可依据部署模式设置强制沙箱和 CCR v2 等环境标记；
- 通过 NDJSON 解析子进程输出并监听 `control_request`、`user` 和工具活动。

这些事实说明该实现的**会话调度层与真实 Agent 执行进程可以分离**；远程 Web/桥接组件不是另一个独立的 LLM Agent Loop。

注意：这不能证明桌面端 3.1623.1 默认也是同一套启动路径，二者应分开研究。

## 二、RemoteIO 与 Client-Server 传输的组合

[remoteIO.ts L32–173](https://github.com/wwxst/-/blob/main/restored-src/src/cli/remoteIO.ts#L32-L173)：

- 双向传输支持 WebSocket 类型；
- CCR v2 模式要求 SSETransport（读）+ CCRClient（写），而不是把所有通信塞进 WebSocket；
- 创建 CCRClient 时需先注册收到事件的回调，再连接 SSE，防止早到事件没有 ACK；
- 在远程恢复时读回 worker metadata，监听命令生命周期；
- 连接/Token 回调能在重连时读取最新的访问凭据。

[replBridgeTransport.ts L12–20](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/replBridgeTransport.ts#L12-L20) 把传输明确划成：

```text
v1: WebSocket 读取 + POST 写入
v2: SSE 读取 + CCRClient/POST 写入 + Heartbeat + Delivery Tracking
```

对于自己的 Agent Kernel，业务协议不能依赖某种 Transport；需在 HTTP+SSE、WebSocket、stdio、远程队列之间保持统一命令与事件语义。

## 三、远程传输里的真实身份、Epoch 与游标

[replBridgeTransport.ts L106–155](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/replBridgeTransport.ts#L106-L155) 包含：

- Worker JWT 区别于 OAuth 访问令牌，且绑定 Session 与 Worker 角色；
- worker_epoch / 过期凭据的更新需要专门处理；
- `initialSequenceNum` 延续旧 Transport 已收到的 SSE 高水位，避免传输重建时从序号 0 重新播放整条历史；
- 多个并行 Session 使用 per-instance getAuthToken 回调，避免全局环境变量互相覆盖。

[remoteBridgeCore.ts L14–21](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/remoteBridgeCore.ts#L14-L21) 文档注释列出会话创建、换取 Worker JWT、SSE/CCR 启动，以及 HTTP 401 后保留 sequence 重建传输。

[SSETransport.ts L244–267](https://github.com/wwxst/-/blob/main/restored-src/src/cli/transports/SSETransport.ts#L244-L267) 会带 `from_sequence_num` / `Last-Event-ID` 恢复流；L468–533 包含退避重连与最终放弃预算。

**可直接确认**：旧版同时使用序列游标、Worker Epoch、凭证刷新和重连去重。然而仅从 CLI 端无法证明服务端 ACK、序号回收或重试保证覆盖所有竞争情景。

## 四、最重要的可靠性发现：收到不等于处理

[replBridgeTransport.ts L230–254](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/replBridgeTransport.ts#L230-L254) 的注释和代码是本轮关键证据：

- CCRClient 初始对 SSE 收到的事件报告 `received`；
- 常规 in-process Agent 还会根据执行生命周期报告 `processing`、`processed`；
- Bridge/daemon 的真实执行引擎在另一个子进程，因此相关模块内的生命周期回调无法简单贯通；
- 代码中因重复派发造成过多 phantom prompts，选择在 Bridge 收到事件时**同时 ACK received 和 processed**；
- 注释清楚描述了相应取舍：消息收到之后、真正写入子进程 Transcript 之前如果崩溃，可能丢失一次输入；但不必承受每次重启 N 次重复消息。

这并不是“Claude 远程系统不可靠”的泛化结论，它是一个**具体、可定位的旧版桥接逻辑与注释说明**。网络层 ACK `processed` 不代表子进程一定持久化、开始执行或完成执行。

### 四种必须分离的事实

```text
delivered  传输已交付数据（可重复）
   ↓
accepted   服务端已持久化请求并完成权限/幂等检查
   ↓
started    Tool Host / Agent Executor 已确认接手
   ↓
completed  业务操作已完成或有可审计的失败结果
```

用这四层状态，不依赖客户端是否正在线。尤其 `received` 和 `processed` 不可随意合并成“用户任务已经完成”。

## 五、远程副作用与重放为什么危险

如果子进程已经执行 Shell 或对外提交 API，Bridge 在崩溃前未能拿到结果，重建连接后不能直接再次执行这条工具调用。

这种情形要记录为 `outcome_unknown`，然后采取以下路径之一：

1. 工具宿主提供幂等键和执行收据，可先查询完成状态；
2. 对读工具可按照受控策略重试；
3. 对修改工作区的工具先检查文件版本/后置条件，再决定是否继续；
4. 对非幂等 Shell、消息发送、支付等副作用要求人工确认或专门的协调流程。

这属于**自研设计建议**，不是在声称 Claude 已经完整实现。

## 六、远程凭证刷新与重建竞态

[remoteBridgeCore.ts L283–354](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/remoteBridgeCore.ts#L283-L354) 明确用 `authRecoveryInFlight` 序列化换凭证过程，避免并发连接刷新；L477–505 使用旧 Transport 的游标生成新 Transport。恢复过程中 Worker Epoch 是请求的一部分，可防止旧 Worker 与新 Worker 同时被无序承认为同一工作者（实际服务端拒绝机制未在本轮核实）。

[ccrClient.ts L644–721](https://github.com/wwxst/-/blob/main/restored-src/src/cli/transports/ccrClient.ts#L644-L721) 能定位 Worker 状态报告与心跳；是否真正限制孤儿进程继续执行，还需 Host 层证据。

**自研内核建议引入 Fencing Token**：每次工作租约刷新产生单调增长 Epoch；Host 收到低版本请求必须拒绝执行，但 Epoch 本身不是授权凭证。

## 七、自己的 Remote Agent Protocol 建议

| 对象 | 必须有的字段 | 原因 |
| --- | --- | --- |
| ClientCommand | commandId、sessionId、expectedTurnId、callerId、idempotencyKey | 防止重复提交和误投 |
| DurableEvent | eventId、sessionId、sequence、committedAt、schemaVersion | 可按游标重放 |
| WorkerLease | workerId、sessionId、epoch、expiresAt、capabilitySet | 恢复与 fencing |
| ToolInvocation | toolCallId、argsHash、toolVersion、epoch、hostId | 不重复执行外部副作用 |
| DeliveryAck | eventId、transportReceivedAt、durablyAcceptedAt、resultState | 区分网络收到与业务已处理 |
| WorkerReceipt | toolCallId、outcome、hostSequence、artifactRef | 核实副作用完成与工件来源 |

Client 的回放游标按 Session 记录；Worker 的执行收据按 ToolCall/Host/Epoch 记录，两者不可用一个数字代替。

## 八、故障注入矩阵（待实现）

- T18-01 SSE 重连后重复消息，只提交一个 Turn；
- T18-02 Broker/Bridge 收到消息但 Agent 未写持久日志时崩溃：请求可从 Durable Inbox 恢复；
- T18-03 子进程已执行但 ACK 丢失：外部非幂等 ToolCall 不自动执行第二次；
- T18-04 401 更新凭证时，原 sequence 不倒退、不漏读取；
- T18-05 两个 Worker 同时宣称同一 Session：过期 Epoch 无法产生新的副作用；
- T18-06 客户端反复取消/批准，不重复改变持久 Turn 状态；
- T18-07 Terminal Event 成功写入后广播失败，重连能读到同一终态；
- T18-08 先广播“已完成”再写盘的实现必须在协议测试中失败；
- T18-09 并行不同 Session 的 token 不得通过进程级环境变量交叉混用；
- T18-10 关闭 Server 时必须 drain 活动工具结果，不能将未知状态伪装为取消成功。

## 九、尚未确认

1. 2.1.304 或 Desktop 3.1623.1 是否仍采用相同 v2 ACK 优化和回放策略；
2. 服务端如何事务提交命令/租约/ACK，远程 Broker 是否具备更强的一致性恢复；
3. 真实 OS 级沙箱是否在所有 remote worker 上启用；
4. 子进程执行 Shell 后服务端是否保存持久 ToolCall 收据；
5. 上述任何测试在真实部署中是否通过。

**结论**：借鉴 Claude Code 的多传输、序列游标、凭证刷新、Worker Epoch 与 Bridge 解耦，同时避免把网络收到当作业务处理成功。自研内核应以事件事务与工具执行收据来定义恢复，而非依赖一次 WebSocket/SSE ACK。
