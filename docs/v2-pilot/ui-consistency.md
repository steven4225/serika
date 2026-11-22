# 桌面界面一致性（少操作）

一句话结论：旧页面被装进统一外壳后仍各自决定布局、展开方式和动作位置；这一轮把导航行、页头、设置归属、路径/权限/保存布局和失败反馈收敛到各一套，并修掉四个会丢状态或静默失败的实际缺陷。

## 1. 改了什么

| 文件 | 为什么 |
| --- | --- |
| `personal/page-header.tsx`（新） | 四处各写一遍的返回按钮和标题合成一套导航行；挂载时把键盘焦点落到标题 |
| `personal/settings-rows.tsx`（新） | 设置里的导航行抽出来，提醒页和其他推进页复用同一种入口样式 |
| `setting-paths.tsx`（新） | 路径列表 + 保存栏（次动作在左、未保存状态贴着保存按钮、失败紧跟其下）一套布局 |
| `project-setting.tsx` / `directory-authorization.tsx` / `autonomy-setting.tsx`（新） | 从 `capabilities.tsx` 拆出，各归属到自己的设置页 |
| `capabilities.tsx` | 只剩「本页的能力开关 + 自己的反馈」；删掉无条件渲染的项目/目录/自主/电脑/Herdr 区块、页尾重复的「配置位置」折叠和泛泛 intro；每行两个折叠合成一个「技术详情」 |
| `personal/settings-model.ts` | 新增能力归属表 `settingsRouteForModule` / `modulesForSettingsRoute`、新路由 `shell`（命令与终端）、`settingsRefreshNeedsRemount` |
| `App.tsx` | 设置页按归属装配；`arrangements` 改成提醒页推进的独立页面；合并两份重复的 Escape 处理；「数据与配置位置」由折叠改为字段；干净保存不再重挂载整页 |
| `personal/tasks-page.tsx`、`work-tasks.tsx` | 任务页直接显示验收控件，记录收进一个「任务记录与产物」折叠；去掉重复卡头与「编号」 |
| `reminders.tsx`、`automation-panel.tsx` | 提醒行去掉工程编号；排期表单整体用 `fieldset` 锁定 |
| `herdr-target-setting.tsx` | 新增空状态 `herdrEmptyNotices`；区块样式从确认框改为设置区块 |
| `context.tsx` | 预算从「高级」折叠里的无标签文本改为页面上的字段，压缩记录留一个按需折叠 |
| `build-identity-panel.tsx` | 关于页版本信息从整体折叠改为设置区块 + 字段，构建 ID 进技术详情 |
| `threads.tsx` | 当前对话加强调边和实心标签，未发送草稿用警示标签，窄窗标题换行不截断，记录详情补全标题 |
| `skills-panel.tsx`、`dreaming-panel.tsx` | 失败反馈从页尾/页顶改为就地显示，失败用 `FailureAlert`（`role=alert`） |
| `formal-memories.tsx` | 记忆写入记下发起时的详情序号，迟到响应不再覆盖已切换的条目 |
| `backup-panel.tsx` | 工作区状态读取失败不再被 `.catch(() => {})` 吞掉 |
| `scripts/task-surface-smoke.mjs` | 删掉两处点击已不存在的折叠的步骤 |

## 2. 逐条对照验收项

### 任务与核对

| 验收项 | 结果 |
| --- | --- |
| 「验收与核对」「任务记录与要求」多一层展开 | 已做：验收控件直接显示，记录改为「任务记录与产物」一个折叠（`personal/tasks.test.ts` "opens a task showing the review controls first, with records on demand and no engineering id"；真实 Electron `task-surface-smoke` 删掉展开步骤后通过） |
| 日常详情里出现「编号」「fixture-review」 | 已做：任务页与提醒行的 `编号` 折叠删除（同上测试断言 id 不出现） |
| 同一个待核对任务两个入口 | 已做：当前任务卡本身就是该任务入口时不再额外显示待核对横幅，改为「另有执行效果待核对」汇总 |
| 结果未知时保留人工核对 | 已做：未知效果汇总、人工验收与确认框文案均未改；`task-surface-smoke` 的 `delivery-pending-human`、`human-accepted` 通过 |

### 提醒、定时安排与返回

| 验收项 | 结果 |
| --- | --- |
| 三种入口样式不一致 | 已做：提醒页用与设置相同的导航行推进到「定时安排与订阅」（`ui-navigation-copy.test.ts` "schedule management is a pushed page off reminders, not a disclosure inside it"） |
| 定时安排设置框套框 | 已做：折叠内嵌卡片改为独立页面，`.task-arrangements*` 样式全部删除 |
| 复用导航行、返回按钮、页标题，减少中间层 | 已做：`PageHeader` + `detailBackTarget`，Escape 与返回按钮走同一条返回链 |

### 设置与目录授权

| 验收项 | 结果 |
| --- | --- |
| 项目/目录授权/设备能力重复出现、嵌在「高级配置与诊断」里 | 已做：归属表决定每项只出现在一页；记忆页不再嵌套该折叠（`personal/settings.test.ts` "every capability switch and permission control belongs to exactly one settings page"） |
| 「添加目录」「保存目录授权」位置与状态不一致 | 已做：`SettingPaths` + `SettingSaveBar` 统一路径、权限、按钮和未保存状态 |
| 按功能拆分设置页 | 已做：新增「命令与终端」（自主执行、Herdr 目标、命令与终端能力），目录授权归文件与网页，电脑控制归设备，项目与数据位置归高级 |
| 删泛泛提示、留权限/失败/未保存提示 | 已做：删 4 条 intro 文案和重复的「配置位置」；保留目录授权、自主执行、Telegram 不继承授权等全部权限与确认文案 |

### 上下文、关于、配置位置、全部对话

| 验收项 | 结果 |
| --- | --- |
| 旧折叠、旧卡片与标签页 | 已做：上下文页删 `context-technical` 折叠，关于页版本改设置区块（`context.test.ts` 已更新，见第 5 节） |
| 配置位置显示为字段 | 已做：高级页「数据与配置位置」改 `dl` 字段；上下文预算 9 项改字段 |
| 对话列表区分当前对话与草稿 | 已做：当前对话实心标签 + 左强调边，草稿用警示色「未发送草稿」标签。没加测试（列表布局与文案属于不写测试的范围） |
| 窄窗能看全长标题 | 已做：≤580px 标题与摘要换行显示，不再 ellipsis 截断；记录详情里也给出完整标题 |

### 等待、失败和刷新

| 验收项 | 结果 |
| --- | --- |
| 配方/经验方法失败提示跑到屏幕外 | 已做：`skills-panel.tsx` 原来成功失败都写进页尾 `notice`，现在按作用域就地反馈；`dreaming-panel.tsx` 失败显示在触发的方法旁 |
| 切换条目时迟到响应覆盖更新的记忆条目 | 已做：`formal-memories.test.ts` "a late memory write never overwrites the entry the user switched to" |
| 外部刷新清空未保存草稿 | 已做：干净保存不再重挂载整页（`personal/settings.test.ts` "a settings save that applied keeps the page mounted and the user on the same category"） |
| 提交锁定 | 已做：排期表单整体 `fieldset` 锁定（`automation-schedule.test.ts` "locks every schedule field while a submission is in flight"） |
| 查询空状态 | 已做：Herdr 会话/终端空状态（`herdr-target-setting.test.ts`）。对话搜索、记忆库、执行记录原有空状态已核对，未改 |
| 键盘焦点 | 已做：推进页面时焦点落到页标题（`tabIndex=-1`），设置切换分类同样落到新标题 |

### 四个补复查项

| 项 | 复现路径 | 结果 |
| --- | --- | --- |
| 排期提交时是否所有字段都锁 | `automation-panel.tsx` 原 93–96 行日期/星期/时间/UTC 偏移无 `disabled` | 已修：整个 `fieldset` 一份锁 |
| Herdr 空会话/空终端是否有空状态 | `herdr-target-setting.tsx` 原 27 行仅在 `sessions.length` 为真时渲染，查找后为空时整块不渲染 | 已修：两条空状态文案 |
| 保存项目或设备设置后的刷新是否跳分类/丢草稿 | `App.tsx` 原 97 行对任何 `identity-changed` 都递增 `identityGeneration`；`desktop-runtime.ts:285` 保存后带 `reason: "modules"`；`settingsRouteForInitial("modules")` → `advanced` | 已修：确认会跳（设备页关开关跳到高级）且各页本地草稿随重挂载丢失；现在只有真正的对话/工作区切换或带 `configurationError` 的失败才重挂载 |
| 备份信息读取失败是否静默/挡住返回原工作区 | `backup-panel.tsx` 原 7 行 `.catch(() => {})` | 已修：确认失败时既无提示也不显示「返回原工作区」；现在给出失败文案和「重新读取」 |

## 3. 前后数字

| 指标 | 数字 |
| --- | --- |
| 产品代码（含 CSS、smoke 脚本） | +557 / −365 行，34 个文件 |
| 测试代码 | +108 / −28 行（低于产品代码行数） |
| 新文件 | 6 个产品文件、1 个测试文件；无新增快照 |
| 删除的样式类 | `.inspector-header*`、`.settings-push-header`、`.settings-back`、`.task-back`、`.task-thread-*`、`.memory-back*`、`.memory-library-toolbar*`、`.task-arrangements*`、`.context-technical` |
| 能力开关归属 | 10 项能力分布在 6 个设置页，每项恰好一页（有测试保证） |

## 4. 实际命令和退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm --filter @serika/desktop typecheck` | 0 | 通过 |
| `pnpm typecheck`（全仓） | 0 | 通过 |
| `pnpm --filter @serika/desktop test` | 1 | 659 通过 / 11 失败，全部为基线环境失败（macOS Seatbelt、常驻 socket、Herdr/tmux、TG 授权、提醒金样本 #382），与 `origin/main` 同一组 |
| `pnpm test`（全仓） | 1 | 运行时包 1222 通过 / 8 失败；在 `origin/main` 的干净 worktree 上跑同一命令得到同样的 8 项（其中记忆保存失败类用例重跑即通过，属偶发） |
| `xvfb-run -a pnpm --filter @serika/desktop smoke` | 0 | 真实 Electron（假模型）：`electron-smoke` 8 项全通过，`task-surface-smoke` 6 项全通过，`sourceWorktreeDirty=false`，`realModelCalls=0`，`costUsd=0` |
| 浏览器预览（模拟 IPC） | — | 7 个设置页在 1440px 下标题正确、无横向溢出、无 console/page error |

真实 Electron 通过项（Linux / Xvfb / 打包后主进程 + 原 preload/IPC，源码提交 `f0ba921`）：`startup`、`chat-reply`、`remember-success-receipt`、`remember-on-memory-page`、`restart-persistence`、`undo-disappears`、`daily-path-refuses-writes`、`daily-config-retired-fields`、`confirm-card`、`saved-not-started`、`delivery-pending-human`、`human-accepted`、`reminder-result`、`reopen`。

模拟预览通过项（Chromium + 预览 mock IPC，不算验收）：连接应用、文件与网页、电脑控制、命令与终端、记忆设置、高级、关于七页渲染与窄窗排版目测。

未覆盖：未在 macOS 下验证（本机为 Linux）；未在常驻进程形态下验证；未做 32K 窗口档位的模型验证（本轮无模型调用）；未跑像素对比与快照（本轮未新增快照，但 CSS 有改动，合并前如需像素基线请在 macOS 上重跑 `ui-snapshots`）。

## 5. 与计划不符的地方与改过的断言

改过的测试断言（逐条）：

| 测试 | 旧断言 | 为什么旧行为是错的 |
| --- | --- | --- |
| `personal/tasks.test.ts` "opens a task…" | `<summary>验收与核对</summary>` 后才有保留验收；`task-thread-meta task-review`；三处 `<summary>编号</summary><code>…</code>` | 验收控件藏在折叠里与「打开任务直接显示当前要做的事」冲突；编号是工程 ID，不该出现在日常详情 |
| `ui-navigation-copy.test.ts` "schedule management…" | 断言定时安排是提醒页内的折叠 | 折叠内再套卡片正是要修的框套框 |
| `ui-navigation-copy.test.ts` "UI regression 1" | `App.tsx` 中出现 `openSettings("advanced")` | 该调用点已改为 `openDetails("arrangements")`；高级页仍可从设置行表进入，断言改为核对设置行表与路由分支 |
| `reminder-copy.test.ts` "reminder home shows…" | `<details><summary>编号</summary><code>task-water</code>` | 同上：提醒行不该显示任务 ID；该 ID 仍可在「定时安排与订阅」的编号折叠里查到 |
| `context.test.ts` "keeps advanced context details closed…" | `<details class="context-technical"><summary>高级：预算与压缩详情` | 预算被藏在「高级」折叠里且是无标签文本，与「把预算显示成字段」冲突 |
| `personal/settings.test.ts` 两处 | `<h1>设置</h1>` 等 | 页标题加了 `tabIndex=-1` 以便接收焦点，只是属性变化 |
| `scripts/task-surface-smoke.mjs` | 点击 `验收与核对` 展开、展开 `details.task-advanced` | 这两层折叠已删除，控件直接可见。基线 `origin/main` 上该 smoke 本来是通过的（已在干净 worktree 验证），改动只是去掉不存在的点击，断言未放宽 |

其他说明：

- 未删除任何测试文件；未改历史分数或快照。
- `desktopLayout()` 仍只返回 `"serika"`，`"classic"` 分支仍是死代码；本轮未动（不属当前范围，已记为遗留）。
- 四种确认框样式（`.memory-setup-preview`、`.capability-confirm`、`.work-task-confirm`、`.task-bubble[role=group]`）尚未统一；Herdr 目标已从确认框样式换成设置区块，其余留待后续。
- 改到权限与自主执行相关文件前查过 `docs/legacy/agents-constraints-2026-10-20.md`：「Trusted desktop foreground autonomy」三条（授权绑定工作区、仅空闲可改、Telegram 与后台不继承、128 步/30 分钟/10 分钟预算）。本轮只移动位置与容器样式，授权语义、确认文案、空闲门槛均未改。
- 证据文件按仓库 §7.1 未提交；smoke 结果以本报告中的数字为准（`result.json` 的 `sourceCommit=f0ba921`、`scriptSha256=dc93b146…`、`status=passed`）。
