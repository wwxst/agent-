# 17 · Claude Code SDK ↔ CLI 控制协议、审批竞态与去重

> 研究日期：2026-10-24；样本：**Claude Code 2.1.88** Source Map 提取源码。  
> 验证类型：源码静态分析；没有实际运行 SDK/CLI、没有对新版 2.1.304 做同等逐函数复核。

## 一、首先区分三个协议平面

1. **用户与 Agent 输入**：`user` 消息、SDK 历史消息及待处理 Turn 队列。
2. **模型与工具运行事件**：`assistant`、`stream_event`、`result`、工具进度和 Session 状态。
3. **宿主控制平面**：`control_request`、`control_response`、`control_cancel_request`，包括权限、MCP、配置、停止任务等请求。

旧版 [SDK 控制 Schema](https://github.com/wwxst/-/blob/main/restored-src/src/entrypoints/sdk/controlSchemas.ts#L550-L645) 用结构化 Schema 定义请求 ID、子类型以及 response/error。

特别重要：一次 `control_response` 的语义不是模型回答本身，而是宿主对某项明确控制请求的应答。不能把聊天消息作为审批的替代渠道。

## 二、实际 I/O 与控制消息相关的代码

| 文件与位置 | 已确认事实 |
| --- | --- |
| [structuredIO.ts L130–219](https://github.com/wwxst/-/blob/main/restored-src/src/cli/structuredIO.ts#L130-L219) | StructuredIO 管理 pendingRequests、已处理 toolUseID、单一 outbound 队列 |
| [structuredIO.ts L349–454](https://github.com/wwxst/-/blob/main/restored-src/src/cli/structuredIO.ts#L349-L454) | 按 request_id 匹配控制响应，重复或孤立响应单独处理 |
| [structuredIO.ts L460–532](https://github.com/wwxst/-/blob/main/restored-src/src/cli/structuredIO.ts#L460-L532) | 发送 request、Abort 时发送 control_cancel_request、等待 Promise |
| [structuredIO.ts L538–660](https://github.com/wwxst/-/blob/main/restored-src/src/cli/structuredIO.ts#L538-L660) | 先运行主策略，ask 时并发触发权限 Hook 和 SDK 宿主询问 |
| [structuredIO.ts L720–754](https://github.com/wwxst/-/blob/main/restored-src/src/cli/structuredIO.ts#L720-L754) | 借用 can_use_tool 请求询问沙箱网络放行 |
| [controlSchemas.ts L550–645](https://github.com/wwxst/-/blob/main/restored-src/src/entrypoints/sdk/controlSchemas.ts#L550-L645) | 控制请求、结果、取消、保活和环境变量更新的 Schema |
| [bridgePermissionCallbacks.ts](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/bridgePermissionCallbacks.ts) | Bridge 把权限请求/响应关联到 requestId 与 toolUseId |

## 三、主策略已确定时，不必弹宿主审批

`StructuredIO.createCanUseTool` 先执行：

```text
hasPermissionsToUseTool(...) 
   ├─ allow -> 直接返回 
   ├─ deny  -> 直接拒绝 
   └─ ask   -> 开启 Hook 与 SDK 弹窗竞态
```

这条路径有一个关键隐含条件：`forceDecision` 可能替代主策略入口。它的调用者和适用情景另需审计；不能从这一个函数断言所有权限优先级全局一致。

## 四、PermissionRequest Hook 与宿主弹窗为何并发

在 `createCanUseTool` 的 ask 分支，旧版同步创建两个异步请求：

1. 调用 `executePermissionRequestHooksForSDK`，包装为 hookPromise；
2. 调用 `sendRequest({subtype:'can_use_tool', ...})`，包装为 sdkPromise；
3. 通过 `Promise.race` 取得较先到达的结果。

具体行为：

- Hook 先完成且给出 allow/deny：Abort 仍在等待的 SDK request，并返回 Hook 的决定；
- Hook 先完成但没有有效决定：继续等待 SDK result；
- SDK 先应答：采用 SDK 结果，之后 Hook 的决定被忽略；
- 发生异常：转换为拒绝而非隐式允许；
- 父 Turn Abort 会传播到 Hook/Sdk 请求；
- 最后根据是否还有 pending permission，决定 Session 是否恢复显示 running。

这是一套**低延迟交互与异步策略竞态**方案。其代价是：Hook 和弹窗可能都已经发生副作用或显示，取消信号并非所有外部消费者都必须同步完成。自研实现应明确“只允许建议性竞态；最终确认由可信 Policy Engine 单点提交”。

## 五、对重复响应的防护：这是重连时真实会遇到的问题

`StructuredIO` 维护 `pendingRequests` 和最多 1000 个 `resolvedToolUseIds`（LRU-like insertion order 裁剪）。由于 WebSocket 重连可能重复派发同一 `control_response`，代码会判断：

- request_id 是否仍在 pending；
- 若 request 已经结束，成功响应中的 toolUseID 是否在 resolved 集合；
- 如果已处理，忽略重复响应，防止再次制造工具相关消息并影响 API 的唯一性要求；
- 对未知的响应仍有 unexpectedResponseCallback 路径。

**本质问题**：网络至少一次交付，不代表可以至少一次改变任务事实。

自研建议：

- `requestId` 用于单次网络关联，`toolCallId` 用于不可重复执行/审批的稳定身份；
- 终态去重必须有持久事实依据，不依赖进程内只有 1000 个元素的 Set；
- 每个审批决定绑定 `scope + toolCallId + canonicalArgsHash + toolVersion`；
- 已经提交的决定不能被同一 request 重播所改变；
- 对未知请求拒绝执行，只记录可审计的 OrphanResponse。

## 六、取消不是撤销已经发生的动作

`sendRequest` 在 Abort 时：

- 发送 `control_cancel_request`；
- 立即 Reject 等待中的 Promise（不等待宿主 ACK）；
- 将相关 ToolCall 标记为已解决，以便晚到响应不会被重新处理；
- 在 finally 中移除监听器并清理 pendingRequests。

这只是控制消息/审批层取消，**不能证明宿主的权限弹窗已经消失，更不意味着 Shell 的副作用可撤销**。

自研建议把状态分开：

```text
ApprovalPending
   → ApprovalCancelRequested
   → ApprovalCancelled / ApprovalResolvedLate

ToolExecution
   → ToolCancelRequested
   → ToolCancelled / ToolSucceeded / ToolOutcomeUnknown
```

两者不能共用一个布尔 `cancelled`。

## 七、特殊的网络权限桥接

`StructuredIO.createSandboxAskCallback` 将网络域名请求装成特殊工具 `SandboxNetworkAccess` 的 `can_use_tool` 控制请求，交给 SDK 宿主提示；请求失败返回 false。

这是**传输复用**（没有新增网络审批专用消息类别），不是把网络操作误认为真实工具执行。

自研内核可用统一 `ApprovalRequested` 事件类型，但其 `resourceKind` 应明确区分：

- tool_execution
- network_access
- filesystem_access
- capability_escalation

否则记录和审批 UI 容易把网络策略混入普通工具允许列表。

## 八、SDK 不是远程 Host 的所有权边界

[remote/sdkMessageAdapter.ts](https://github.com/wwxst/-/blob/main/restored-src/src/remote/sdkMessageAdapter.ts#L21-L120) 会把远程 SDK 消息映射到 REPL 的展示消息。这是典型的**协议适配器**，不意味着 UI 能直接读写内核内部对象。

`structuredIO.ts` 还处理诸如 `set_permission_mode`、`mcp_message`、`stop_task` 等控制类型（具体允许范围需结合调用者授权审计）。不能假设“存在控制字段 = 未验证用户有权调用该控制”。

## 九、建议的自研控制协议（示意）

```ts
type ControlRequest = {
  protocolVersion: number;
  requestId: string;
  sessionId: string;
  expectedTurnId?: string;
  subtype: 'approval' | 'cancel' | 'tool_host_control' | 'configuration';
  payload: unknown;
};

type ControlDecision = {
  requestId: string;
  decisionId: string;       // 持久且不可重复
  parentToolCallId?: string;
  expectedStateVersion: number;
  decision: 'allow' | 'deny';
  approvedArgsHash?: string;
};
```

服务端对来源、身份、状态版本、Scope、是否重复、是否过期逐一核验，再事务提交。

## 十、验收用例

- **T17-01** 权限 Hook 与 UI 先后完成顺序互换，最终仅能产生一次有效 Decision；
- **T17-02** Hook 返回无决定时，SDK 弹窗结果仍可生效；
- **T17-03** 宿主断网或 Schema 错误，默认拒绝；
- **T17-04** request_id 不同但 toolCallId 相同的响应不重复授权或执行；
- **T17-05** 重连收到旧响应，审批状态不会倒退；
- **T17-06** Cancel 和 allow 同时发生，按持久状态版本决胜；
- **T17-07** 沙箱网络权限必须限定域名、端口、宿主、过期；
- **T17-08** 权限参数被 Hook 或用户更改后，旧指纹的审批失效。

> **证据边界**：上述行为在旧版 2.1.88 源文件能静态追踪。2.1.304 的当前协议实现是否保留相同优先级、去重上限、竞态规则，此文档不作保证。
