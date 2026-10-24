# 10 · Claude Code Agent 内核源码追踪（第一轮）

> 研究日期：2026-10-24  
> 状态：**静态源码证据报告**；未执行 Claude CLI、未联网调用模型、未运行用户代码。  
> 本仓库仍处于设计阶段；此文档不意味着已实现或获得了 Claude Code 的原始新版工程。

## 0. 目标与结论

这次不凭公开产品介绍推断 Claude Code 的行为，而是以用户提供的**打包产物和旧版 Source Map 提取源码**为研究材料，确认：

- 模型请求如何进入 Agent Loop；
- `tool_use` 什么时候加入工具执行队列；
- 工具输入验证、Hook、权限与执行如何串起来；
- `tool_result` 如何回填到下一轮模型上下文；
- 压缩和 Subagent 与主 Loop 的关系；
- 哪些结论仍然只是静态观察。

**第一轮结论**：2.1.304 的 CLI 文件中确有完整的 Agent 调度路径，而不是只有 SDK 包装层。已经直接核对的核心链路是：

```text
YL / su  →  iu
         →  I.callModel (zIt → mgn → Xmn)
         →  beta.messages.create(..., stream: true)
         →  assistant tool_use
         →  streamingToolExecutor.addTool
         →  wG → AYr → Svr（参数 / Hook / 权限）
         →  tool.call(...)
         →  tool_result / user-message 包装
         →  [...messages, ...assistantMessages, ...toolResults]
         →  next_round → 下一轮
```

**这不是在证明 Claude Code 2.1.304 所有配置都运行相同分支**；只证明能从样本中追踪到这条可达的执行路径。

## 1. 证据材料与可见性

### 1.1 新版 Claude Code 2.1.304

用户上传到项目的 ZIP：

```text
claude-agent-reverse-kit-desktop-3.1623.1-cli-2.1.304.zip
└─ claude-agent-reverse-kit-desktop-3.1623.1-cli-2.1.304/
   ├─ VERSIONS.json
   ├─ LOCAL_AGENT_BACKEND.md
   ├─ evidence/
   ├─ cli-2.1.304/
   │  ├─ claude.exe
   │  └─ modules/
   │     ├─ chunk-smbjjyps.js
   │     ├─ chunk-4b60tdnk.js
   │     ├─ chunk-k3djx6vq.js
   │     └─ chunk-451m4237.js
   ├─ extracted-3.1623.1/
   └─ reference-2.1.88/
```

已直接读取 ZIP 的文件条目、上述 JS 源码片段及报告。ZIP 总条目 **5,201**，并包含 CLI 发布产物及旧版参考。内部分析报告本身不是独立证据；下面涉及调用链的结论基于**再次打开上述实际 JS**核对。

新版模块为打包后的 JavaScript、符号名高度缩短，有 Bun 虚拟模块和不同宿主分支；**不是原始、可完整构建的 TypeScript 工程**。目前不把压缩变量名理解为其原始语义名。

### 1.2 旧版 Claude Code 2.1.88

[用户提供的公开旧仓库](https://github.com/wwxst/-) 中：

- [`package/package.json`](https://github.com/wwxst/-/blob/main/package/package.json) 明确声明 `@anthropic-ai/claude-code` 版本 `2.1.88`。
- `package/cli.js`、`package/cli.js.map` 存在。
- `extract-sources.js` 从 Source Map 的 `sourcesContent` 提取文件。
- `restored-src/src/` 有约 **1,902 个非 node_modules 的还原文件**；它们是旧版本的源码参考，不保证能完整重建可运行项目。

旧版关键链接：

- [`src/QueryEngine.ts`](https://github.com/wwxst/-/blob/main/restored-src/src/QueryEngine.ts)
- [`src/query.ts`](https://github.com/wwxst/-/blob/main/restored-src/src/query.ts)
- [`src/Tool.ts`](https://github.com/wwxst/-/blob/main/restored-src/src/Tool.ts)
- [`src/services/tools/StreamingToolExecutor.ts`](https://github.com/wwxst/-/blob/main/restored-src/src/services/tools/StreamingToolExecutor.ts)
- [`src/services/api/claude.ts`](https://github.com/wwxst/-/blob/main/restored-src/src/services/api/claude.ts)

**不可假设 2.1.88 的函数名、行为和实现细节与 2.1.304 完全一致。**

## 2. 已确认的主执行路径

> 新版位置统一用 **模块名称 + 0 基 Unicode 字符 offset**；不是源代码行号，不是 EXE 物理字节偏移。已从 ZIP 实际模块 `read_text('utf-8')` 对照。旧版位置用文件路径 + 1 基行号，便于 GitHub 跳转。

### 2.1 入口：一次 Turn 如何进入 Loop

**旧版直读：**

- `QueryEngine.ts:675` 调用 `query({...})`，并以 `for await` 消费事件；其调用者负责会话级输入及输出。
- `query.ts:219` 的 `export async function* query` 进入 `queryLoop`（约 `241` 行）。
- `query.ts:307` 存在推进内部状态的 `while(true)` 循环。

**新版直读：**

- `chunk-smbjjyps.js@135116`：`async function*YL(...)` 进入 `su(...)`；
- 同文件 `@137532`：`async function*su(...)`，初始化状态；
- `@141376`：内部 `async function*iu()` 处理单轮；
- `@209036`：将新状态写回 `V={...messages:[...q,...J,...Je], transition:{reason:"next_turn"},...}`；
- `@209492`：外围 `while(!0)` 继续迭代。

**确认**：Agent Loop 是一个跨模型请求与工具执行不断更新上下文的执行过程，而非“一条大 Prompt”。

**限制**：静态分析没有验证哪些入口会启用每一种特殊参数、实验标记或模式。

### 2.2 模型请求：谁真正发送 API

**旧版直读：**

- `src/query.ts` 将模型调用工作委派给模型 API 服务；
- `src/services/api/claude.ts:752` 定义 `queryModelWithStreaming`，转交下层 `queryModel`；
- 旧版同文件约 `864` 行能看到非流式回退分支对 `anthropic.beta.messages.create` 的调用。**不要把该旧版非流式调用误写成标准主流式调用点。**

**新版直读：**

- `chunk-smbjjyps.js@162542`：`Ni=I.callModel`，向其传递历史 `messages`、`systemPrompt`、`tools`、`thinkingConfig`、取消信号等；
- `chunk-4b60tdnk.js@2690290`：`zIt(...)`；
- `@2705215`：`mgn(...)`；
- `@2705953`：`Xmn(...)`；
- `@2743622`：构造包含 `model/messages/system/tools/tool_choice/max_tokens/thinking` 等参数的请求体；
- `@2780615`：调用 `Wl.beta.messages.create({...Xg,stream:!0}, {signal:h,...}).withResponse()`。

**确认**：模型推理发生在模型 API 一侧；Claude Code CLI 本地负责组织上下文、流式响应和工具编排。不能因此声称可看到云端模型推理实现。

### 2.3 `tool_use` 接收与流式调度

**旧版直读：**

- `src/query.ts:842` 有 `streamingToolExecutor.addTool(toolBlock,message)`；
- `src/services/tools/StreamingToolExecutor.ts:76` 的 `addTool` 把工具加入队列；
- 同文件 `129` 行附近的 `canExecuteTool(isConcurrencySafe)`：没有在执行的工具时可以启动；已有工具在运行时，只允许适合并发且与执行中工具兼容的调用。
- `src/Tool.ts:402` 定义工具的 `isConcurrencySafe(input)` 能力；不能用工具名硬编码所有并发性。

**新版直读：**

- `chunk-smbjjyps.js@52975`：`class vs` 具备工具队列、响应流状态、排空剩余结果等字段；
- `@181931`：在流式处理 `tool_use` 后，调用 `he.streamingToolExecutor.addTool(...)`；
- `@59131`：派发下层 `wG(...)` 处理执行；
- `chunk-k3djx6vq.js@31408-31958`：另有 `vn/El` 工具分组执行路径，根据 `isConcurrencySafe` 分为可并发组与串行组。

**确认**：工具调度与模型输出流相互重叠，并具有“并发安全”约束；不是只有简单的串行 `for...of`。

**限制**：不是所有工具都可并发；旧版与新版的实际队列实现可能变化，不能仅凭某个函数存在就断定每次调用都采用该路径。

### 2.4 工具验证、权限和真实执行

**旧版直读：**

- `src/Tool.ts:489` 附近定义 `validateInput`；
- `src/Tool.ts:557` 附近定义 `mapToolResultToToolResultBlockParam`；
- `src/utils/permissions/permissions.ts:473` 有 `hasPermissionsToUseTool`；
- 同文件 `1071` 行有 `checkRuleBasedPermissions` 规则判断函数；
- `src/hooks/useCanUseTool.tsx` 是另一层用户确认入口。

**新版直读：**

- `chunk-4b60tdnk.js@3957580`：`wG` 先解析工具名与别名、存在性及后续分派；
- `@3967595`：`AYr` 开始处理输入解析、校验与相关前置逻辑；
- `@3976664`：`Svr(...)` 处理权限决定；
- `@3980050`：未获准时构造同一 `tool_use_id` 的 `is_error:true` `tool_result`，作为结果反馈；
- `@3985545`：获准路径执行 `e.call(Ut, context, ...)`；
- `@3987768`：调用 `e.mapToolResultToToolResultBlockParam(cs.data,n)`；
- `@3993507`：把结果包装成新的消息 `Ae({content:...})`。
- `chunk-451m4237.js` 内还能找到 `can_use_tool` 请求形态、allow/deny schema、权限决定与 SDK 宿主回调处理路径。

**确认**：工具调用不是模型一要求就马上执行，而是经参数校验、权限分支等处理；拒绝也会形成结构化结果。

**限制**：**应用级审批不等于操作系统沙箱**。本轮没有完成所有文件路径、网络隔离、Shell 限制的端到端安全验证，也不能证明每种 Tool Host 都有等效的防护。

### 2.5 将结果带入下一轮

**旧版直读：**

- `src/query.ts` 在流式及结束阶段收集工具结果，处理 missing/tool-error 分支；
- `src/query.ts:1019` 对尚未排空的工具调用使用 `getRemainingResults()`；
- `src/query.ts:1716` 将 assistant 消息、工具结果等合并到后续状态。

**新版直读：**

- `chunk-smbjjyps.js@199861`：`he.streamingToolExecutor.getRemainingResults()`；
- 同文件 `@150797`：辅助结果归一化/回填函数 `Gr`，向 `Je` 加入结果；
- `@209036`：下一轮状态 `messages:[...q,...J,...Je]`；
- `@209492`：下一次 `iu()` 迭代。

**确认**：工具结果通过用户/工具结果消息回到后续模型输入，工具调用具有 `tool_use_id` 关联。

## 3. 其他机制：只记录第一轮已见到的边界

### 3.1 上下文压缩

- 旧版 `src/services/compact/autoCompact.ts:160` 定义 `shouldAutoCompact`；`241` 行定义 `autoCompactIfNeeded`。
- 新版 `chunk-smbjjyps.js@144401`：在模型请求前调用 `I.autocompact`；其具体实现至少可追踪到 `chunk-4b60tdnk.js` 中的 `rkr`。
- 结论限于：上下文压缩是 Loop 的一个真实执行阶段，会影响后续请求上下文；**尚未完整审计压缩触发阈值、保留策略、失败恢复与所有模型的例外行为**。

### 3.2 子 Agent

- 旧版 `src/tools/AgentTool/runAgent.ts:248` 存在子 Agent 执行生成器。
- 新版 `chunk-k3djx6vq.js@87525`：`ZR` 创建子 Agent 运行任务；
- `@100692`：子 Agent 获取 `runQuery` 入口；
- `@107819`：使用 `nt.options.runQuery({...messages,systemPrompt,canUseTool,toolUseContext,maxTurns,...})`。
- 结论限于：子 Agent **复用主 Agent 的查询执行能力**，带有子任务自己的上下文与配置；**本轮尚未完全确认**每种异步/后台路径的任务恢复、权限继承和资源清理不变量。

### 3.3 权限策略并非只有 UI 确认

- 旧版的权限逻辑分散在 `permissions.ts`、`useCanUseTool.tsx` 和 Tool 接口。
- 新版通过 `Svr`、权限决策路径及 `can_use_tool` 形成服务端/SDK/宿主配合。
- **仅能确认存在这些多层分支，不据此承诺某个具体隔离等级或无漏洞。**

## 4. 对自研 Agent Kernel 的具体借鉴

| Claude Code 中已核实的机制 | 建议吸收 | 必须加强或独立设计 |
| --- | --- | --- |
| Generator 驱动的执行循环 | 明确每轮消息与工具结果的输入输出 | 稳定、可重放的 Turn FSM，不将 generator 内存视为持久状态 |
| Model Provider 流式事件 | 尽早解析增量但晚于完整参数校验执行 | 多模型标准事件 Schema，Provider 不接管 Loop |
| StreamingToolExecutor | ToolCall 到达后调度，可对安全工具并发 | 保留 ToolCall ID、策略检查、顺序依赖和副作用幂等 |
| `isConcurrencySafe` | 工具声明并发能力 | 结合文件/资源冲突、写集与运行期 Scope 判断，不只信任插件布尔值 |
| 参数验证 / Hook / Permission | 将校验和权限置于 `tool.call` 前 | Tool Host 再次强制执行，Hook 不可绕过沙箱 |
| ToolResult 回填 | 规范化工具错误与成功结果，再继续模型 Loop | 在写入 Journal 后推进状态；崩溃恢复不重复危险工具 |
| Context Compaction | 将压缩当成真实上下文转换步骤 | 可审计、版本化、保留关键任务与审批事实 |
| Subagent 复用 Loop | 独立 Context + 同一执行引擎 | 明确父子任务、预算/权限子集、取消与恢复 |

### 应优先定义的内部接口（示意，不是现有代码）

```ts
interface KernelModelStream {
  stream(input: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

interface KernelToolDefinition {
  id: string;
  version: string;
  inputSchema: unknown;
  concurrency: 'exclusive' | 'read-only' | 'scoped';
  risk: 'read' | 'write' | 'external-side-effect';
}

interface KernelToolDispatcher {
  prepare(call: ProposedToolCall): Promise<PreparedToolCall>;
  authorize(call: PreparedToolCall): Promise<AuthorizationDecision>;
  execute(call: AuthorizedToolCall): Promise<ToolExecutionResult>;
}
```

真实执行过程中必须先保存工具意图与授权上下文再执行，工具结果未知时禁止盲目重试，参见 [事件与持久化](03-事件与持久化.md) 与 [工具安全](04-工具与安全.md)。

## 5. 旧版与新版能比较到什么程度

**可以确定的共同机制**：

1. 旧版 `query.ts` 的 `queryLoop` 与新版 `su/iu` 都具有迭代式 Agent 调度。
2. 旧版 `StreamingToolExecutor` 与新版 `vs` 都支持入队、并发安全判断和剩余结果收集。
3. 两版都包含参数校验、权限决策、结果回填。
4. 两版均包含上下文压缩与子 Agent 机制。

**现在不能断定的具体差异**：

- 哪个版本新增了某一特性，或默认配置何时改变；
- 2.1.304 的缩写函数是否与 2.1.88 原函数逐行同源；
- 在不同 OS、Desktop/CLI/Remote、不同 feature gate 下哪个执行分支被实际使用；
- 特定 Hook 是否始终有最终审批权；
- 模型回答效果、任务成功率、沙箱真实隔离程度。

做版本差异要按**相同机制的调用入口与测试**逐项比较，不能只用函数名或文件数定论。

## 6. 复核方法（可在原 ZIP 本地重复，不运行 CLI）

读取单个模块、打印字符 offset 附近片段：

```python
from pathlib import Path
from zipfile import ZipFile

archive = Path("claude-agent-reverse-kit-desktop-3.1623.1-cli-2.1.304.zip")
suffix = "/cli-2.1.304/modules/chunk-smbjjyps.js"
offset = 209036
with ZipFile(archive) as z:
    member = next(name for name in z.namelist() if name.endswith(suffix))
    text = z.read(member).decode("utf-8")
    print(text[offset - 150:offset + 450])
```

本轮核对的新版模块 SHA-256（对 ZIP 中**对应 JS 条目解压后的原始字节**计算）：

| 模块 | SHA-256 |
| --- | --- |
| `chunk-smbjjyps.js` | `1e28512664e9ef8818c84e5c4f6b19ee48c8f0c832e6673f29ad1a7f0872a46d` |
| `chunk-4b60tdnk.js` | `c0df8641329d42ecea033337ce51bf9b44986b4b82b858ac6c6ef1ba851404bb` |
| `chunk-k3djx6vq.js` | `1b4dc9236bf90b77cd9d9d13aa82f67c6a792920e9253d92ef402a2f6dd615fe` |
| `chunk-451m4237.js` | `ac9245fd7b0008384f7f1404ac53e3e7acfdca0d7351898db1a1f1c831b26621` |

**注意**：报告中的源文件、字节哈希和字符 offset 旨在帮助复核样本中存在的逻辑，不能证明样本来自官方的完整供应链。用户提供的 ZIP 附有签名与校验报告，但本次没有独立完成 EXE 签名链和 CDN 原产地验证。

## 7. 第二轮研究建议（未执行）

1. **完整权限执行链**：`Svr` 及 `can_use_tool` 到宿主审批再到 Shell 的真实安全边界。
2. **上下文压缩**：所有触发条件、状态持久化、保留历史与失败处理。
3. **Subagent 生命周期**：前后台子 Agent、权限继承、取消、并发和恢复。
4. **SDK ↔ CLI 协议**：Desktop 3.1623.1 到 CLI 2.1.304 的进程启动、控制通道及异常恢复。

以上每项都应新增“实证范围 / 不能确认 / 对本项目的借鉴 / 测试建议”，而不是对未知细节补猜。

---

### 适用于此报告的判断标准

- **代码确认**：能定位真实函数、条件、调用点；
- **接口确认**：只找到协议或类型，内部不做进一步承诺；
- **运行确认**：必须实际运行或具有可复核测试（本轮**无**）；
- **无法确认**：公开或提供的样本无法支持结论。

**研究资料仅在本项目可见的用户上传 ZIP 和公开旧版仓库中；本报告不复制 Claude Code 源码进入 `agent-` 项目，也不修改其核心代码。**
