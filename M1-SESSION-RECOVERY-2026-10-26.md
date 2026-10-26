# M1 第四批：Session 恢复入场、事件完整性与取消失败保护

> 2026-10-26 · 开发分支 `feat/kernel-m1-provider-stream`。研究结论落入真实内核代码，使用 Node 22.16.0 + TypeScript 严格模式的离线测试。**恢复对象仍是内存 EventStore 中的已有事件**，不是磁盘重启恢复、生产断电保证或跨进程 Exactly-Once。

## 实现内容

1. 新增 `AgentKernel.resumeSession(sessionId)`：新建 AgentKernel 实例后，可从传入 EventStore 读取并检验**已静止、全部 Turn 都有终态**的 Session，重新建立 Session ID 与下一个事件序列，继续处理新的 Turn。
2. 拒绝没有 `session.created`、重复创建、事件序号断裂、跨 Session 串入事件、重复 EventId、重叠 Turn、重复 TurnId、无 Start 就 Terminate 的错误日志。
3. 对 Assistant ToolCall 与 `tool.result` 做关联：孤立或重复结果是日志错误；存在 ToolCall 未收到结果时返回 `SESSION_RECOVERY_REQUIRED`，**不会重新执行工具，也不会合成“未执行”或“成功”的结果**。
4. 对 Context Checkpoint 验证 `throughSeq`：必须是此前已经完成的 Turn 边界，不能跳过 Failed/Cancelled 的历史，摘要内容必须有效。恢复后模型读的是 Checkpoint 派生投影，原 EventStore 历史不被修改。
5. 对 `resumeSession` 入场先同步占位，防止两个恢复调用或创建操作并发争夺同一个 Session ID。
6. 修复 `cancelTurn` 在 `turn.cancel_requested` 事件写入失败时可能无法向阻塞的 Provider 发送 Abort：现在 `finally` 总会发出停止信号，写入失败仍向调用者抛错，**不会谎称取消请求已持久接受**。
7. 本轮**没有自动恢复未结束 Turn**；在缺少可靠 Host Receipt 的情况下，这样做会引入重复副作用风险。M2 再引入重启后 Tool Intent/Receipt 的明确协调流程。

## 验证

```bash
npm run check
npm test
```

- 60 项基线回归通过。
- 9 项新增恢复/取消故障测试通过。
- **总计 69/69 通过**。测试涵盖：成功重新挂载继续问答、Checkpoint 投影、未知 Session、未结束 Turn、未配对工具、事件序号与 ID 损坏、非法摘要边界、并发 Resume、取消事件写盘失败导致 Provider 阻塞。
- 以上运行结果来自离线 Node 内建测试；**未进行真实远程模型请求或任何有副作用的 Shell 执行**。

## 关键边界

- `resumeSession` 仅恢复**可证明安全的终止后历史**。如果 Turn 中途崩溃，返回 `SESSION_RECOVERY_REQUIRED`；让后续的专用协调器依据可信 ToolHost 收据再决定是否可恢复。
- `MemoryEventStore` 不可跨操作系统进程/掉电保存；目前只是同一份 EventStore 对象被新的 Kernel 实例重用，以验证日志检查与状态恢复逻辑。
- EventId/Seq 检查属于结构一致性，不是恶意篡改认证；M2 需要事务存储、身份/策略与写入原子性。
- `context.checkpoint` 是模型输入投影，不是执行事实；不能覆盖用户授权和工具收据。
- 对失败写入的取消信号，内核会尽力使 Provider 停止，但无法从内存 Signal 证明任何外部副作用已取消。
- 尚未具备可安全重试的 Provider Policy、物理 Token 预算、精确 tokenizer、真实 Context Summary Provider 或分布式 Worker Recovery。

## 下个阶段

先完成剩余 Provider 兼容/请求能力协商和实际模型联调，再把 `EventStore` 迁移到 SQLite 事务实现，设计 Tool Host Intent/Receipt。持久化和权限根属于 M2，不通过协议假象提前宣称可靠。
