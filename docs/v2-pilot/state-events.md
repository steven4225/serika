# 状态事件结构化（第 3 步收尾：桌面端不再解析状态文本）

## 盘点（`5af1121`）

| 状态 | 现在怎么到桌面端 | 桌面端是否解析文本 | 处理 |
| --- | --- | --- | --- |
| Shell 进度 | 已是结构化事件 `shell-progress`（Controller → `runtime-bridge.ts`） | 否 | 不用改 |
| Controller 状态行（`assistant-controller.ts` 里 13 处 `recordOutput`：补齐任务证据、任务停止原因、记忆已保存、`[automation]`、`[经验学习]`、`/skills`、`/hooks`、`[compact]`、`[resume]` 等） | `output` 文本 | 否：只原样显示在「系统输出 · 仅供诊断」面板 | 本轮不改：没有消费方，结构化只会多一层代码 |
| Home「本地任务」条目 | Home 快照里的条目文本 | **是**：`reminder-copy.ts` 的 `presentHomeTaskItem` 用正则拆 `status · id · 提示 · runAt 时间 · 详情` | 改：快照条目带结构化字段 |
| 模块通知 | 输出流里的 `[module:id] message` 行 | **是**：主进程 `parseModuleNotification` 用正则拆出来发系统通知 | 改：结构化事件 |
| 提醒确认卡（后补，`21c3789`） | 待确认审批的 `preview` 文本（任务模块 `formatReminderConfirmation` 生成） | **是**：`reminder-copy.ts` 的 `presentReminderConfirmation` 按行拆「时间：」「重复：」「内容：」「原时间：」，按工具名选标题 | 改：审批带结构化字段 |

桌面端其余 `startsWith` 是读工具结果里的错误码（`TOOL_DENIED` 等，属于回执/transcript 格式，在底线内），不动。

## 1. Home 任务条目

- `HomeItem` 增加 `task?: HomeTask`（`status`、`id`、`prompt`、`runAt`、`detail`，值与文本里打印的一致）和 `taskList?: "inbox" | "pending"`（任务列表的标题和读取失败提示）。CLI 文本由同一组字段拼出，与第 1 步 `home.txt` 逐字一致。
- 桌面端 `presentHomeTaskItem(item)` 直接读字段，正则删除。
- 金样例：改动前用旧解析器对所有 Home 分支记录 `apps/desktop/src/renderer/src/__baseline__/home-task-rows.json`，另记录 5 条其他状态/读取失败的行；新路径逐项一致。
- 差异只在病态输入：提示词本身含「 · runAt 」或「最近创建的 scheduled/running」时，旧正则会切错或误替换，现在按字段显示。

## 2. 模块通知

- `createRuntimeApp` 新增 `onModuleNotification({ moduleId, message })`，在写出 `[module:id] message` 文本之后调用；CLI 文本不变。
- 桌面端 `TeeOutput.moduleNotification` 发出 `{ type: "module-notification", moduleId, message }`；主进程据此发系统通知（正文为 `message.trim()`，与旧正则取出的一致），渲染进程忽略（文本仍在诊断输出里）。`parseModuleNotification` 删除。
- 顺带删除没有调用方的 `pomodoroReplies`（按行解析 `[module:pomodoro]`，只有测试在用）。番茄钟面板仍只把输出变化当作刷新信号，不解析文本。
- 差异：助手连接完成前（Controller 尚未 attach）发出的通知，原来要等 attach 后随输出补发，现在立即发出。实际只可能出现在装配期间。

## 3. 提醒确认卡

- 任务模块的 `confirmation()` 可以返回 `{ text, reminder }`（`ToolConfirmationCard`）。`reminder: ReminderConfirmationFields` 是 `action`（save / reschedule / cancel / pause / resume）、`time`、`repeat`、`subject`、`previous?`（含「（预览，不锁定这条提醒）」）、`footnote?`。文本由同一组字段拼出（`reminderConfirmation`），与原来逐字一致。
- `PendingToolApproval.reminder` 跟 `preview` 一样只在内存里，不落盘；Telegram 的 `approvalHash`、权限快照、回执、CLI 显示文本都不变。
- 桌面端 `presentReminderConfirmation(approval)` 直接读 `approval.reminder`，标题/按钮/安全提示按 `action` 查表；文本解析（`labeledLine`、按工具名选文案）删除。没有 `reminder` 字段的审批显示通用确认卡。
- 金样例：改动前用旧解析器记录 24 个用例 `apps/desktop/src/renderer/src/__baseline__/reminder-cards.json`（卡片字段 + `ApprovalCard` 渲染的 HTML）；新路径逐项一致。
- 差异只在病态输入：
  - 时间值带首尾空白时，旧解析器会 trim，空白时间会退回通用卡；现在按字段原样显示（模块生成的时间不带空白）。
  - 补充说明里如果有一行和字段行完全相同（例如另起一行「时间：…」），旧解析器会把它过滤掉；现在照常显示。
  - 不是任务模块发出、但文本以「提醒确认」开头的审批，旧代码会显示提醒卡（标题「提醒」）；现在显示通用确认卡。
- `apps/desktop/src/shared/human-title.ts` 的 `reminderConfirmationView` 也是这张卡的文本解析器，产品代码没有调用，只有 `human-title.test.ts` 在用；用户确认后已删除（「审批里保留业务编号」的测试改到 `reminder-copy.test.ts`，对真正显示的卡片做断言）。

## 结果

桌面端不再从状态文本里解析数据。剩下的文本只进「系统输出 · 仅供诊断」面板。
