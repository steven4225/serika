# 架构第 6 步 6a：四状态与单一 TaskStore

依据：[任务重做草案](../architecture-v2-step6-task-draft.md) §4、§9。2026-10-31 已确认：统一进现有 `tasks.json` v5；四状态加回执／验收硬门槛；`work_task_create` 留给 6b；不升级真实日用、不花费模型。查过旧约束：Tool side-effect invariants、创建幂等、typed arrangements、后台交付及通知、WorkTask 恢复／验收（unknown 进待核对、`reconcile` 的 continue 回到可再显式开始、cancel 不证明副作用未发生）、requestChanges 保留交付并清空验收、结束检查不放宽。

## 改了什么

| 文件 | 原因 |
|---|---|
| `task-lifecycle.ts`、`task-store.ts` | 安排实例只存 `pending \| running \| completed \| cancelled`；失败／中断留在 attempt 与 `error`；运行时只接受 v5，v1–v4 或旁路 `work-tasks.json` 报 `TASK_MIGRATION_REQUIRED`，启动不迁移 |
| `work-task-store.ts` | 交办记录并入同一文件；`effectReviewRequired`／`acceptanceOpen` 是硬门槛，可见阶段由 `workTaskPhase` 推出；删掉第二条写入 |
| `task-store-upgrade.ts`、`scripts/task-store-upgrade.mjs` | 只接受绝对 `--data`，拒绝 `~/.serika` 与 `~/.config/serika`；dry-run／upgrade／rollback 只动授权副本 |
| Controller、worker、工具、桌面、备份 | 同一 PR 改到唯一 `TaskStore`。worker 的 `interruptRunning` 只收安排实例 |
| 草案、INDEX、记忆计划 §4.1、架构路线第 6 行 | 记下已确认取舍，并标明 6a 待合并、6b／6c 未做 |

产品改动超过 400 行，按已有边界拆开：生命周期、安排存储、交办存储、离线升级、调用方。没有第二套可写状态机。

## 逐条对照验收项

| 草案 §9 的 6a | 结果 |
|---|---|
| 四状态和 7→4、定时实例映射 | 已做。`task-store-upgrade.test.ts`：安排 2、交办 6；`scheduled`／`failed`／`needs_review`／`awaiting_acceptance`／`ready` 各 1 |
| 唯一 TaskStore，同批迁调用方并删除第二条写路径 | 已做。`createWorkTaskStore` 只收 `TaskFilePort` |
| 离线 dry-run／upgrade／rollback，不碰真实日用，启动不自动迁移 | 已做。上述测试 dry-run 不改字节；rollback 后两文件与升级前逐字节相同。未对 `~/.serika` 执行 |
| 单 worker、Run 绑定、类型化来源、owner 隔离；worker 不碰前台交办；unknown／待核对不解锁 | 已做。同文件：待核对不能 `beginRun` 或普通 `cancel`；`interruptRunning` 只把已领取的提醒收成 pending，前台交办仍为 running。失败安排不会被重新领取 |
| 文档不再把取舍写成待确认 | 已做。见 INDEX 与草案开头 |

6b（`work_task_create`、确认卡）、6c（五分钟 Electron）、真实日用升级、dreaming 重做、SQLite、真实 TG、S2／S3：没做。

## 前后数字

相对 `origin/main`：产品代码 +526／−320（净 +206）；测试与快照 +342／−317（净 +25）。测试新增行数低于产品新增行数。任务文件运行时版本 4 → 5。真实模型调用 0。未改 `docs/v2-pilot/evidence/**`。

断言改动（旧行为不再是存储状态）：

| 测试 | 旧断言 | 为什么旧行为是错的 |
|---|---|---|
| `home.test.ts` 两个 renderHome | 一次 `pending` 列表，标题 `scheduled/running` | 四状态下等待与执行要分开列；标题改为 `pending/running`。失败／中断行改由 `settlement` 印出 |
| `work-tasks.test.ts`、`desktop-runtime.test.ts`、`telegram-gateway.test.ts` | 存储 `status` 为 `paused` 或 `ready` | 存储只有四态；可见的暂停／待开始是 `workTaskPhase` |
| `__baseline__/home.txt`、`home-snapshots.json`、`home-view.json`、`home-app.txt` | `scheduled · next` 与 `scheduled/running` | 同一标题和等待态用词 |
| `__baseline__/assembly-full*.txt` | `task_list` 枚举含 `scheduled`／`failed`／`interrupted` | 模型可见过滤器改为四态加 `attention` |
| `__baseline__/hashes.json` 的 dreaming batch fingerprint | `c997a347…` | 旧样本按测试字面量的字段顺序哈希。回执现在按已落盘的七态字段顺序计算，并去掉 `kind` 与两个门槛，使原档案的来源哈希仍对得上。新值 `afda97fc9ccc05d2bdc4498d96d2674baceb27a5873bd295a4217173d23db964` |

## 实际命令和退出码

Linux，Node 测试进程，不是 Electron，不是常驻进程，未在 32,768 窗口或 macOS 上验证。

| 命令 | 退出码 |
|---|---|
| `pnpm typecheck` | 0 |
| `node --test` 商店／升级／worker／recovery／completion／rework／controller／home／task-module／幂等／回执／dreaming | 0（168 过） |
| 临时 home 下桌面：home-view、work-tasks、desktop-runtime | 0（27 过） |
| 同批还跑了 reminder、today、inbox、backup、work-task-data | 通过；下面两条 Telegram 除外 |

`telegram-gateway.test.ts` 的 “independent TG authorization…” 在 `run.tools[1].shell.exitCode` 失败（实际没有 shell 回执，10 个工具都是 `completed`）。“TG grant survives…” 报 `Telegram state did not settle`。失败点不在本次改过的 `workTaskPhase` 断言；`app.ts` 只改了任务存储接线，shell 回执写入器不在 diff 里。没有在 `main` 上复跑这两条，所以不把它们写成已证明的既有失败，也不把它们算进 6a 通过项。

## 与计划不符的地方及理由

没有做 6b／6c，也没有升级真实日用。Home 行仍用英文 `failed`／`interrupted` 表示保留下来的 attempt 事实，存储状态是 `pending`。`scheduleStatusLabel` 仍把已退休的单词 `scheduled` 显示成等待，避免旧文案变成“状态待核对”；存储和工具枚举不再产出这个词。dreaming 不在 6a 范围，但交办记录多了字段，所以回执哈希显式丢掉这些字段，避免已有来源对不上。
