# 31 · Pi Agent Core → Kernel 边界适配原型

> 日期：2026-10-29。状态：隔离原型，未接入生产 Kernel。  
> 动态包：`@earendil-works/pi-agent-core@1.4.0`、`@earendil-works/pi-ai@1.4.0`。  
> 验证：GitHub Actions [Run #40844898896](https://github.com/wwxst/agent-/actions/runs/40844898896)。  
> **结论范围：验证了注入式 Journal/Host 边界的控制流；没有验证真实数据库事务或真实外部副作用。**

## 0. 结论

**Pi Core 可以被包在一个明确的 Kernel 边界后面，值得进入下一阶段集成验证；它仍然不是可直接替换当前内核的成品。**

在 Node 22.19.0 下，循环实验 4 项 + 边界适配实验 7 项，共 **11/11 测试通过**。同一 CI Run 的自研 Kernel 回归矩阵 Node 22.16.0 与 Node 22 也都通过。

本轮新增的关键点不是让 Pi 自己拥有执行权，而是让 Pi 负责循环、消息编排与模型可见结果，同时由注入的可信 Host 负责工具执行，由注入的 Journal 负责 Intent/Receipt/恢复判定。

## 1. 本轮原型的边界

代码：`experiments/pi-core-adapter/kernel-boundary-adapter.mjs`。测试：`experiments/pi-core-adapter/adapter.test.mjs`。

- `Agent.message_end` 事件监听器被异步等待。普通可执行 Assistant 消息与整批 ToolCall Intent 通过一次 `commitAssistantMessage(...)` 调用提交；提交完成之前，Pi 不会开始工具。
- Assistant 消息总是先提交到注入的 Journal。对于 `length`、`error`、`aborted` 这类 Pi 不会执行其 ToolCall 的终态消息，只记录消息，不生成可执行 Intent。
- 工具包装器在进入 Host 前检查 Intent 是否已提交；检查过程中若另一并行工具已触发 fail-closed 状态，还会再次检查状态，避免晚到的工具越过安全边界。
- Host 必须返回与当前 `callId` 匹配的 Receipt。Receipt 持久化成功前，不会把工具输出交给 Pi 作为模型可见结果。
- Host 抛错、返回 Unknown、Receipt 缺失/不匹配或 Receipt 写入失败，都会转为 `OUTCOME_UNKNOWN`、尝试记录 UNKNOWN，并中止后续模型请求。
- 若 UNKNOWN 标记本身也写入失败，缺少 Receipt 的 Intent 仍保持 unresolved；下一次运行被拒绝，而不是自动重放。
- 同一 adapter 实例明确串行化 Turn。上一次运行留下失败的内存 transcript 时，不允许直接复用它盲目重试。
- Turn 结束后再次检查 unresolved 状态，不能在仍有未结算 Intent/Receipt 时返回 `COMPLETED`。

## 2. 动态测试结果

| 测试 | 结果 | 证明范围 |
|---|---|---|
| 完整 Assistant + Intent 批次一次提交 | PASS | 注入的 fake Journal 接口被一次调用；不证明真实数据库事务原子性 |
| 同一 Agent 实例串行化 Turn | PASS | 并发调用在第二次模型请求前被拒绝 |
| Intent 批次写入失败 | PASS | 批内任何工具都没有启动；旧 Agent 状态不能被直接重用 |
| Receipt 写入失败 | PASS | 结果为 `OUTCOME_UNKNOWN`，无后续模型请求，无盲目重放 |
| 截断 ToolCall | PASS | Assistant 消息仍记录，但不创建可执行 Intent、不启动工具 |
| 并行批次中一个工具变成 Unknown | PASS | 还未跨过 Host 边界的晚到工具被阻止；原 Unknown 原因没有被覆盖 |
| UNKNOWN 标记写入失败 | PASS | 未收据化的 Intent 仍然阻止后续运行 |
| 循环级事件屏障、反序完成、截断、事件监听器失败 | PASS | 与报告 30 的四项循环实验一致 |

## 3. 这轮发现的架构要求

### 3.1 Pi 只能提供控制流，不拥有可信执行事实

Pi transcript 中的 ToolResult 是给模型看的反馈，不是 Host Receipt。即使 Pi 认为工具执行成功，只有 Kernel 所信任的 Host 才能产生执行事实；只有 Journal 成功提交 Receipt 后，结果才能被当作已结算的上下文。

### 3.2 未知结果必须让会话保持阻塞

Receipt 写入失败时，工具可能已经产生副作用。把它变成普通工具错误后继续向模型请求，可能导致模型再次发起同一操作。原型把这条路径转成 `OUTCOME_UNKNOWN`，并在之后的运行入口检查 unresolved 状态。

### 3.3 事件监听器不是事务系统

原型中的 `commitAssistantMessage` 是一个注入接口，测试只验证调用顺序和失败时不执行工具。实际生产实现仍必须用同一个数据库事务持久化 Assistant 消息与完整 Intent 批次，并在崩溃后通过 EventStore/审计逻辑恢复。当前实验使用的是内存 fake Journal，不具有 fsync、进程崩溃或跨进程互斥保证。

### 3.4 并行未知结果仍需进一步验证

本轮验证了一个工具进入 Unknown 后，尚未进入 Host 的晚到工具会被阻止；没有证明已经开始执行的其他并行工具都能安全取消、排空或收敛。生产实现必须等待所有已启动 Host 调用的可证明终态，并对每个调用分别记录 Receipt/Unknown。

## 4. 尚未实现的生产合同

本原型没有接入以下现有内核能力，也没有证明这些合同在 Pi 后端下成立：

- SQLite EventStore 与真实原子事务；
- ManagedSessionRunner、Lease 续租、fencing token 和撤租后的行为；
- 当前 ToolRegistry、ToolHost、权限审批、工具隔离与凭据边界；
- 进程崩溃、恢复审计、重复调用防护与跨进程会话独占；
- Cancellation、Steering、Follow-up、上下文压缩/检查点；
- 真实模型 Provider、真实 Coding 任务、跨平台和性能/维护成本基准；
- Pi 发布包 1.4.0 与固定源码提交之间的精确构建对应关系，以及完整许可/依赖审查。

## 5. 下一道验收门槛

下一步应当是把这个接口连接到**现有 Kernel 的真实 EventStore 和可信 ToolHost**，而不是让 Pi 自己接管这些机制：

1. 实现真实的 `commitAssistantMessage + Intent batch` 数据库事务；
2. 让 Pi Tool 包装器调用当前可信 ToolHost，而不是直接执行任意工具实现；
3. 将 Host Receipt 映射回当前事件账本，并沿用现有 `inspectToolAudit` / unresolved 检查；
4. 注入 Lease 撤销、取消、Host 已执行但 Receipt 写入失败、进程崩溃和 UNKNOWN 标记失败；
5. 验证并行批次中一个调用 Unknown 时，其他已启动调用如何排空和结算；
6. 对照当前自研 Loop，在相同 FakeProvider 轨迹下比较行为覆盖、适配代码量、依赖维护成本与最低 Node 版本。

## 6. 裁决

- **ADOPT AS EXPERIMENT**：Pi Agent Core 作为可替换 Loop 候选继续验证。
- **KEEP**：现有 Kernel EventStore、Lease/Fencing、可信 Host、Receipt 与 Unknown 恢复合同。
- **DO NOT ADOPT YET**：不把 Pi 加入生产依赖，不替换当前 Loop，不因这 11 项测试通过就声称整体能力超过 Codex 或 Claude Code。

目前得到的是一个值得继续投入的适配边界原型，不是生产迁移批准。
