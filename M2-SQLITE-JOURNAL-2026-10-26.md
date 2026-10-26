# M2 研发记录 · SQLite WAL 事务事件日志与命令幂等

日期：2026-10-26。基于 `feat/kernel-m1-provider-stream` 的 M1 69 测试版本新建 `feat/kernel-m2-sqlite-journal`，`main` 不修改。

## 实际代码

- `packages/event-store-sqlite/src/index.ts`：新建 Node 内建 `node:sqlite` 的 EventStore Adapter，包含 Session、Event、Command 三张 SQLite 表。
- `packages/contracts/src/index.ts`：`KernelEventType` 新增审计事件 `command.accepted`。
- `packages/kernel-core/src/index.ts`：恢复日志时允许并严格校验 `command.accepted`；命令接受事件不是 Tool Host 授权。
- `tests/m2-sqlite.test.ts`：对真实磁盘文件运行 16 项新增测试；拒绝非 JSON 值、过大事件、陈旧 CAS、重复命令和损坏日志。

## 写入协议

`BEGIN IMMEDIATE` → 读取/对比 Session 版本 → 向 Event Journal 写入整个 Batch → 如为 `acceptCommand`，同事务写 `command.accepted` 和 `(sessionId,commandId,fingerprint)` 记录 → `COMMIT` → 才返回接受收据；所有错误回滚。

相同幂等 ID / 相同规范化 JSON 内容重试只返回原始收据；相同 ID / 更改参数明确返回 `ConflictError`。命令指纹是 SHA-256 内容摘要，不是可用来提权的签名或 Secret。**当前 `acceptCommand` 没有与 HTTP/CLI `runTurn` 接口整合，不可声称整个 Agent Turn 已实现幂等执行。**

## 真实执行验证

```text
npm run check  → TypeScript 严格检查通过
npm test       → 85 tests; 85 pass; 0 fail; 0 skipped（本地 Linux）
```

关键测试：SQL Trigger 在 batch 第二条事件插入时制造失败，第一条也不能写入；跨两个 SQLite 连接抢相同 `expectedSeq` 只允许一个提交；进程提交命令并输出 ACK，随后被父进程 `SIGKILL`，新的 SQLite 连接能够恢复原始事件，重复调用返回 `replayed:true` 且不新增事件。

**这不是物理掉电测试。** WAL/FULL 的配置不代替磁盘、文件系统及硬件的验证。工具副作用一旦发起也不能被 SQLite 回滚，所以不能宣称 exactly-once 外部执行。

## M2 下一步

1. 将 `acceptCommand` 接入 Kernel 的 Turn Command Admission 和客户端幂等响应（不能在异步入口之间留下新的竞争窗口）。
2. 设计并实现可信 `ToolCallIntent` + `HostReceipt` 的事务格式、恢复协调器，非幂等 Unknown 不能自动重执行。
3. 独立 ToolHost 的能力根、参数指纹核验和 OS 沙箱 fail-closed；M2 完成前不启用危险 Shell。
4. 为 EventStore 添加跨进程 Worker/写入背压、数据库版本迁移及磁盘错误注入测试。

架构依据：[ADR 0005](docs/adr/0005-首版自主内核技术基线与取舍.md)、[四内核持久化审计](docs/research/comparative/12-四内核执行与持久化证据审计.md)。
