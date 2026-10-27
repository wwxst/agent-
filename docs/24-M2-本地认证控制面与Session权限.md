# 24 · M2 本地认证控制面：身份、Session 权限与无重放 API

> 交付性质：**可显式启动的 127.0.0.1 本地 HTTP 适配器**，为 Command Inbox 和 Dispatcher 补齐最小可信入口。不是生产远端网关、密码保险箱、认证授权中心或高风险工具审批系统；**没有 TLS、账号生命周期、持久审计身份、生产限流或 OS 隔离**。不能直接绑定到公网、容器公开端口或经反向代理公开。

## 目的与范围

当前 `ManagedSessionRunner.acceptCommand()` 和 `dispatchCommand()` 属于可信同进程方法；如果直接开放 HTTP，这类操作会让未经认证的请求驱动模型和工具。新增 `packages/control-plane`，把远端可到达的**接受、查看、分发**操作强制经过两道检查：

1. 使用强随机 **32 字节 Base64url Bearer Secret**；后端只存 SHA-256 摘要，在固定长度 Buffer 上用 `timingSafeEqual` 与每个 Principal 比较。
2. 每个 Principal 必须显式列出 `sessionIds` 以及 `permissions`：`command.accept`、`command.inspect`、`command.dispatch`，缺少权限即 `403 FORBIDDEN`。不允许通配 Session、隐式超级管理员或匿名访问。

这些 Secret 应由外部受信机制用 `randomBytes(32).toString('base64url')` 生成并在程序启动时注入，**不可硬编码于源码、URL、日志或 GitHub Actions 输出**。配置一个短令牌、重复令牌、重复主体或空权限列表，服务启动前就会被拒绝。它使用静态内存身份表；**Principal 身份仅对当前进程内会话有效**，尚未提供正式用户认证、身份签名和撤销/轮换传播。

## 接口

```ts
import {randomBytes} from 'node:crypto';
import {startLoopbackControlServer} from './packages/control-plane/src/index.js';

const credential = randomBytes(32).toString('base64url');
const control = await startLoopbackControlServer({
  databasePath: './agent.sqlite',
  runner, // 已配置 Trusted ManagedSessionRunner，Session 必须先在可信侧创建
  principals: [{
    principalId: 'operator-a',
    bearerToken: credential,
    sessionIds: ['session_1'],
    permissions: ['command.accept','command.inspect','command.dispatch'],
  }],
  port: 0, // OS 选择未占用端口
});
console.log(control.origin); // 仅示例：不要输出 credential
// 使用结束后 await control.close()
```

> 仅绑定 IPv4 `127.0.0.1`；强制 `Host: 127.0.0.1:<实际端口>`。拒绝浏览器 Origin 和 CORS 预检，不设置 Cookie，不启用任何 Access-Control-Allow-Origin。HTTP 客户端必须自己保护 Bearer Secret，不允许将它放进 URL 或 query string。

接口（`Authorization: Bearer <secret>`）：

| 方法与路径 | 权限 | 请求 | 响应 |
| --- | --- | --- | --- |
| `POST /v1/sessions/:id/commands` | `command.accept` | JSON `{expectedSeq,commandId,kind:"turn.run",payload:{text}}` | `{command:{sessionId,commandId,acceptedSeq,replayed,status:"accepted"}}` |
| `POST /v1/sessions/:id/commands/:commandId/dispatch` | `command.dispatch` | 无请求体 | `{dispatch:{sessionId,commandId,turnId,acceptedSeq,boundSeq,replayed,status}}` |
| `GET /v1/sessions/:id/commands/:commandId` | `command.inspect` | 无请求体 | 若已绑定返回不含文本的 `dispatch` 元数据；仅接受未绑定则返回 `{command:{commandId,acceptedSeq,status:"accepted"}}` |

**严格区分 Command ACK 与实际执行结果。** 即使 HTTP 断开或命令丢失响应，重复投递必须先读取原持久映射：`dispatchCommand` 自身保证不会第二次调用 Provider/ToolHost。GET 是只读，不获取 Writer Lease，故不需要占用当前运行中 Session 的 Writer 锁；POST 操作则保持既有 Fencing/事务语义。

本 API **故意不返回**任何 Command Payload、`DispatchedTurn.text`、模型输出、工具内容、API Secret、DB 异常栈、HTTP 内部错误信息。它适合受信客户端查看 Command 状态，不是全功能 Agent UI 事件订阅。

## 请求与安全限制

- HTTP Server 只监听本机 TCP loopback，不受配置影响绑定到 `0.0.0.0` 或公共网卡。
- 路由中 Session 和 Command ID 只允许 1–128 位 `[A-Za-z0-9_-]`；用于控制面的 Session ID 不支持 URI 路径嵌入斜线。
- 拒绝重复的 `Authorization` Header。仅接受严格 `Bearer ` 大小写格式；使用定长 Base64url 字符集，所有主体进行定长 `timingSafeEqual` 比较。
- 对 POST /commands，`Content-Type` 必须是 `application/json`；原始 HTTP Body 最大 70 KiB，解析后仅接受规定键与 `kind=turn.run`、单一 `payload.text`。JSON 经过下层 Inbox 的规范化与幂等指纹校验。拒绝压缩 Body、异常额外字段及空文本。
- 对 POST /dispatch 和 GET /status，不能包含请求体；浏览器跨 Origin 请求和伪造 Host 拒绝。响应含 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。
- 所有 API 错误返回固定结构化 `error`；内部异常不回显 Payload/SQL/模型消息。429 速率限制尚未实现，**不能开放给无可信网络隔离的客户端**。
- GET 已接受但未分发的命令时，`SqliteCommandInbox.inspectAccepted` 在同一 SQLite 读取事务中验证 `session_commands` 与对应 `command.accepted` 的身份/Hash 一致，不能相信孤立篡改的 Inbox 表。

## 验证

新增 `tests/control-plane.test.ts` **12 项**（严格 TypeScript、真实 loopback HTTP、无公网请求、FakeProvider + SQLite）：

1. 经认证先 ACK、后分发，仅执行模型一次，HTTP 不泄漏原始文本和结果；
2. 无效、缺失、格式不合的 Bearer 被拒，数据库无写入；
3. 多 Principal 权限与 Session 白名单隔离；
4. 伪造 Host、浏览器 Origin 和错误方法被拒；
5. 内容类型、额外字段、超大 Body、空 Prompt 被拒；
6. ACK 丢失后的重复接受与内容冲突；
7. 弱 Token、重复 Principal/Token、非法配置启动前拒绝；
8. GET、POST 路由和 Query String 严格区分，禁止 GET 执行；
9. Writer Lease 已被持有时 GET 仍可只读状态查询，POST 分发被拒；
10. 没有 Cookie/CORS/密钥/Prompt 意外泄露；
11. 两个同名 Authorization 头被拒，不得绕过身份校验；
12. 篡改 Command ACK 后的 GET 不返回伪造已接受状态。

累计目标 **184 项**（原 172 + 12），Node 22.16.0 与 Node 22.x 双环境 GitHub Actions `npm run check`、`npm test` 以最终 PR CI 为准。

## 未解决风险与下一批

- Auth 只对受信 localhost 访问提供基础隔离，**不能抵御同一 OS 用户的恶意进程获取 Token 或修改 SQLite**，不提供多租户数据库强隔离；本地凭据需单独密钥管理和轮换。
- 尚无 HTTP TLS、密钥撤销/持久审计、生产暴力尝试限流、CSP/浏览器客户端协议或全链路主体身份与事件记录绑定。
- 仍只有演示只读工具，没有生产审批闭环与独立 OS 沙箱；不能因这轮增加了 HTTP 鉴权就放开 Shell 或外部写入工具。
- 下一步建议：**持久 Principal 授权审计 + 凭据轮换/撤销**，再做可信人工审批和 OS 级 Host 隔离。未决 ToolCall/Turn 不自动重放。

参考：[Command Inbox](20-M2-Command-Inbox-事务ACK与幂等.md)、[Command Dispatcher](23-M2-Command-Dispatcher-持久Turn绑定与重放阻断.md)、[双账本对账](17-M1-双账本只读对账与证据判定.md)。
