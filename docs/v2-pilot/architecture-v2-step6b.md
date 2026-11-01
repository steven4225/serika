# 架构第 6 步 6b：对话创建，只保存

依据：[任务重做草案](../architecture-v2-step6-task-draft.md) §5、§9。6a 已在 `main@bd1a895` 合并。查过旧约束：Tool side-effect invariants、创建幂等、typed arrangements、后台交付及通知、WorkTask 恢复／验收、结束检查不放宽。没有改这些语义，也没有把 `work_task_create` 交给 worker、后台沉淀或 Skill。

## 改了什么

| 文件 | 原因 |
|---|---|
| `work-task-create.ts`、`task-module.ts` | 普通 primary 增加 `work_task_create`。模型只提目标、约束和检查；宿主绑定 Thread、项目、home 和创建键 |
| `work-task-store.ts` | 创建回执哈希纳入项目和 home。相同键和参数返回当前实体；参数或归属变化拒绝。桌面不传这两项时哈希与原来一致 |
| `app.ts` | 只在普通对话暴露该工具。已绑定 WorkTask 的 Run 从工具表拿掉。已读文件正文供命令出处核对 |
| `assistant-controller.ts` | 保存成功后发 `work-task-updated`，任务页沿用 6a 的同一查询。工具行只显示「已创建，尚未执行。」 |
| 桌面确认标题 | 确认卡标题为「保存工作任务」。正文列出目标、约束、程序检查、人工项，并写明尚未开始 |
| 草案、INDEX、架构路线、记忆计划 §4.1 | 标明 6a 已合并、6b 待合并、6c 未做 |

创建不调用 `beginRun`，不跑检查，不授予 Shell 或文件权限。桌面「创建并开始」仍在创建成功后走现有 `runWorkTask`。程序检查仍是 `artifact_exists`／`shell_exit_zero`；宿主只核对类型、项目路径、授权目录和当前材料里的命令，不另调模型裁判。路径有歧义或没有唯一项目时拒绝，不默认选目录。

## 逐条对照验收项

| 草案 §9 的 6b | 结果 |
|---|---|
| 普通 primary 的 `work_task_create` | 已做。`work-task-create.test.ts`：保存一轮；worker 与已绑定任务的 Run 没有该工具 |
| 宿主归属／创建键 | 已做。同文件：模型带 `threadId` 被拒；同一键换目标或换项目拒绝；新消息另建一条 |
| 可读确认卡；已保存 ≠ 已开始 | 已做。同文件断言卡片含目标、约束、命令、人工项和「未开始」；回执 `started:false`，`runIds` 为空，阶段 `ready` |
| 任务页与定时页共用查询 | 已做。交办写入同一 `tasks.json`；安排列表不含这条目标；保存后发 `work-task-updated` |
| Runtime／AgentLoop：保存、拒绝、参数与归属拒绝、精确重放、未知提交只读核对 | 已做。同文件四条：保存、拒绝（否认／无出处／越界路径／伪造身份／无项目）、回放与归属、目录 sync 失败后只读且不自动重发 |
| 收尾检查不放宽 | 已做。`work-task-completion.test.js` 通过；新建任务的程序项和人工项验收结果都不是 `passed` |
| 权限快照没有意外变化 | 没在本机比完。`permission-boundary.test.js` 的 b0 在启用 computer 时抛 `computer module currently requires macOS`，快照断言还没跑到。新工具不设 autonomy，且 `remember: "never"`。快照文件没有改 |

6c、真实日用升级、真实模型、$2 批次、真实 TG、SQLite、S2／S3、架构第 7 步：没做。

## 前后数字

相对 `main@bd1a895`：产品代码 +342／−17（净 +325）；测试 +272／−5（净 +267）。测试新增行数低于产品新增行数。真实模型调用 0。未改 `docs/v2-pilot/evidence/**`。任务文件版本仍是 5。

断言改动：

| 测试 | 旧断言 | 为什么旧行为是错的 |
|---|---|---|
| `baseline-assembly.test.ts` 的 `assertStep3Assembly` | 工具表和能力文案与历史快照逐字相同 | 普通对话新增 `work_task_create`。历史快照文件未改；比较前去掉这一项，其余工具 schema 仍逐字对照 |

## 实际命令和退出码

Linux，Node 测试进程，不是 Electron，不是常驻进程。未在 32,768 窗口或 macOS 上验证。

| 命令 | 退出码 |
|---|---|
| `pnpm typecheck` | 0 |
| `node --test` `work-task-create`、`baseline-assembly` | 0（9 过） |
| `node --test` controller、`work-task-completion`、home、`work-task-store`、创建幂等、workspace task read、directory-access | 0 |
| 桌面 `create-task`、`work-tasks`、`telegram-format`、`work-task-data` | 0（28 过） |
| `permission-boundary.test.js` 的 b0 | 失败：`computer module currently requires macOS`。失败在快照比较之前，不把它算进 6b 通过项 |
| `SERIKA_TEST_HOME` 为临时目录时 `pnpm test` | 1。runtime 1236 项里 1188 过、27 败、21 跳过；桌面套件因此没跑到。单独重跑后，记忆抽取 32k 通过。仍失败且不在本次 diff 里的是：连续性断言存储 `paused`、Skill 验收断言 `failed`、RSS `RSS_BATCH_PENDING`、Herdr 的 `/private/tmp`、computer 需要 macOS。这些不算 6b 通过 |

## 与计划不符的地方及理由

项目和 home 写进现有创建回执的哈希，没有给 WorkTask 增加新的落盘字段，因此不升任务文件版本。确认卡沿用现有 y/n 预览，桌面只加了标题「保存工作任务」。没有做 6c，也没有跑真实模型或真实 Electron 冒烟。
