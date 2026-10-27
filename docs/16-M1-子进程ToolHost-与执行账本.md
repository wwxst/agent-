# 16 · M1 子进程 Tool Host：本地 IPC、Fencing 与持久执行账本

> 交付状态：**已实现最小的真实子进程 Tool Host 与 Host 自身执行前/执行后 SQLite 栅栏**，仅白名单只读演示工具；未实现 OS 权限沙箱、租户鉴权、外部副作用工具、Host Receipt 与 Kernel Receipt 原子跨进程提交或 exactly-once。此增量仍**不能部署为不可信代码执行服务**。

## 一、本次实现的系统边界

新增模块：

- `packages/tool-host/src/index.ts`：父进程 `ProcessToolHost`，使用 `node:child_process.fork` 启动 `worker.js`，通过 Node 内置 IPC 发送工具请求。
- `packages/tool-host/src/worker.ts`：真实子进程入口。进程自己选择并检查工具白名单，不执行父进程传来的任意脚本、命令、插件或模块。
- `packages/tool-host/src/ledger.ts`：`HostExecutionLedger`，用 SQLite WAL + `synchronous=FULL` 保存 Host 侧执行状态。
- `packages/contracts/src/index.ts`：新增 `ToolExecutionContext`（`sessionId`、`turnId`、`callId`），是路由元数据，**不是权限证明**。
- `packages/session-runtime/src/index.ts`：`ManagedSessionRunner` 的工具参数支持 `(lease: WriterLease) => ToolRegistry`，使每次 Turn 注入独立租约的 Host 代理 Registry。
- `packages/tool-scheduler/src/index.ts`：向每次工具调用传递可信 Kernel Context，并保留 `LEASE_LOST` / `TOOL_OUTCOME_UNKNOWN` 的 fail-closed 语义。

简化拓扑：

```text
父进程 AgentKernel
   |
   |  assistant.message + 所有 tool.intent 持久提交
   |  ManagedSessionRunner 提供当前 Fencing Token
   |
   v
Tool Scheduler / ToolDefinition（仅 IPC 代理）
   |
   |  {lease, turnId, callId, toolName, input}  经本地进程 IPC
   v
独立 Node 子进程 worker.js
   |
   |  严格工具白名单、参数再校验
   |  BEGIN IMMEDIATE:
   |    验证数据库里的当前 Session Lease owner/token/有效期
   |    验证原始 assistant.message 的 ToolCall 身份与参数
   |    验证匹配的持久 tool.intent 已提交
   |    拒绝历史重复 callId、已完成 Turn 或已有 Receipt
   |    写入 host_tool_executions.state='started'
   |  COMMIT
   |
   |  执行白名单只读工具
   |
   |  BEGIN IMMEDIATE:
   |    再检查当前 Lease + STARTED 记录
   |    写入 state='succeeded'/'failed'
   |  COMMIT
   v
IPC 响应父进程 -> tool.receipt + tool.result 同批次持久化
```

**为什么两次事务**：执行前必须先保存 STARTED，使 SIGKILL 后能检测到已开始或可能已开始的操作。工具执行不能长期占据数据库写锁，执行结束单独复核 Token，避免旧 owner 在被接管后继续确认成功。

Host 执行账本主键为 `(session_id, turn_id, call_id)`，保存 `fence_token`、`tool_name`、`state`、`content`。`STARTED` 是最保守的未知状态；即使 Host 曾经在进程内执行过，只要没有可靠完成记录，便不能自动重跑。成功记录也**不意味着父进程已经保存 Kernel Receipt**。

## 二、只读工具与安全限制

本轮子进程内只有两个演示工具：

- `read.echo`：读取 JSON 对象的 `text`（最长 1024 字符）并原样返回，**不访问文件或网络**。
- `read.sleep`：最多 1500ms 的有界延迟，用于租约接管、IPC 超时和 SIGKILL 故障注入；不调用 Shell/系统服务。

Host **不接收任意工具模块和可执行脚本**。即使调用方伪装工具名/风险标签，服务端仍自行判定是否在白名单并重新校验参数。任何子进程校验失败都不写入 STARTED 记录。

父进程 fork 时关闭 stdout/stderr 交互、剔除继承的环境变量和 `execArgv`，减少意外暴露；**但是进程仍与父进程共用操作系统用户权限、磁盘访问权限和文件系统**。这不是 seccomp/namespace/chroot/container/AppContainer/sandbox，也没有用户身份认证、网络 ACL、密钥保护或可证明的进程隔离。

## 三、调用方式

```ts
import { ProcessToolHost } from './packages/tool-host/src/index.js';
import { ManagedSessionRunner } from './packages/session-runtime/src/index.js';

const host = new ProcessToolHost('./agent.sqlite');
try {
  const runner = new ManagedSessionRunner(
    './agent.sqlite',
    provider,
    lease => host.createRegistry(lease), // 绑定本次 Session 的 Fencing Token
  );
  await runner.createSession('s1');
  const result = await runner.runTurn('s1', '调用 read.echo', 't1');
  // Provider 可输出 ToolCall {id:'c1',name:'read.echo',arguments:{text:'hello'}}
} finally {
  host.close();
}
```

`ProcessToolHost` 必须先启动且与 Runner 指向**同一 SQLite 文件**。示例中的 `provider` 为业务调用方提供的 `ModelProvider`；并非已经提供 HTTP 服务或 CLI。

`ProcessToolHost.invoke()` 是受信调用方的底层接口，不能直接公开给未授权用户；它依赖数据库内部的租约、Tool Intent 和原始调用核对，不信任 IPC 传入的身份、参数或过期时间。Worker 对 `lease.expiresAtMs` 的输入**忽略**，以数据库时间验证。

## 四、崩溃、不确定结果与恢复判定

| 故障点 | Host 执行账本 | Kernel 收据 | 安全处置 |
| --- | --- | --- | --- |
| 请求无持久 Intent | 无记录 | 无 | 拒绝执行 |
| 旧租约/错误参数/未知工具 | 无记录 | 无 | 拒绝执行 |
| STARTED 持久提交后进程崩溃 | `started` | 可能缺失 | `outcome_unknown`，禁止自动重试 |
| 工具执行中 Token 被新 owner 接管 | `started` | 可能缺失 | Host 不得用旧 Token 写 succeeded |
| Host 成功落库，父进程尚未存 Receipt 就崩溃 | `succeeded` | 缺失 | 需要对账，不得再次执行 |
| 父进程与 Host 断开或 IPC 超时 | `started` 或 `succeeded` | 可能缺失 | `TOOL_OUTCOME_UNKNOWN` |
| 相同 Session/Turn/Call ID 重复请求 | 不新增记录 | 视历史而定 | 永远拒绝重复启动工具 |
| 正常执行且 IPC 回复成功 | `succeeded` | succeeded Receipt + Result | 可继续 Kernel Loop |

`HostExecutionLedger.inspect(sessionId)` 可只读检查主机执行状态；`inspectToolAudit(events)` 检查 Kernel 事件上的 Intent/Receipt。两份状态必须对账后才能判断是否应由可信协调器修复事件日志。**本阶段仅提供审计接口，没有合并修复、授权重放或恢复执行的功能**。

## 五、验证矩阵

新增 `tests/process-tool-host.test.ts` 共 10 项：

1. 子进程 PID 与父进程不同，真实 IPC 接入 ManagedSessionRunner，Tool Intent/Receipt 与 Host `succeeded` 记录相互核对；
2. 无持久 Intent、篡改 ToolCall 参数、伪造工具名拒绝；
3. 即使存在匹配 Intent，高风险 Shell 名称仍由 Host 拒绝；
4. 已执行 Call ID 的再次请求不重新运行；
5. 租约被新 owner 接管后，旧持有者请求被 Host 拒绝且不开始执行；
6. Host STARTED 后 Token 被接管，旧 Host 无法确认成功，只保留未知状态；
7. 子进程 SIGKILL 后保留 STARTED，重启 Host 不执行旧调用；
8. IPC 超时产生未知结果，不伪装成工具失败；
9. Host 已成功但 Kernel 未记录 Receipt 的双账本断点仍禁止重放；
10. 服务端参数非法，拒绝并不产生 STARTED 状态。

GitHub Actions 在 Node 22.16.0 与 Node 22.x 上运行 `npm run check` / `npm test`，累计应为 **65 项**；最终以对应 workflow 成功记录为准。

## 六、剩余重要缺口

1. **OS 强制隔离**：为真正可写文件、Shell 或第三方工具建立最小权限的独立用户/namespace/container、资源预算和审计，不可仅依靠 child_process。
2. **单独可验证的工具 Host 身份、授权与可信配置**：目前同 OS 用户和 DB 文件权限，恶意客户端若持有 DB 原始写权仍可绕过应用层校验。
3. **Host/Kernel 账本对账协调器**：进程间不能原子提交两个不同时间点的状态；未决 Receipt 仍需保守判定。
4. **执行中断强制语义**：只读工具关闭 worker 时使用 SIGKILL，STARTED 保留未知；需要资源回收/子进程树隔离/执行预算与可审计回收。
5. **真实副作用权限/审批/幂等**：有外部动作的工具仍禁用，不能由只读白名单的测试结果推导出副作用 exactly-once。

参考：[M1 Intent/Receipt](15-M1-Tool-Intent-Receipt-执行审计.md)、[M1 Writer Lease](13-M1-Writer-Lease-与-Fencing-Token.md)、[M1 ManagedSessionRunner](14-M1-ManagedSessionRunner-自动租约与中断.md)、[ADR 0003](adr/0003-远程控制事件确认与执行收据.md)。
