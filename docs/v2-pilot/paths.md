# v2 试点：数据路径清单（基线 `9fa8678`）

本清单只记录现状，不调整任何映射（dataDir 调整不在本轮范围，见 `docs/architecture-v2.md` §4.4）。路径和文件名属于已落盘格式，重构时不能移动。

实际路径快照：

- `packages/assistant/src/__baseline__/paths.txt`（`baseline-paths.test.ts`）：路径常量；完整装配和最小装配各跑一次 Run 后实际创建的文件；省略 transcript 目录时的临时目录。
- `apps/desktop/src/main/__baseline__/desktop-paths.txt`（`baseline-paths.test.ts`）：userData 默认位置、生成的配置和默认工作区、显式启动的 Thread/transcript 推导、常驻服务路径。

「信任」一列：是否参与信任判定（自主执行、沙箱、自动记忆、文件授权等是否放行）。

## 助手核心（`packages/assistant`、`packages/core`）

| 类别 | 路径 | 由谁创建 | 用途 | 信任 |
|---|---|---|---|---|
| transcript 目录 | 装配参数 `directory`；CLI `--transcripts`/`RUNLOOM_TRANSCRIPTS`；省略时 `mkdtemp(<tmp>/runloom-tui-*)`（TUI）或 `<tmp>/runloom-demo-*`（离线 demo） | `createRuntimeApp`（`app.ts` 第 279～281 行） | 对话记录 | 否 |
| transcript 文件 | `<directory>/<sha256(threadId)>.jsonl`、`.jsonl.append.lock`（Windows 无锁） | `JsonlAgentStore`（core） | 一个 Thread 的提交记录；文件名是 hash，见 `hashes.md` | 否 |
| 执行回执 | `<directory>/execution-records.json`、`.execution-owner-<sha256(threadId)>.lock` | `createExecutionRecordStore` | Run/工具回执，verifier 的证据来源 | 否（但它是 verifier 的输入） |
| 配置文件 | 装配参数 `configPath`；CLI `--config`/`RUNLOOM_CONFIG`；桌面端默认 `<userData>/runloom.json` | 用户；桌面端首次启动生成 | 模块选择、工作区、授权 | **是**：配置位于工作区内时，拒绝 sandbox、`fileAuthorizations`、computer、自动记忆、automation、前台自主执行、语义记忆（`tui-module-config.ts` 第 572～579 行）；未写 `writePolicy` 时只有工作区外的配置才默认自动写入记忆（第 582～585 行） |
| 工作区 | 配置里的 `workspace`（相对配置文件所在目录解析）；CLI `--workspace` | 用户；桌面端默认 `<userData>/workspaces/personal` | 文件工具的根目录，`.runloom/` 所在 | **是**：文件路径授权以它为边界；`desktopAutonomy.workspaceRoot`、`telegramAutonomy.workspaceRoot` 必须等于它 |
| 记忆 | `<workspace>/.runloom/memory.json`、`.lock` | `createMemoryStore`（启用 memory 时，首次写入时创建） | 双时态记忆、候选、游标、导入回执 | 否（记忆文本不授予执行权限） |
| 语义索引 | `<workspace>/.runloom/memory-semantic-index.json` | `LocalMemorySemanticIndex`（`app.ts` 第 725 行，配置了 semantic 时） | 向量索引缓存 | 否 |
| checkpoint | `<workspace>/.runloom/checkpoint.json`、`.lock` | `createCheckpointStore` | 项目进度快照 | 否 |
| 定时任务 | `<workspace>/.runloom/tasks.json`、`.lock`、`task-worker.lock`、`task-worker-health.json` | `createTaskStore`、task worker | 提醒/定时任务、worker 单实例锁、健康状态 | 否 |
| WorkTask | `<workspace>/.runloom/work-tasks.json`、`.lock`、`.work-task-owner-<sha256(threadId)>.lock` | `createWorkTaskStore` | WorkTask 与验收证据 | 否 |
| 命令配方 | `<workspace>/.runloom/recipes.json` | `RecipeStore`（启用 shell 时） | 登记的命令配方 | 否（配方不授予权限） |
| RSS | `<workspace>/.runloom/rss.json` | `rss-subscriptions.ts` | 订阅与已读游标 | 否 |
| dreaming | `<workspace>/.runloom/dreaming.json` | `dreaming.ts` | 学到的技能、已处理批次 | 否 |
| 桌面前台提示 | `<workspace>/.runloom/desktop-frontmost.json` | 桌面端写，task worker 读 | 通知展示方式 | 否 |
| 后台 worker（macOS） | `~/Library/LaunchAgents/dev.runloom.task-worker.<sha256(workspace)[:20]>.plist` | `createTaskWorkerService` | launchd 任务 | 否 |

所有 `.runloom/` 文件都是惰性创建的：装配和一次普通 Run 不会在工作区里留下文件（见 `paths.txt`）。

## 桌面端（`apps/desktop`）

| 类别 | 路径 | 由谁创建 | 用途 | 信任 |
|---|---|---|---|---|
| userData | `RUNLOOM_USER_DATA`（必须是绝对路径），否则 `<appData>/@aisdk-agent/desktop`（改名前的旧位置，固定不动） | `main/index.ts` 在 ready 之前 `setPath` | 桌面端全部本地状态 | 间接：默认配置放在这里，即工作区外 |
| 桌面配置 | `RUNLOOM_CONFIG`，否则 `<userData>/runloom.json`（`.lock`） | `resolveDesktopConfig`（不存在时生成） | 同上「配置文件」 | **是**（同上） |
| 默认工作区 | `RUNLOOM_WORKSPACE`，否则 `<userData>/workspaces/personal` | `resolveDesktopConfig` 首次生成配置时 | 日常工作区 | **是**（同上） |
| 身份 | `<userData>/desktop-identity.json` | `desktop-identity.ts` | 当前 Thread 与 transcript 目录的启动偏好 | 否 |
| 桌面 transcript | `<userData>/transcripts/<threadId>/`；显式启动 `<userData>/transcripts/explicit-<key>/`，Thread 为 `desktop-explicit-<key>` | `desktop-identity.ts` | 对话记录 | 否 |
| 草稿 | `<userData>/conversation-drafts.json` | `ConversationDraftStore` | 输入框草稿 | 否 |
| 恢复选择 | `<userData>/recovery-selection.json` | `recovery-profile.ts` | 备份恢复后的选择 | 否 |
| Telegram | `--identity` 所在目录（常驻服务即 `stateDirectory`）下的 `telegram.json`、`telegram-archive/<kind>/<sha256>.json`、`auth-token` | `TelegramStore`、`startResidentServer`（`resident-entry.ts`） | 绑定、投递、归档 | **是**：保存的私聊身份在 Run 开始时校验 `telegramAutonomy` |
| 常驻传输 | `<userData>/resident/` | `resident-transport.ts` | 本机连接信息 | 否 |
| 常驻服务（macOS） | label `dev.serika.assistant-host.<sha256(workspace)[:20]>`；socket `/private/tmp/serika-host-<uid>/<hash>/host.sock`（非 macOS 为 `/tmp`）；状态 `~/Library/Application Support/Serika/resident/<hash>/identity.json`；plist 在 `~/Library/LaunchAgents/` | `resolveResidentPaths` | 常驻进程 | 否 |
| 备份 | 用户选择的目标；归档内是 `workspace/.runloom/<store>`、`transcripts/<sha256(threadId)>.jsonl`、`recovery.json` | `backup.ts` | 导出/恢复 | 否 |

## 临时目录

| 来源 | 前缀 |
|---|---|
| 离线 demo（不传 `assistant`） | `runloom-demo-` |
| TUI/装配不传 `directory` | `runloom-tui-` |
| 验收脚本（不属于产品） | `runloom-*-acceptance-`、`runloom-*-live-` 等 |
