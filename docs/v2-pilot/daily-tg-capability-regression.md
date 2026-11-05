# TG 能力指引与日用回归第一轮

目标：TG 权限不足时给出可用的授权入口，在现有批准范围内执行，并按真实回执交付。本轮已修正能力与拒绝指引，完成隔离验证；真实 TG 和真实模型验收仍未执行。

基线 `9470a19d38abba877993510e5211c4d8a4da3eb0`；分支 `codex/tg-capability-guidance`。日用切换报告记录任务 v5 已迁移、10/10 可读；本轮未重验日用在线状态，未迁移或切换日用。

## 1. 改了什么

- `packages/assistant/src/capability-status.ts`：仅受信任 Telegram 前台入口把已有目录命令、空闲条件、原卡确认、保存回读和未知结果处理加入模型能力事实。根因是网关已有功能，但普通聊天模型请求缺少说明。
- `apps/desktop/src/main/telegram-directory-authorization.ts` 与 `telegram-run-result.ts`：复用已有 usage，让结构化目录拒绝直接显示只读、读写授权命令和确认步骤。授权保存、CAS、原卡与身份检查未改。
- `packages/assistant/src/modules/browser-cli-instructions.ts`：修正每次确认的旧说明，匹配当前任务同 cwd 及子目录批准复用、结束、撤回和空闲 30 分钟失效规则。
- `packages/assistant/src/modules/seatbelt-policy.ts`：说明 Node/git 支持不证明 npm/pnpm 或构建测试兼容；已有主机路径为已注册且明确批准的 `terminal_exec`。执行策略未改，没有自动主机回退。

按 Fix Root Causes 将缺失事实放回能力摘要与宿主回执；按 Prove It Works 检查实际模型请求、命令输出、产物和持久任务。已查旧约束的工具副作用、目录与文件权限、Docker 不回退、回执未知效果、前台 TG 授权和后台安排条目。

## 2. 逐条对照验收项

| 验收项 | 已做与边界 |
| --- | --- |
| 目录拒绝及模型能力说明 | 已做。Runtime/Controller 的脚本模型请求与宿主回执原先缺命令，修复后定向用例通过；desktop 对照不注入 TG 命令。未做真实模型回答验收。 |
| 未保存、保存核对、保存未知 | 已做隔离目录卡测试，覆盖原卡、绑定、目录替换、未知保存与回读不一致，不自动重试。未做真实 TG 卡片点击。 |
| 浏览器批准复用 | 已做 desktop 和 telegram 离线 CLI fixture，五次调用只批准一次。未做真实浏览器业务验收。 |
| TG 委派完整链 | 已做真实 Herdr/Pi、脚本模型、假 TG 的 8 项 gate：两个 Pi 选择、选择不等于批准、原卡批准、单次派发、回读、独立产物核对。未知效果回归保留。真实 TG 和真实模型没做，缺授权。 |
| npm/pnpm、构建和测试 | 已做生产 Seatbelt runner 实测：简单 Node build/test 成功；本机 npm/pnpm 裸命令 exit 127，已观察绝对路径 exit 126。独立明确的 host 对照四条命令均 exit 0。范围仅此安装布局与无依赖 fixture，未验证依赖安装或任意项目。Node 成功命令仍有既有 shell 警告。 |
| 关闭桌面、后台执行、重开和已读 | 已做真实 Electron 44.4.5、原 preload/IPC、独立 worker。提醒与新 RSS 各执行一次；受控通知失败后只重试通知。空 RSS 用受控次日时钟，无模型、无通知。重开后实际点击三个已读，回读结果和执行次数不变。安排通过生产 Store 准备，未覆盖 GUI 创建、公网 RSS、真实 OS 通知或 launchd 安装。 |
| 五分钟 Demo | 没做完整计时验收。后台外部脚本调试产生失败与同实例续验，未冒充单次全绿。 |

## 3. 前后数字

产品 5 文件 `+12/-6`，测试 2 文件 `+17/-2`；测试新增略多，用于实际模型请求的 TG/desktop 对照和宿主拒绝回执回归。没有新快照或审批状态机。

- 定向测试 17/17；完整 runtime 1258 项，1241 通过、10 失败、7 跳过；desktop 681 项，678 通过、3 失败；desktop 脚本 25/25。
- 在未修改的同一固定基线另建临时 worktree，逐个复现全部 13 个失败，失败名称集合一致。完整套件不绿色。未更改这些断言。
- Pi gate：8 项通过，5 次脚本主助手调用、3 次本机代理 Pi 请求，真实模型与真实 TG 调用均 0。
- 后台：提醒、新 RSS、空 RSS 各一个持久结果，任务 attempt 均 1；前两项通知 attempt 从 1 到 2，模型 Run 始终 1；三个结果已读后数据除 `acknowledgedAt` 外完全一致。

## 4. 实际命令和退出码

测试均在 macOS arm64、隔离临时 home 下运行；使用 `TMPDIR=/private/tmp`，避免系统 `/var` 别名先触发实际路径约束。完整测试启用既有 `SERIKA_B2_RECORD_CONCURRENT_HOME=1`，保护器写入违规数为 0，但观察到并发日用变化，不能宣称日用文件字节不变。

| 命令 | 退出码与结果 |
| --- | --- |
| `pnpm typecheck`；`pnpm build:runtime`；`pnpm --filter @serika/desktop build` | 各 0，构建有依赖警告。 |
| `node --test packages/assistant/dist/{capability-status,foreground-wiring,terminal-control}.test.js` | 0，8/8。 |
| `pnpm --filter @serika/desktop exec tsx --test src/main/telegram-run-result.test.ts src/main/telegram-directory-authorization.test.ts` | 0，9/9。 |
| `pnpm test` | 1，runtime 的 10 个基线失败使 desktop 未自动运行。 |
| `pnpm --filter @serika/desktop test` | 1，3 个基线失败；随后独立运行 `node --test apps/desktop/scripts/*.test.mjs` 为 0。 |
| 同基线 6 个失败 runtime 文件及 3 个失败 desktop 用例的定向复跑 | 各 1，13 个失败均复现；完整命令与失败名称见本地日志。 |
| `pnpm --filter @serika/desktop exec tsx scripts/chat-run-target-telegram-gate.mjs --output /private/tmp/serika-tg-guidance-pi-gate-20261105` | 0，8 项通过，隔离 Herdr 目标清理完成。 |
| `node /private/tmp/serika-p1-probe-script.7NIThQ/probe.mjs` | 0，采用最后单次 `3BetwF` 证据，脚本哈希已独立核对。 |
| `node /private/tmp/serika-background-verification-scripts/electron.mjs`；同目录 `ack.mjs` | 前者 1，后台成功后外部脚本从隐藏详情读 ID 为空；后者 0，同实例续验实际点击已读，不重跑 worker。原失败报告保留，续验绑定原报告 SHA。 |
| `pnpm --filter @serika/desktop smoke` | 干净产品提交 `cde233d` 首次 1，重开切换与启动 `/home` 竞争；同提交未改脚本复跑 0，首组 8 项、任务流程 6 项通过。保护器写入违规 0。 |
| `git diff --check` | 0，独立只读审核未发现阻塞问题。 |

原始证据仅保存在本机隔离验证目录，不进入产品 PR。`verification-manifest.json` 绑定源码、日志和基线失败集合；`background/` 保存原失败、worker、已读续验、一致性报告及脚本截图。主线程独立核对源与构建哈希、三个任务前后内容、截图哈希及测试 Electron 退出。官方成功运行编号 `808a79be-1620-4707-8de3-9a69c646ad0a`，开始时源码干净，证据生成物归档后工作区仍干净。

## 5. 与计划不符的地方及理由

- 两个既有 TG 回执精确文本断言在保留原错误内容后追加授权说明。旧断言只允许拒绝原因，与本次明确要求的新指引冲突；其余断言未弱化、删除或跳过。
- 官方 smoke 首次因未提交源码被阻止，授权 checkpoint 后的首次运行在重开切换时失败。最小重开探针在本轮与原 `9470a19` 基线都复现同一拒绝，状态时间线均出现启动 `/home`。源码路径为 renderer `app/runtime-store.ts` 启动尾部执行 `home()`，与脚本仅等待输入框启用后立即 `selectThread()` 竞争。这些路径均未被本轮修改。未加 sleep、改断言或更改脚本；同产品提交的完整官方复跑 exit 0，保留首次失败，不宣称消除了既有竞争。
- 远端 main 尚不含日用基线两笔提交。本轮 PR 以固定基线分支 `codex/daily-timeout-receipts` 为目标，仅展示本轮 8 文件；前序依赖进入 main 后可转向 main。CI workflow 当前为 `disabled_manually`，本地验证不代表远端检查通过。
- 真实模型费用、真实 TG 测试绑定、系统通知与再次日用切换尚无本轮授权。所有隔离结果都不等同于真实 TG 和模型日用验收，整份 issue 仍未关闭。
