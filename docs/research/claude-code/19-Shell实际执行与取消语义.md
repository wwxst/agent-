# 19 · Shell 工具完整执行链：模型参数到进程、沙箱、输出与取消

> 研究日期：2026-10-25。证据范围：用户旧仓库 `wwxst/-` 的 Claude Code **2.1.88** Source Map 提取源码。  
> 研究方法：逐段阅读 BashTool → Shell.exec → SandboxManager → child_process.spawn → ShellCommandImpl 的代码；未实际运行 Shell、沙箱或 2.1.304。  
> **所有默认设置、条件分支和函数行号仅指 2.1.88；不能当作 2.1.304 的新版行为。**

## 一、主调用链（旧版已追踪到真实 OS 进程入口）

```text
模型返回 Bash ToolCall
  → Tool/Schema/Policy/审批（前期研究 12、17）
  → BashTool.call(input)                 BashTool.tsx L624
  → runShellCommand(...)                 BashTool.tsx L826
  → exec(command, abort, 'bash', ...)
       shouldUseSandbox(input)           BashTool.tsx L896
  → Shell.exec(...)                      utils/Shell.ts L181
       provider.buildExecCommand(...)   L208–215
       检查/恢复 cwd、检查预取消
       SandboxManager.wrapWithSandbox() L259–265（仅需要沙箱时）
       spawn(spawnBinary, shellArgs...)  L316
       wrapSpawn(...)                    L339
  → ShellCommandImpl                    utils/ShellCommand.ts
       事件监听、超时、杀进程、输出管理
  → ExecResult / 进度 / 后台 Task
  → ToolResult → Agent Loop
```

| 源文件 | 代码证据 |
| --- | --- |
| [BashTool.tsx L624–710](https://github.com/wwxst/-/blob/main/restored-src/src/tools/BashTool/BashTool.tsx#L624-L710) | 工具入口、进度、错误收集 |
| [BashTool.tsx L826–918](https://github.com/wwxst/-/blob/main/restored-src/src/tools/BashTool/BashTool.tsx#L826-L918) | 从工具命令构造 `exec`，传递超时、是否沙箱与是否转后台 |
| [Shell.ts L181–343](https://github.com/wwxst/-/blob/main/restored-src/src/utils/Shell.ts#L181-L343) | Shell Provider、cwd、SandboxManager、真实 spawn |
| [ShellCommand.ts L120–345](https://github.com/wwxst/-/blob/main/restored-src/src/utils/ShellCommand.ts#L120-L345) | 取消、超时、结果状态与进程树终止 |
| [shouldUseSandbox.ts L130–154](https://github.com/wwxst/-/blob/main/restored-src/src/tools/BashTool/shouldUseSandbox.ts#L130-L154) | 运行沙箱判定 |
| [sandbox-adapter.ts L701–789](https://github.com/wwxst/-/blob/main/restored-src/src/utils/sandbox/sandbox-adapter.ts#L701-L789) | CLI 对外部 sandbox-runtime 的初始化和命令包装 |

## 二、模型输入与内部特权字段分离

[BashTool.tsx L224–264](https://github.com/wwxst/-/blob/main/restored-src/src/tools/BashTool/BashTool.tsx#L224-L264) 的 `fullInputSchema` 包含普通命令、timeout、description、run_in_background、dangerouslyDisableSandbox 等字段，也包含一个专供内部授权编辑流程使用的 `_simulatedSedEdit`。

**源码直接证据**：模型可见的 `inputSchema` 主动 `omit({_simulatedSedEdit:true})`；相应注释明确指出，若让模型写此字段，可将无害命令与任意文件改写组合，绕过正常审批/沙箱检查。

必须正确区分两层：

1. **不向模型暴露内部字段**：属于降低入口风险；
2. **在真实工具调用入口拒绝外部伪造字段**：需要单独的信任和参数来源验证；不能仅从模型 Schema 的 `omit` 推导所有 SDK、插件和远程输入路径都不可伪造。

**自研建议**：模型参数和宿主内部授权参数使用不同 DTO，内部参数绝不能由任意 JSON 拼装而来，应由 Policy Engine 产生不可伪造的能力引用。

## 三、命令如何经过 Shell Provider 才真正执行

[Shell.ts L197–269](https://github.com/wwxst/-/blob/main/restored-src/src/utils/Shell.ts#L197-L269) 先按 bash/powershell 等 ShellType 取得 Provider，通过 `buildExecCommand` 生成包含 cwd 跟踪、引号/重定向处理的命令，再视 `shouldUseSandbox` 运行 `SandboxManager.wrapWithSandbox`。

这意味着 OS 运行的不是简单的模型原始 `command` 字符串。源文件中还可见：

- 构造 Shell Provider 前后会判断工作目录是否还存在；若当前 cwd 丢失，尝试回退到初始 cwd；
- 如果在 spawn 前已经 Abort，则返回“未执行”的结果对象；
- PowerShell 进入沙箱时有特殊外层 `/bin/sh -c` 与 `pwsh` 参数包装逻辑，不能直接把不同平台当作一种 Bash；
- 沙箱本身来自 `@anthropic-ai/sandbox-runtime` 的封装，应用适配层并不完整实现 OS 隔离。

**警告**：在正在修改仓库的 Agent 中，“工作目录失效后自动回退到另一个目录”可能造成写错位置的安全/正确性问题。我们的 Tool Host 将工作区路径与 Host 身份绑定；高风险任务应明确报 `WorkspaceMissing` 并停止，而不是默认切换工作目录。

## 四、输出文件与真正的资源限制

[Shell.ts L282–343](https://github.com/wwxst/-/blob/main/restored-src/src/utils/Shell.ts#L282-L343) 的普通 Bash 输出：

- stdout/stderr 可以共用一个打开的文件描述符，以减少实际传输与输出错乱；
- POSIX 输出文件使用 `O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW`，其中 O_NOFOLLOW 是防止输出路径被换成符号链接的安全保护；
- Windows 路径使用另一种打开模式，避免句柄访问权限不兼容；
- 输出到内存管道与写文件两种模式分开，UI 实时输出不意味着日志具有事务一致性。

[ShellCommand.ts L225–327](https://github.com/wwxst/-/blob/main/restored-src/src/utils/ShellCommand.ts#L225-L327)：

- 对后台进程设置输出文件大小看门狗，超限时尝试终止进程；
- 退出结果可包含完整 stdout 或 outputFilePath/outputTaskId 等产物引用；
- 工具退出码与被 SIGKILL、SIGTERM 中止的状态做一定区分。

**自研要求**：产物与临时输出不应变成任意可覆盖的文件路径；应采用不可预测文件名、目录句柄、所有权/权限与大小配额。输出路径须属于工具宿主产物仓库，客户端只能获得经过授权的工件 ID。

## 五、最值得注意的取消语义

[ShellCommand.ts L186–196](https://github.com/wwxst/-/blob/main/restored-src/src/utils/ShellCommand.ts#L186-L196) 的 `#abortHandler` 明确区分 Abort reason：

- `reason === 'interrupt'` 时**不立即杀进程**，注释说明目的是让调用方可转成后台任务，让模型读取部分结果；
- 其他 Abort 进入 kill；
- timeout 可以终止，也可能按工具配置自动转为后台任务。

[ShellCommand.ts L264–345](https://github.com/wwxst/-/blob/main/restored-src/src/utils/ShellCommand.ts#L264-L345) 使用 `'exit'` 而非 `'close'` 结束 Shell 等待：因为子孙进程可能继承文件描述符，等待全部 stdio close 会阻塞。但这也意味着“外层 Shell 已退出”**不等于所有后代副作用都已经完成**。

`#doKill` 尝试以 `treeKill(pid,'SIGKILL')` 结束进程树，并在代码层填充中止结果。**只能证明有终止尝试，不能保证任意 OS 上所有子进程/外部请求都确实停止或回滚**。

### 对我们的执行状态模型的影响

```text
TurnInterruptRequested
    ├─ UI/模型流暂停或转后台（若策略允许）
    └─ Shell 可能仍运行 → Backgrounded

TurnCancelRequested
    ├─ 请求终止 Shell/子任务
    └─ 等待宿主回执 → Cancelled / Succeeded / OutcomeUnknown

Timeout
    ├─ 如明确允许后台任务：Backgrounded
    └─ 终止尝试 → Failed / OutcomeUnknown
```

必须将 **Interrupt / Cancel / Background / Timeout** 作为独立动作，不用一个 `cancelled:boolean` 覆盖全部情形。工具结果、宿主回执和外部副作用状态也必须分开。

## 六、当前证据无法支持的结论

- **不能确认 2.1.304** 是否仍采用同样的 `_simulatedSedEdit`、`O_NOFOLLOW`、`interrupt` 或 cwd 回退策略。
- 没有独立读出 `@anthropic-ai/sandbox-runtime` 的平台底层实现，因此不能根据 CLI Adapter 推断系统调用级安全。
- 没有运行真正的工具，也没有测量它的进程树清理成功率、并发性、任务丢失概率或高风险操作越权。
- 没有证明模型面对所有 API/SDK 入口都不可能控制内部编辑字段；需要源头调用链加动态测试。

## 七、给自研内核的测试要求

- T19-01 使用模型输入伪造内部编辑字段：拒绝且无文件副作用；
- T19-02 Sandbox required 但不可用：拒绝启动，不以非隔离路径兜底；
- T19-03 取消与 Interrupt 具有不同、显式可见的效果；
- T19-04 Shell 已退出但后代仍运行：宿主仍记录未确认副作用；
- T19-05 工作目录消失：高风险工具不偷偷切换 cwd；
- T19-06 产物目录符号链接攻击、路径碰撞与并发写入拒绝；
- T19-07 stdout 大量输出时限额与任务回执一致；
- T19-08 Windows/POSIX Shell Provider 使用统一 ToolHost 合同，但隔离能力逐平台验收。

此文档是对 [16 · 沙箱策略映射](16-沙箱执行与策略映射.md) 的进一步实证补充，不替代它。
