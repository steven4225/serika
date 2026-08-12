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
