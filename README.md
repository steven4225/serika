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

当前：`M-TUI-thin / Stage 7-5`（内置模块接入约定与验收整理）

已经具备自有 AgentLoop、JSONL transcript、print CLI、精简 TUI，以及独立的本地任务 worker。Stage 6 的本地任务闭环已经完成；Stage 7 从一个真实 Todoist 只读模块开始验证应用扩展。当前 7-5 只把现有内置模块的接入方式写成约定，保持零运行时改动，不提供外部插件加载；7-3、7-4 的真实模型验收仍待补齐，不计入已完成口径。接入路径见 [模块开发指南](docs/module-development.md)。

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

### Todoist 只读模块

Todoist 模块只在 TUI 中通过 `--todoist` 显式启用。它不依赖 `--workspace`；启用时必须通过环境提供非空的 `TODOIST_API_TOKEN`：

```bash
export TODOIST_API_TOKEN="<your-personal-token>"
RUNLOOM_MODEL=minimax-m3 pnpm tui -- ./var/runloom --thread daily-plan --todoist
```

默认规划时区是 `Asia/Shanghai`，可用 `RUNLOOM_TODOIST_TIMEZONE` 设置为 Node `Intl` 支持的其它时区。全天日期保持原日期；没有 UTC 偏移的浮动时间按这个规划时区解释，不读取 Todoist 账户时区。因此当账户时区不同时，Runloom 的日期视图可能与 Todoist App 不一致。

模块提供 `todoist_list_tasks` 工具和 `/todoist list [planning|today|overdue|upcoming]` 命令。读取范围是令牌可见的活动任务中分配给当前用户或未分配的任务，明确包含共享项目中的未分配项。模块不提供完成、改期、改优先级、评论或其它写操作。

自然语言调用工具时会等待 `y/n`，因为返回的任务内容会进入模型上下文，并在 Run 成功后写入 transcript。直接执行 `/todoist list` 只查询并显示结果，不调用模型、不创建 Run，也不写 transcript；`RUNLOOM_MODEL=mock` 不会阻止这条命令访问真实 Todoist API。

查询最多扫描 5 页、返回 100 条任务，并限制工具结果大小。达到容量预算时返回 `truncated: true`，命令和模型必须明确说明结果不完整；即使 `tasks` 为空，也不能据此声称没有任务。认证、限流、网络或响应解析失败会使整次查询失败，不会把已经取得的前几页当作成功结果。

### 内置模块启动配置

Stage 7-2 支持用一份显式 JSON 配置选择 TUI 启用的内置模块。配置在启动时读取，修改后重启生效；不会自动搜索 `.runloom/config.json`，也不支持热更新、运行中启停或配置写入：

```bash
RUNLOOM_MODEL=mock pnpm tui -- ./var/runloom --thread daily-plan --config ./runloom.json
```

配置模式下未列出的模块默认关闭，模块配置必须使用 `{ "enabled": true|false }`。支持的模块是 `pomodoro`、`read-file`、`memory`、`task` 和 `todoist`；`read-file` 仍包含 `/workspace`、文件读写和搜索能力，示例 `add` 工具不属于配置模块。

```json
{
  "version": 1,
  "workspace": "./sample-project",
  "modules": {
    "pomodoro": { "enabled": true },
    "read-file": { "enabled": true },
    "memory": { "enabled": true, "autoConsolidate": false },
    "task": { "enabled": false },
    "todoist": { "enabled": true, "timeZone": "Asia/Shanghai" }
  }
}
```

`workspace` 相对配置文件所在目录解析。启用 `read-file`、`memory` 或 `task` 时必须提供有效 workspace；只启用 Todoist 或番茄钟可以省略。配置模式下 Todoist 时区只读取 JSON，缺省为 `Asia/Shanghai`；不传 `--config` 时仍沿用 `RUNLOOM_TODOIST_TIMEZONE`。Todoist token 始终从 `TODOIST_API_TOKEN` 读取，不能写进 JSON。

`--config` 与 `--workspace`、`--todoist`、`--auto-consolidate` 互斥，但可和 transcript 目录、`--thread` 一起使用。不传 `--config` 时，原有命令行行为保持不变。

`/modules` 始终可用，不属于配置模块；它显示配置来源、workspace、五个模块开关、自动整理、Todoist 时区和 token 是否存在，不显示 token。关闭 `memory` 会同时关闭记忆工具、记忆注入和自动整理；关闭 `task` 只影响当前 TUI，不会停止独立 worker。命令不创建 Run，也不写 transcript。

启用 `task` 并配置 workspace 后还可以创建一次性任务。TUI 提供 `/task create <带时区的ISO时间> <prompt>`、`/task list [pending|attention|status]`、`/task inbox`、`/task show <id>`、`/task ack <id>` 和 `/task cancel <id>`；任务保存在 `<workspace>/.runloom/tasks.json`。独立 worker 必须持续运行，TUI 关闭后仍会在到期时执行：

```bash
RUNLOOM_MODEL=mock pnpm task-worker -- --workspace ./sample-project
```

默认启动时，worker 为每个任务创建新 thread，只运行一次无工具的纯文本回复，并把结果写回任务文件；任务不会自动重试或从中断处恢复。任务更新使用 `.runloom/tasks.json.lock`，worker 独占使用 `.runloom/task-worker.lock`，两者都是由操作系统释放的 advisory `flock` 锁。worker 的 claim、执行、重复任务推进和启动恢复不读取 inbox 确认状态。

Stage 7-4 可通过独立的 `--todoist` 开关，授权该 worker 在后台任务中使用唯一的只读工具 `todoist_list_tasks`：

```bash
export TODOIST_API_TOKEN="<your-personal-token>"
RUNLOOM_MODEL=minimax-m3 RUNLOOM_TODOIST_TIMEZONE=Asia/Shanghai \
  pnpm task-worker -- --workspace ./sample-project --todoist
```

worker 不读取 TUI 的 `--config`；Todoist 规划时区独立取自 `RUNLOOM_TODOIST_TIMEZONE`，缺省为 `Asia/Shanghai`，启动日志会显示规范化后的实际时区。启用失败（如 token 缺失、时区非法或工具注册边界变化）会在领取队列任务前退出。不开 `--todoist` 时继续使用原有无工具、一步纯文本行为，也无法实时读取 Todoist。

`--todoist` 是 worker 进程级授权，覆盖该 workspace 中已经排期和以后到期的全部任务。任务触发查询时，Todoist 内容会进入所配置模型的上下文，并随结果写入本地 `resultText` 和该任务 thread 的 transcript；后台没有逐次 `y/n` 确认，也不保存 Markdown 或其它笔记。生产 `RUNLOOM_MODEL=mock` 仍只生成纯文本，不会主动调用 Todoist，因此 mock 运行成功不能作为真实查询证据。

开启 Todoist 后，正常的今日计划链路是一次 `planning` 查询后生成结果。查询失败时，模型可以把失败说明作为正常文本交付，此时任务仍可能是 `completed`：这里的 `completed` 表示 Run 正常结束，不表示 Todoist 查询或计划业务成功。该结果会出现在未确认的 `/task inbox` 和 `/task show <id>` 中；`/task list attention` 只列出 `failed` 与 `interrupted`，不会识别 `completed` 文本里的业务失败。

真实验收使用隔离 workspace、真实模型和正常权限的 Todoist token：先创建一个明确要求读取 Todoist 并生成今日计划的到期任务，再以 `--todoist` 启动 worker；核对启动时区、一次 `planning` 调用、任务事实与完整性标记、五个计划章节、`resultText`、transcript 和 inbox；重启后确认结果仍可通过 `/task show` 读取，最后显式 ack。worker 必须由用户持续运行；本阶段不提供操作系统唤醒、跨进程推送通知或生产级可靠性保证。

### Stage 7-5 模块接入约定

7-5 的版本内交付是[模块开发指南](docs/module-development.md)和本 README 的进度入口：沿用现有工厂注入、`setup` 注册、TUI 配置或 worker 显式清单、工具/命令执行和 `dispose` 的接入路径。指南以现有 Todoist/read-file 模块为例，不新增接口、配置版本、运行时行为或外部插件加载；`/modules` 和计算器 `add` 也不属于 `AgentModule` 协议。

本节只说明入口和边界，不复制各工具的数据契约。7-3、7-4 的真实 Todoist/模型验收仍需独立提供证据；因此 7-5 的指南完成不等于 Stage 7 封板。

任务查询只读现有任务文件：`/task list pending` 查看 `scheduled` 和 `running`，`/task list attention` 查看 `failed` 和 `interrupted`，`/task inbox` 查看尚未确认的终态任务（`completed`、`failed`、`interrupted`）。`/task show <id>` 查看完整 prompt、执行信息、结果、失败原因和 `Acknowledged at`；列表显示结果、错误摘要和确认时间，完整内容通过 `show` 获取。`/task ack <id>` 只确认一个已完成、失败或中断且尚未确认的任务；重复确认保持第一次的时间戳并返回同一记录。`task_list` 的 `inbox` 可与 `status`、`recurringTaskId` 一起作为 AND 条件使用。查询不会重试任务、改变执行状态，也不会从 worker 跨进程推送通知。

同一 workspace 还支持 daily/weekly 固定时区偏移的重复任务：`/task repeat create daily <HH:mm> <+/-HH:mm> <prompt>` 或 `/task repeat create weekly <1-7> <HH:mm> <+/-HH:mm> <prompt>`，并可用 `/task repeat list [active|paused|cancelled]`、`show`、`pause`、`resume`、`cancel` 管理。每次到期只生成一个独立的一次性任务；worker 会把下一次时间推进到严格晚于当前时间，过期多周期也只补一个并跳过中间周期。暂停会清空下一次时间，恢复从未来 occurrence 重新计算；取消只停止后续 occurrence，已经运行的任务继续完成。任务文件当前为 `version: 3`，`TaskRecordV3` 增加可空的 `acknowledgedAt`；旧版 `version: 1`/`version: 2` 文件仍可读，第一次成功写入时升级为 `version: 3`，旧记录补为 `null`。`task_ack` 是幂等的单任务写工具；不引入推送、批量确认、通知表、队列或多 worker。

### Todoist 今日计划保存

Stage 7-3 将 Todoist 只读查询与已有 workspace 文件工具组合起来：在配置中同时启用 `todoist` 和 `read-file`，然后由一次自然语言请求生成并保存计划。workspace 和目标父目录必须事先存在，workspace 路径相对配置文件目录解析：

```json
{
  "version": 1,
  "workspace": "./notes",
  "modules": {
    "read-file": { "enabled": true },
    "todoist": { "enabled": true, "timeZone": "Asia/Shanghai" }
  }
}
```

例如：

> 读取 Todoist，按规划时区生成今日计划，保存为 workspace 下的 2026-09-11-plan.md。若结果不完整请在笔记中注明；文件已存在时停止并告诉我。

这条链路固定调用 `todoist_list_tasks({ "view": "planning" })` 和已有的 `write_file`。它会经历两次现有的 `y/n` 确认：第一次确认查询结果进入模型上下文，第二次确认完整的目标路径和 Markdown 内容后才写文件。目标文件只新建；如果文件已存在，返回 `FILE_EXISTS` 后停止，不覆盖、编辑、自动改名或重试。目标路径必须是 workspace 内用户明确指定的 `.md` 相对路径，缺少路径时先询问，不猜测其它目录。

保存内容包含五个固定章节：`今日三件最重要的事`、`上午 / 下午 / 晚上`、`逾期处理`、`未来 7 天风险`、`15 分钟立即行动`。标题下会保留规划时区、查询时间、查询范围、完整性和返回任务数；Todoist 任务 ID 或 URL 用于引用事实，排序、时段和耗时等推测标为建议，不自动改期或完成任务。

查询结果 `truncated: true` 时仍可确认保存，但计划必须明显标注不完整；任务为空且结果被截断时不能据此声称没有任务。查询失败不会继续生成或保存伪装成成功的计划；写入拒绝、同名文件、父目录缺失和其它路径错误也只报告具体原因。成功写入后以 `write_file` 返回的路径和字节数确认保存事实，后续 Run 取消或失败不会回滚已经创建的文件。

Stage 7-3 的 `pnpm typecheck` / `pnpm test` 只验证生产 instructions 已到达模型边界、Todoist → `write_file` 的离线接线、两次确认和文件副作用边界；组合测试使用固定文本夹具，不证明真实模型会写出五个章节、缺路径先问、失败不保存或空任务不凑数。`write_file.test.ts` 单独证明 `FILE_EXISTS` 不覆盖。完整验收还需提供真实模型和 `TODOIST_API_TOKEN`，使用独立测试笔记目录与一个尚不存在的 `.md` 路径，完成两次 `y/n` 并检查任务来源、日期、完整性说明、五个章节及实际文件；凭据缺失时不能把离线测试当作真实 Todoist 验收。

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
