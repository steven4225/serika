# 架构第 6 步 6c：隔离操作验收

依据：[任务重做草案](../architecture-v2-step6-task-draft.md) §9、§10。6a 已在 `main@bd1a895` 合并。6b 在本起点 `main@2277072`。查过旧约束：Tool side-effect invariants、unknown 不自动重放、WorkTask 恢复／验收、通知失败不重跑任务。没有改这些语义。`work_task_create` 仍然只保存。

## 改了什么

| 文件 | 原因 |
|---|---|
| `App.tsx` | 任务页「＋ 创建任务」改为普通对话。用户输入交办后由脚本模型调用 `work_task_create`。顶栏「创建并开始」仍走原来的 `createAndStartTask` |
| `smoke-model.ts` | 只在交办、slug 修复和「一分钟后提醒复核」这三句上按真实工具调用往下走：读材料、保存、编辑、回读、测试、提醒 |
| `tasks-page.tsx`、`tasks-model.ts`、`tasks.css` | 任务行标出「效果待核对」。定时页并入未读提醒结果，打开后能看到结果正文 |
| `work-task-phase.ts`、`browser.ts`、`work-tasks.ts` | `workTaskPhase` 从任务存储文件拆出。渲染进程再从 `/browser` 引用，否则当前 electron-vite 会把含 `fileURLToPath` 的存储模块打进页面并构建失败 |
| `task-surface-smoke.mjs` | §10 主链。新 home、`repo-regression-v1` 可写副本、真实 Electron、原 preload／IPC、脚本模型、手动单 worker |
| `work-task-step6c.test.ts` | 已派发后 unknown、继续只开新 Run、取消保留 unknown、前台租约不被 worker 恢复改写、通知故障只增加通知次数、32,768 与日用大窗口 |

没有新建 eval 框架，没有移动 `examples/eval`，没有改旧 Oracle，没有动 `~/.serika`，没有在创建时自动开始。

## 逐条对照验收项

| 草案 §10 | 结果 |
|---|---|
| 任务 → 创建任务；可写 fixture；脚本模型真实工具调用；确认卡含目标、`node --test test/slug.test.mjs`、「改动范围可接受」后保存 | 已做。`task-surface-smoke.mjs` 的 `confirm-card` |
| 保存后只显示待开始；没有文件写入和测试执行 | 已做。同脚本 `saved-not-started`。`src/slug.mjs` 哈希不变，回执里没有 edit／write／shell |
| 开始并按当前权限确认；交付含本次写入／回读、最后一次修改后的测试回执、人工项待验收；未接受前不是全部完成 | 已做。同脚本 `delivery-pending-human` |
| 接受人工项后 completed；重开后按当前交付仍能读到；通知已读不改变验收 | 已做前半。同脚本 `human-accepted` 与 `reopen`（状态仍 completed）。没做「先标为已读再读验收」：隔离 worker 没有 `--notify`，没有系统通知可标已读。重开断言提醒 `acknowledgedAt` 仍为 null |
| 同一实例「一分钟后提醒复核」；到点后从任务入口打开结果；没有工程文件或 Shell，没有真实模型 Run；后台是否可用单独显示 | 已做。同脚本 `reminder-result`。`runId` 为 null，`execution` 为 `deterministic`。新增工具只有 `task_create`。页面正文含「后台」 |
| 关闭再开：工程交付、提醒结果、归属保留；不重放；不把通知冒充已读；从已准备实例起五分钟内 | 已做。同脚本 `reopen`。本次约 71 秒。重开后当前线程是原来的空线程，任务在「＋ 创建任务」打开的那条对话上，`taskCount > 0`，选中后仍显示验收通过。slug 哈希与 Run 条数不变 |
| 已派发、结果不明 → 任务页显著待核对；开始、普通取消、自动完成不可用；重开后仍在，模型／工具请求不增加 | 已做。`work-task-step6c.test.ts`「dispatched write with an unconfirmed cleanup…」用真实 `write_file`，写到一半且清理失败，回执为 unknown。`tasks.test.ts`「shows 效果待核对 on the task list…」 |
| 核对后继续只允许新 Run；取消保留 unknown 历史 | 已做。同上文件的 continue／`new-run` 断言，以及「cancelling after an unknown write keeps that receipt」 |
| 同库：前台 WorkTask 运行时，隔离 worker 恢复不改其状态、Run、租约 | 已做。同文件「worker recovery leaves a foreground running work task…」 |
| 通知故障只增加通知尝试 | 已做。同文件「a notification fault increases only notification attempts」。模型调用 0，`runId` 仍为 null |
| 两档窗口：32,768（有效输入 26,624）和日用大窗口 | 已做保存一轮。同文件「scripted save fits the 32768 window and the daily large window」：小窗 `availableInputTokens === 26624`，大窗 `contextWindowTokens === 1000000` 且 `inputBudgetTokens === 256000`，当次估计输入不超过该额度。Electron 主链配置用日用大窗口。没有在 32,768 窗口下重跑整段 Electron 界面 |
| 真实模型、真实 TG、launchd、日用 home 迁移 | 没做。草案把这些留在费用和日用授权之后 |

失败判据（手填工程 schema、保存后暗中执行、无证据 completed、人工项自动接受、重开重放、提醒拿到工程权限、结果或核对提示丢失）在这次脚本里没有出现。

证据种类：主链是真实 Electron＋脚本模型＋真实工具，不是浏览器预览。失败链和两档窗口是 Node 测试进程里的真实工具与真实存储。都不是真实模型验收。

## 前后数字

相对 `main@2277072`：产品代码 +132／−26（净 +106）；测试与冒烟脚本 +652／−0。测试行数高于产品行数，因为这一步的交付就是主链脚本和失败链用例，不是新的任务模型。真实模型调用 0。未改 `docs/v2-pilot/evidence/**`。任务文件版本仍是 5。

断言改动：无。没有改旧断言、历史分数或快照。

## 实际命令和退出码

Linux，Xvfb `:99`。Electron 冒烟是真实 Electron 进程加脚本模型。Node 测试不是常驻进程。未在 macOS 上验证。32,768 窗口只跑了保存一轮，没有跑整段 Electron 界面。

| 命令 | 退出码 |
|---|---|
| `pnpm typecheck` | 0 |
| `tsx --test` `work-task-step6c.test.ts`、`tasks.test.ts`、`package-boundary.test.ts` | 0（21 过） |
| `DISPLAY=:99 node apps/desktop/scripts/task-surface-smoke.mjs` | 0。检查：`confirm-card`、`saved-not-started`、`delivery-pending-human`、`human-accepted`、`reminder-result`、`reopen`。约 71 秒。`realModelCalls: 0` |
| `DISPLAY=:99 pnpm --filter @serika/desktop smoke`（干净工作区） | 0。原冒烟 8 项与上面 6 项都过。test-home 守卫 `metadataUnchanged: true`、`violations: 0`。冒烟写进 `docs/v2-pilot/evidence/**` 的文件没有提交 |
| `SERIKA_TEST_HOME` 为临时目录时 `pnpm test` | 1。runtime 1241 项里 1194 过、26 败、21 跳过；因此没跑到桌面套件。失败不在本次 diff：Herdr 写 `/private/tmp`、computer 需要 macOS、连续性断言存储状态 `paused`、记忆抽取、RSS、Skill。不算 6c 通过 |
| 同条件下 `pnpm --filter @serika/desktop test` | 1。662 项里 650 过、9 败、3 跳过。失败是 Herdr／终端绑定和两条 Telegram 网关，与 6a 记录的壳层回执失败同类，不在本次 diff。任务页新增用例在这套里面通过 |

两次套件的 test-home 守卫都是 `metadataUnchanged: true`、`violations: 0`。守卫标 failed 是因为测试进程退出码不是 0，不是因为写了日用 home。

远端 GitHub Actions 工作流 `CI` 的 state 是 `disabled_manually`。本地绿不等于远端检查绿。

## 与计划不符的地方及理由

重开后先落在原来的空线程，任务在创建时打开的那条对话上。归属还在，要选中那条对话才看到验收通过。没有改启动时选哪条线程。

`workTaskPhase` 挪到单独文件，是为了让当前渲染构建通过，阶段判断没有改。

没有跑真实模型，也没有把脚本模型的 fixture 结果写成推导质量或日用验收。
