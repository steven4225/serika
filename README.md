# Runloom

这是一个已具备本地 Agent 执行能力的实验性运行时。当前尚未绑定具体业务；本地能力建设到 Stage 6 为止，下一步通过一个真实用例验证它，不继续预建通用平台功能。

## 当前结论

- TypeScript + Node.js，使用 pnpm 管理依赖。
- AI SDK adapter 使用 `streamText`，由框架自行控制模型—工具循环。
- 对上提供自己的 `AgentRuntime` 契约，不让应用直接依赖 AI SDK 的循环实现。
- 当前本地路径支持单 Agent、多步工具调用、流式事件、取消、超时，以及基于 JSONL 的对话恢复。
- TUI 已支持受控的文件读写、当前工具调用的临时 y/n 确认，以及显式的 workspace 记忆；后台 worker 支持一次性/重复任务和结果 inbox。
- 持久化人工审批、Web UI、RAG、长期/全局记忆、多 Agent 和 Durable 执行不在当前本地主链内。workspace JSON/JSONL 不提供可恢复的外部副作用保证。

完整设计见 [docs/architecture-v0.md](docs/architecture-v0.md)。

## 阶段

当前：`M-TUI-thin / Stage 6`（本地任务闭环）

已经具备自有 AgentLoop、JSONL transcript、print CLI、精简 TUI，以及独立的本地任务 worker。Stage 6 的范围止于创建、执行、查询、重复调度和显式结果确认；不继续增加推送、批量管理或多 worker。

运行：

```bash
pnpm typecheck
pnpm test
pnpm demo
pnpm tui
```

`pnpm tui -- <transcript-directory> --thread <id>` 启动精简 TUI；不传目录或 thread 时会生成临时目录和 thread id。

要启用受控的 workspace 文件工具，同时传入 workspace：

```bash
RUNLOOM_MODEL=minimax-m3 pnpm tui -- ./var/runloom --thread demo --workspace ./sample-project
```

需要在每次成功的普通 Run 后自动发起一次只读记忆整理时，加上 `--auto-consolidate`（必须同时提供 `--workspace`）：

```bash
RUNLOOM_MODEL=minimax-m3 pnpm tui -- ./var/runloom --thread demo --workspace ./sample-project --auto-consolidate
```

`--workspace` 是本次进程允许文件工具访问的根目录；不传时不会注册这些工具。每次工具调用都显示相对路径并等待 `y/n` 确认。工具只接受 workspace 内的相对路径，读取普通 UTF-8 文本，单文件上限为 64 KiB；绝对路径、越界路径、符号链接、目录、非法 UTF-8 或含 NUL 的内容会被拒绝。它不按扩展名判断文本类型，也不承诺识别所有二进制格式。文件内容会进入模型上下文，并在 Run 完成后随已提交 transcript 保存。workspace 是应用层的路径边界，不提供操作系统级沙箱隔离。

配置 workspace 后，TUI 提供 `list_directory`、`search_files`、`read_file`、`write_file`、`edit_file` 以及 `memory_list`、`memory_prepare_consolidation`、`memory_add`、`memory_update`、`memory_delete`。`list_directory` 列出一层目录；`search_files` 按字面量搜索符合条件的 UTF-8 文本，并跳过隐藏路径、`node_modules` 和符号链接，结果可能因上限被标记为 `truncated`。`write_file` 只创建新文件，已存在则失败，不会覆盖。`edit_file` 对已有文件做恰好一处字面量替换；找不到或多处匹配则失败。workspace 记忆保存在 `.runloom/memory.json`，只有用户明确要求时才由工具增删改；启用的条目会作为不进入 transcript 的参考消息注入模型上下文。用户明确要求整理或沉淀对话时，`memory_prepare_consolidation` 读取当前 thread 最近已提交的对话和全部记忆，下一步模型先给出普通回复建议；用户点名后才调用 `memory_add` 或 `memory_update` 保存。每次工具调用仍需 `y/n` 确认；确认通过后写入立即生效，之后取消或 Run 失败不会回滚文件或记忆。

启用 `--auto-consolidate` 后，普通 Run 成功且本轮没有 `memory_*` 工具请求时，TUI 会在回到空闲前串行发起一次只读整理 Run。整理只会提出建议，记忆写入仍需用户明确点名并通过 `y/n` 确认；失败、取消和整理自身不会再次触发。

TUI 的模块命令在空闲时直接执行，不创建 Run；配置 workspace 后可用 `/workspace` 查看当前根目录。模块通知使用同一条 TUI 输出流。

TUI 默认提供一个进程内番茄钟：`/pomodoro start`、`/pomodoro status`、`/pomodoro cancel`。启动计时后立即返回，退出 TUI 时清理计时器；计时状态不会跨进程恢复。

配置 workspace 后还可以创建一次性任务。TUI 提供 `/task create <带时区的ISO时间> <prompt>`、`/task list [pending|attention|status]`、`/task inbox`、`/task show <id>`、`/task ack <id>` 和 `/task cancel <id>`；任务保存在 `<workspace>/.runloom/tasks.json`。独立 worker 必须持续运行，TUI 关闭后仍会在到期时执行：

```bash
RUNLOOM_MODEL=mock pnpm task-worker -- --workspace ./sample-project
```

worker 为每个任务创建新 thread，只运行一次无工具的纯文本回复，并把结果写回任务文件；任务不会自动重试或从中断处恢复。任务更新使用 `.runloom/tasks.json.lock`，worker 独占使用 `.runloom/task-worker.lock`，两者都是由操作系统释放的 advisory `flock` 锁。worker 的 claim、执行、重复任务推进和启动恢复不读取 inbox 确认状态。

任务查询只读现有任务文件：`/task list pending` 查看 `scheduled` 和 `running`，`/task list attention` 查看 `failed` 和 `interrupted`，`/task inbox` 查看尚未确认的终态任务（`completed`、`failed`、`interrupted`）。`/task show <id>` 查看完整 prompt、执行信息、结果、失败原因和 `Acknowledged at`；列表显示结果、错误摘要和确认时间，完整内容通过 `show` 获取。`/task ack <id>` 只确认一个已完成、失败或中断且尚未确认的任务；重复确认保持第一次的时间戳并返回同一记录。`task_list` 的 `inbox` 可与 `status`、`recurringTaskId` 一起作为 AND 条件使用。查询不会重试任务、改变执行状态，也不会从 worker 跨进程推送通知。

同一 workspace 还支持 daily/weekly 固定时区偏移的重复任务：`/task repeat create daily <HH:mm> <+/-HH:mm> <prompt>` 或 `/task repeat create weekly <1-7> <HH:mm> <+/-HH:mm> <prompt>`，并可用 `/task repeat list [active|paused|cancelled]`、`show`、`pause`、`resume`、`cancel` 管理。每次到期只生成一个独立的一次性任务；worker 会把下一次时间推进到严格晚于当前时间，过期多周期也只补一个并跳过中间周期。暂停会清空下一次时间，恢复从未来 occurrence 重新计算；取消只停止后续 occurrence，已经运行的任务继续完成。任务文件当前为 `version: 3`，`TaskRecordV3` 增加可空的 `acknowledgedAt`；旧版 `version: 1`/`version: 2` 文件仍可读，第一次成功写入时升级为 `version: 3`，旧记录补为 `null`。`task_ack` 是幂等的单任务写工具；不引入推送、批量确认、通知表、队列或多 worker。

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

Shell 工具和持久化审批仍未进入这条主链；受控写文件工具已经接入。TUI 的 y/n 只决定当前 Run 的一次工具调用，不形成可恢复的审批记录。Durable Run Driver 仍不进入这条主链。

### Stage 6 验收

`pnpm test` 包含命令模块 → 独立 worker 进程 → 结果/transcript → inbox → ack → 杀进程并重启的闭环验收，默认强制使用 mock，不依赖模型密钥。Store 测试另用虚拟时钟验证重复任务跳过过期周期、启动中断恢复，以及确认旧结果与下一次执行互不干扰。

使用已配置的 MiniMax 环境进行同一闭环的真实模型验收（会发起两次短文本模型请求）：

```bash
pnpm build
RUNLOOM_ACCEPTANCE_MODEL=minimax-m3 node --env-file=.env --test examples/cli/dist/task-acceptance.test.js
```

`.env` 需自行配置且不应提交；普通 CLI/worker 不自动加载它，应先导出变量或使用 Node 的 `--env-file`。验收创建临时 workspace 并在结束后清理，不修改日常任务。此测试覆盖命令模块和真实 worker 进程，不是终端交互 UI 测试，也不证明操作系统会自动唤醒已退出的 worker。

`.github/workflows/ci.yml` 在 PR 和 main push 上执行依赖锁定安装、`pnpm typecheck` 和 `pnpm test`；真实模型验收与 PostgreSQL integration 不在该基础 CI 内。
