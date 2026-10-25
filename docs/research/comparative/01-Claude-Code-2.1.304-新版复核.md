# Claude Code CLI 2.1.304 与 Desktop 3.1623.1：新版打包代码直接复核

> 日期 2026-10-25；证据 A1。基于用户项目 ZIP 中实际解压后的 JS；**未运行 claude.exe 或任何 Desktop 组件**。记录的是存在的代码路径，不保证所有运行平台/开关都走此路径。

## 一、样本、边界和复核方法

ZIP：`claude-agent-reverse-kit-desktop-3.1623.1-cli-2.1.304.zip`（本轮在容器中直接打开成功，条目数 **5,201**）。

- `cli-2.1.304/modules/` 含 2,707 个文件条目，JS 文件可按需直接读取；
- `extracted-3.1623.1/asar/.vite/build/` 含 Desktop 主进程及 SDK 打包 JS；
- `reference-2.1.88/` 是用户旧版样本，可以辅佐，但不是 2.1.304 的同源符号表。

对直接核查模块的解压字节 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `chunk-smbjjyps.js` | `1e28512664e9ef8818c84e5c4f6b19ee48c8f0c832e6673f29ad1a7f0872a46d` |
| `chunk-4b60tdnk.js` | `c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb` |
| `chunk-bfx63tqm.js` | `54bc7e0c6a4542c0b151c36734394eb27ae152895e3af3781cdb32062745b157` |
| `Desktop/index.chunk-J7YnW_mh.js` | `80d308de49d2eacee72a561734b05e32209783de7772881036e5608cfd725a42` |
| `Desktop/index.chunk-BRvO7fVg.js` | `1a87853c63ad0e52ffa69e2de27004dc0dfccfb5394f23f3daaf5829da6b7976` |

以下 `@N` 是对 **UTF-8 解码后的 JS 字符串**的 0 基字符偏移，不是 TS 行号或 EXE 字节偏移。

## 二、2.1.304 的实际 Agent Loop

```text
YL @135116 进入 su @137532
    → iu @141376 处理模型/工具一轮
    → I.callModel @162542
       → zIt @2690290 / mgn @2705215 / Xmn @2705953
       → beta.messages.create(..., stream:true) @2780615
    → assistant.message.content 中 tool_use
       → streamingToolExecutor.addTool @181934
       → getCompletedResults / getRemainingResults @61816
       → wG @3957580 → AYr @3967595 → Svr @3976664
       → tool.call @3985545
       → tool_result
    → 状态中汇总 messages:[...旧消息,...assistant,...工具结果]
    → su 的 next_round，继续模型请求
```

- `chunk-smbjjyps.js` 中 `YL` 是 async generator，`su` 持有 `maxTurns`、`querySource`、权限回调及工具上下文；`iu` 处理单次模型步骤。
- `chunk-smbjjyps.js@181934`：从 assistant 消息中筛选 `tool_use`，把它们送入 StreamingToolExecutor。**能直接确认存在流式接收和工具入队的重叠**，但不表示执行尚未完成校验的 JSON 片段。
- `chunk-smbjjyps.js@61816`：工具调度器的 `getRemainingResults()` 在 Response 关闭后收集未结束工具，并根据运行中 Promise/进度唤醒迭代。代码有 `isConcurrencySafe` 和对排队独占工具的处理。
- `chunk-4b60tdnk.js@3957580`：`wG` 查找工具名、别名和可能尚待注册的 MCP 工具。后续 `AYr`/`Svr` 路径在权限拒绝时生成带 `tool_use_id` 的错误结果，许可后才调用 `e.call`，并经过结果映射。
- `chunk-4b60tdnk.js@2522174`：`rkr` 是实际上下文压缩分支，读模型窗口/压缩配置，出现 `not_needed`、`compacted`、`failed`、Hook 阻断及失败计数相关路径；不能从符号名直接恢复全部策略。

**可靠性限制**：单凭消息拼接不能证明工具意图先于外部副作用持久提交，更不能证明恰好一次执行；需要独立检查 Session Store 与工具执行器及故障测试。

## 三、新版沙箱：已确认的不只是旧版的布尔标记

### 3.1 CLI 的沙箱选择层

- `chunk-4b60tdnk.js@3154274`：Shell 执行路径接受 `shouldUseSandbox`、`requireConfiningSandbox`、`sandboxDenyRead`、`sandboxDenyWrite`、`isolationRoot` 等显式参数。
- `chunk-4b60tdnk.js@3161659`：根据平台走不同的沙箱包装入口，Windows 路径使用 `Je.wrapWithSandboxArgv(...)`，其他路径可使用 `Je.wrapWithSandbox(...)`。
- 如果包装阶段返回不可启动的结果，当前路径会返回“未执行”的控制结果，而不是无条件启动裸 Shell。
- 源码还可找到沙箱包装前后的其他条件如远程限制和策略变更；**不能仅凭单一路径证明所有 Shell 都强制受限**。

### 3.2 真正的运行时模块

`chunk-bfx63tqm.js@816667`：

- `wrapWithSandbox()` 对 Windows 显式报错，并要求调用 `wrapWithSandboxArgv()`，后者需用 `shell:false` 风格启动实际进程。
- `wrapWithSandboxArgv()` 的 Windows 分支考虑文件读写拒绝、网络白名单、凭据等；某些 per-exec `allowRead/allowWrite` 不支持时明确抛出，不假装能力等同。
- `chunk-bfx63tqm.js@822023` 运行时对象暴露 `initialize`、`isSupportedPlatform`、`isSandboxingEnabled`、`getFsReadConfig`、`getFsWriteConfig`、`getNetworkRestrictionConfig`、`wrapWithSandbox`、`wrapWithSandboxArgv`、`cleanupAfterCommand`、`reset` 等不同入口。

**新旧差异已经实证**：旧版可读源码重点是 BashTool→Shell.exec 的 `wrapWithSandbox()` 包装；新版实际存在 Windows `wrapWithSandboxArgv()` 分支。这证明跨平台隔离架构存在演进，不能把旧版“Windows 不支持”的注释直接套在新版。

**未证明**：Windows 内核安全策略的完整强制效果，Linux namespace/seccomp 实际生效范围、macOS seatbelt 的全部规则、绕过攻击的测试结果。

## 四、Desktop 3.1623.1 本地 Agent 调用链：SDK ProcessTransport

`extracted-3.1623.1/asar/.vite/build/index.chunk-J7YnW_mh.js` 有可直接复核代码：

1. `@1160779` `ProcessTransport` 相关对象管理 `spawn()`、abort、写入队列、延迟启动；`spawnLocalProcess` 使用 Node `child_process.spawn(command,args,{cwd,stdio:['pipe','pipe','pipe'],signal,env,windowsHide:true})`。
2. `@1163390` 初始化构造 CLI 参数，至少包括 `--output-format stream-json --verbose --input-format stream-json`，并根据传入选项添加 `--max-turns`、`--max-budget-usd`、`--model`、`--agent`、工具/Skill 权限等配置。
3. `@1181042` 处理来自子进程的 `control_request`、`control_response`、`control_cancel_request`、`keep_alive`，并区分 `result`、`autocompact_state`、`active_goal` 等状态。
4. `@1174589` 包含 `@anthropic-ai/claude-agent-sdk` 包与平台可执行文件的定位逻辑，说明上述代码位于实际随 Desktop 打包的 Agent SDK 层。
5. `Desktop/index.chunk-BRvO7fVg.js@6649153` 可见 Electron `ipcMain.handle` 封装，检查 `senderFrame` 是否可信后再调用处理器；这个证据只确认**存在受控 Electron IPC 分发入口**，不是所有本地会话 Channel 的完整映射。

由此可以谨慎推断以下**部分已确认的拓扑**：

```text
Desktop 打包代码 / SDK 集成
    → SDK ProcessTransport（stdio + stream-json）
    → 本地 Claude CLI 子进程
    → Agent Loop、模型请求和 Tool Host
    → stdout 控制/进度/结果事件回到 SDK
```

这里的第一段“Desktop UI 的某按钮或窗口究竟连接哪一个 Session Manager”仍需追踪 renderer → 主进程的特定 IPC Channel，不能把所有 UI 点击行为都归到同一条已核实路径。**但本轮已经确认 SDK→CLI 的实际进程边界**，不再标为完全未知。

## 五、新旧差异矩阵：只写有新证据的

| 机制 | CLI 2.1.88 源码 | 2.1.304 新版代码 | 结论 |
| --- | --- | --- | --- |
| Generator Agent Loop | `query.ts/queryLoop` | `YL/su/iu` | 跨版本都存在同类机制，不证明相同实现 |
| 流式工具并发 | `StreamingToolExecutor.ts` | `vs` 等调度器 | 跨版本都存在排队和 `isConcurrencySafe` |
| 工具审批 | permission/Hook/SDK | `wG/AYr/Svr` 与 `can_use_tool` | 新版仍有多层处理，默认模式仍需核对 |
| Context Compaction | `autoCompact.ts` | `rkr` 及循环调用 | 共通机制，**旧版阈值不可移植到新版** |
| Windows 沙箱包装 | 旧版路径依赖外部运行时，平台可见性不完整 | 明确 `wrapWithSandboxArgv()` 和能力缺失报错 | 可证实新版特化分支 |
| Desktop 进程控制 | 旧 Bridge 用 stdio NDJSON | 打包 SDK 实际 `ProcessTransport` | 两者都是父子进程控制设计，但不能断言 Desktop 等于 Bridge |

## 六、自研内核建议

- 基于流式 ToolCall 的结构化消息协议，但只能在完整解析、策略检查和持久记录后执行。
- 借鉴前置 `StreamToolExecutor` 的并发性与逐调用进度；写操作必须添加资源冲突和幂等语义。
- 多平台 Tool Host 采用明确 `IsolationRequirement` 和 `IsolationReport`；没有某项 OS 能力时如实拒绝，不能伪造“沙箱已开启”。
- SDK/CLI 的传输可借鉴 JSONL/流式事件和控制面分离，但**自研协议的最终状态、权限与事件 ID 属于我们自己的 Kernel**。
- 不直接将压缩 JS 的缩写符号当作稳定 API，不复制第三方运行时源码。

## 七、下一阶段必需的动态验证（均未执行）

- 2.1.304 全套策略组合和 OS 级沙箱系统调用的实际效果；
- Desktop UI → 具体 IPC Channel → Agent SDK → CLI 的 Session 创建、审批、取消、恢复；
- CLI 进程崩溃、Host 崩溃、ToolCall 已执行但 stdout 回执丢失时的状态；
- 当前模型配置的最大 Turn、预算、压缩失败熔断在全部 Feature Gate 下的实际行为；
- Windows/macOS/Linux 的同案例审批与文件安全隔离对照。

## 八、最小可复核脚本（不执行 CLI）

```python
from zipfile import ZipFile
from hashlib import sha256

archive = "claude-agent-reverse-kit-desktop-3.1623.1-cli-2.1.304.zip"
suffix = "/cli-2.1.304/modules/chunk-bfx63tqm.js"
with ZipFile(archive) as z:
    name = next(x for x in z.namelist() if x.endswith(suffix))
    raw = z.read(name)
    source = raw.decode("utf-8")
    print(sha256(raw).hexdigest())
    loc = source.index("wrapWithSandboxArgv")
    print(source[loc - 200:loc + 500])
```

本报告特意不上传 ZIP 里的可执行文件或大段专有源码，只保留函数标识、哈希、偏移、结构和技术取舍。
