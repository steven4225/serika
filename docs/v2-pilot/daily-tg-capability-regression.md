# TG 能力指引与日用回归第一轮

目标：TG 权限不足时给出可用的授权入口，在现有批准范围内执行，并按真实回执交付。本轮已修正能力、拒绝和批准回执指引，完成隔离验证；2026-11-06 补测真实项目副本的主机批准流程。2026-11-07 追加真实 TG 与模型结果，见第 2 节末尾。

基线 `9470a19d38abba877993510e5211c4d8a4da3eb0`；分支 `codex/tg-capability-guidance`。日用切换报告记录任务 v5 已迁移、10/10 可读；本轮未重验日用在线状态，未迁移或切换日用。

## 1. 改了什么

- `packages/assistant/src/capability-status.ts`：仅受信任 Telegram 前台入口把已有目录命令、空闲条件、原卡确认、保存回读和未知结果处理加入模型能力事实。根因是网关已有功能，但普通聊天模型请求缺少说明。
- `apps/desktop/src/main/telegram-directory-authorization.ts` 与 `telegram-run-result.ts`：复用已有 usage，让结构化目录拒绝直接显示只读、读写授权命令和确认步骤。授权保存、CAS、原卡与身份检查未改。
- `apps/desktop/src/main/telegram-gateway.ts`：批准处理成功后仍统一声称“不适用于后续操作”，与任务内复用冲突。回执改为按原卡说明界定范围、按执行回执核对结果，通用按钮改“允许”；身份、原卡、短码、批准和执行策略未改。
- `packages/assistant/src/modules/browser-cli-instructions.ts`：修正每次确认的旧说明，匹配当前任务同 cwd 及子目录批准复用、结束、撤回和空闲 30 分钟失效规则。
- `packages/assistant/src/modules/seatbelt-policy.ts`：说明 Node/git 支持不证明 npm/pnpm 或构建测试兼容；已有主机路径为已注册且明确批准的 `terminal_exec`。执行策略未改，没有自动主机回退。

按 Fix Root Causes 将缺失事实放回能力摘要与宿主回执；按 Prove It Works 检查实际模型请求、命令输出、产物和持久任务。已查旧约束的工具副作用、目录与文件权限、Docker 不回退、回执未知效果、前台 TG 授权和后台安排条目。

## 2. 逐条对照验收项

下表保留原离线交付时的验收范围；后续真实结果单独记录。

| 验收项 | 已做与边界 |
| --- | --- |
| 目录拒绝及模型能力说明 | 已做。Runtime/Controller 的脚本模型请求与宿主回执原先缺命令，修复后定向用例通过；desktop 对照不注入 TG 命令。未做真实模型回答验收。 |
| 未保存、保存核对、保存未知 | 已做隔离目录卡测试，覆盖原卡、绑定、目录替换、未知保存与回读不一致，不自动重试。未做真实 TG 卡片点击。 |
| 浏览器批准复用 | 已做 desktop 和 telegram 离线 CLI fixture，五次调用只批准一次。未做真实浏览器业务验收。 |
| TG 委派完整链 | 已做真实 Herdr/Pi、脚本模型、假 TG 的 8 项 gate：两个 Pi 选择、选择不等于批准、原卡批准、单次派发、回读、独立产物核对。未知效果回归保留。真实 TG 和真实模型没做，缺授权。 |
| npm/pnpm、构建和测试 | 已做生产 Seatbelt runner 实测：简单 Node build/test 成功；本机 npm/pnpm 裸命令 exit 127，已观察绝对路径 exit 126。独立明确的 host 对照四条命令均 exit 0。2026-11-06 再复制未经修改的 core 与 adapter 源码及本机已安装依赖：真实网关＋Controller、脚本模型＋假 TG 中，原卡批准一次后 npm/pnpm 各构建成功、各跑 core 测试 53/53；四条命令各执行一次。待批准、普通“可以”、外人／复制卡、重复点击和新 scope 拒绝均不产生额外执行。未验证依赖安装或任意项目；Node 简单命令仍有既有 shell 警告。 |
| 关闭桌面、后台执行、重开和已读 | 已做真实 Electron 44.4.5、原 preload/IPC、独立 worker。提醒与新 RSS 各执行一次；受控通知失败后只重试通知。空 RSS 用受控次日时钟，无模型、无通知。重开后实际点击三个已读，回读结果和执行次数不变。安排通过生产 Store 准备，未覆盖 GUI 创建、公网 RSS、真实 OS 通知或 launchd 安装。 |
| 五分钟 Demo | 原 issue 的真实 TG／模型 Demo 未做。新增本地主机项目单实例闭环 31.616 秒；后台 GUI 创建至已读的单次计时复验见 desktop PR #212，不能合称为同一版本的真实 TG 完整验收。 |

### 2026-11-07 真实验收追加

- 使用包含本 PR 和 #212 的本地组合候选 `24a56952e37ff4f864c1393f3f16c9cb2bfb4027`，源码干净。本轮没有新增产品代码，不能据此声称本 PR 单独分支通过同一真实批次。
- 真实 TG、模型及隔离 Pi 委派通过：选择目标与冻结批准目标一致，control 1 次，Pi 用户输入 1 次，回读及主助手独立读取产物一致，结果为 `sum=14` 和原 `order`。批次总时长 212.633 秒，成功批次没有重复执行。原产物已随临时目录清理，原始 Pi transcript、请求及读取回执保留在本机。
- 新目录批次的真实拒绝及授权指引通过，回复包含只读、读写命令、原卡确认、保存回读及未知结果核对。确认卡送达，点击前配置仍未保存。
- 目录保存整链未通过：CUA 点击内联按钮报 `AXError.failure`；用户反馈已点击，但宿主未收到 callback，等待保存超时。停机后只读 Bot API 检查未发现迟到事件。没有代写配置或合成 callback，授权后读取及只读写入拒绝未执行。
- 所有批次累计真实模型请求 20 次，按已核对高峰单价复算费用上界 `$0.018957376`，未知预留 `$0`，总上限 `$1`，账单未核对。失败及中断批次均计入。独立核对脚本 exit 0，测试宿主已停止，专用 profile 已关闭，未结输入和未审核投递均为 0。
- 真实系统通知、服务安装及日用切换未授权。本轮只更新报告，未重跑既有单元测试或 Electron 冒烟。两张 PR 均 OPEN，远端 check 列表为空；原有基线失败及离线测试边界继续保留。原始证据和本地核对脚本不进入产品 PR，整份 issue 尚未完成。

## 3. 前后数字

产品 6 文件 `+14/-8`，测试 3 文件 `+19/-2`；测试新增略多，用于实际模型请求的 TG/desktop 对照、宿主拒绝和确认范围回执回归。没有新快照或审批状态机。

- 定向测试 17/17；完整 runtime 1258 项，1241 通过、10 失败、7 跳过；desktop 681 项，678 通过、3 失败；desktop 脚本 25/25。
- 在未修改的同一固定基线另建临时 worktree，逐个复现全部 13 个失败，失败名称集合一致。完整套件不绿色。未更改这些断言。
- 2026-11-06 新增两条确认范围断言先红后绿，网关和结果回执定向 96/96、scripts 25/25、typecheck 通过；全套仍为 runtime 10、desktop 3 个既有失败，最终失败集合与本报告原基线证据一致。该分支与 #212 的 main 基线不同，不能把失败数 13 与 12 当作修复收益。
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
| `TMPDIR=/private/tmp pnpm --filter @serika/desktop exec tsx --test src/main/telegram-gateway.test.ts src/main/telegram-run-result.test.ts` | 0，96/96；新增断言修复前在真实宿主回执“不适用于后续操作”处失败，修复后通过。 |
| `pnpm --filter @serika/desktop exec tsx /private/tmp/serika-project-toolchain-verification/probe.mjs <repo>` | 0，31.616 秒；实际项目副本的生产 Seatbelt 下 npm/pnpm 均 exit 126，不回退；显式 host 原卡批准后四条命令 exit 0，拒绝／重复不执行。 |
| `git diff --check` | 0，独立只读审核未发现阻塞问题。 |

2026-11-06 最终产品提交 `98991818c49d4dda848c0b69525e1906eaf90ce7` 的官方 Electron 冒烟 exit 0，8＋6 项通过；开始及恢复后源码干净，guard 违规 0，观察到并发日用变化。源码、脚本、产物与 core 测试日志已独立回读，后续仅更新本报告。本次新增证据位于同一 visualization 根目录的 `issue-followup-20261106/`，含 `final-toolchain/report.json`、完整日志和 `baseline-comparison.json`。

原始证据仅保存在本机隔离验证目录，不进入产品 PR。`verification-manifest.json` 绑定源码、日志和基线失败集合；`background/` 保存原失败、worker、已读续验、一致性报告及脚本截图。主线程独立核对源与构建哈希、三个任务前后内容、截图哈希及测试 Electron 退出。官方成功运行编号 `808a79be-1620-4707-8de3-9a69c646ad0a`，开始时源码干净，证据生成物归档后工作区仍干净。

## 5. 与计划不符的地方及理由

- 2026-11-06 的首轮项目副本缺少 core 测试引用的 adapter；pnpm 11.9 默认运行前还会尝试安装不匹配的依赖，网络拦截挡住请求。第二轮禁止运行前安装后仍因 adapter 缺失失败。补齐未经修改的 adapter 源码及已安装依赖，使用新实例完整重测通过，未删改测试。原失败报告均保留。
- 本次主机子进程由命令中的 `env -i` 指定独立 HOME、TMPDIR、空 npm 配置、离线选项和网络拦截；不能仅凭 DesktopRuntime 的 env 参数声称 Shell 子进程已隔离。最终网络尝试 0，没有执行依赖安装。

- 两个既有 TG 回执精确文本断言在保留原错误内容后追加授权说明。旧断言只允许拒绝原因，与本次明确要求的新指引冲突；其余断言未弱化、删除或跳过。
- 官方 smoke 首次因未提交源码被阻止，授权 checkpoint 后的首次运行在重开切换时失败。最小重开探针在本轮与原 `9470a19` 基线都复现同一拒绝，状态时间线均出现启动 `/home`。源码路径为 renderer `app/runtime-store.ts` 启动尾部执行 `home()`，与脚本仅等待输入框启用后立即 `selectThread()` 竞争。这些路径均未被本轮修改。未加 sleep、改断言或更改脚本；同产品提交的完整官方复跑 exit 0，保留首次失败，不宣称消除了既有竞争。
- 远端 main 尚不含日用基线两笔提交。本轮 PR 以固定基线分支 `codex/daily-timeout-receipts` 为目标，仅展示本轮 8 文件；前序依赖进入 main 后可转向 main。CI workflow 当前为 `disabled_manually`，本地验证不代表远端检查通过。
- 原离线交付时尚无真实模型和 TG 授权；后续专用 env、测试绑定及总预算 $1 已获授权，真实结果见第 2 节追加。系统通知、服务安装及再次日用切换仍未授权，整份 issue 仍未关闭。
