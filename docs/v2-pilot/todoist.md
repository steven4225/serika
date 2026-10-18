# 第 2 步：Todoist 试点

## 现在归 Todoist 模块的东西（`packages/assistant/src/modules/todoist-module.ts`）

| 内容 | 以前在哪 | 现在 |
|---|---|---|
| 配置片段 `modules.todoist`（`enabled`、`timeZone`） | `tui-module-config.ts` 的 `todoistModuleSchema` | `todoistModuleConfigSchema`，格式逐字不变（同样 strict、同样拒绝空白时区） |
| 时区默认值和校验 | `tui-module-config.ts` 的 `DEFAULT_TODOIST_TIME_ZONE`、`normalizeTodoistTimeZone` | `resolveConfiguredTodoistTimeZone` / `resolveShorthandTodoistTimeZone`，错误文案 `Invalid Todoist time zone` 不变 |
| `RUNLOOM_TODOIST_TIMEZONE` | `app.ts` 直接读 `env` | `todoistTimeZoneFromEnv(env)`，`env` 由装配方传入 |
| `TODOIST_API_TOKEN` 读取与缺失报错 | `app.ts` 254–262 行 | `assembleTodoist({ enabled, timeZone, env })`；不碰 `process.env`；报错文案和报错时机（在 Shell sandbox 检查之后）不变 |
| `/modules` 的三行 | `app.ts` 内联模板 | `todoist.statusLines.{module,timeZone,token}`；位置仍由宿主按原顺序摆放 |
| 能力报告条目 | `capability-status.ts` 通用分支 | `todoist.capability(registeredTools)`；通过 `capabilityStatus` 新增的 `moduleEntries` 参数传入，列表顺序仍是 `BUILTIN_MODULE_IDS` |
| 给任务模块的跨模块事实 | `todoistPlanningAvailable: todoistEnabled` | `todoist.planningAvailable`，在装配入口作为带类型的参数传入，没有服务注册表 |

`app.ts` 里提到 Todoist 的行从 19 行变为 13 行（含 1 行注释），剩下的都只是引用：import、时区 env、
`assembleTodoist` 调用、模块列表一项、任务模块的两个规划事实（本进程、后台服务）、`/modules` 三行、
指令一行、能力报告一项、`taskAutomation.status` 的返回类型。不再有 Todoist 的解析、默认值、token 读取或文案模板。

## 验收

- 不配置 Todoist：工具表、Todoist 模块自己的指令、能力报告里都没有它的工具；输出与第 1 步快照
  `__baseline__/assembly-full-without-todoist.txt` 逐字一致（按用户选择 (a)：「todoist：未启用」等状态行和
  任务模块那句 todoist-brief 说明保留，属于原有文案）。
- 全部模块配置：`assembly-full.txt`、`assembly-minimal.txt`、Home 快照逐字一致。
- 权限快照 `permission-decisions.snapshot.ts` 未变。
- 回执、verifier 测试未改动，全部通过。
- 演示工具：见紧接着的两个提交（加上、再 `git revert` 删掉）。

## 桌面端涉及 Todoist 的位置（本步只列出，不改）

| 文件 | 内容 |
|---|---|
| `apps/desktop/src/main/index.ts:172,181` | 用 `process.env.TODOIST_API_TOKEN` 判断后台 worker 是否带 `--todoist` |
| `apps/desktop/src/main/resident-entry.ts:30` | 同上（常驻进程入口） |
| `apps/desktop/src/main/rss-worker-service.ts:26,50,71–131` | 后台服务的 `--todoist` 参数、`todoistPlanningAvailable` 状态和提示文案 |
| `apps/desktop/src/main/runtime-bridge.ts:228` | 写死的模块 id 列表（含 `todoist`） |
| `apps/desktop/src/renderer/src/capabilities.tsx:11,83` | Todoist 名称、说明和未启用提示 |
| `apps/desktop/src/renderer/src/personal/settings-model.ts:28,48,68` | 「连接应用」把 todoist 当作连接器 |
| `apps/desktop/src/renderer/src/automation-schedule.ts:9`、`personal/tasks-model.ts:269`、`personal/today-feeds.ts:14`、`shared/human-title.ts:113` | `todoist-brief` 安排的显示名 |

## 没动、留给第 4 步报告的

- 后台 worker（`task-worker-entry.ts:411–419`）仍自己读 `process.env` 的 token 和时区，并且写死「只能有
  `todoist_list_tasks` v1 read」。这是安全检查，不是重复；但意味着 Todoist 模块加工具时 worker 要跟着改。
- worker 的报错文案（`... when --todoist is enabled`、`Invalid RUNLOOM_TODOIST_TIMEZONE`）与交互入口不同，
  合并会改用户可见文本，所以没合并。
- `ResolvedTuiModuleConfig.todoistTimeZone` 和 `enabled.todoist` 仍在通用配置结构里（配置格式不能变）。
