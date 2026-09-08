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

要启用受控的只读文件工具，同时传入 workspace：

```bash
RUNLOOM_MODEL=minimax-m3 pnpm tui -- ./var/runloom --thread demo --workspace ./sample-project
```

`--workspace` 是本次进程允许 `read_file` 读取的根目录；不传时不会注册这个工具。每次读取都显示相对路径并等待 `y/n` 确认。工具只接受 workspace 内的相对路径，读取普通 UTF-8 文本，单文件上限为 64 KiB；绝对路径、越界路径、符号链接、目录、非法 UTF-8 或含 NUL 的内容会被拒绝。它不按扩展名判断文本类型，也不承诺识别所有二进制格式。文件内容会进入模型上下文，并在 Run 完成后随已提交 transcript 保存。workspace 是应用层的路径边界，不提供操作系统级沙箱隔离。

TUI 的模块命令在空闲时直接执行，不创建 Run；配置 workspace 后可用 `/workspace` 查看当前根目录。模块通知使用同一条 TUI 输出流。

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

Shell 工具、写文件工具和持久化审批仍未进入这条主链；TUI 的 y/n 只决定当前 Run 的一次工具调用，不形成可恢复的审批记录。Durable Run Driver 仍不进入这条主链。
