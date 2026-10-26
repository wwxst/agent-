# 09 · DeepSeek Harness 架构研究与借鉴评估

> 状态：v0.1 架构研究草案｜2026-10-24
> 研究对象：DeepSeek Harness（dsh）及 Cordis。只记录公开源码/文档观察和本项目设计建议；本项目尚未实现下述模块。

## 一、结论

**建议将 DeepSeek Harness 纳入第四个长期研究对象，优先吸收其“能力组合、作用域化注册、可逆生命周期、不同部署 Profile”思想，但不照搬“一切皆插件”的底层权威模型。**

区别在于：DeepSeek Harness 将 Agent Loop、Session Log、Tool Registry、模型适配与 UI 等作为可组合 Cordis 插件；本项目计划由稳定的 Kernel 内核持有不可绕过的 Turn 状态转换、事件提交、权限验证与副作用恢复语义，提供受控的扩展接口给业务能力。

## 二、公开架构证据（截至 2026-10-24）

- 官方首页：https://www.deepseek.com/harness/
- 开源仓库：https://github.com/deepseek-ai/deepseek-harness
- 架构总览：https://deepseek-harness.github.io/deepseek-harness/en/reference/
- Scoped Registration：https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/scope
- 进程沙箱：https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox
- Agent Loop 包说明：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md
- 官方安全声明：https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md

它以 Cordis Context 组织服务与事件，以 Profile/Bundle/Patch 组合应用，区分持久 Session Event 与短暂 live Agent Event，支持 per-Agent 的 scoped registration，以及插件注册资源的可逆销毁。官网说明目前仍为开发者预览版，接口可能出现不兼容变更。

**重要限制**：官方 Agent Loop 文档指出，内建 Turn 预算尚未具备；Root shutdown 时活跃 Agent 的最后 turn/end 可能存在内存已生成、持久日志尚未落盘的问题。官方安全文件明确指出未经安全审计，不可视为生产级安全系统。评估优势时必须保留这些限制，不能把参考对象的设计等同于已验证的实现质量。

## 三、四套参考项目的优势互补

| 研究对象 | 优先借鉴 | 不直接采用 |
| --- | --- | --- |
| Pi Agent | 清晰的小型 Loop、模型工具交互与 Steering | 不将 Pi SDK 设为自研内核依赖 |
| Codex | Turn/事件/审批/沙箱/上下文与恢复 | 不继承产品级内部耦合和外部协议所有权 |
| Claude Code | Skills、Hooks、Subagents、权限声明 | 不把提示词或 Hook 当作真实隔离边界 |
| DeepSeek Harness | Cordis 式可组合服务、Scope、可逆卸载、Profile、事件分层 | 不采用“所有权与安全内核都能任意热替换”的假设 |

不能据公开架构给出同模型同任务的绝对能力排行；这里比较的是**架构复用价值**。

## 四、优先吸收的五个机制

### 1. 能力契约和依赖组合（优先级 P1）

每种能力通过契约发布：ModelProvider、ToolProvider、ContextContributor、SkillProvider、TransportAdapter 等。由注册表装配和做能力协商，Agent Loop 不应 import 具体插件包。

初期固定组合；后期增加 Profile 配置、版本校验与冲突诊断。不为了配置灵活度而让 EventStore 或授权根可被用户安装插件替换。

### 2. 每 Agent 的 Scope 与能力视图（P1）

区分全局注册能力和 Agent/Session/Task 作用域：

- 工具注册有来源、版本、权限与作用域；
- 子 Agent 仅继承父 Agent 授权能力的子集；
- Agent 结束时，属于它的 Hook、监听器、临时工具、文件句柄和任务订阅全部解绑；
- 同名能力冲突要有明确顺序/错误，不能默默覆盖；
- 热卸载不能使正在执行的 ToolCall 跳转到另一个无关实现。

### 3. 可逆注册与资源生命周期（P1）

安装插件产生一个 ResourceScope，拥有对注册项、监听器、计时器、后台任务和外部连接的清理责任。卸载/异常回滚要做到幂等，重复关闭不得重复触发副作用。

概念接口：

```ts
interface ResourceScope {
  register(dispose: () => Promise<void> | void): void;
  dispose(): Promise<void>;
}
interface CapabilityPlugin {
  id: string;
  version: string;
  setup(ctx: CapabilityContext, scope: ResourceScope): Promise<void>;
}
```

真实设计还需要：依赖就绪、回滚顺序、超时处理、正在使用资源的引用与 drain、插件失败隔离。不能只实现一个 dispose 列表就宣称安全热插拔。

### 4. 持久事实与瞬态过程分离（P1）

- Session/Turn/ToolCall 状态改变需要持久事件、事务和可回放的来源；
- 模型 Token 增量、实时进度、UI Loading 等属于瞬态事件，可丢失并按需重建；
- 插件可以监听事件、贡献受限动作，但不能伪造终态或越过 Journal/Policy；
- 需设计提交前/提交后通知，避免“看到了完成通知，但持久日志丢失”。

这是值得借鉴而且需要比参考实现更严格验收的地方。

### 5. Profile/Bundle 配置式组装（P2）

计划支持：

- coding：文件/Shell 与代码测试工具；
- browser：浏览器、页面抓取与网络策略；
- media：FFmpeg、视频/音频处理与工件预览；
- headless：无 UI、定时或后台执行；
- safe-readonly：不允许副作用的受限配置。

Profile 是经过签名/校验的能力清单与依赖配置，不是获得额外操作系统权限的凭证。切换配置应作用于**下一 Turn 或安全边界**，已运行 Turn 固定所依赖的工具版本及能力授权。

## 五、明确不照搬的设计

1. **核心状态机不热替换**：Turn 生命周期、幂等和安全恢复由受保护 Kernel 管理；如果以后提供替代 Loop，要走实验标记、协议兼容与故障迁移。
2. **Event Journal 和授权根不允许普通插件接管**：可替换底层存储 Adapter，但必须满足一致性、权限和事务契约，禁止运行中无迁移切换。
3. **插件授权与 Sandbox 是不同的边界**：插件拥有 JS/Node 执行权时需要隔离环境、最小权限，不能假设 Cordis 的生命周期机制本身具备安全沙箱。
4. **不提前建设完整 HMR**：活跃 Turn 的热重载、可逆副作用和配置迭代冲突复杂，MVP 暂不做。
5. **不删除内建预算保护**：即使自定义 Loop，最大模型步数/工具调用/时长及审批边界必须由可信 Kernel 默认执行。

## 六、拟议的内核构成

```text
                    Client API (Web / CLI / Desktop)
                                │
                      Kernel Invariants
                 Turn FSM / Journal / Policy Root
                                │
                     Capability Composer
              Profile / Registry / Scope / Lifecycle
               ┌──────────┼──────────┐
           ModelProvider  ToolProvider  ContextProvider
               │           │           │
             Model API    Tool Host   Skills / MCP
                          │
                  Sandbox / OS Enforcement
```

Composer 只能为当前 Task 选择**已经得到授权**的 Provider、工具和扩展，不签发权限，也不能改动持久 Turn 结果。核心边界保持稳定；扩展自由发生在边界之外。

## 七、实施顺序与测试

- **M0**：先定义 Service/Capability 契约、静态 Registry、Fake 生命周期和构造期依赖检查。
- **M1**：Agent Loop 通过 Registry 获取 Provider/Tool，不直接 import 具体实现；基础作用域生命周期测试。
- **M2**：Scope 资源归属、卸载 drain、事件持久化门禁、权限绑定 ToolCall 与宿主，发布工具合同版本。
- **M3**：Skills/MCP/Plugin、分 Agent 能力视图与复合 Profile。
- **M4**：受限热重载、动态 Profile 与远程 Host；必须依赖稳定快照/迁移协议。

必须覆盖：插件初始化中途失败回滚、重复卸载、执行中卸载、同名覆盖、跨 Agent 能力泄漏、运行中 Profile 切换、事件先广播后写盘、恢复悬空 ToolCall、Budget 不足与未审计插件拒绝。

## 八、决策状态

该文档是研究与建议，并非已经批准的架构变更。将本建议转为工程约束前，应审阅 [ADR 0002](adr/0002-能力组合与可信内核边界.md) 并明确其 Accepted 状态，再同步更新 API/Schema 和测试。
