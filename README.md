# AI SDK Agent Framework

这是一个处于设计阶段的通用 Agent 内核。当前还没有绑定具体业务；目标是先建立一个可靠、可测试、可扩展的最小运行时，再通过真实用例验证它。

## 当前结论

- TypeScript + Node.js，使用 pnpm 管理依赖。
- AI SDK adapter 使用 `streamText`，由框架自行控制模型—工具循环。
- 对上提供自己的 `AgentRuntime` 契约，不让应用直接依赖 AI SDK 的循环实现。
- 当前本地路径支持单 Agent、多步工具调用、流式事件、取消、超时，以及基于 JSONL 的对话恢复。
- 持久化人工审批、真实写工具、Web UI、RAG、长期记忆、多 Agent 和 Durable 执行暂缓；TUI 已支持当前工具调用的临时 y/n 确认。

完整设计见 [docs/architecture-v0.md](docs/architecture-v0.md)。

## 阶段

当前：`M-TUI-thin`

已经具备自有 AgentLoop、JSONL transcript、print CLI，以及只通过 Runtime 契约驱动、带临时工具确认的精简 TUI。

运行：

```bash
pnpm typecheck
pnpm test
pnpm demo
pnpm tui
```

`pnpm tui -- <transcript-directory> --thread <id>` 启动精简 TUI；不传目录或 thread 时会生成临时目录和 thread id。

### MiniMax M3

CLI 默认使用内置 mock 模型。要接入国际版 MiniMax M3，设置 API Key 并切换模型模式：

```bash
export MINIMAX_API_KEY="<your-minimax-api-key>"
RUNLOOM_MODEL=minimax-m3 pnpm demo
```

入口默认使用 `https://api.minimax.io/v1` 和 `MiniMax-M3`。也可以通过 `MINIMAX_BASE_URL`、`MINIMAX_MODEL_ID` 覆盖；API Key 只在 CLI 入口读取，模型工厂本身不读取环境变量。

TUI 使用相同的模式和环境变量：

```bash
RUNLOOM_MODEL=minimax-m3 pnpm tui -- ./var/runloom --thread demo
```

真实文件/Shell 工具和持久化审批仍未进入这条主链；TUI 的 y/n 只决定当前 Run 的一次工具调用，不形成可恢复的审批记录。Durable Run Driver 仍不进入这条主链。
