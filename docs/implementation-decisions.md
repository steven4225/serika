# 模块细节如何敲定

本项目不在开工前冻结所有内部实现，也不允许公共接口在编码中无记录地漂移。采用三层决策节奏。

## 1. 进入里程碑前：冻结跨模块契约

在 M1、M2、M3 各自开工前，先敲定：

- 模块职责和依赖方向；
- 公开输入、输出和错误；
- 状态转换与必须维持的不变量；
- 事件语义；
- 最少一组契约测试。

这些变更会影响调用方，修改时必须更新架构文档和契约测试。

## 2. 实现模块时：敲定内部细节

编码前为该模块写下正常路径、边界路径和失败路径；随后通过实现与单测确定：

- 私有数据结构；
- 算法和控制流；
- 依赖库的具体 API；
- 错误映射；
- 资源清理与并发细节。

这些细节如果可逆、且不越过模块边界，可以直接迭代，不需要提前做成框架配置项。

## 3. 接入真实业务后：验证扩展能力

数据库、HTTP/UI、RAG、长期记忆、多 Agent 和分布式恢复，只有首个真实用例证明需要后才进入里程碑。出现第二个实现之前不抽象通用 adapter。

## M1 已冻结的模块细节

以下表格是 M1 当时的决策记录，不代表当前实现快照。当前本地 adapter 已使用 `streamText` 和自有 `AgentLoop`；运行能力以 README 和现有代码为准。

| 模块 | 已冻结内容 | 仍可调整 |
| --- | --- | --- |
| Core types | AgentDefinition、RunRequest、RunHandle、RunResult 语义 | 字段命名的兼容性调整 |
| Runtime | 一次 run 一个 AbortController；总超时归 Runtime；终态只落一次 | 更细的错误分类 |
| Store | run 乐观版本号；每个 thread 一个 active run；事件序号连续 | 持久化数据库和事务实现 |
| Event channel | 先持久化再推送；关闭后不可写；流结束不代表失败 | backpressure 策略 |
| Model registry | 逻辑 model ID 映射 AI SDK LanguageModel | 首个真实 provider |
| Tool registry | 工具与风险 metadata 分离；按 AgentDefinition 激活工具 | M2 审批策略、超时包装和脱敏 |
| AI SDK adapter | 使用 AI SDK 7 ToolLoopAgent；只向上输出框架事件 | M2 approval resume；将来是否自定义 loop |
| Tests | Node 内置 test runner；mock-first；不需要 API key | 真实 provider smoke test |

## 决策升级标准

满足任一条件时，应新增 ADR：

1. 改变两个或更多模块的接口；
2. 改变持久化格式或状态机；
3. 引入不可逆的外部依赖；
4. 涉及安全、审批、幂等或副作用语义；
5. 有两个合理方案且会长期影响维护成本。

模块内部的小重构、命名修正和测试辅助代码不写 ADR。

## M-TUI-thin 任务 inbox 契约（Stage 6-4）

本阶段只为现有 workspace 任务增加“是否已确认”的终态标记，不改变 worker 的执行路径：

- `TaskRecordV3` 增加 `acknowledgedAt: string | null`。`version: 1`/`version: 2` 文件在读取时补 `null`，第一次成功写入时升级为 `version: 3`。
- inbox 候选必须同时满足 `status ∈ {completed, failed, interrupted}` 和 `acknowledgedAt === null`。`scheduled`、`running`、`cancelled` 不能确认并返回 `TASK_NOT_ACKNOWLEDGEABLE`。
- `acknowledge(id)` 只确认单条任务且幂等：首次写入 UTC 时间，重复调用保留第一次时间戳并返回同一记录。`finish` 和 `interruptRunning` 产生的终态都保持 `acknowledgedAt: null`。
- `task_list` 增加可选 `inbox`，与已有 `status`、`recurringTaskId` 过滤器按 AND 组合；摘要和 `show` 返回 `acknowledgedAt`。`task_ack` 是对应的单任务写工具；命令适配器提供 `/task inbox` 和 `/task ack <id>`。
- worker 仍只 claim 到期的 `scheduled` 任务，重复任务仍按原规则推进；inbox 确认不触发重试、执行、递归推进或跨进程通知。

## Stage 6 收尾边界

- 完成证据：命令创建任务后，由独立 worker 执行并持久化结果和 transcript；查询不写入，ack 后退出 inbox，重启仍保留首次确认与历史；新任务使用新 thread 正常执行。
- 重复任务的执行进度与结果确认正交：确认旧 occurrence 不改变计划；与另一客户端的 finish 并发时不丢写；启动恢复只把遗留 running 标为 interrupted，不重放该 occurrence。
- 自动测试使用 mock 和虚拟时钟；真实模型复用同一闭环验收，不新增生产 API 或依赖。基础 PR CI 运行现有 typecheck/test，不承诺数据库集成或真实模型网络可用性。
- Stage 6 到此封板。后续先确定一个真实产品闭环，不因任务模块已经存在而继续增加通知系统、批量操作、队列或调度平台。

2026-09-11 本地验收：`pnpm typecheck` 通过，`pnpm test` 为 283/283；同一生命周期测试使用真实 MiniMax 完成两次任务并通过重启后的结果/确认持久性校验。CI YAML 已通过本地解析，但 GitHub 首跑仍待提交后验证；本轮未运行 PostgreSQL integration。
