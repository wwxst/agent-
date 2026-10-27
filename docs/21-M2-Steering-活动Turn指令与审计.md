# 21 · M2 Steering：活动 Turn 的指令接收、消费与故障审计

> 状态：Steering 只在**当前进程持有租约的活动 Turn**中可用，任何未知工具结果仍被阻断。不是远程 Inbox、不是高风险工具授权，不保证已接受输入最终一定得到完整模型回复。

## 交付

- `AgentKernel.steerTurn(sessionId,expectedTurnId,text)`：只允许已开始且正在 `running_model / running_tools` 的目标 Turn；目标不匹配、会话结束、已取消或被 Fencing 淘汰时返回 false。有效请求先持久化 `turn.steer_queued`，再返回 true。
- 内部同步入队，从而防止模型回复结束瞬间丢掉已经发起的 Steering 请求。下一次安全模型步骤前，原子写入 `turn.steer_consumed` + 对应 `user.message`；模型历史从原始事件投影，新输入因此能在下一次请求看到。
- 当模型本次文本已完整但存在排队 Steering 时，优先消费并继续下一 Model Step，而不提前写入 `turn.completed`。工具执行中 Steering 等待工具返回并结清 Intent/Receipt；不允许因为收到 Steering 自动中断未知工具并重放。
- `ManagedSessionRunner.steerTurn()` 将控制转交给当前活动且已持有租约的内存 Kernel，**不创建第二 Writer Lease、不另启新 Turn**。不同进程/重启后没有活动 Kernel 可操作，返回 false；未来需要具备鉴权和持久控制 Inbox 的 Remote Steering 协议。
- 新增 `packages/steering-audit`，检查每条 consumed 必须匹配此前未消费的 FIFO queued 记录，而且 consumed 后**紧邻**相同文本的 user.message（当前一次批量 EventStore.append）。队列剩余项不被默认为已处理。
- `AgentKernel.openSession()`、`SqliteToolReconciler`、`SqliteCommandInbox` 全部要求不存在 unconsumed steer：**即使 Turn 已记为 failed/cancelled，不能默默忽略已接受的用户输入并继续。** 审计报告新增 `unconsumedSteers`。

## 验证

新增 `tests/steering.test.ts` 9 项：
1. 只接受符合 expectedTurnId 的活动 Turn 指令；
2. 多次并发接受的 Steering 按 FIFO 顺序供下一步模型读取；
3. 未开始和已完成 Turn 拒绝迟到 Steering；
4. 经过 SQLite Fencing Runner 接收并由下一模型步骤看到；
5. 接收之后 Provider 崩溃使 unconsumed 记录残留，重开拒绝；
6. Cancel 后已经接受但未消费的 Steering 不可变成悄然完成；
7. 消费事件不紧邻匹配 user.message 被识别为损坏日志；
8. 历史存在未消费 Steering 时 Command Inbox 无法接受新命令；
9. 独立进程 Host 正在执行受信只读工具时接受 Steering；执行 Receipt 仍然齐全。

历史通过 137 项，本轮新增 9 项，总计目标 146 项，最终以两套 Node 版本的 PR CI 为准。

## 尚未实现的内容

- 远程多客户端 Steering 排队/断线恢复与认证授权：`ManagedSessionRunner.steerTurn()` 仅为**同进程控制句柄**；不提供跨进程事件订阅或生命周期保证。
- 运行中打断/抢占工具：Steering 不能当作 Cancel，也不意味着外部副作用回滚。
- 已接受但未消费的 Steering 仍仅有人工对账、没有自动恢复协调器；不允许抹掉 Event Journal 中这些未决事实。
- Context Checkpoint、可信摘要及上下文截断协议将作为下一独立变更，避免与本轮并发事件状态机混在一起。

相关：[旧 PR #2 Provider 整合](19-M1-旧PR2-真实Provider和CLI整合.md)、[Command Inbox](20-M2-Command-Inbox-事务ACK与幂等.md)、[双账本对账](17-M1-双账本只读对账与证据判定.md)。
