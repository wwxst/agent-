# 24 · 第十轮：可信 Workspace 文件提交器与 Host Ledger 联动实证

> 2026-10-28；基线 `wwxst/agent-@9662809913285c46cc0ad2e91ad156beb113305f`。本轮实现**仅供可信调用方使用的 Linux 文件提交控制器候选**。它不注册为模型工具，默认的 `risk:write` 拒绝没有改变；**不宣称可供不可信扩展或多租户环境生产使用**。

## 1. 固定运行证据

| 项目 | 结果 |
| --- | --- |
| 提交器与 Ledger 验证提交 | [`600d639668f7a676bdcd883651b905ff544994d1`](https://github.com/wwxst/agent-/commit/600d639668f7a676bdcd883651b905ff544994d1) |
| 完整 CI | [GitHub Actions #40649926158](https://github.com/wwxst/agent-/actions/runs/40649926158) |
| Node.js 22.16.0 / 22.23.3 | 两个 Job 都是 `success`；每个 282 tests / 281 pass / 0 fail / 1 skip |
| 新增测试 | `WORKSPACE-COMMIT-01` 至 `05` 均实际执行且未跳过 |
| 唯一跳过 | 原有受 CI 父 cgroup v2 有限资源配额影响的条件测试；不是本轮的提交器测试 |

对照第 23 号报告：之前只验证`previewWorkspacePatch()`纯函数和隔离 Stage；本轮是真实 Linux 文件操作与共享 SQLite Host Ledger 联动。

## 2. 新增实现及精确执行序列

新增 [`workspace-commit.ts`](../../../packages/tool-host/src/workspace-commit.ts)，导出 `TrustedWorkspaceCommitController`。扩展 [`ledger.ts`](../../../packages/tool-host/src/ledger.ts) 一个仅供受信进程调用的 `finishSuccessWithEffect()`。该方法使用 `BEGIN IMMEDIATE` 在同一数据库写锁内校验原租约、执行同步文件副作用、写入 `host_tool_executions.succeeded` 并提交数据库事务。

流程：

1. 由受信的构造者指定工作区根、独立的 Host DB 路径及不可由模型供应的 `authorize(call)`。Linux-only；校验根与数据库不交叠。
2. 将 `HostCall` 限定为 `workspace.patch`，验证相对路径、Base SHA-256、旧片段唯一匹配、文件长度、目标文件普通文件属性、所有权以及 `nlink === 1`。拒绝符号链接、特殊文件和硬链接目标。
3. `HostExecutionLedger.begin(call)` 在 **`STARTED` 持久化之前** 通过原有 Ledger 合同检查 Writer Lease、同一 Turn 的已持久 `assistant.message` 和单一 `tool.intent`；重复 ID 不得重新领取。
4. 在目标文件**同一目录**写入唯一临时文件、同步文件内容、保留基本权限位；再次检查文件内容版本与 inode 身份、授权与取消状态。
5. 在 Ledger 的 `BEGIN IMMEDIATE` 事务内再次校验租约，运行受信同步回调实施 `rename`，同步父目录，再进行授权检查及 Ledger 成功记录。跨进程租约写事务不能在这一短暂临界区完成所有权转移。
6. 完成时返回原 SHA-256 与候选 SHA-256；**一旦 `STARTED` 后出错，保守返回 `TOOL_OUTCOME_UNKNOWN` 并保留 `STARTED` 待审计**。文件与 SQLite 并非同一种原子事务，绝不能自动重复提交。

该控制器**不会写入 Kernel EventStore 的 `tool.receipt` 事件**；它写的是 Host Execution Ledger。后续必须在受信调用层实现从 Ledger 到 Kernel Receipt 的持久协调与恢复对账。

## 3. 动态测试证据分级

| 测试 | 实际证实 |
| --- | --- |
| `COMMIT-01` | 纯预览不改文件；真实 Linux 临时文件 + 同目录 rename 后候选哈希正确，Ledger 最终 succeeded，旧摘要不能重复提交 |
| `COMMIT-02` | 路径越界、symlink、hardlink、过期 SHA-256 拒绝，且不产生 STARTED |
| `COMMIT-03` | 不存在持久 Intent、预授权失败、执行前取消均不写入目标文件 |
| `COMMIT-04` | 通过受信故障注入在 rename **之后**撤销授权：文件已改变但数据库事务回滚，Ledger 保留 STARTED；恢复原文件后仍拒绝重领旧 ID |
| `COMMIT-05` | 通过故障注入在 STARTED 之后释放 Lease，最终事务拒绝执行 rename；新的 Fence Owner 也不能重领同一个 Tool Intent |

`PASS` 表示对应测试下的精确不变量成立；并不意味着经过断电、敌对并发或未知文件系统特性认证。

## 4. 安全与工程限制（必须保留）

- **只可用于独占控制的可信 Workspace**。Node.js 的 `lstat/open/rename` 路径组合不能替代 `openat2`、目录文件描述符锚定或 `renameat2` 的原子条件操作；对恶意进程并发重命名父目录等 TOCTOU 尚无防护。不得直接应用于多租户共享、未受隔离的真实仓库。
- **最小普通 UTF-8 文件场景**。文件大小上限 256 KiB；拒绝已有硬链接、symlink、特殊文件。保留基本 Unix 权限位，不承诺 ACL、xattr、SELinux label、所有者策略、Git 工作区语义或所有文件系统上的完整元数据一致性。
- **未知结果必须人工或专用 Reconciler 处理**。SQLite 与文件系统持久化之间可能崩溃，只有 `STARTED` 与真实文件内容联合审核后才能判断是否完成；不能把 `UNKNOWN` 当作“未执行”。
- **审批与身份仅为接口边界**。`authorize` 是可信调用者同步回调，本轮没有完整的权限数据库/可撤销 Approval 生命周期、模型 API 入场、WorkspaceHost 独立进程身份认证或审计策略。
- **生产编码尚未开放**。ToolScheduler `risk:write` 仍被 M0 策略拒绝；现有 ProcessToolHost Worker 白名单仍只读。Stage/test 沙箱与此提交器尚未接成同一个生产端到端 Kernel Turn。
- **环境实测有限**。未验证多进程恶意文件竞争、实际断电、写中断目录恢复、跨 OS、生产 cgroup+Seccomp+Workspace 组合、进程树杀死及 Pi/Codex/Claude 动态等价基准。

## 5. 下一阶段验收建议

优先构造一个**专用可信 Workspace 控制进程**，让它持有工作区独占权/目录句柄、SQLite Ledger 和权限审批；模型只能提出补丁候选，不得控制 `authorize`、工作区根或临时文件。采用隔离 Stage 运行固定测试命令，随后审查候选差异，并通过可信提交器在复核版本后提交。必须补上 `Host Ledger → tool.receipt` 的对账，以及授权撤销/崩溃时的 Unknown 恢复。完成这些之前保持模型写工具关闭。

关联：[第 23 号隔离副本与纯 Patch](23-Workspace执行隔离与纯补丁规划-2026-10-28.md)、[Workspace 威胁模型 Issue #37](https://github.com/wwxst/agent-/issues/37)、[租约测试稳定性 Issue #36](https://github.com/wwxst/agent-/issues/36)。
