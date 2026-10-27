# 20 · M2 旧 PR #3 Command Inbox：租约栅栏、事务 ACK 与幂等

> 状态：**只持久化接收事实，不执行命令。** 本增量迁移了旧 PR #3 的命令 ID/指纹去重思想，**没有复制旧版 SQLite 存储、Tool Intent/Receipt 或自动重跑逻辑**，使用当前 `main` 的 SQLite `kernel_events`、Writer Lease/Fencing、ManagedSessionRunner。

## 一、协议语义：收到不等于执行

`SqliteCommandInbox.accept()` 和 `ManagedSessionRunner.acceptCommand()` 的成功结果表示：**命令及其内容已由本地 SQLite 事务持久保存，返回原始 Command ACK**。

- 命令持久接受 **不代表** 开始了 Turn、调用了模型、启动了 Host 或完成了副作用。
- 新 `command.accepted` 是 Session 级事件，`turnId` 必须不存在；Kernel/只读双账本对账读取时明确允许它，不会把它冒充 `turn.queued` 或 `tool.receipt`。
- 未决 Turn、未知 ToolCall 或损坏日志阻止 **新命令** 接受。相同命令重发只返回已提交的原始 ACK，仍不触发执行。
- 本增量不提供网络服务、工作队列 Dispatcher、自动执行、真实用户鉴权、撤回/取消控制、消息外发或 Exactly-Once 副作用协议。

## 二、接口

```ts
import { ManagedSessionRunner } from './packages/session-runtime/src/index.js';
import { SqliteCommandInbox } from './packages/command-inbox/src/index.js';

const runner = new ManagedSessionRunner('./agent.sqlite', provider, tools);
await runner.createSession('s');

// 客户端此前读取到 Session seq=1。同一个 commandId 可在 ACK 丢失后重发：
const ack = await runner.acceptCommand(
  's',                    // session
  1,                      // expectedSeq（新的命令必须与当前 Journal 相等）
  'command-unique-id',    // 幂等 ID
  'control.note',         // 命令类型：此处只是被审计的消息类别
  {instruction:'inspect'},// 持久 payload；不执行
);
// {sessionId, commandId, kind, fingerprint, acceptedSeq, replayed:false}

// 即使 expectedSeq=1 已过期，重复的同一请求只重播原始 ACK，
// 但同一 ID 对应不同内容/类型必须拒绝。
```

`SqliteCommandInbox.list(sessionId)` 只返回命令 ID、类型、指纹、接受 seq；不返回可能敏感的原始 Payload。Payload 作为明文保存在本地 SQLite `session_commands.payload_json`，未经认证的远端用户不应有数据库写权限。未来需要鉴权、保留期及加密和敏感信息清理。

## 三、持久准入事务

```text
ManagedSessionRunner.withLease
  -> Kernel.openSession 校验完整历史与不确定工具
  -> SqliteCommandInbox.accept
     BEGIN IMMEDIATE
       SQLite 服务器时间核对当前 Lease owner + Fencing Token
       同 Session/CommandId 若存在：核对 kind + SHA256(payload)，
         再核对原始 command.accepted Event；直接返回原始 ACK，不触发新事件
       若是新 ID：
         校验现有 Session 事件链、Seq、Turn 终态、ToolAudit
         expectedSeq == currentSeq
         验证每个历史 ACK 在 session_commands 中有一致去重记录
         INSERT kernel_events (command.accepted)
         INSERT session_commands (payload+SHA256+acceptedSeq)
     COMMIT -> 才可返回 Command ACK
```

- Fencing 在 **同一次 BEGIN IMMEDIATE** 里生效。旧 Owner 无法接受新命令，甚至不能利用这条 API 重播旧 ACK。
- 摘要：按 key 排序的 JSON 深度规范化，对 `{kind,payload}` 作 SHA-256；最多 64 KiB，最深 64 层。拒绝循环、getter、非普通对象、稀疏数组、NaN、Infinity、undefined 等；不悄悄丢字段。
- 重复 ID + 相同语义（即使对象 key 顺序不同）返回 `replayed=true` 的原始 acceptedSeq；重复 ID + 不同 kind/payload 返回 `ConflictError`。
- 同步 SQLITE 写入异常导致事件、命令表 **全部回滚**。若子进程在 COMMIT 后 ACK 到达前 SIGKILL，恢复后重复 ID 仍返回原始记录，不追加新事件。
- `command.accepted` 被纳入双账本 `evidenceHash`，可使已经开始的人工复核快照失效；它本身没有赋予任何审批权。

## 四、与现有运行时的相容性

`AgentKernel.openSession()` 和 `SqliteToolReconciler` 只在 `command.accepted` 的 Session 级位置放宽合法事件类型；其余普通事件仍强制属于有效活动 Turn，未决工具仍触发 `RECOVERY_REQUIRED`。

接受命令后仍可通过 `ManagedSessionRunner.runTurn()` 运行一个**独立**的 Turn；此操作并非对该接受命令的自动分发。**切勿将人工调用 runTurn 与 ACK 视为同一个幂等事务**。如果未来需要客户端通过单条请求真正启动 Turn，必须新增 Command Dispatcher/Turn Admission 协议并在一次可信事务中解决 ACK 与 Turn 关联、状态恢复、重复投递和取消。

## 五、测试与安全边界

新增 `tests/command-inbox.test.ts` 12 项：

1. 受 Fencing 管理的 Runner 接受命令，只有 ACK，不触发模型；
2. ACK 丢失后跨 Runner 重发只返回原始 Seq；
3. 同一 ID 不同 Kind/Payload 冲突；
4. 新 Command 对旧 Seq 拒绝，重复 ID 仍可确认；
5. 旧 Owner/Fencing Token 被新 Owner 接管后拒绝；
6. 严格 JSON：包括 getter（不能执行 getter）、循环、非有限数、过大 payload；
7. SQL Trigger 中途拒绝，事件与命令一起 rollback；
8. 篡改 ACK 不允许返回伪成功；
9. 未决 Turn 阻止新命令；
10. SIGKILL 后只返回已持久化 ACK；
11. Session 级事件可由只读对账和 Kernel 重开识别，不冒充 Turn；
12. Command ACK 修改人工复核所绑定的 `evidenceHash`。

上一阶段 125 项，本轮加 12 项，目标累计 137 项。GitHub Actions：Node 22.x/22.16.0、TypeScript strict、全部测试，以最终 SHA 为准。

下一阶段保留原 PR #2 的 Steering 与 Context Checkpoint（待单独状态机评审），以及生产级鉴权、沙箱和外部副作用执行协议；原 PR #3 的旧存储已由新版取代。
