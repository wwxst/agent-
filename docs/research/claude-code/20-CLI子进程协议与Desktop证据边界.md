# 20 · Claude Code CLI 子进程控制协议、Bridge 边界与 Desktop 尚未核实的部分

> 研究日期：2026-10-25。  
> **已直接验证：用户旧仓库 wwxst/- 的 Claude Code 2.1.88 文件。**  
> **未验证：Claude Desktop 3.1623.1 原生 IPC / SDK→CLI 进程拓扑，以及 Claude Code 2.1.304 同版本执行路径。** 项目上传 ZIP 在本轮访问时存在运行环境读取障碍，未据附件自带报告补猜。

## 一、不要混淆三种“本地 Agent”拓扑

1. **CLI 自己执行 Agent Loop**：可交互本地进程发模型请求并执行 Shell/文件工具。
2. **外部 SDK/Bridge 控制 CLI**：父程序通过 stdio JSON Lines 和远程传输发消息、控制权限、收进度，但实际工具 Loop 在子 CLI 内。
3. **Claude Desktop 对 Agent 的控制**：可能还涉及应用内进程、SDK 和桌面 IPC；本轮不能从 Bridge 源码推出 Desktop 3.1623.1 的具体实现。

因此本文的“IPC”只指**已确认的父子 CLI stdio/控制消息**，不是宣称已逆向出 Desktop Electron/Tauri/WebView 的全部进程通信。

## 二、CLI 子进程的真实启动证据

[sessionRunner.ts L248–343](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/sessionRunner.ts#L248-L343)：

- 调用 Node `child_process.spawn(deps.execPath, args, {cwd, stdio:['pipe','pipe','pipe'],env,...})`；
- 参数包括 `--print`、`--sdk-url`、`--session-id`、`--input-format stream-json`、`--output-format stream-json`、`--replay-user-messages`；
- CLI 子进程的 stdin 用于控制输入，stdout 传输 NDJSON，stderr 用于诊断；
- 调整子进程环境：不把 Bridge 的 OAuth Token 直接透传，使用 Session Access Token；
- 可按 Bridge 运行配置传递 Worker Epoch/CCR v2 等信息。

这只能证明**该 Bridge 的这条启动路径**。不能外推所有 Claude Code 和 Claude Desktop 安装必然通过这组参数启动。

## 三、控制消息的结构化 Schema

[controlSchemas.ts L550–645](https://github.com/wwxst/-/blob/main/restored-src/src/entrypoints/sdk/controlSchemas.ts#L550-L645) 定义：

| 传输消息 | 字段/用途 | 对内核有什么启发 |
| --- | --- | --- |
| control_request | request_id、request.subtype | 跨进程命令标识稳定 |
| control_response | success/error、request_id、可选 response | 响应应验证 Schema 和调用范围 |
| control_cancel_request | request_id | 撤销未完成的控制请求，不等于撤销系统副作用 |
| keep_alive | 控制连接保活 | 和业务 Session 存活/工具心跳区分 |
| update_environment_variables | variables | 高权限配置变更不能被任意外部调用伪造 |

已在 Schema 中确认的部分控制能力有 `can_use_tool`、`set_permission_mode`、`set_model`、`cancel_async_message`、`stop_task`、MCP 连接控制、插件刷新、Hook 回调等。**Schema 声明某种命令，不代表所有客户端都被授权调用它。**

## 四、具体数据如何跨进程移动

```text
父 Bridge / SDK 主机
     │
     ├── stdin ──(stream-json 控制输入/user)──> CLI
     │                                         │
     │                            StructuredIO 解析请求/响应
     │                                         │
     │                           Agent Loop / Tool / Policy
     │                                         │
     └── stdout <──(NDJSON events/control_request)── CLI
            │
       sessionRunner 提取活动、检测控制请求
            │
       Bridge / SDK Permission Adapter
            │
       control_response 再送回 CLI
```

[sessionRunner.ts L360–441](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/sessionRunner.ts#L360-L441) 直接通过 `readline` 按行处理子进程 stdout，对 `control_request` 和首个用户消息进行解析，向上层转发权限请求。同时可选把原始 NDJSON 追加到 Transcript 文件供调试。

[structuredIO.ts L130–219](https://github.com/wwxst/-/blob/main/restored-src/src/cli/structuredIO.ts#L130-L219) 在子进程内维护 pending request、已决 ToolCall、单一 outbound 流；注释强调单一写入队列可避免控制请求插队到先前尚未发出的模型事件之前。

这意味着**事件写入顺序与审批消息的可观察顺序**是协议的一部分，不能只保证 JSON 格式正确。

## 五、权限审批不是简单同步 RPC

[structuredIO.ts L538–660](https://github.com/wwxst/-/blob/main/restored-src/src/cli/structuredIO.ts#L538-L660) 先执行本地工具权限规则。只有 ask 时才并行运行 PermissionRequest Hook 和外部 SDK 审批。

- Hook 与外部审批以 `Promise.race` 争先；
- Hook 明确决定后取消未完成 SDK 请求；
- 外部审批先完成，则忽略之后 Hook 的决策；
- Hook 不给明确决定时继续等待 SDK；
- 抛错转为拒绝；
- 同一工具可能因为并行 ToolCall 出现多个进行中的审批请求。

[structuredIO.ts L275–340](https://github.com/wwxst/-/blob/main/restored-src/src/cli/structuredIO.ts#L275-L340) 还允许 Bridge 将网页端/远端的回答注入当前权限 Promise，同时向 SDK 消费端发取消控制消息，清除重复弹窗。

**自研建议**：多个审批来源可以并行收集意见，但可信 Policy Engine 必须以单一版本化事务确定最终结果。不要让“谁先从网络回来”成为不可审计的最终权威；输入改写应触发重新授权。

## 六、迟到、重复和断线

[structuredIO.ts L349–454](https://github.com/wwxst/-/blob/main/restored-src/src/cli/structuredIO.ts#L349-L454)：

- 按 request_id 查 pending；
- 收到响应时对已处理 ToolCall 去重；
- 对没有 pending 且已经处理的响应明确忽略；
- 对未知、孤立响应有外部处理回调；
- 成功响应仍要过 Schema；
- 输入流被关闭时会拒绝未完成请求。

[remoteIO.ts L105–173](https://github.com/wwxst/-/blob/main/restored-src/src/cli/remoteIO.ts#L105-L173) 说明 Bridge/SDK 远程模式还涉及 SSE/CCR；而 [replBridgeTransport.ts L230–254](https://github.com/wwxst/-/blob/main/restored-src/src/bridge/replBridgeTransport.ts#L230-L254) 明确存在 received/processed ACK 取舍，已单列在 [研究 18](18-远程Bridge事件确认与恢复.md)。

**自研建议**：

1. API 事件和 SDK 控制包采用版本化 Schema；
2. `requestId` 和 `toolCallId` 分离；
3. stdout/stderr/ToolHost 诊断信息不与业务事件任意混流；
4. 审批去重基于持久 `DecisionId`，不要仅依赖进程内环形集合；
5. 中断请求/被取消/已执行成功须分别编码，不能默默重复执行；
6. 客户端断线不能取消服务端实际已接收的 Turn，除非明确发送 CancelTurn。

## 七、对 Desktop 3.1623.1 的待验证清单

要把本文升级为**Desktop 专项逆向分析**，必须在新版 ZIP 实际内容中分别追踪：

- Desktop 主进程/renderer 的 Session 启动入口；
- 是否直接调用 Claude Agent SDK、Node/Bun/Native CLI 或某个中间进程；
- 真实 IPC Channel 名、payload Schema 和安全检查；
- 控制消息如何从 UI 经过主进程抵达 CLI，如何携带用户授权；
- 模型/工具输出如何从 Agent Loop 到 UI，是否经多级聚合；
- Desktop 断开或退出时，子进程是否保留运行、如何取消/恢复；
- Desktop 使用哪套 2.1.304 模块和具体版本，哪些路径仅存在于测试/旧兼容代码。

本轮未能读取项目 ZIP 的原始内容：文件服务尝试物化时返回文件过大（215770104 字节，限制 104857600 字节）；容器读 ZIP 工具也未成功。**因此本报告不将任何 Desktop 进程名、函数名或 IPC Channel 名写成既定事实。**

## 八、自研内核协议接口和测试

```ts
interface AgentControlEnvelope {
  schemaVersion: number;
  requestId: string;
  sessionId: string;
  expectedTurnId?: string;
  callerIdentity: string; // 由可信认证上下文赋值，而不是直接信任客户端字符串
  type: 'start_turn' | 'cancel_turn' | 'approval_decision' | 'stop_task';
  payload: unknown;
}
```

- T20-01 子进程 stdout 流有坏行、超大行、半条 JSON、非 UTF-8：不破坏其他 Session；
- T20-02 客户端审批断线后恢复，迟到响应不能改变已持久决定；
- T20-03 多个 Hook 和 UI 审批竞态：单次 ToolCall 只能被唯一一次批准；
- T20-04 用户请求重复投递，不重复创建 Turn；
- T20-05 停止 Task 与取消 Turn 各自使用独立 ID 和结果状态；
- T20-06 SDK Schema 披露的 `update_environment_variables` 等高危能力只对可信主体开放；
- T20-07 子进程重启不会借重新发出 `control_request` 重放危险工具；
- T20-08 UI 显示的“已完成”必须来自持久 Turn 终态，而非仅收到 `control_response`。

## 九、结论和限制

可以确认 Claude Code 2.1.88 的 Bridge/SDK/CLI 父子进程控制方式，以及具体权限事件与重复响应处理。**暂时不能确认 Claude Desktop 3.1623.1 的真实 IPC 拓扑，亦不能把 2.1.88 的协议实现逐字归属于 2.1.304。**

因此对我们的 Agent Kernel，建议只吸收明确的**控制平面与数据平面分离、Schema 校验、去重、单一事件顺序与受信任审批提交**原则；实际 Desktop 兼容适配必须等新版 ZIP 可直接读取后再决定。
