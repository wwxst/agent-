# 22 · 第八轮：真实 Bubblewrap Workspace 可写范围与编码测试闭环

> 日期：2026-10-28。**已运行 GitHub Actions 上的 OS 实验**；这是候选 Workspace Mount 的研究探针，未接入生产 ProcessToolHost 审批、SQLite Ledger 或强制 Seccomp/cgroup。Agent 架构仍未定案。

## 1. 固定版本与证据

| 样本 | 固定信息 |
| --- | --- |
| Kernel 基线 | `wwxst/agent-@f66482d21b06b7499f2ed124139c953e700b90f2` |
| 真实 OS 实验修订提交 | [`e43c6d71808adb28e24a07cb3029bc32e486b95c`](https://github.com/wwxst/agent-/commit/e43c6d71808adb28e24a07cb3029bc32e486b95c) |
| 研究测试源码 | [workspace-bwrap-slice.probe.test.ts](https://github.com/wwxst/agent-/blob/e43c6d71808adb28e24a07cb3029bc32e486b95c/tests/workspace-bwrap-slice.probe.test.ts) |
| 真实运行 | [GitHub Actions #40644361725](https://github.com/wwxst/agent-/actions/runs/40644361725) |
| Node.js 22.16.0 / 22.23.3 | 两个作业 `success`；每个共 271 tests、270 pass、0 fail、1 skip；新增 WORKSPACE-OS-01/02 两项均 `ok` 且**未跳过** |

## 2. 实验的执行和挂载约束

以生产 `buildBubblewrapLaunch()` 返回的受限 Linux argv 为基础，在**临时实验进程**追加 Workspace `--ro-bind`；只在 `WORKSPACE-OS-02` 中再以 `--bind` 把一个明确指定的 `src` 子目录变为可写。保留 `--unshare-all`、显式 `--unshare-user`、代码只读、空环境、私有 `/tmp` 及专用 SQLite 挂载。没有暴露任意 Shell 指令，而是运行固定的 Node.js `-e` 文件检查、受限字符串替换和 `node --test`。

这个研究 argv 是人工组装的，并非生产 `ProcessToolHost` API 已支持 Workspace Mount。**可写范围是整个 `src` 目录，不是单个文件授权**；实验没有对真实模型传入的不可信补丁做路径审查或哈希条件检查。

## 3. 动态观察结果

**WORKSPACE-OS-01**：在 Workspace 整体只读时，从 Bubblewrap 内尝试覆盖 `src/calc.mjs`，操作被拒绝；宿主检查内容未改变。

**WORKSPACE-OS-02**：整个 Workspace 只读，同时将 `src` 子目录重新挂载为可写；实际观察：

- 可以读取 `src/calc.mjs` 和只读的 `spec/protected.txt`，可以写入 `src/calc.mjs`。
- 无法覆盖 `spec/protected.txt`、通过源目录中的符号链接覆盖受保护文件、读取不在挂载范围的宿主私有文件、通过符号链接读取该私有文件，或写入已挂载的运行代码目录。
- 为检验网络隔离，测试打开**宿主真实监听的 `127.0.0.1` 动态端口**，再由沙箱进程尝试连接；连接没有成功。初版探针连接无人监听的端口，不能作为证据，因此已在最终提交中修正并重新运行。
- 在沙箱内先把 `add(a,b)` 错误改为乘法，真实 `node --test` 退出 1；再改为加法，重新启动真实 `node --test` 退出 0；宿主验证最终代码和只读文件内容。

上述检查均是 Ubuntu Runner 中的真实 Bubblewrap 进程行为，而不是字符串 argv 检查或内存假实现。

## 4. **不能**由此证明的事情

- **不能证明生产 Coding Agent 已可写文件**：当前 `ToolScheduler` 默认拒绝 `risk:'write'`，生产 `ProcessToolHost` 的 Worker 仍只允许 `read.echo/read.sleep`。
- **不能证明生产可信 Host 的授权与收据链已经对接**：本实验直接启动测试用 Node 进程，不写入真实 ToolCall `STARTED`/Receipt，也不具备对应 Lease、Fencing 或跨进程一致性。
- **不能证明 Seccomp + Workspace 组合已验证**：现有 Seccomp 动态测试是针对原白名单 Worker 的独立路径。本次仅验证 Linux namespace/mount/network 场景，未为新 Workspace 组合配置 Seccomp FD。
- **不能证明真实 Shell 子孙进程可靠停止**：实验仅运行预设 `node --test`，没有任意命令、进程树取消、超时 Kill 或 cgroup 资源回收验证。
- **不能证明拒绝所有路径攻击**：测试覆盖两个具体 symlink 路径和几个只读/不存在挂载；尚无 mount namespace TOCTOU、复杂硬链接、rename、overlay 或多租户隔离完整枚举。
- **不能证明跨 OS/发行版稳定**，也未进行 Codex/Pi/Claude 同条件动态编程基准。

## 5. 下一道研发门槛（建议，不冻结架构）

先定义可信 WorkspaceHost 输入：固定工作区身份、真实 Repo 根、可写范围及版本化批准；把 `file.read`、受限 `file.patch`、预定义 `test.run` 显式分开，并将执行绑定真实 `sessionId/turnId/callId`、Host Ledger 和一致性恢复。输入校验必须在可信进程完成，工作区根和可写路径不得由模型提升权限。

规范性测试需要覆盖：路径逃逸/符号链接/TOCTOU、防重复 Patch、变更前哈希校验、写中断导致的未知结果、测试进程及子进程树取消、实际 Seccomp+cgroup+Workspace 组合，以及不可用沙箱的 fail-closed 路径。保留当前只读 Worker 和此前已运行安全测试，不以演示用 Mount 直接修改生产 Host。

关联：[第 20 号真实 Host 并发与 Linux 沙箱证据](20-真实ToolHost并发故障及沙箱复核-2026-10-28.md)、[第 21 号编码工作流能力边界](21-编码工作流能力边界与动态实验-2026-10-28.md)。

## 第九轮后续限定（2026-10-28）

**第 22 号报告中的只读路径实验不应外推成文件内容绝对不可变。** 后续在 [第 23 号报告](23-Workspace执行隔离与纯补丁规划-2026-10-28.md) 和 [Issue #37](https://github.com/wwxst/agent-/issues/37) 中，真实 CI 已证实：可写子目录若含指向受保护路径的硬链接，可借同一 inode 修改受保护文件；原只读 Host 的可写 SQLite 目录也不应向不可信项目代码暴露。经过验证的改进方向是运行**独立字节复制的工作副本**，且执行进程完全不挂载 Host 账本。
