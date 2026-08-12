# AI SDK Agent Framework

这是一个处于设计阶段的通用 Agent 内核。当前还没有绑定具体业务；目标是先建立一个可靠、可测试、可扩展的最小运行时，再通过真实用例验证它。

## 当前结论

- TypeScript + Node.js，使用 pnpm 管理依赖。
- 底层采用 Vercel AI SDK 的 `ToolLoopAgent`。
- 对上提供自己的 `AgentRuntime` 契约，不让应用直接依赖 AI SDK 的循环实现。
- 第一阶段只支持单 Agent、多步工具调用、流式事件、人工审批、取消和超时。
- 第一阶段使用内存存储和 CLI 示例；数据库、Web UI、RAG、长期记忆、多 Agent 和分布式执行暂缓。

完整设计见 [docs/architecture-v0.md](docs/architecture-v0.md)。

## 阶段

当前：`M1 / runnable skeleton`

已经具备公共契约、运行时状态机、连续事件流、内存 Store、Model/Tool Registry、AI SDK 7 adapter、CLI 示例和 mock 契约测试。

运行：

```bash
pnpm typecheck
pnpm test
pnpm demo
```

下一步是 M2：工具风险策略、审批后恢复、工具级 deadline/cancel、错误分类细化和日志脱敏。
