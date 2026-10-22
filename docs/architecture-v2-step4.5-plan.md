# 架构 v2 第 4.5 步计划

状态：待审核、待用户拍板。本文只制定计划，不授权实施或切日用。SQLite 继续暂缓。

## 0. 范围与证据基准

- 实施分支限定为 `experiment/architecture-v2`。本轮只新增本文，不改产品代码，不读写日常内容，不重启日用进程，不修改或合并 main。
- v2 代码基准为 [`1275051668433ee94b1ccb65f40a34845e1afcd1`](https://github.com/steven4225/serika/tree/1275051668433ee94b1ccb65f40a34845e1afcd1)。本文代码链接固定到此提交。
- 用户已宣布上下文记忆计划 0–7 步全部完成，确认第 7 步迁移副本内容。用户提供的 Linux 审核结果是统一验证退出 0、1747 通过 / 0 失败 / 15 跳过、eval 101/101、真实 Electron 加假模型冒烟 8/8。这是前一步审核记录，不是本计划的实测结果。
- main 附录只做只读评估，基准为 [`cfb46dddd182887ed41a3129d99b8c5e46747278`](https://github.com/steven4225/serika/tree/cfb46dddd182887ed41a3129d99b8c5e46747278)。不据此自动移植任何 PR。
- 路线依据为 [architecture-v2.md](architecture-v2.md)，记忆语义依据为 [context-memory-refactor-plan.md](context-memory-refactor-plan.md)。[paths.md](v2-pilot/paths.md) 是旧基线，下面补齐当前路径并指出退休项，不改写其历史结果。

### 用户结果

**Before：** 文件权限、自主执行身份、数据位置和项目上下文都依附一个工作区。换项目容易同时改变数据与信任范围；CLI、桌面和常驻服务还各有路径入口。

**After：** 一份可指定的 Serika home 保存个人助手数据；独立授权目录决定文件访问范围；项目识别只选择项目上下文；用户记忆跨项目可用，项目笔记限定项目。原数据经一次受控导入后保留备份。

**五分钟 Demo：** 在两个全新临时 home 启动测试实例，使用离线脚本模型。第一个实例授权目录 A，保存一条用户偏好和项目 A 笔记，切到项目 B；偏好仍可见，A 笔记不注入，写未授权目录仍被拒绝或请求必要授权。重启后结果相同，第二个 home 看不到第一份数据。系统沙箱另做 §4 的操作系统级 Demo。以上是未来验收要求，本轮未实施。

## 1. 现状盘点

下文 W 指规范化工作区根目录，D 指 Electron userData，T 指某 Thread 的 transcript 目录，H 指拟议的 Serika home。操作系统用户主目录仍由 OS 提供，不能把 `$HOME` 改成 H。

### 1.1 工作区承担的信任与身份职责

| 位置与读取方 | 当前实际判定 | 4.5 需要拆出的职责 |
|---|---|---|
| [tui-module-config.ts:440](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/tui-module-config.ts#L440)，由 CLI、桌面装配和 worker 配置加载读取 | 配置相对路径解析 W；部分模块要求 W；沙箱、持久文件授权、computer、显式自动记忆、automation、自主执行配置必须位于 W 外。未显式写 policy 时，外部配置才有自动策略默认值 | H 中可信配置与授权目录分开。不能仅删除“配置在 W 内”的检查而失去防自我授权保护 |
| [tui-module-config.ts:327](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/tui-module-config.ts#L327)，沙箱配置解析器 | W 必须存在、为目录且根不能是符号链接；挂载项还检查路径分量 | 对授权目录保留等价的规范化、越界和符号链接约束 |
| [app.ts:252](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/app.ts#L252)，装配方与每次前台 Run | 桌面授权绑定 exact W；Telegram 另绑定 bot/user/chat/Thread，且 Docker 模式排除现有前台自主执行。Run 开始取得权限快照 | 实例身份、频道身份与目录权限分别表达；不能因改路径扩大桌面或 TG 权限 |
| [workspace-path.ts:27](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/workspace-path.ts#L27)、[read-file-module.ts:38](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/modules/read-file-module.ts#L38)，文件工具执行器与权限扩展 | 工具只收 W 内相对路径；拒绝绝对路径、越界与现存符号链接分量。文件工具声明可按路径授权、自主模式可放行；写入的记住范围为所在目录、不含子目录 | 授权目录确定可访问集合；工具审批仍由原权限流程决定。项目识别不得扩大集合 |
| [tool-confirmation.ts:365](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/tool-confirmation.ts#L365)，逐调用权限判定器 | 按模块默认、拒绝搜索后的连带规则、自主权限、Run Shell/来源/文件授权、持久文件授权、记住项等顺序决定；Telegram 不继承桌面记住项 | 保留顺序、agent/Run/频道和记住项有效期，目录列表本身不等于所有工具免确认 |
| [permission-extension.ts:53](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/permission-extension.ts#L53)、[app.ts:848](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/app.ts#L848)，宿主执行前钩子 | 宿主免确认早于普通确认器，包含真实注册的 memory_read、capability_status、整理 Skill 声明工具、许可的任务只读 | b 的快照必须走完整宿主入口，不能只测确认器 |
| [shell-module.ts:100](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/modules/shell-module.ts#L100)、[docker-shell-runner.ts:212](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/modules/docker-shell-runner.ts#L212)，Shell 模块和执行器 | host 的 cwd 在 W 内，但命令仍持有宿主权限。当前 host Shell 即使自主模式也逐条确认；只有 Docker 提供相应 Run Shell 授权，挂载声明路径且无网络、不可用时不回退 host | Shell 系统隔离另做独立步骤。旧 architecture-v2.md §4.3 中“自主 host 无需确认”的现状描述已过时，不能据它放宽权限 |
| [app.ts:293](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/app.ts#L293)、[memory-v6-store.ts:76](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/memory-v6-store.ts#L76)，装配、记忆工具、后台抽取、上下文准备 | store 从 W 派生数据位置，v6 scope 固定 workspace；自动抽取实际由 memoryStore 与 autoConsolidate 决定。记忆文本不授予权限 | 显式数据文件路径、user/project scope 与来源验证；不能把 workspace 文本批量推断成全局用户事实 |
| [skill-catalog.ts:141](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/skill-catalog.ts#L141)，Skill 加载器；[tui-module-config.ts:520](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/tui-module-config.ts#L520)，computer 配置解析器 | 已注册 Skill 包及 computer executable 必须位于 W 外，Skill 还绑定内容 hash | 可信程序/Skill 配置独立于项目。普通文件工具和 Shell 不能改这些可信控制文件后取得新权力 |
| [scheduled-skill.ts:11](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/scheduled-skill.ts#L11)、[task-worker-service.ts:94](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/task-worker-service.ts#L94)，worker 和服务安装器 | worker 配置外置且 W 必须匹配；notification helper 外置；服务 label 派生 W。env 是显式文件，不能把其路径检查概括成所有入口都检查“在 W 外” | worker 获得独立的 home/数据/任务范围输入，不继承前台权限；外部 env 的所有者、权限与可信来源继续检查 |
| [resident-service.ts:17](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/resident-service.ts#L17)、[runtime-ownership.ts:34](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/runtime-ownership.ts#L34)，resident 路径/启动/归属检查 | 常驻身份、服务 label 与 socket 关联 W；协议 scope 包含 userData、configPath、W；外部 env/identity 有路径、所有者和模式约束 | 常驻实例改绑定 H，不能通过切项目误连另一个实例；服务启用仍需显式操作 |
| [desktop-config.ts:89](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/desktop-config.ts#L89)、[module-settings.ts:107](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/module-settings.ts#L107)、[desktop-runtime.ts:77](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/desktop-runtime.ts#L77)，桌面首次配置、设置和重建 | 默认生成 D/runloom.json 与 personal 工作区；显式 RUNLOOM_CONFIG 不改写。配置更新加锁/CAS；桌面与 TG 授权分别校验 W 和身份 | 首次创建 H 与配置；目录授权显式管理；项目切换不重写授权或 Thread 归属 |
| [experimental-data.ts:20](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/experimental-data.ts#L20)，app/store/desktop/resident 启动边界 | 在创建目录、加锁和写入前拒绝实验进程碰日用根 | 4.5 期间保留保护；是否切日用另设关口 |

### 1.2 数据路径全集与读取方

范围覆盖产品持久数据、锁、传输状态、外部可信文件及临时文件。表中的 `.lock`/原子写入临时文件随所属 store 管理，不是第二份事实来源。应用缓存和 OS 服务文件单列。

| 现有位置 | 写入方 / 读取方与代码依据 | 建议目标及导入处理 |
|---|---|---|
| `--config` / `RUNLOOM_CONFIG`；桌面默认 `D/runloom.json`，另有配置锁与临时文件 | CLI、desktop-config、module-settings；[配置入口](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/desktop-config.ts#L89) | `H/config.json`；旧字段由 d 转换一次，不常驻读取两套配置 |
| CLI `--workspace`，或相对配置位置解析的 workspace；桌面默认 `D/workspaces/personal` | 配置加载、文件工具、各 store | 拆成目录授权、项目上下文、数据路径；不在 H 偷建“默认工作区”继续混用 |
| `RUNLOOM_USER_DATA`，否则 `<appData>/@aisdk-agent/desktop` | Electron ready 前 [user-data-path.ts](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/user-data-path.ts) 与 main/index | UI 状态进 `H/desktop/`，Electron 缓存候选为 `H/cache/electron/`；由用户确认 |
| 装配 `directory`、CLI `--transcripts` / `RUNLOOM_TRANSCRIPTS`；省略时临时目录；桌面 `D/transcripts/<threadId>/` 或 `explicit-<key>/` | app、[desktop-identity.ts:121](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/desktop-identity.ts#L121) | `H/transcripts/` 下保留 Thread 对应关系；显式导出路径不变成隐式第二写入位置 |
| `T/<sha256(threadId)>.jsonl`、`.jsonl.append.lock`、写入临时文件 | core [jsonl-store.ts:320](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/core/src/jsonl-store.ts#L320) | 原字节复制、校验前缀/hash；消息 chunk 已嵌在 JSONL，没有另一个 chunk 目录 |
| `T/execution-records.json`、`.lock`、`.execution-owner-<sha256(threadId)>.lock` | [execution-record-store.ts:337](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/execution-record-store.ts#L337)，Controller/恢复/verifier | 随 T 迁移；历史回执不赋予新执行权，unknown 不重放 |
| `T/model-calls-YYYY-MM-DD.jsonl`、`.model-calls.lock` | [model-call-log.ts:58](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/model-call-log.ts#L58)，调用审计读写 | 随 T 迁移；这是旧 paths 清单漏项 |
| `W/.runloom/memory.json`、`.lock`、`.memory.json.runloom-*.tmp` | [memory-v6-store.ts:101](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/memory-v6-store.ts#L101)，v6 条目/文档库/排除来源/进度/屏蔽/导入回执 | `H/data/memory.json`；scope 扩展建议显式升版本，见 c2 |
| `W/.runloom/checkpoint.json`、`.lock` | [checkpoint-store.ts:14](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/checkpoint-store.ts#L14)，checkpoint 工具/上下文/Home | `H/projects/<projectId>/checkpoint.json`，无项目时不伪造项目 |
| `W/.runloom/tasks.json`、`.lock`、`task-worker.lock`、`task-worker-health.json` | TaskStore、task-worker-entry、服务健康读取 | `H/data/`；运行租约与健康状态不恢复成“worker 已运行” |
| `W/.runloom/task-transcripts/` 下的 Thread JSONL 与 append 锁 | [task-worker-entry.ts:423](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/task-worker-entry.ts#L423)，worker 的 JsonlAgentStore | `H/transcripts/tasks/`；独立于前台 T，一并纳入完整备份/Thread 计数，不因导入而重跑任务 |
| `W/.runloom/work-tasks.json`、`.lock`、`.work-task-owner-<sha256(threadId)>.lock` | [work-task-store.ts:457](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/work-task-store.ts#L457)，WorkTask 管理与前台注入 | `H/data/`；保留 Thread/Run/证据关联，不自动继续 |
| `W/.runloom/recipes.json`、`recipes.lock` | [recipe-store.ts:110](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/recipe-store.ts#L110)，配方注册/执行 | `H/data/`；注意锁不是 recipes.json.lock，配方不产生授权 |
| `W/.runloom/rss.json`、`.lock` | [rss-subscriptions.ts:76](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/rss-subscriptions.ts#L76)，订阅管理与 worker | `H/data/`；不自动启用服务 |
| `W/.runloom/dreaming.json`、`.lock` | [dreaming.ts:126](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/dreaming.ts#L126)，技能学习/上下文读取 | `H/data/`；内容不升级为可信程序 |
| `W/.runloom/desktop-frontmost.json` | [task-notification-presentation.ts:7](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/task-notification-presentation.ts#L7)，桌面写/worker 读 | `H/desktop/`；恢复后重新采样，旧记录不证明当前前台状态 |
| `D/desktop-identity.json` | [desktop-identity.ts:34](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/desktop-identity.ts#L34)，当前 profile 与 Thread 注册 | `H/desktop/`；保留已有 Thread ID，不能因新 home 重新生成旧 Thread |
| `D/conversation-drafts.json`、`D/recovery-selection.json` | [conversation-draft-store.ts:57](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/conversation-draft-store.ts#L57)、[recovery-profile.ts:18](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/recovery-profile.ts#L18)，renderer 草稿/恢复启动选择 | `H/desktop/`；恢复选择由导入映射显式重建 |
| `D/resident/runtime.sock`、`auth-token`、`transport.lock` 等本机传输状态 | [resident-transport.ts:14](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/resident-transport.ts#L14)，桌面连接/启动 resident | `H/resident/`；token 与 socket 重新生成，不能照搬成有效连接 |
| `~/Library/Application Support/Serika/resident/<workspaceHash>/identity.json`；同目录 `telegram.json`、`telegram-archive/<kind>/<sha256>.json`、`auth-token` | resident-service、resident-entry、TelegramStore；[resident-service.ts:17](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/resident-service.ts#L17) | `H/resident/`；聊天归属保留，信任重新核对，不自动发送积压内容 |
| macOS `/private/tmp/serika-host-<uid>/<hash>/host.sock`，其他平台 `/tmp/...`；`~/Library/LaunchAgents/dev.serika.assistant-host.<hash>.plist` 与 `dev.runloom.task-worker.<hash>.plist` | resident/service/worker 安装器、OS 服务管理器 | socket 保留 OS 临时目录并绑定 H 身份；plist 仍由 OS 管理。导入只生成待启用配置，不安装或启动 |
| `RUNLOOM_ENV_FILE` / host/worker env 参数；Node、driver、notification helper、注册 Skill 包的显式路径 | 启动器、配置解析、Skill loader、worker；[resident-service.ts:96](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/resident-service.ts#L96) | 凭据与可信可执行文件维持显式外部来源；不复制到项目、普通导出或审核证据 |
| 用户选择的备份目标；归档 `workspace/.runloom/*`、transcripts、execution records、`recovery.json` | [backup.ts:23](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/backup.ts#L23) | 产品备份只枚举六类 store，并非所有路径的完整迁移备份。d 需额外覆盖配置、recipes、TG、草稿、调用日志等，记录缺项 |
| Electron 在 D 下管理的缓存、日志等；`runloom-tui-*`、`runloom-demo-*`、验收临时目录 | Electron、app 与验证脚本 | 缓存可重建，日志按私密数据处理；不导入为事实，不恢复运行锁。验收使用独立临时 H |
| 第 7 步已确认副本 `~/.serika-cm7-review-20261022-final/v6-review/workspace` 与配套配置/transcripts/备份清单 | 第 7 步迁移脚本和审核读取 | d 的显式导入源。配置仍含旧绝对路径，禁止直接启动该配置；只读取经清单确认的同一批副本，不顺便合并当前日用新增内容 |
| 历史 `memory-semantic-index.json`、旧 v4/v5 备份及 `.pre-v6` 等归档 | 旧版遗留；当前 v6 不再写语义缓存、候选或双时态存储 | 只归档，不当作当前事实重复导入。第 7 步已裁决的 14 行表不重新解释 |

### 1.3 审核模式残留

| 残留 | 当前事实 | e 的处理 |
|---|---|---|
| [memory-instructions.ts:2](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/memory-instructions.ts#L2) 的 review/automatic 类型；配置 schema、默认值和外部配置检查 | 字段仍可输入 | 删字段、枚举、分支与文案，d 导入器一次消费旧字段 |
| [memory-module.ts:15](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/modules/memory-module.ts#L15) 的 writePolicy；[app.ts:436](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/app.ts#L436) 传参 | setup 实际未使用该选项，普通记忆工具仍注册；[app.ts:716](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/app.ts#L716) 的自动抽取只看 store 与 autoConsolidate。不能声称 review 现在阻止自动写入 | 只删伪配置，不恢复候选流程。自动整理仍需明确启用及来源校验 |
| desktop-config 的 review→automatic 修补；Controller 的 memory-updated reason 仍有 proposals/review | [desktop-config.ts:40](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/desktop-config.ts#L40)、[assistant-controller.ts:82](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/assistant-controller.ts#L82) | 删已无生产者的类型、修补和测试；对仍被实际消费的事件先查调用再改 |
| 路线旧文说 CLI 仍留候选工具、双时态和语义缓存 | 已被记忆计划 0–7 步替代 | 更新当前说明，不改历史验收成绩，不再为已经删除的实现重复报删除量 |
| WorkTask `needs_review`、TG 投递核对、未知工具回执；退役 Skill 的拒绝加载保护 | 这些属于副作用核对或拒绝旧执行入口 | 保留，不以 review 关键词批量删除。unknown 绝不变成普通失败或自动重试 |

## 2. 目标模型与路径建议

以下细节均为建议，§6 未批准前不得实现。

1. 应用入口解析 `--home > SERIKA_HOME > ~/.serika`，规范化后首次自动创建。assistant/core 只接收显式路径与上下文，不读取全局 home，保留同进程多实例装配能力。现有 `home.ts` 是首页视图，路径解析模块另取明确名称，避免混淆。
2. H 保存配置和个人数据；授权目录表示允许访问的文件集合；项目表示上下文归属。三者可以指向不同位置。没有授权目录时，聊天、用户记忆和不依赖目录的提醒仍可工作。
3. 建议数据布局如下。只有应用装配层负责这些映射，store 接收自己的文件路径，不再自行拼 W/.runloom。锁和临时文件仍与对应数据文件同目录。

```text
H/
  config.json
  data/                 memory.json、tasks.json、work-tasks.json、recipes.json、rss.json、dreaming.json
  transcripts/          原 Thread 映射、JSONL、执行回执、模型调用日志
  desktop/              Thread 注册、草稿、恢复选择、前台状态
  resident/             频道状态和本实例身份，运行 token 重新生成
  projects/             项目注册与各项目 checkpoint
  imports/              导入清单、映射、结果回执
  cache/electron/       可重建缓存，最终位置待确认
```

4. `authorizedDirectories` 建议按规范化目录记录读/写能力。路径在列表内只满足文件范围条件，不绕过模块审批。保留下一 Run 授权、会话内记住、桌面与 TG 的分别授权。H 控制配置、env、可信 driver/Skill 等还需明确保护，不能因为授权了其父目录就允许模型改动后自我提权。
5. 项目从宿主明确提供的 cwd/选中目录找最近 `.git`，支持 Git worktree 的 `.git` 文件；无 Git 时使用用户明确选定的文件夹上下文或无项目。不得从窗口焦点、历史文本或模型猜测自动授权。项目 ID 绑定规范化路径，移动/改名通过显式重绑处理。
6. 记忆建议采用 `user` 与 `project(projectId)` 两种作用域；Thread ID 继续是来源，不再拿它当用户归属。项目笔记复用现有 document 类别和文档库，先不另加 Markdown 事实源。每次准备只选 user＋当前项目，`memory_read` 同样过滤。
7. 当前 v6 [scope 固定 workspace](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/memory-v6-store.ts#L20)，建议 c2 明确升为 v7，再由 d 做离线一次转换，不原地改变 v6 的含义。来源、CAS、冲突、撤回、进度和屏蔽键都必须覆盖 scope/project。scope 不明时不能自动晋升 user。
8. 保持当前 [偏好/其他两组各 4096 字节](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/memory-snapshot.ts#L14) 的预算，user 与项目共享，不能每加一个作用域就翻倍。项目文档索引也只含当前项目。任何预算调整另提规则变更。

## 3. a–e 的小步实施计划

顺序是 a → b → c → d → e。每个编号为一个可验收单位，完成后提交、推送、交审核。涉及未决行为必须先取得 §6 对应选择；不能把“批准计划”理解成批准全部推荐值。

净行数均为工程估计，指新增减删除，不是已测结果或承诺上限。产品、迁移工具、测试分开列；跨步共用文件不重复创造接口。迁移/权限测试可能多于产品行数，原因是需要验证旧数据与安全判定的保真，交付时列实际差异。不设临时兼容开关，不留新旧双写。

### a1. Home 入口与 CLI 数据位置

- 文件：`apps/cli/src/cli-options.ts`、`index.ts`；`packages/assistant/src/app.ts`、`tui-module-config.ts`、各 store 的路径参数与 `index.ts` 导出。新增单一职责的应用 home 解析模块，不改 core 领域规则。
- 做法：CLI 解析 H 并注入配置、transcript 和 store 文件位置；把各 store 内的 W/.runloom 拼接替换成显式文件路径，同时迁完对应调用者。文件工具暂仍以原 W 判断权限。旧数据不隐式读入，新 H 不建默认工作区。
- 验收：全新 H 首启/重启一致；无 workspace 也能创建用户数据；H1/H2 同进程互不可见；不设置全局环境变量；只读 preflight 不创建目录；旧日用路径被实验保护拒绝。配置解析的已批准权限规则不变。
- 估计净行数：产品 **+40～+120**；测试 **+80～+140**。路径与两实例隔离测试是此步重点。

### a2. 桌面、resident 与 worker 的 home 归属

- 文件：`apps/desktop/src/main/{index,user-data-path,desktop-config,desktop-identity,desktop-runtime,runtime-ownership,resident-service,resident-entry,resident-transport,resident-protocol,recovery-profile,backup}.ts`；`packages/assistant/src/{task-worker-service,task-worker-entry,scheduled-skill}.ts`；对应启动脚本和路径基线。
- 做法：桌面与常驻均显式传 H；服务身份从 W 改为 H 的实例身份；Thread 注册不随项目变。worker 读明确任务范围，不继承前台目录或自主权。旧数据只交 d 处理，不并行维持旧默认写入路径。
- 验收：两个 H 的 socket、身份、任务与频道状态隔离；切项目不换 Thread；新实例不误连日用 resident；不可自动注册、替换或启动 OS 服务。旧权限 grant 不因路径重映射失效后静默扩大，未转换的授权保持未启用。
- 估计净行数：产品 **−60～+40**；测试 **+80～+140**。

### b0. 固定权限判定快照

- 文件：`packages/assistant/src/{permission-decisions.test,permission-decisions.snapshot,permission-extension.test,tool-confirmation-remember.test,tui-module-config.test}.ts`，`apps/desktop/src/main/foreground-autonomy.test.ts` 及必要的桌面 module-settings/Telegram 装配测试。
- 做法：用改造前的真实代码录制 allow/deny/ask、确认范围、是否能记住、实际确认卡和注册命令。记录源码提交、配置摘要、OS、场景输入与快照 SHA。现有 [permission-decisions.test.ts:246](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/permission-decisions.test.ts#L246) 排除了 memory_，且普通确认器表覆盖不了宿主免确认，需要补覆盖。
- 场景：普通/自主/Docker/Telegram/worker；宿主免确认；真实记忆读写；Run/持久文件授权；记住后、重启/切 Thread 后；拒绝搜索连带规则；配置内外位置；路径越界、符号链接、敏感控制文件；缺失或外来 grant。
- 验收：同输入重复录制结果一致，快照人工审阅后冻结。后续 b1 逐项比较，禁止自动更新快照消掉差异；发现现有问题只记录，规则改动另经确认。
- 估计净行数：产品 **0**；测试及快照 **+100～+180**。新增快照是用户明确要求的例外。

### b1. 单目录等价替换

- 文件：`tui-module-config.ts`、`workspace-path.ts`、`tool-confirmation.ts`、`permission-extension.ts`、`modules/read-file-module.ts`、`foreground-autonomy.ts`；桌面 `module-settings.ts`、`desktop-runtime.ts`、`telegram-gateway.ts` 与相关共享输入类型。
- 做法：先把一份 W 映射为一个授权目录，路径仍能无歧义地定位原文件；迁移判定调用者后删除旧 workspace 信任字段。把实例/频道身份与目录范围拆开，桌面、TG grant 各自转换。项目仍不参与判定。
- 验收：对 b0 每个输入的规范化等价映射，allow/deny/ask、记住行为与宿主免确认结果全部一致；host Shell 仍逐条确认。只接受字段表示变化，不接受权限扩大。无授权目录时文件操作不能越权。
- 估计净行数：产品 **+60～+140**；测试 **+100～+180**。

### b2. 多目录与可信控制文件保护

- 文件：b1 的路径/配置/文件模块，以及桌面目录设置、共享协议和权限展示；Shell 的目录输入仅改为同一份声明，不在此步替换后端。
- 做法：目录列表支持读/写区分、嵌套去歧义和跨目录明确定位。相对路径以明确项目/目录为基点，多候选时要求选择，不猜。保护 H 配置、凭据、可信程序与 Skill 文件；持久目录授权与一次工具批准分开。
- 验收：读目录不能写；列表外不能借绝对路径、`..`、符号链接绕过；授权父目录不能篡改可信配置后自授权限；删目录授权对下一请求生效。对比 b0，新增能力/保护收紧逐条列批准编号，再更新对应快照，原场景仍保持。
- 估计净行数：产品 **−40～+60**；测试 **+60～+100**。规则收紧及多目录行为属于用户拍板项。

### c1. 项目自动识别

- 文件：应用 CLI/desktop 入口、`packages/assistant/src/{app,context-sources,home,checkpoint-store}.ts`；新增只负责项目定位与注册的模块；桌面当前项目展示。
- 做法：按 §2 的宿主目录发现项目，支持 Git worktree；非 Git 的明确文件夹和无项目状态都可用。项目注册位于 H，读项目元信息不自动读任意正文、不开 Shell、不调用模型。项目移动显式重绑。
- 验收：嵌套目录、worktree、无 Git、无目录四种输入得到稳定结果；换项目只改变项目上下文；目录授权快照无差异；同名不同路径项目互不混淆；重启恢复选择不恢复授权。
- 估计净行数：产品 **+80～+140**；测试 **+60～+100**。

### c2. User 记忆与项目笔记

- 文件：`packages/assistant/src/{memory-types,memory-v6-store,memory-library,memory-snapshot,memory-extraction,memory-instructions,memory-read-tools,memory-write,memory-merge,memory-import,context-assembler,context-sources}.ts` 的实际相关实现、`modules/memory-module.ts` 及 `controller-memory.ts`；桌面 `memory-library.tsx`。格式确定后将 store 文件名与导出一起改成当前版本名称，不留 v6/v7 两个运行时 store。
- 做法：应用显式传作用域，存储/抽取/冲突/撤回/进度/读取统一过滤；笔记复用 document。新格式写一个文件，旧 v6 由离线导入器读取。用户偏好跨项目，项目笔记限定项目；无法确定归属时不自动写成全局事实。
- 验收：A 项目笔记不进入 B 或无项目的主上下文及 memory_read；user 偏好跨项目；来源仍绑定原 Thread/消息；同名偏好跨 scope 不误合并；CAS/unknown commit/撤回/冷启动保持；共享快照预算不增加，文档索引只见当前项目。旧 v6 启动只能提示导入，不能自动升级旁写。
- 估计净行数：产品 **+140～+240**；测试 **+160～+260**。数据格式与归属决策须先确认；SQLite 不进入此步。

### d1. 一次性导入器与副本演练

- 文件：新增专用离线导入脚本与测试，复用 `packages/assistant/scripts/cm-step7-migrate.mjs` 中适用的读取/校验方式；只在职责吻合时复用，不让旧迁移脚本变成通用框架。涉及 `apps/desktop/src/main/backup.ts` 的格式校验，不把现有六-store 导出称为完整备份。
- 做法：输入显式源清单、目标 H 与用户批准的项目/scope 映射；输出预览、完整私密备份、文件 SHA/条目数、转换映射、导入回执及回滚报告。默认 dry-run；必须显式执行。用备份副本演练迁移与回滚，不碰原路径。
- 验收：满足 §5 全部备份/回滚核对；同一源摘要重复导入无重复写入；源变化或目标冲突即停止，不自动合并；失败恢复后可重跑；未完成写入不能留下“导入成功”标志。测试覆盖持久化中断边界，因为此步直接改变存储。
- 估计净行数：产品 **0～+20**；迁移工具 **+160～+260**；测试 **+140～+220**。

### d2. 导入已确认的第 7 步 v6 副本

- 文件：d1 导入器、配置转换、启动提示、路径基线与迁移文档。用户私密数据及备份不进 Git；公开报告仅放去标识的清单结构和可复算校验结果。
- 做法：演练审核通过后，读取 §1.2 指定 v6 副本及其同批 transcripts。已确认的三条偏好建议映射 user、三份文档建议映射 Serika 项目，仍须确认具体项目映射。保留 ID、来源与历史回执；旧 v4/v5 档案不重复导入。目标是新的隔离 H，原日用目录和入口不变。
- 验收：导入前后按类别核对条目数、正文/来源/ID、Thread 关联、原 transcript 字节 SHA；格式变化字段有单独映射报告。原副本与日用源 SHA 不变；目标重启可读；unknown 与未完成任务进入原有核对流程，不自动读回、重试、继续任务、发消息或启服务。导入成功后只写 H，旧运行路径调用者同一步删净。
- 估计净行数：产品 **−80～−20**；迁移工具 **+60～+120**；测试 **+60～+100**。真实内容核对由用户进行；离线测试只能证明机制。

### e. 清除审核模式残留

- 文件：`tui-module-config.ts`、`memory-instructions.ts`、`modules/memory-module.ts`、`app.ts`、`assistant-controller.ts`；桌面 `desktop-config.ts`；相关测试、当前配置示例与路线说明。
- 做法：按 §1.3 删除无效 writePolicy、review/automatic 选择、桌面启动修补和失去生产者的事件值。旧配置只在 d 导入时消费；新配置遇旧字段明确要求导入，不长期静默接收。后台抽取仍由明确的自动整理设置控制，不重新开放候选审核。
- 验收：生产代码无记忆审核模式入口/参数/死分支；关闭自动整理仍不抽取；正常写入、uncertain 原话保存和用户撤回语义不变；WorkTask/TG/unknown 的人工核对仍保留。逐个列删除的测试文件及依据，不靠删断言让快照变绿。
- 估计净行数：产品 **−100～−50**；测试 **−60～+20**。

## 4. Shell 系统级沙箱：独立步骤 S

S 依赖 b 的授权目录及其批准规则，可在 a–e 完成后单独实施。未完成 S 不得宣称 4.5 的系统沙箱目标完成，也不能放开 host 自主执行。保留逐条确认的 host 模式是路线已定目标；Docker 退出安排需用户确认，不能长期留三个后端。

系统隔离只约束 Shell 子进程。Todoist、web_fetch、Telegram、Computer 的授权不因此扩大。向 Herdr 或浏览器已有进程发送指令可能使外部进程产生副作用，不能把该行为算成已被 Shell 沙箱隔离。

| 步 | 文件与交付 | 验收 | 预计净行数 |
|---|---|---|---|
| S0 后端可用性与规则定稿 | Shell 模块/配置；专用 OS 能力探测和隔离验证脚本。现场确认 macOS sandbox-exec 与 Linux bubblewrap 在支持系统可用，确定运行时只读依赖、敏感路径和凭据环境规则 | 在真实 macOS、Linux 分别给出支持/不可用结果；缺程序、user namespace 禁用等情况拒绝沙箱执行，不回退 host。只探测不启用自主权 | 产品 +30～+60；验证工具/测试 +60～+100 |
| S1 文件隔离与默认断网 | `modules/shell-module.ts`、替换执行后端、新增各 OS 的具体 runner；接 b 的授权目录配置；进程组取消与回执衔接 | 授权写可用，未授权写、敏感读、环境凭据泄漏、符号链接越界、子进程逃逸、IPv4/IPv6 直连、继承 socket 均受约束；取消后后代不继续运行，无法证明结果时仍 unknown，无自动重试 | 产品 +180～+300；测试/真实 OS 脚本 +180～+300 |
| S2 域名网络放行 | 明确网络 broker/代理与系统阻断策略，配置/确认卡接现有审批；不额外实现网页工具 | 只开 HTTP_PROXY 不算隔离。必须阻断直接外连，再验证域名白名单、DNS 重绑定、重定向、裸 IP、IPv6 与子进程绕过。未批准域名不可外发；不能实现则保持断网并报告阻塞 | 暂估产品 +120～+240；测试 +120～+220，S0 后重估 |
| S3 自主规则切换与旧后端删除 | `foreground-autonomy.ts`、权限声明/快照、服务配置、Shell 设置；删除 Docker runner 与其配置/测试，若用户选择退休 | 自主 Shell 必须使用可用系统沙箱；host 仍逐次确认；worker 不继承前台自主。相对 b0 的每条规则变化均有批准记录，更新快照后真实 Electron 重测 | 产品 −220～−80；测试 −100～+40，取决于 Docker 删除范围 |

Linux 的 bubblewrap 仅提供机制，[官方 README](https://github.com/containers/bubblewrap) 明确隔离强度取决于调用参数；不能把“进程经过 bwrap”当验收。macOS 的实际 profile 和系统版本同样必须现场验证。禁止为方便启动把整个 `/` 以可写方式挂入沙箱；Node/npm/git 等依赖只开放实际需要的只读路径。

S 的五分钟 Demo：临时 H 授权目录 A，运行可写 A 的 Shell，再尝试写 B、读测试敏感哨兵、连接未授权本地测试端点，后几项应被 OS 阻断；允许指定测试域后仅该域可达。禁用后端后，自主命令应拒绝执行；显式选择 host 后仍出现逐次确认。Demo 用测试哨兵，不读取真实钥匙串、浏览器资料或密钥。

## 5. 护栏与统一验证

### 5.1 权限快照

1. b0 在 b 的产品改动前提交快照与生成输入；现有快照冻结后不自动改写。现有更新环境变量只能在已批准差异时使用。
2. b1 对等价映射逐项比较判定；b2 和 S 的新场景另加，旧场景保持。差异报告列旧值、新值、影响工具/agent/来源、用户批准记录。
3. 不把目录在列表中、自主模式、项目识别或导入旧配置单独当成免确认依据。宿主前置放行与完整 Controller 路径也纳入测试。
4. 改权限、TG、沙箱或回执前，实施者重新查阅 [旧约束对应条目](legacy/agents-constraints-2026-10-20.md)，在当步报告写清依据；发现两套规则冲突先提请确认。

### 5.2 备份、演练与回滚

1. 源只读。记录完整相对文件清单、类型、字节数、SHA-256、权限模式，以及每类 store 条目数、Thread/消息数、版本。符号链接单列链接值，不能跟随它读入未申报数据。凭据备份仅存私密受限位置，Git 报告不含正文、路径身份或密钥。
2. 对运行中的日用目录不做零散混拷。本轮 d 使用已确认的静态第 7 步副本；若未来要求更新源，另获授权取得一致快照，不能自行停日用进程。复制前后核对源清单/SHA，发生变化即停止。
3. 从备份生成演练副本，迁入全新 H；记录每个源文件到目标文件/字段的映射，区分原样复制与格式转换。原 transcript 不重写 hash，导入不恢复旧权限或执行状态。
4. 在演练副本执行回滚，逐项比较**文件清单、SHA、条目数**，三项都必须与备份相同；还检查权限模式、无多余新文件。恢复的运行锁/token/plist 只作取证保存，不启动服务；工作副本启动前另按现行流程重新创建运行状态。
5. 演练报告经审核后才允许 d2 写目标隔离 H。目标写入先持久化数据，成功后记录导入回执；以源摘要与导入 ID 防重复。任何结果未知先核对目标，不自动再次写入。
6. 保留备份、导入回执和回滚报告；不删除原副本或日用目录。切日用、注册服务、启用 TG 外发均是后续独立授权，4.5 交付不自动做。

### 5.3 每步验证与报告

- 中间实现单元跑 `pnpm typecheck` 与受影响测试。每个交付步骤按现有约定执行 `node packages/assistant/scripts/cm-step6-verify.mjs`，依次完成 UTC 和 Asia/Shanghai 全套测试、eval、临时干净检出的真实 Electron 冒烟及离线审计。Linux 用 Xvfb。
- 冒烟脚本 SHA 固定 `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f`；检查器固定 cm-step6-offline-v5，SHA `f45f10aa5f644fdc450d9e8ffef81d45d48f53f38d7455cca00c611b4e43c46a`。不修改它们或手动测试故障注入函数来迁就新结果。接口变化若使冻结验证无法运行，先列冲突等审核确定替代协议。
- 报告只写当次可复算数字，区分单元测试、真实 Electron＋假模型、真实模型、真实 OS 沙箱和用户实际内容确认。S 需 macOS、Linux 原生进程证据；Linux 上跑了 Electron 不等于验证 macOS Seatbelt。
- 本轮与后续离线验证都不得调用收费真实模型；如确需真实模型，先说明次数、预算和停止条件，取得用户批准。
- 交付列产品/迁移工具/测试的增删与净行数、命令/退出码、源码提交和证据 hash。提交并推送实验分支后停在该步审核口，不进日用迁移。

## 6. 用户需要拍板的事项

以下推荐尚未获批；可以按编号选择，不能用本表自行授权。

| 编号 | 选项 | 推荐与原因 | 最晚决定点 |
|---|---|---|---|
| D1 Home 解析 | A：`--home > SERIKA_HOME > ~/.serika`；B：仅环境变量＋默认值 | A。三个入口已在路线中确定，优先级明确；CLI、桌面、resident 一致 | a1 |
| D2 旧入口与缓存 | A：旧 RUNLOOM 配置/路径由一次导入消费，Electron 缓存进 H；B：长期支持旧环境变量与外部 userData | A。单一配置写入位置，缓存可重建；外部密钥文件仍显式引用，不混入导入 | a1/a2 |
| D3 目录能力与审批 | A：目录列表区分读/写，工具审批另判；B：目录内全部工具自动执行 | A。能延续当前范围授权语义，避免给目录授权时连带放开 Shell/Computer | b1 |
| D4 控制文件保护 | A：即使父目录获写权限，也禁止普通工具修改 H 配置、env、可信 driver/Skill；B：只排除 H，不保护外部可信文件 | A。防自我授权；具体保护清单与用户手动配置入口单独审阅，属于规则收紧 | b2 |
| D5 原自主权转换 | A：桌面/TG 独立、按原范围重绑，不能转换的保持未启用；B：导入后统一信任本实例所有工具 | A。不能悄悄带入 #177 的 toolApproval:skip | b1/d |
| D6 项目识别 | A：宿主 cwd/选中目录＋最近 Git/worktree，无 Git 明确文件夹或无项目；B：模型/窗口焦点自动猜项目 | A。可重复、无授权副作用；移动项目显式重绑 | c1 |
| D7 记忆格式 | A：显式 v7，user/project scope；B：继续称 v6 并扩义 | A。旧 v6 schema 固定 workspace，版本应反映不兼容变化；仍是 JSON，不引入 SQLite | c2 |
| D8 项目笔记载体 | A：现有 document＋project scope；B：项目中的 Markdown 成为主事实源 | A。复用现有来源、CAS、撤回和文档库，避免两份事实写入；如选 B 需另定文件编辑与来源规则 | c2 |
| D9 旧内容归属 | A：已确认三条偏好→user、三份文档→指定 Serika 项目，其余逐项映射；B：全部 workspace 条目→user | A。需用户给出项目路径/ID；不把项目目标晋升成用户长期偏好 | d1/d2 |
| D10 导入源 | A：只导入已确认第 7 步 v6 静态副本；B：另取最新日用快照再裁决差量 | A，符合本轮日用只读与已确认内容。B 是新迁移范围，需独立授权和一致快照 | d1 |
| D11 Shell 后端 | A：macOS Seatbelt＋Linux bubblewrap，逐条 host 保留，系统后端通过后删除 Docker；B：先仅实现一个 OS，另一 OS 自主 Shell 不可用 | A 为完整目标；如选 B 明确未完成的平台，不把它称为跨平台完成 | S0 |
| D12 网络与外部进程 | A：先默认断网，独立验收域名 broker；Herdr/浏览器控制保留逐次 host 特例或暂不开放；B：把已有进程控制当沙箱内自主操作 | A。已有进程的副作用超出子进程隔离范围。broker 具体方案需 S0 实测后审阅 | S0/S2 |
| D13 切日用前 main 能力 | A：按附录按需重实现；B：八项全部前置 | A。TG 用户优先 #184＋#185；启用 Computer 则前置 #182；记忆页小修 #174 可并 c2；其他按真实入口选 | 4.5 后日用门槛 |

## 7. 附录：main 八项变化与 v2 的关系

main 历史路径主要是 `examples/cli/src/`，v2 的对应职责在 `packages/assistant/src/` 与 `apps/cli/`。以下按能力重实现估算，不直接复制旧压缩器、旧记忆或旧装配层。成本为初步人日及净行数估计，包含离线回归，不包含真实设备/账户搭建、付费模型或用户验收等待。

### #171 本地终端控制、前台压缩与重复探测

- 来源：[PR #171](https://github.com/steven4225/serika/pull/171)，合并提交 `d370fd379b6aa5536c42bc833b8286d55dfe431d`。
- 作用：发现本地 CLI 能力、明确 Herdr 目标和既有终端入口；同时修前台请求/Steer/回执在旧压缩路径中的保留、重复成功 Shell 探测及 TG 忙时行为。
- v2 差异：现有新上下文计划已经有请求/Steer/工具底线和无进展约束，不能再搬旧压缩器。当前 v2 尚无 main 的 `local-terminal.ts` / `herdr-target.ts` 与对应设置/IPC。
- 依赖：CLI 能力描述可独立；能控制哪个终端、跨进程副作用和自主权依赖 b/S 的授权选择。host Shell 不因该能力变为免确认。
- 成本：只补 CLI/Herdr 目标链，约 **2～4 人日，产品 +120～+220，测试 +120～+220 行**；旧压缩改动不另移植。
- 日用建议：需要接管 Pi/Herdr 终端则前置该子集；否则不阻塞 home/记忆迁移。

### #174 旧记忆标题与刷新入口

- 来源：[PR #174](https://github.com/steven4225/serika/pull/174)，合并提交 `197ea64288ab2097b625540172e306e1b37da958`。
- 作用：无独立名称的旧条目显示短标题“记忆条目”，不重复把长正文首行当标题；移除详情页常驻刷新入口。
- v2 差异：[memory-library.ts:53](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/packages/assistant/src/memory-library.ts#L53) 仍有首行标题逻辑，renderer `memory-library.tsx` 仍有刷新入口。
- 依赖：无 4.5 硬依赖，可在 c2 项目笔记界面完成；不需要改来源和记忆语义。
- 成本：**少于 0.5 人日，产品 −5～+5，测试 0～+20 行**。只补必要交互检查，不写布局镜像测试。
- 日用建议：经常用记忆页则顺带完成，非存储迁移前置条件。

### #175 通过本机 CLI 操作浏览器

- 来源：[PR #175](https://github.com/steven4225/serika/pull/175)，合并提交 `2f1589d61c177d0e779886677d16a8ddbe9a97e7`。
- 作用：复用 Shell 的 ego-browser 发现、帮助和可信 Skill，要求操作前重读状态、结果未知不重放；没有新增 browser 工具族。
- v2 差异：当前没有对应 CLI 指引与接入链。
- 依赖：依赖 #171 的 CLI 发现子集；真实操作还涉及 S 的网络/socket 和“控制已存在浏览器进程”边界。不能因 CLI 在沙箱启动就称浏览器副作用也受隔离。
- 成本：指引与装配约 **0.5～1 人日，产品 +20～+50，测试 +30～+70 行**；真实浏览器、账号和沙箱桥接另估，不能含在这个数字里承诺完成。
- 日用建议：浏览器是必需入口时单独验收，否则后置。

### #177 已有 Pi 控制与 Telegram 私聊信任

- 来源：[PR #177](https://github.com/steven4225/serika/pull/177)，合并提交 `724436d9ba92e3d50615e9ad653bb60c0f89b5fd`。
- 作用：补 Homebrew 等 PATH 下的 Herdr 发现、已有 Pi 的 get/read/prompt 流程、简短 TG 回复；新增显式 `telegramAutonomy.toolApproval: "skip"`，允许绑定私聊跳过已注册主工具审批，旧 grant 不自动扩大。
- v2 差异：当前严格配置不支持 toolApproval，TG 自主能力与 host Shell/Computer 的审批比该选项窄。
- 依赖：CLI/格式可拆出；skip 是单独权限规则，必须经 D5/b/S 决策，不是 home 路径迁移的自然结果。
- 成本：在 #171 CLI 子集后补路径/Pi 指引与 TG 格式，约 **1～2 人日，产品 +50～+110，测试 +80～+160 行**。若批准 skip，额外权限矩阵与风险验收另估。
- 日用建议：可选保留 Pi/格式，**不自动带入整工具集免确认**。用户确实需要该策略时另立批准项。

### #180 QQ 群聊与群主审批

- 来源：[PR #180](https://github.com/steven4225/serika/pull/180)，合并提交 `f0a9114810736eda42014f94b5e6b50b121ad228`。
- 作用：接 NapCat/OneBot v11、独立群 Thread、群主逐工具审批、频道状态持久化与 unknown 不重放；群配置拒绝私人记忆、checkpoint、任务、Todoist、computer、Skills 等。
- v2 差异：尚无对应 QQ 应用。路线已决定群聊在个人助手稳定后另开独立实例，不沿用 main 的桌面内嵌布局。
- 依赖：不阻塞个人 4.5；将来依赖 A1/A2/A3 的可多次装配、可选模块和独立 H，不能共享私人数据/凭据。
- 成本：独立应用约 **3～5 人日，产品 +450～+650，测试 +250～+450 行**；NapCat 实际环境与真实群验收另算。main 合并不能代替真实 QQ 验收。
- 日用建议：后置独立线，除非用户改变当前个人助手范围。

### #182 Computer 首次接入、审批与驱动恢复

- 来源：[PR #182](https://github.com/steven4225/serika/pull/182)，合并提交 `62bcdc00acf329bbadf4a930eb32fb50c42f0ac4`。
- 作用：修 computer_check 空确认预览；提供 driver 选择/发现、allowBundleIDs 和健康结果；旧程序失踪时允许停用；冷启动恢复需确认；错误有界，AX 只读诊断不含可执行 action token。
- v2 差异：尚无该批新的连接/恢复界面与文件，现有驱动配置解析和错误处理较早。
- 依赖：不是 home 的硬依赖，但应与 b 的外部可信 driver/配置保护配合。Computer 继续单独逐次审批，不继承 Shell 沙箱权限。
- 成本：约 **2～4 人日，产品 +250～+400，测试 +200～+350 行**，另需真实 macOS driver 与 Electron 验收。
- 日用建议：**若启用 Computer，切日用前完成**；未启用可后置。main 的真实 Electron/driver＋脚本模型证据不等于任意真实模型电脑任务验收。

### #184 TG 连续补充与桌面跨端同步

- 来源：[PR #184](https://github.com/steven4225/serika/pull/184)，合并提交 `4809b03028124eb2fd7af154189adc121577f73f`。
- 作用：普通 TG 补充进入同 Run 的有界 Steer，先落消息 ID/Run 绑定再派发，未知确认按对应回执核对、不重放；resident revision、窗口重新聚焦/可见刷新与 renderer generation 防止旧快照覆盖新流。
- v2 差异：[telegram-gateway.ts:447](https://github.com/steven4225/serika/blob/1275051668433ee94b1ccb65f40a34845e1afcd1/apps/desktop/src/main/telegram-gateway.ts#L447) 仍依赖显式“调整：”且普通忙时消息被拒绝；resident 传输尚无该 revision 同步链。
- 依赖：无 4.5 硬依赖，实例/Thread 归属须接 a2/b；不能将快照同步当权限更新。
- 成本：约 **1～3 人日，产品 +100～+180，测试 +160～+260 行**，手机和桌面真实跨端验收另列。
- 日用建议：**使用 TG＋桌面连续工作的用户应在切日用前完成**。

### #185 TG 成功补充静默

- 来源：[PR #185](https://github.com/steven4225/serika/pull/185)，合并提交 `cfb46dddd182887ed41a3129d99b8c5e46747278`。
- 作用：成功接受 Steer 及确认已接受的恢复回执不再额外发确认消息；拒绝、未应用、结果未知仍通知。
- v2 差异：当前只有较早的显式调整链，不能只删一句回复冒充完整行为。
- 依赖：依赖 #184 的普通补充、持久绑定和核对路径，适合与 #184 一起交付。
- 成本：#184 之后 **少于 0.5 人日，产品 0～+10，测试 +20～+40 行**。
- 日用建议：若做 #184 同时做 #185；main 合并与单测不等于用户手机实际体验已验收。

## 8. 本轮交付与停止点

本轮只新增本计划。产品代码净变化 0 行，测试代码净变化 0 行；文中各步和附录的数字均标为未来估计，不作为已完成指标。

提交前核对代码链接的文件/行号、八项 PR 的合并提交、a–e 与 S 的覆盖、备份回滚护栏、未决事项及仅文档 diff；执行结果在交付消息中另报。遵循现有统一验证要求时，证据输出到独立目录，不改冻结脚本或日用数据。

交付后停下等审核与用户拍板。获准后首个实施单位为 a1，不自动进入 a1、系统沙箱或日用迁移。

非阻塞待办保留：unknownRequests 容量与溢出投影之后单独定上限；日常试用时复测未知结果写入的用户原话与回执保留；内部词外露、目标/待办/决定分类、摘要缺字段恢复按原待办处理，不混入本轮产品改动。
