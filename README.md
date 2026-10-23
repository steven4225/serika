# Serika

## Serika Electron 桌面（单仓入口）

前后端现在同在本仓库：`packages/*` 是 Runtime，`packages/assistant` 是应用/Controller，`apps/desktop` 是 Serika Electron 主进程、preload 和 React 页面。桌面使用原有 AgentLoop，不引入第二套执行循环。前端从旧仓 `runloom-desktop` 的 `f6de16b34e9a895c21c6b16efb2d0cf0c233e2f0` 带历史导入；旧仓仅保留作回滚，不再双向开发。

在仓库根目录运行（Node >= 22.12，pnpm 版本以 `packageManager` 为准）：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`typecheck` 和 `test` 覆盖两端；`build` 按 Runtime → Electron 顺序构建。仅后端使用 `pnpm build:runtime` / `pnpm test:runtime`。桌面可单独运行 `pnpm desktop:check`、`pnpm desktop:dev`；真实日用入口为 `pnpm desktop:daily`，macOS 安装入口为 `pnpm desktop:install`。Electron 不是网页预览；Linux 图形测试需要桌面会话及 Electron 的系统依赖。

日用默认读取**根目录未提交的 `.env`**，也支持显式的绝对 `RUNLOOM_ENV_FILE`。不会从 Git 提供 Key，日用入口拒绝 mock。自动测试使用脚本模型，不声称证明真实模型或手机投递。

迁仓不改变 bundle ID、`serika://`、原 userData、workspace、Thread、transcript、记忆、草稿或任务格式。已有本机入口和 launchd 服务需要显式切换路径，不在启动时偷偷替换。安装迁移、回滚和可直接交给 Grokbot 的检查步骤见 [桌面使用与验收](apps/desktop/README.md#单仓入口与-grokbot-检查)。

这是一个已具备本地 Agent 执行能力的实验性运行时。M10 之后不再预建通用平台功能；当前是用真实小开发任务验证单 Agent 能否交付可 review 的修改。

## 当前结论

- TypeScript + Node.js，使用 pnpm 管理依赖。
- AI SDK adapter 使用 `streamText`，由框架自行控制模型—工具循环。
- 对上提供自己的 `AgentRuntime` 契约，不让应用直接依赖 AI SDK 的循环实现。
- 当前本地路径支持单 Agent、多步工具调用、流式事件、取消、超时，以及基于 JSONL 的对话恢复。
- TUI 已支持受控的文件读写、当前工具调用的临时 y/n 确认，以及显式的 workspace 记忆；后台 worker 支持一次性/重复任务和结果 inbox。
- 持久化人工审批、Web UI、RAG、自动写入的长期/全局记忆、多 Agent 和 Durable 执行不在当前本地主链内。workspace JSON/JSONL 不提供可恢复的外部副作用保证。

完整设计见 [docs/architecture-v0.md](docs/architecture-v0.md)。

## 本机指定应用（Cua Driver，实验性）

接入现有主 AgentLoop 的 `computer_observe` / `computer_action`，不新增循环、不改变桌面前端或 worker。默认关闭，只支持 macOS；用户须先安装并启动 [Cua Driver](https://cua.ai/docs/cua-driver/quickstart)，自行完成它的系统权限配置。Serika 不安装驱动、不启动 daemon、不申请权限，也不连接 Cua Cloud。

在 **workspace 外**的配置里明确允许应用 bundle ID 和可信驱动绝对路径（驱动也必须在 workspace 外）：

```json
{
  "version": 1,
  "modules": {
    "computer": {
      "enabled": true,
      "executable": "/absolute/path/to/cua-driver",
      "allowedBundleIds": ["com.apple.TextEdit"]
    }
  }
}
```

`executable` 替换为你本机 `command -v cua-driver` 的输出；应用需由你先打开。原有配置可直接增加 `modules.computer`，不必启用 Shell。后端使用官方 `cua-driver call` 连接已经运行的 daemon；要求版本提供 `list_apps`、`list_windows`、`get_window_state` 的结构化 JSON，以及控件 `element_token` 和动作 `effect`。响应不兼容时关闭本次操作，不猜字段或回落到 AppleScript。

```bash
pnpm build
RUNLOOM_MODEL=deepseek node --env-file=.env apps/cli/dist/index.js --tui /absolute/path/to/transcripts --thread computer-user --config /absolute/path/to/config.json
```

测试指令：`只观察 TextEdit 的窗口，告诉我有哪些控件，不要修改内容。` 确认后再指定窗口和动作。桌面端通过原有 `createRuntimeApp` / Controller 配置和 approvalId 接线即可，本次未修改桌面仓。`--check` 只检查配置，不证明驱动运行或操作成功。

路径固定为 **列出指定应用窗口 → 观察精确窗口 → 确认点击/输入 → 再观察**。观察和动作都逐次确认；观察最多 200 个控件、24 KiB，token 最长有效 60 秒（确认期间也计时），每次动作或重新观察都会使旧观察失效。驱动单次调用最多 10 秒、输出 256 KiB；输入最多 4096 字符。截断/退化观察不授予动作 token。每次动作前重新核对 bundle/PID/窗口归属；过期或目标改变时不派发。

驱动的有界树遍历最多 2000 个节点（包含应用菜单）；给模型的仍是唯一 `AXWindow` 根及其子树，最多 200 个控件、24 KiB。菜单、孤立节点及其 token 不进入模型或动作白名单。缺失/歧义窗口根、重复节点编号或截断响应均拒绝，不靠解析半棵树放行。

本版仅提供控件 token 定位的后台点击和文本插入，不暴露屏幕坐标、截图、全局快捷键、剪贴板、启动/终止应用或前台升级。后台输入的实际 AX/事件投递由驱动实现；白名单不是系统沙箱，允许应用也可能发邮件、删除内容或影响其他应用，确认前应核对动作后果。UI 原文可进入模型和 transcript，别在敏感应用上启用。

驱动返回 `confirmed` 也只表示它的操作观察，不是业务完成证明；`unverifiable` / `suspected_noop` 表示已派发但效果未验证，只允许继续观察，不自动重复。传输中断、超时、非法回执、`partial` / `indeterminate` 等走非幂等 `TOOL_OUTCOME_UNKNOWN`，停止 Run，需用户核对，不重放。Electron/浏览器控件树可能不可靠，画布/复杂窗口可能截断，本版不声称支持通用视觉 Computer Use；需要独立业务证据或人工验收。

取消会终止 Serika 的 CLI 客户端，不能证明 daemon 已撤回动作；派发后的取消必须核对实际应用，不能直接重新执行。离线测试不操作真实桌面。真机封板另做：隔离 TextEdit 文档，在批准应用里观察→确认输入→再观察并人工核对；拒绝时无动作、非白名单应用拒绝、取消/驱动断连不重试。未完成这些场景前只能称接入实现，不能称本机控制已封板。

可重复的真实模型验收入口为 `packages/assistant/dist/computer-native-acceptance.js`，默认不会在 `pnpm test` 中运行。显式 opt-in 后可测隔离 TextEdit 的一次输入、拒绝或确认前取消；每次报告独立保留，`backendPassed` 不等于 Electron/完整封板。参数、严格授权范围及桌面接线说明见 [本机 Computer 接线与验收](docs/embedding-assistant-controller.md#本机-computer-接线与验收)。

## 阶段

当前：验证真实开发任务与长任务续接。最近的模块里程碑仍是 `M10 Proactive Assistant`（复用重复任务做明确排期的 workspace 简报）。

已经具备自有 AgentLoop、JSONL transcript、精简 TUI、独立本地任务 worker，以及显式 Memory、workspace checkpoint、Git `/resume` 和只读 Home。M9 的按需 RSS/Atom 阅读已合并；M10 让现有 worker 在任务到点时选用当前 workspace 的有界参考快照，结果仍交付到任务 inbox。模块接入路径见 [模块开发指南](docs/module-development.md)。

任务级验收使用 A01–A09 案例及不覆盖旧尝试的 JSON/Markdown 报告，操作入口和当前证据缺口见[阶段一验收指南](docs/task-acceptance.md)。`pnpm test` 验证离线契约；真实模型、真实网络、TUI 人工确认和最终产物分别记录，不能由构建通过或 worker `completed` 推定任务通过。

长上下文压缩和被动记忆整理的两条真实主链已在隔离环境验收；低预算手动压缩不代表日用配置的自动阈值表现。复验命令与取证要求见[阶段二验收指南](docs/long-context-memory-acceptance.md)。

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

配置 `authorizedDirectory` 后提供受控文件工具，记忆数据写入显式 H 的 `data/memory.json` v6。`write_file` 只新建，`edit_file` 只替换恰好一个匹配。记忆保留 ID、用户原话来源、版本及撤回回执，来源核对失败不会保存；不确定内容沿用 uncertain 原话保存规则。没有候选审核模式、候选工具或 `writePolicy` 配置。后台抽取仅在明确启用 `autoConsolidate` 时运行。

存储容量与注入预算分开：模型输入改为固定工作区快照，偏好和笔记各 4 KiB，置顶优先；超额完整条目保留在库中按需查。记忆文档与已有方法只注入索引，正文通过免确认的 `memory_read` 读取，查询只做最小关键词匹配。查询改写、相关性、contextView、向量服务及配置已删除。旧 Thread 记忆留待第 7 步裁决，不注入主聊天或 worker。

固定参考在压缩边界刷新，中间变更在新消息的可选 metadata 附注。时间、任务、检查点和 WorkTask 引用随新消息保存；旧消息不回写。记忆写工具与后台沉淀在第 4 步重做，现阶段保留来源与写入校验。

独立开启 `modules.checkpoint.enabled` 后，TUI 在 workspace 的 `.runloom/checkpoint.json` 保存一份项目工作进度；它与 Memory、transcript 分开，默认关闭且不依赖 `memory.enabled`。新 Thread 只注入当前版本，明确标为保存时的参考快照，不代表当前磁盘状态，也不恢复工具授权。用户明确要求时才调用 `checkpoint_prepare`、`checkpoint_get` 或 `checkpoint_save`，三者都走现有 `y/n`；prepare 只返回 current 和当前 Thread 可注入的 Memory，不调用模型、不重复复制近期对话。保存预览包含 `expectedVersion` 与完整草稿；版本冲突不覆盖，按 `n` 零写入。当前快照和注入消息各不超过 12 KiB，文件不超过 128 KiB，损坏或超限时 fail-closed。它不验证 artifacts 路径当前是否存在，也不是自动记忆整理的候选；`completed` 仍是 current，后续保存递增版本。

启用 checkpoint 且有 workspace 时，可在 TUI 空闲输入 `/resume` 做一次只读 Git 核对：程序显示当前 HEAD、branch、工作区 dirty 与 checkpoint 保存时 pin 的对账状态（`consistent` / `stale` / `diverged` / `insufficient_evidence`）。未被 Git 跟踪的 Serika checkpoint 和锁文件不计入 dirty；若用户将它们纳入 Git 跟踪，修改仍会计入。`checkpoint_save` 确认后会尝试记录 Git pin；非仓库或检查失败仍可保存，只是没有 pin，旧 checkpoint 也仍可读取。`/resume` 不创建 Run、不写 transcript、不联网、不运行测试，也不授权工具；观察只注入紧接着的下一次普通主 Run，结束、失败或取消后消失，重启不会恢复。重复 `/resume` 不会移动保存时的 pin；要更新 pin，必须由用户明确要求再次保存 checkpoint。Git 检查只是执行当时的局部证据，不能证明文件内容、PR 状态或测试结果；不输入 `/resume` 时仍只提供 M5 的 checkpoint 参考。

TUI 启动时会在历史记录之后显示一次只读 Home；空闲输入 `/home` 可重新读取当前状态。Home 显示模型配置、workspace、Thread 与 transcript 路径，并分别提醒临时目录和临时 Thread；项目区块读取 workspace 当前 checkpoint，并标出它由哪个 Thread 保存；本地任务区块显示未确认的 `completed` / `failed` / `interrupted` 结果以及最近创建的 `scheduled` / `running` 任务。列表截断时会明确提示还有更多，不声称展示全部待办。Home 不运行模型、Git 或 Todoist 查询，不写文件、不 ack、不推断桌面通知已送达；只有 checkpoint 启用时才提示 `/resume`，只有 task 启用时才提示 `/task inbox`。

旧的 8 回合 / 128 KiB 滑动裁剪和进程内工作摘要已删除。已提交原文保持完整，可用 `/history <message-id>` 或 `/history turn:<number>`（回合编号从 0 开始）回查当前 Thread。分层摘要、块屏蔽和超长内容处理留到第 5、6 步；第 3 步不靠截断绕过窗口限制。

如果一次任务需要连续处理一组文件，可在提交任务前使用 `/authorize <tool[,tool...]> <path> [path ...]`，例如 `/authorize read_file,search_files,write_file docs/ reports/`；列出的每个工具都适用于列出的每个路径前缀。这只把列出的文件工具和 workspace 相对路径前缀授权给下一次 Run；Run 结束、失败或取消后立即失效。未列出的工具或路径仍逐次询问，`shell_exec` 不受这条授权影响；授权规则不写入 transcript、memory 或 `tasks.json`。

需要跨重启保留明确的文件授权时，可在 `--config` JSON 根部配置 `fileAuthorizations`。每条规则包含 `tools` 和 `allowedPaths`，列出的工具适用于列出的每个路径前缀：

```json
{
  "version": 1,
  "authorizedDirectory": "./sample-project",
  "modules": { "read-file": { "enabled": true } },
  "fileAuthorizations": [
    { "tools": ["read_file", "search_files"], "allowedPaths": ["docs/"] },
    { "tools": ["write_file"], "allowedPaths": ["reports/"] }
  ]
}
```

持久规则只在配置启动时加载，配置文件必须位于 workspace 外；编辑或删除规则后重启 TUI 生效。`/permissions` 只读显示当前加载的规则，Shell、memory、Todoist 和 task 不受持久文件授权影响。

启用 `--auto-consolidate` 后，普通 Run 成功且本轮没有 `memory_*` 工具请求时，会串行发起一次整理 Run：先 `memory_prepare_consolidation`，再 `memory_stage_candidates`。stage 只在进程内暂存；只有 Run 成功后才把待审候选与游标同锁保存到 `memory.json` v3，不直接写入正式记忆。首次最多取八个符合条件的普通回合，之后从最早未处理的积压开始，不跳过旧材料；游标绑定有序用户消息 ID 与精确正文，旧 JSONL 整理标记不再是完成证据。失败、取消、无效提案或提交失败不推进游标。候选来源只认已提交的普通用户原话，不认助手、工具、网页或摘要。候选通过当前 Thread 的显式审阅接受，或用 `memory_apply_candidate` 并通过正常 `y/n`；拒绝工具调用仍保留 pending，拒绝候选只改候选状态。接受原子写入正式记忆和应用回执，同一请求重放不重复写。详见[原生 Memory A+B 验收](docs/memory-native-acceptance.md)。

TUI 的模块命令在空闲时直接执行，不创建 Run；配置 workspace 后可用 `/workspace` 查看当前根目录。模块通知使用同一条 TUI 输出流。

TUI 默认提供一个进程内番茄钟：用户可以直接说“开始番茄钟”“专注 25 分钟”“还剩多久”或“取消番茄钟”，模型会调用对应工具；也保留 `/pomodoro start`、`/pomodoro status`、`/pomodoro cancel`。未指定时长默认为 25 分钟；已有计时不会被重置；这三个计时操作不需要 `y/n` 确认。计时结束会写入 TUI 提示，并在 macOS 尝试发送桌面通知和提示音；提醒失败只报告失败，不改变已经结束的计时状态。退出 TUI 时清理计时器，计时状态不会跨进程、休眠或系统重启恢复。

如果一次 Run 在文件写入或番茄钟工具已经成功后又失败、取消或超时，TUI 会根据已有工具完成事件列出已经发生的动作（文件路径与字节数，或番茄钟状态）；没有成功执行的动作不会被列为已完成。

TUI 对尚未产生文本或工具调用的临时模型请求提供一次 Run 内的有限重试：最多三次尝试，等待 250ms、1s；重试只针对连接/DNS、429、408、500/502/503/504 和无输出的单步超时。鉴权失败、协议错误、已有部分输出、已经提出工具调用、取消和总超时不会重试。重试提示只存在于当前 Run，不写入 transcript；worker、print CLI 和工具执行不自动获得这项策略。

非幂等工具已经开始执行但超时、断线或抛错而没有明确结果时，TUI 会报告 `TOOL_OUTCOME_UNKNOWN` 并停止当前 Run；会同时结算此前已经收到的成功动作，提示先用现有只读工具核查，当前 Run 不会自动重试该操作。`ok:false`、`FILE_EXISTS`、路径错误和明确的非零结果仍按原有明确失败语义处理。

### Todoist 只读模块

Todoist 模块只在 TUI 中通过 `--todoist` 显式启用。它不依赖 `--workspace`；启用时必须通过环境提供非空的 `TODOIST_API_TOKEN`：

```bash
export TODOIST_API_TOKEN="<your-personal-token>"
RUNLOOM_MODEL=minimax-m3 pnpm tui -- ./var/runloom --thread daily-plan --todoist
```

默认规划时区是 `Asia/Shanghai`，可用 `RUNLOOM_TODOIST_TIMEZONE` 设置为 Node `Intl` 支持的其它时区。全天日期保持原日期；没有 UTC 偏移的浮动时间按这个规划时区解释，不读取 Todoist 账户时区。因此当账户时区不同时，Serika 的日期视图可能与 Todoist App 不一致。

模块提供 `todoist_list_tasks` 工具和 `/todoist list [planning|today|overdue|upcoming]` 命令。读取范围是令牌可见的活动任务中分配给当前用户或未分配的任务，明确包含共享项目中的未分配项。模块不提供完成、改期、改优先级、评论或其它写操作。

自然语言调用工具时会等待 `y/n`，因为返回的任务内容会进入模型上下文，并在 Run 成功后写入 transcript。直接执行 `/todoist list` 只查询并显示结果，不调用模型、不创建 Run，也不写 transcript；`RUNLOOM_MODEL=mock` 不会阻止这条命令访问真实 Todoist API。

查询最多扫描 5 页、返回 100 条任务，并限制工具结果大小。达到容量预算时返回 `truncated: true`，命令和模型必须明确说明结果不完整；即使 `tasks` 为空，也不能据此声称没有任务。认证、限流、网络或响应解析失败会使整次查询失败，不会把已经取得的前几页当作成功结果。

### 内置模块启动配置

Stage 7-2 支持用一份显式 JSON 配置选择 TUI 启用的内置模块。配置在启动时读取，修改后重启生效；不会自动搜索 `.runloom/config.json`，也不支持热更新、运行中启停或配置写入：

```bash
RUNLOOM_MODEL=mock pnpm tui -- ./var/runloom --thread daily-plan --config ./runloom.json
```

配置模式下未列出的模块默认关闭，模块配置必须使用 `{ "enabled": true|false }`。支持的模块是 `pomodoro`、`read-file`、`memory`、`checkpoint`、`task`、`todoist`、`shell` 和 `web`；`read-file` 仍包含 `/workspace`、文件读写和搜索能力，`shell` 提供显式启用的 `shell_exec`，`web` 提供公开 URL 的 `web_fetch`，并可在 `web.search.enabled` 下显式开启搜索，示例 `add` 工具不属于配置模块，只在离线 mock 模型下注册，真实模型看不到它。

```json
{
  "version": 1,
  "authorizedDirectory": "./sample-project",
  "modules": {
    "pomodoro": { "enabled": true },
    "read-file": { "enabled": true },
    "memory": { "enabled": true, "autoConsolidate": false },
    "checkpoint": { "enabled": true },
    "task": { "enabled": false },
    "todoist": { "enabled": true, "timeZone": "Asia/Shanghai" },
    "web": { "enabled": true }
  }
}
```

`authorizedDirectory` 相对配置文件所在目录解析；旧配置的 `workspace`、自主授权的 `workspaceRoot` 和记忆 `writePolicy` 须先用离线导入器转换。启用 `read-file`、`memory`、`checkpoint`、`task` 或 `shell` 时必须提供有效 workspace；只启用 Todoist、web 或番茄钟可以省略。配置模式下未列出的模块默认关闭，因此 checkpoint 默认关闭并独立于 memory。配置模式下 Todoist 时区只读取 JSON，缺省为 `Asia/Shanghai`；不传 `--config` 时仍沿用 `RUNLOOM_TODOIST_TIMEZONE`。Todoist token 始终从 `TODOIST_API_TOKEN` 读取，不能写进 JSON。

`--config` 与 `--workspace`、`--todoist`、`--auto-consolidate` 互斥，但可和 transcript 目录、`--thread` 一起使用。不传 `--config` 时，原有命令行行为保持不变。

`/modules` 始终可用，不属于配置模块；它显示配置来源、workspace、模块开关、自动整理、Todoist 时区和 token 是否存在，不显示 token。关闭 `memory` 会同时关闭记忆工具、记忆注入和自动整理，但不会关闭 checkpoint；关闭 `checkpoint` 只关闭 checkpoint 工具和注入；关闭 `task` 只影响当前 TUI，不会停止独立 worker。命令不创建 Run，也不写 transcript。

日用可从无密钥的 [固定配置示例](docs/daily.example.json) 开始。在仓库根目录先创建自己的 workspace 和 transcript 目录，再检查静态启动条件、启动同一 Thread：

```bash
mkdir -p ./var/personal-workspace ./var/personal-transcripts
RUNLOOM_MODEL=deepseek node --env-file=.env apps/cli/dist/index.js \
  --tui ./var/personal-transcripts --thread personal --config ./docs/daily.example.json --check
RUNLOOM_MODEL=deepseek node --env-file=.env apps/cli/dist/index.js \
  --tui ./var/personal-transcripts --thread personal --config ./docs/daily.example.json
```

运行前先执行 `pnpm build`。示例开启文件工具、Memory、checkpoint、task 和预算压缩；自动整理明确关闭，需要验证日用打扰程度后自行开启。未配置永久文件授权，也未开放 Shell。`--check` 只读地检查配置、路径及所需凭据是否存在；不会请求模型或网络，不创建 Thread、transcript 或临时目录。通过仅表示静态启动条件满足，不表示 Key 已认证、worker 在线或真实任务可用。Home 负责当前工作环境与任务结果，`/modules` 负责模块配置和记忆注入概况；记忆详情仍用 `memory_list` / `memory_get`，涉及工具读取时保留现有确认。

启用 `task` 并配置 workspace 后还可以创建一次性任务。TUI 提供 `/task create <带时区的ISO时间> <prompt>`、`/task reschedule <id> <带时区的ISO时间>`、`/task list [pending|attention|status]`、`/task inbox`、`/task show <id>`、`/task ack <id>` 和 `/task cancel <id>`；任务保存在 `<workspace>/.runloom/tasks.json`。空闲 `/task reschedule` 和其它 `/task` 命令一样直接执行，不经过模型工具的 `y/n`；自然语言改期调用 `task_reschedule`，先展示原时间和新时间并逐次确认。改期只更新尚处于 `scheduled` 的一次性任务原 ID，不会先取消再新建；旧时间虽已到但尚未被 worker 领取时仍可改期。若 worker 已先领取，改期会明确失败。独立 worker 必须持续运行，TUI 关闭后仍会在到期时执行：

也可以直接用自然语言说“**一分钟后提醒我喝水**”或“安排一个任务”。模型会调用 `task_create`，需要把时间转换成带时区的 ISO 8601 时间；时间不明确时会先追问。`task_create` 只把任务写入 `<workspace>/.runloom/tasks.json`，不会立即启动 worker 或执行 prompt；必须有 worker 运行，任务到期才会执行。创建成功后会返回任务 ID、执行时间和任务内容，仍沿用现有写入确认。自然语言改期若有多个候选，先列出任务并请用户点名，不用取消加新建代替改期。若任务已创建或已改期而本轮随后失败、取消或超时，TUI 会列出已经成功的任务事实；失败或被拒绝不会显示为成功。已排期不代表 worker 正在运行，也不代表桌面通知已送达。

```bash
RUNLOOM_MODEL=mock pnpm task-worker -- --workspace ./sample-project
```

默认启动时，worker 为每个任务创建新 thread，只运行一次无工具的纯文本回复，并把结果写回任务文件；任务不会自动重试或从中断处恢复。任务更新使用 `.runloom/tasks.json.lock`，worker 独占使用 `.runloom/task-worker.lock`，两者都是由操作系统释放的 advisory `flock` 锁。worker 的 claim、执行、重复任务推进和启动恢复不读取 inbox 确认状态。

需要任务结束时收到 macOS 桌面通知时，显式加上 `--notify`：

```bash
RUNLOOM_MODEL=mock pnpm task-worker -- --workspace ./sample-project --notify
```

通知在任务已经写入终态后发送，包含任务 ID、状态和结果摘要；worker 执行产生的完成、失败或中断都会通知。通知失败只记录到 worker 的标准错误，不改变任务终态，也不会重试或新增任务记录。不开启 `--notify` 时不发送桌面通知；该开关依赖 worker 进程持续运行和 macOS 的 `osascript`。

Stage 7-4 可通过独立的 `--todoist` 开关，授权该 worker 在后台任务中使用唯一的只读工具 `todoist_list_tasks`：

```bash
export TODOIST_API_TOKEN="<your-personal-token>"
RUNLOOM_MODEL=minimax-m3 RUNLOOM_TODOIST_TIMEZONE=Asia/Shanghai \
  pnpm task-worker -- --workspace ./sample-project --todoist
```

worker 不读取 TUI 的 `--config`；Todoist 规划时区独立取自 `RUNLOOM_TODOIST_TIMEZONE`，缺省为 `Asia/Shanghai`，启动日志会显示规范化后的实际时区。启用失败（如 token 缺失、时区非法或工具注册边界变化）会在领取队列任务前退出。不开 `--todoist` 时继续使用原有无工具、一步纯文本行为，也无法实时读取 Todoist。

`--todoist` 是 worker 进程级授权，覆盖该 workspace 中已经排期和以后到期的全部任务。任务触发查询时，Todoist 内容会进入所配置模型的上下文，并随结果写入本地 `resultText` 和该任务 thread 的 transcript；后台没有逐次 `y/n` 确认，也不保存 Markdown 或其它笔记。生产 `RUNLOOM_MODEL=mock` 仍只生成纯文本，不会主动调用 Todoist，因此 mock 运行成功不能作为真实查询证据。

开启 Todoist 后，正常的今日计划链路是一次 `planning` 查询后生成结果。查询失败时，模型可以把失败说明作为正常文本交付，此时任务仍可能是 `completed`：这里的 `completed` 表示 Run 正常结束，不表示 Todoist 查询或计划业务成功。该结果会出现在未确认的 `/task inbox` 和 `/task show <id>` 中；`/task list attention` 只列出 `failed` 与 `interrupted`，不会识别 `completed` 文本里的业务失败。

真实验收使用隔离 workspace、真实模型和正常权限的 Todoist token：先创建一个明确要求读取 Todoist 并生成今日计划的到期任务，再以 `--todoist` 启动 worker；核对启动时区、一次 `planning` 调用、任务事实与完整性标记、五个计划章节、`resultText`、transcript 和 inbox；重启后确认结果仍可通过 `/task show` 读取，最后显式 ack。worker 必须由用户持续运行；本阶段不提供操作系统唤醒或生产级可靠性保证。

### Stage 7-5 模块接入约定

7-5 的版本内交付是[模块开发指南](docs/module-development.md)和本 README 的进度入口：沿用现有工厂注入、`setup` 注册、TUI 配置或 worker 显式清单、工具/命令执行和 `dispose` 的接入路径。指南以现有 Todoist/read-file 模块为例，不新增接口、配置版本、运行时行为或外部插件加载；`/modules` 和计算器 `add` 也不属于 `AgentModule` 协议。

本节只说明入口和边界，不复制各工具的数据契约。7-3、7-4 的真实 Todoist/模型验收仍需独立提供证据；因此 7-5 的指南完成不等于 Stage 7 封板。

任务查询只读现有任务文件：`/task list pending` 查看 `scheduled` 和 `running`，`/task list attention` 查看 `failed` 和 `interrupted`，`/task inbox` 查看尚未确认的终态任务（`completed`、`failed`、`interrupted`）。自然语言查询会复用 `task_list`；需要某个任务的完整状态、结果或错误时使用 `task_get`，候选不唯一时先列出候选并让用户确认。`/task show <id>` 查看完整 prompt、执行信息、结果、失败原因和 `Acknowledged at`；列表显示结果、错误摘要和确认时间，完整内容通过 `show` 获取。`/task ack <id>` 只确认一个已完成、失败或中断且尚未确认的任务；模型不会因为查询结果自动 ack，只有用户明确要求确认时才调用 `task_ack`。`completed` 表示 worker Run 正常结束，不代表业务成功，也不代表桌面通知已经送达；`failed` 与 `interrupted` 是不同的终态，必须分别说明。创建任务时不承诺会弹出桌面通知；跨进程桌面通知由 worker 的显式 `--notify` 开关控制。

同一 workspace 还支持 daily/weekly 固定时区偏移的重复任务：`/task repeat create daily <HH:mm> <+/-HH:mm> <prompt>` 或 `/task repeat create weekly <1-7> <HH:mm> <+/-HH:mm> <prompt>`，并可用 `/task repeat list [active|paused|cancelled]`、`show`、`pause`、`resume`、`cancel` 管理。每次到期只生成一个独立的一次性任务；worker 会把下一次时间推进到严格晚于当前时间，过期多周期也只补一个并跳过中间周期。暂停会清空下一次时间，恢复从未来 occurrence 重新计算；取消只停止后续 occurrence，已经运行的任务继续完成。任务文件当前为 `version: 3`，`TaskRecordV3` 增加可空的 `acknowledgedAt`；旧版 `version: 1`/`version: 2` 文件仍可读，第一次成功写入时升级为 `version: 3`，旧记录补为 `null`。`task_ack` 是幂等的单任务写工具；不引入推送、批量确认、通知表、队列或多 worker。

### M10 排期简报

可以在 TUI 里说：“每天 09:00（固定 +08:00）根据当前项目进度和记忆，给我一份简报：依据、最重要的一件事、15 分钟下一步。”模型应使用已有 `task_repeat_create`，由你确认后才保存重复任务；固定 UTC offset 不会随夏令时自动调整。简报格式由这条任务的 prompt 决定，普通提醒不会被改写成简报。

启动同一 workspace 的 worker 时显式加 `--workspace-context`：

```bash
RUNLOOM_MODEL=deepseek pnpm task-worker -- --workspace ./sample-project --workspace-context
```

这个开关适用于该 worker 领取的**全部任务**，独立于 TUI `--config`。每次领取后只读一次当前 `.runloom/memory.json`、`.runloom/checkpoint.json` 和未确认的失败／中断任务摘要；只注入有效的 workspace 记忆和当前 checkpoint，其他 Thread 的记忆不会进入。attention inbox 先按现有列表上限读取，去掉当前重复系列后再保留最多五条 120 字 preview，并按过滤后的集合计算 `truncated`。缺失记忆或 checkpoint 是合法空源；损坏、超限、符号链接或读取失败会在调用模型前将该任务记为 `failed`（`runId: null`）。checkpoint 只是保存时快照，不能证明当前 Git 或文件状态；记忆冲突时以当前有效记忆为准。自身重复系列的往期失败不会自动变成今天的优先事项。

快照作为本次 Run 的参考上下文发送给所配置模型，不另存为 transcript 消息；模型可能在任务结果中引用其中的信息。`--workspace-context` 不给 worker 增加工具；`--todoist` 仍是独立的只读开关。结果沿用现有 `/task inbox`、`/task show <id>` 和显式 ack。`completed` 只表示 Run 正常结束；桌面通知仍取决于 worker 是否加 `--notify`，也不代表用户已经看见。worker 必须持续运行，重启后的重复任务沿用现有“漏跑只补一次”语义。

### Todoist 今日计划保存

Stage 7-3 将 Todoist 只读查询与已有 workspace 文件工具组合起来：在配置中同时启用 `todoist` 和 `read-file`，然后由一次自然语言请求生成并保存计划。workspace 和目标父目录必须事先存在，workspace 路径相对配置文件目录解析：

```json
{
  "version": 1,
  "authorizedDirectory": "./notes",
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

### Command Code / DeepSeek V4.1 Flash

CLI/TUI、嵌入式 Controller 和 worker 共用模型入口，支持 `RUNLOOM_MODEL=command-code`。复用 OpenAI-compatible adapter；默认 URL 为 `https://api.commandcode.ai/provider/v1`，模型 ID 为 `deepseek/deepseek-v4.1-flash`，运行时 alias 为 `command-code/default`。不改变默认 mock 或原有 DeepSeek/MiniMax 配置，不新增行为循环。

在本地未提交的 `.env` 中加入 `COMMAND_CODE_API_KEY`（不要把真实 Key 发到聊天）：

```dotenv
COMMAND_CODE_API_KEY=<your-command-code-api-key>
```

```sh
pnpm build
RUNLOOM_MODEL=command-code node --env-file=.env apps/cli/dist/index.js \
  --tui ./var/runloom --thread personal --workspace ./var/notes
```

可选 `COMMAND_CODE_BASE_URL` / `COMMAND_CODE_MODEL_ID` 覆盖，Key 仅发送到所选 endpoint，覆盖 URL 时须信任该地址。缺 Key 启动失败，不借用其它 provider Key，不回退模型。该入口针对 DeepSeek 非 thinking 模式：工具回放仍不保存 provider 专属 `reasoning_content`。Command Code 的 `deepseek/` 模型除了 `thinking: {type: "disabled"}`，还发送网关的 `reasoning_effort: "off"`；只发前者实测仍返回思考 token，可能耗尽正文/摘要预算。此网关不接受 `"none"`。其它模型或 thinking 模式不在本次验证范围。

官方 [Provider API 文档](https://commandcode.ai/docs/provider) 与 [公开模型目录](https://api.commandcode.ai/provider/v1/models) 描述服务端能力；目录中的模型存在不证明当前账号可用。离线测试只证明 URL、认证字段、流式工具回放及 preflight 接线，真实账号与请求仍须单独验收。截图/视觉输入、Computer Use 和付费连续压缩验收未由本次接入证明，也未自动启用。

2026-10-02 本机隔离验收：Command Code 的上述默认模型通过真实 Controller 完成 TextEdit 精确窗口观察 → 一次文本插入 → 新观察回读标记，primary Run 为 `completed`。验收程序按 approvalId 仅放行测试窗口、一次精确标记输入，非白名单观察被拒绝；没有操作其他窗口或保存文件。这证明当前账号的该工具链可用，不代表独立视觉/业务验收。Electron 人工确认、真实点击、派发中取消/断连及连续压缩链仍未由该次验收证明。

### DeepSeek

CLI/TUI 和 worker 均支持 `RUNLOOM_MODEL=deepseek`；未指定时仍使用 mock。复用现有 OpenAI-compatible adapter，不新增执行循环，也不改变工具确认、worker 白名单或超时预算。

在本地、不提交的 `.env` 中配置（不要把真实 Key 发到聊天或写入版本内配置）：

```dotenv
RUNLOOM_MODEL=deepseek
DEEPSEEK_API_KEY=<your-deepseek-api-key>
```

默认地址为 `https://api.deepseek.com`，模型为 `deepseek-flash`。可选 `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL_ID` 覆盖地址和模型，例如 `deepseek-v4-pro`。覆盖地址会将 Key 发往该地址，只应使用可信端点。缺 Key 会在启动时失败，worker 不领取任务；不会借用 MiniMax Key 或回退到 mock。

首次可先用本地资料目录，不启用 Todoist。以下命令在仓库根目录执行；已有配置可替换 `--workspace` 为 `--config`，不能同时使用两者：

```bash
pnpm build
mkdir -p ./var/notes
RUNLOOM_MODEL=deepseek node --env-file=.env apps/cli/dist/index.js --tui ./var/runloom --thread personal --workspace ./var/notes
```

例如输入：`把“本周只推进 Serika 的资料保存与找回”保存为 first-note.md。` 核对路径和正文后由操作人输入 `y/n`。使用相同目录和 thread 重启后，可请求查找并读取该笔记。`.env` 不会由普通 CLI/worker 自动加载，上述命令通过 Node 的 `--env-file` 加载。

上下文压缩默认关闭。需要在长任务中启用时，在 TUI 配置根部加入 `contextCompaction`，例如：

```json
{
  "version": 1,
  "contextCompaction": {
    "enabled": true,
    "contextWindowTokens": 32768,
    "maxOutputTokens": 4096,
    "safetyMarginTokens": 1024,
    "keepRecentTokens": 8192,
    "summaryMaxOutputTokens": 1024
  },
  "modules": {}
}
```

启用后，TUI 在模型请求前按预算压缩较早的对话和已完成的工具交互，保留原始 JSONL 和 `/history` 回查。手动压缩入口已删除。摘要不是长期记忆，也不会恢复授权或未提交的工具副作用。预算采用 `char-half/v1` 估算，属于保守估算而非服务端 tokenizer 的精确计数。

worker 使用同一模型配置，但不读取 TUI `--config`；加 `--todoist` 仍需单独配置 `TODOIST_API_TOKEN`：

```bash
RUNLOOM_MODEL=deepseek node --env-file=.env packages/assistant/dist/task-worker-entry.js --workspace ./var/notes
```

此模式明确关闭 thinking。当前循环不回传 `reasoning_content`，而 DeepSeek 思考模式下的工具对话要求回传该字段；本次仅适配非思考模式的文本和工具调用，不宣称支持思考模式或图像输入。默认模型名与参数依据 [DeepSeek 接入文档](https://api-docs.deepseek.com/) 和 [思考模式约定](https://api-docs.deepseek.com/guides/thinking_mode/)。

离线测试覆盖模型选择、请求参数、流式工具调用 → 工具结果回传 → 最终文本，以及缺 Key 时不领取后台任务；不代表真实服务认证、延迟或任务质量已通过。已有后台闭环真实验收可将下节命令的 `RUNLOOM_ACCEPTANCE_MODEL` 改为 `deepseek`；Stage 7 的真实 Todoist 验收仍需单独完成。TUI calculator 每步模型流上限为 30 秒，自动整理 agent 仍为 5 秒；该上限只约束一步模型流，不含确认等待。若真实请求超时，应记录结果并单独确认预算调整。

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

配置中启用 `shell` 且提供 workspace 后，TUI 会注册 `shell_exec`。不配置 `sandbox` 时保持宿主 Shell：每次命令调用显示命令和 workspace-relative cwd，并通过现有 `y/n` 确认；workspace cwd 不是操作系统级沙箱。要启用隔离 Shell，可在 `modules.shell` 下配置：

```json
{
  "version": 1,
  "authorizedDirectory": "./sample-project",
  "modules": {
    "shell": {
      "enabled": true,
      "sandbox": {
        "backend": "docker",
        "image": "node:22-bookworm-slim",
        "readablePaths": ["package.json", "src", "docs"],
        "writablePaths": ["docs", "reports"]
      }
    }
  }
}
```

Docker sandbox 只挂载列出的路径，根文件系统只读，网络固定关闭；`writablePaths` 中的目录必须已存在，配置文件必须位于 workspace 外。镜像必须已存在，不会自动 pull，Docker daemon 或镜像不可用时 TUI 启动失败，不会退回宿主免确认。启动后使用 `/authorize-shell` 可让下一次 Run 连续调用隔离 Shell，Run 结束、失败或取消后失效；未授权时仍逐次 `y/n`。命令默认 30 秒超时、输出可能截断。shell_exec 只进入 TUI，worker 不会因为 TUI 配置自动获得它。Durable Run Driver 仍不进入这条主链。

### Web 只读模块

配置中启用 `web` 后，TUI 注册只读工具 `web_fetch({ url })`。它只支持公开 HTTP(S) 文本/HTML 响应，GET 请求最多跟随 5 次重定向；每次请求前都会校验目标和 DNS 结果，拒绝 localhost、私网、链路本地、元数据地址、URL 凭据和非文本内容。公开域名被 Clash/Surge fake-ip 解析到 `198.18.0.0/15` 时仍允许抓取；把该网段写成 URL 主机或解析到 `10/8`、`127/8`、`169.254/16`、`192.168/16` 等真实私网地址仍拒绝。响应最多读取 512 KiB，交给模型的正文最多 64 KiB，超出时返回 `truncated: true`；失败、HTTP 错误、超时和不支持的内容类型会以结构化错误返回。不会携带 Cookie、Authorization 或本机应用密钥，也不会访问登录网站、PDF、图片或下载附件。

`web_fetch` 默认沿现有 `y/n` 确认。已知来源可在 Run 前输入 `/authorize-web https://example.com https://docs.example.org`，授权只对下一次 Run、列出的精确 origin 和 `web_fetch` 生效，Run 结束、失败或取消后清除；不会写入 memory、transcript 或配置。网页正文是不可信数据，不能把页面里的指令当成系统指令。工具返回 `requestedUrl`、`finalUrl`、HTTP 状态、内容类型、抓取时间、正文和完整性标记，生成报告时应引用实际 `finalUrl`，不能把截断或失败说成已读全文。

在配置中同时写入 `"web": { "enabled": true, "search": { "enabled": true } }` 后，TUI 通过免 Key 的 Exa 托管 MCP 注册只读 `web_search({ query, limit? })`，不需要 `EXA_API_KEY` 或 `BRAVE_SEARCH_API_KEY`，也不会自动回退到付费 API。它只返回最多 10 个标题、URL 和摘要用于发现来源；默认 5 条，不分页、不自动重试。`web_search.truncated: true` 只表示本次响应中解析出的有效候选超过本地返回上限；`false` 不代表互联网没有更多结果，空数组也不证明没有相关来源。标题和摘要另有长度限制，不由这个布尔值表示。搜索请求仍逐次经过 `y/n`，因为 query 和摘要会进入模型上下文与成功 Run 的 transcript。同一 Run 中一旦 `web_search` 被 `n` 拒绝，后续 `web_fetch` 不再弹出确认、不发网络请求，并直接返回 `TOOL_DENIED`；该闩锁在 Run 结束时清除。托管服务可能限流或不可用；工具会如实返回错误。

`web_search` 的摘要不能当作事实证据。研究任务必须先搜索，再用现有 `web_fetch` 打开选定原文，报告引用实际 `finalUrl`；原文失败或截断时必须标明未核验。搜索 query 会发送至 Exa 托管服务，不要把私人笔记或敏感信息拼进 query。

可选 `"web": { "enabled": true, "feed": { "enabled": true } }` 注册 `feed_read({ url, limit? })`，读取用户点名的公开 RSS 2.0/Atom URL；`web.enabled=false` 时不能单独开启 feed。默认显示文档中的前 10 条，上限 20 条，不按日期重排；缺标题的条目跳过，`truncated` 只表示有效条目超过本地 limit，不表示 feed 或互联网没有更多内容。返回 feed 的实际 `finalUrl`、抓取时间、格式及条目标题、链接、时间和有界摘要。条目相对链接基于 feed 的 `finalUrl` 解析，非公开 HTTP(S) 链接返回 `null`。feed 的 Content-Type 可以是 XML 或错误标记为 HTML，但必须有 RSS 2.0/Atom 根元素；HTTP 正文超过 512 KiB、XML 不完整或声明非 UTF-8 均报错，不解析半份内容，也不做正文 HTML 抽取。

`feed_read` 每次单独 `y/n`；`/authorize-web` 仍只授权 `web_fetch`。同一 Run 拒绝 `web_search` 后，`feed_read` 与 `web_fetch` 均不会发请求。标题和摘要只用于选材，事实性结论仍须另用 `web_fetch` 打开条目原文并引用抓取的 `finalUrl`；外部文本不能自动写成用户 Memory 或 task。M9 不保存订阅源、不轮询、不接 QQ/微信/Email，worker 与 Home 不读取 feed。

后续独立实现了显式的[定期 RSS 订阅简报](docs/rss-subscriptions.md)：桌面管理订阅及排期，worker 必须另外带 `--rss`，仅处理绑定的重复任务。程序抓取、持久化去重、生成来源清单，模型只整理有界 feed 摘要，不读取文章原文，不获得联网工具或自动写记忆权限。M9 的交互式工具确认和 `/authorize-web` 没有放宽。

R3c 的联网研究交付沿用这两个工具，不新增研究工具或来源数据库：一次 `web_search` 只发现候选，最多选择两个来源，再用 `web_fetch` 打开原文。只有 `web_fetch` 成功返回的内容才能作为已核验来源；`web_fetch.truncated: true` 表示正文不完整，只能作为部分证据，失败或拒绝不能支持事实结论。报告引用实际 `finalUrl`，`write_file` 成功后才说明文件已保存；拒绝、失败或文件冲突不能换参数绕过，也不能声称已保存。报告不强制固定 Markdown 章节，但必须写清来源和不完整项。

R3c 的真实验收是：指定 URL 阅读、搜索→原文核验→报告保存，以及搜索/抓取拒绝、单来源失败或截断三个边界。`web` 只进入 TUI，worker 不会获得它；R3a、R3b 的代码已合并，但 R3 仍需完成真实证据后才封板。

### Stage 6 验收

`pnpm test` 包含命令模块 → 独立 worker 进程 → 结果/transcript → inbox → ack → 杀进程并重启的闭环验收，默认强制使用 mock，不依赖模型密钥。Store 测试另用虚拟时钟验证重复任务跳过过期周期、启动中断恢复，以及确认旧结果与下一次执行互不干扰。

使用已配置的 MiniMax 环境进行同一闭环的真实模型验收（会发起两次短文本模型请求）：

```bash
pnpm build
RUNLOOM_ACCEPTANCE_MODEL=minimax-m3 node --env-file=.env --test packages/assistant/dist/task-acceptance.test.js
```

`.env` 需自行配置且不应提交；普通 CLI/worker 不自动加载它，应先导出变量或使用 Node 的 `--env-file`。验收创建临时 workspace 并在结束后清理，不修改日常任务。此测试覆盖命令模块和真实 worker 进程，不是终端交互 UI 测试，也不证明操作系统会自动唤醒已退出的 worker。

`.github/workflows/ci.yml` 在 PR 和 main push 上执行依赖锁定安装、`pnpm typecheck` 和 `pnpm test`；真实模型验收不在该基础 CI 内。
