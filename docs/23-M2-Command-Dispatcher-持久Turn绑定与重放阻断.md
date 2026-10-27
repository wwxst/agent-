# 23 · M2 Command Dispatcher：持久 Command ACK → 唯一 Turn 的原子绑定

> 状态：**可信本地 Dispatcher 已实现首次分发与模型循环、重复交付只返回状态、绝不盲目重放**。没有后台轮询队列、网络鉴权、跨主机协调或外部副作用 exactly-once。独立 Tool Host 仍只有受信演示只读工具，生产沙箱尚未实现。

## 一、为什么不能直接 `runTurn`

[20 Command Inbox](20-M2-Command-Inbox-事务ACK与幂等.md) 只负责持久命令接收、ACK 和内容指纹，不自动分发。在独立的 `acceptCommand` 和 `runTurn` 之间如果没有持久对应关系，客户端丢失 ACK 后可能把相同请求当成新 Turn，再次调用 Provider / Tool Host。

本轮新增 `packages/command-dispatcher`：

- `SqliteCommandDispatcher.bind({lease,commandId,expectedSeq})` 只对已经接受的 `kind='turn.run'` 命令生效；Payload 必须严格是 `{text:string}` 且非空、长度受限。它本身不调用模型/工具。
- 在 **BEGIN IMMEDIATE** 内使用 SQLite 当前时间验证 Writer Lease owner 和 Fencing Token，验证完整 Session 事件链、Tool/Steering/Context 审计及 Seq CAS，再把 **command.turn_bound（Session 级）+ turn.queued + user.message + turn.started** 四条事件，以及 `command_turn_dispatches` 唯一映射记录，一次 COMMIT 落库。SQL 中途失败全部回滚，绝无半条 Turn Admission。
- `command.turn_bound` 记录命令 ID、唯一 Turn ID、原始 acceptedSeq、**用户文本 SHA-256 指纹**；`packages/command-dispatcher/src/audit.ts` 检查连续四事件、身份、文本指纹以及是否存在重复命令绑定。指纹只防意外篡改，不是防同权限 DB 写入的数字签名。
- `command_turn_dispatches` 以 `(session_id,command_id)` 为主键，约束同一 `(session_id,turn_id)` 及 `(session_id,bound_seq)` 唯一；原始 Command Inbox ACK 与 `session_commands` 记录仍保持不变。
- `AgentKernel.openSession`、`SqliteToolReconciler`、`SqliteCommandInbox` 均审核这种 Session 级事件及完整绑定关系；破损历史 fail-closed。

## 二、可信运行时入口

```ts
const runner = new ManagedSessionRunner('./agent.sqlite', provider, toolRegistry);
await runner.createSession('s');

// 客户端之前看到的 Journal seq 为 1，先接收并返回持久 ACK：
await runner.acceptCommand('s', 1, 'user-command-unique-id', 'turn.run', {
  text: '请做一次只读查询',
});

// 可信服务端显式开始执行：
const dispatched = await runner.dispatchCommand('s', 'user-command-unique-id');
// 首次交付 {dispatch:{turnId,status:'completed',replayed:false}, execution:{...}}

// 客户端请求重试：只查询原来绑定的 Turn，不再启动模型
const repeated = await runner.dispatchCommand('s', 'user-command-unique-id');
// {dispatch:{同一个 turnId,replayed:true,status:'completed'},execution:undefined}
```

- 首次调用时，`ManagedSessionRunner` 在自己的 Writer Lease 生命周期里先确认 Session 可安全重开，再绑定并调用 `AgentKernel.runTurn(...,dispatchProof)`。Kernel 验证当前 Session cursor 必须恰好在四条绑定事件之前，并再次检查 `commandId/turnId/文本/boundSeq` 对应关系，才接续执行；**不会写第二份 Turn Admission**。
- **若调用方重复交付同一命令**，即使这次状态只停留在 `admitted`，Dispatcher 也只返回原先绑定的状态，**不会重做**已绑定的 Turn。没有“模型尚未开始所以可以安全自动重跑”的乐观假设。
- `model.started` 是模型循环已开始的持久边界；如果进程在这之后停止，重试只会报告 `model_started` 或更保守的 `outcome_unknown`，不调用 Provider。
- 有未决 Tool Intent/Receipt、未消费 Steering、损坏 Checkpoint 时报告 `outcome_unknown` 或 fail-closed；报告是证据而不是恢复授权。终态 `completed/failed/cancelled` 不可通过客户端重试重新执行。

### 状态和含义

| 状态 | 含义 | 能否自动重试模型/工具 |
| --- | --- | --- |
| `admitted` | 命令已绑定且 Turn 入场，尚无 model.started | **不能**，防止崩溃窗口造成双重执行 |
| `model_started` | 已持久记录至少一个模型步骤开始，未有确定终态 | **不能** |
| `completed` / `failed` / `cancelled` | 原 Turn 已有终态 | **不能**；只能读取状态 |
| `outcome_unknown` | 可能存在未决工具、助手执行记录或未消费指令 | **必须人工核查，不得重放** |

**命令接受、Turn 绑定、模型启动、工具收据是四种不同的事实。** 即使由同一个 Runner 协调，它们也不能被宣传为跨外部模型与外部副作用的单个 exactly-once 事务。

## 三、崩溃与异常

- 数据库拒绝写入 `command_turn_dispatches`：四条新的 Kernel Event 一起回滚；下次仍可从同一个持久 ACK 再次进行首次绑定。
- **绑定 COMMIT 后、模型开始前进程 SIGKILL**：后续只返回该命令原 Turn 的 `admitted` 状态；不能自作主张重跑 Provider。
- 模型步骤开始后进程退出/租约失效：只读取 `model_started` 或 `outcome_unknown`，新的 Writer Token 不得重新使用旧的执行许可。
- 两个 Dispatcher 争抢同一个 Session：通过 Writer Lease 与 SQLite BEGIN IMMEDIATE 串行化；同 CommandId 映射仍唯一，失败或重投递不能新增一个绑定。
- 异常用户文本/命令类型/不匹配的 ACK 指纹、篡改的绑定事件/用户文本/映射表导致拒绝，不假装完成。

## 四、测试

`tests/command-dispatcher.test.ts` 新增 **12 项**，涵盖：首次绑定并完成 Turn、失联后跨 Runner 查询、非 `turn.run` 拒绝、不合法 Payload、原子回滚、绑定后 SIGKILL、持久 `model.started` 重放屏障、旧 Writer Token 被接管、前一个 Turn 未完成阻断新分发、故意篡改绑定文本（Kernel/只读对账/Dispatcher 全拒绝）、真实独立 Host 的单份 Intent/Receipt、模型失败后重复投递不运行第二次。

历史累计 158 项，本轮 12 项，目标 **170 项**。Node 22 / Node 22.16.0 严格类型检查及测试以最新 PR CI 为准。

## 五、下一步

1. 生产级 authenticated Dispatcher Service：验证调用者身份、租户隔离、命令类型 ACL、事件订阅，以及 ACK/status 分离的远端协议。
2. 更精细的恢复协调器：针对“已绑定但模型未开始”建立具备签名/审批的人工恢复决定。**这次没有开放任何自动重放**。
3. 强制 OS Tool Host 沙箱、独立进程凭证/权限边界、外部副作用最小能力模型，以及外部系统后置条件证明。

参考：[Command Inbox](20-M2-Command-Inbox-事务ACK与幂等.md)、[Steering](21-M2-Steering-活动Turn指令与审计.md)、[Context Checkpoint](22-M2-Context-Checkpoint-可信摘要投影.md)、[双账本对账](17-M1-双账本只读对账与证据判定.md)。
