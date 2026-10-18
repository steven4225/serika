# 状态事件结构化（第 3 步收尾：桌面端不再解析状态文本）

## 盘点（`5af1121`）

| 状态 | 现在怎么到桌面端 | 桌面端是否解析文本 | 处理 |
| --- | --- | --- | --- |
| Shell 进度 | 已是结构化事件 `shell-progress`（Controller → `runtime-bridge.ts`） | 否 | 不用改 |
| Controller 状态行（`assistant-controller.ts` 里 13 处 `recordOutput`：补齐任务证据、任务停止原因、记忆已保存、`[automation]`、`[经验学习]`、`/skills`、`/hooks`、`[compact]`、`[resume]` 等） | `output` 文本 | 否：只原样显示在「系统输出 · 仅供诊断」面板 | 本轮不改：没有消费方，结构化只会多一层代码 |
| Home「本地任务」条目 | Home 快照里的条目文本 | **是**：`reminder-copy.ts` 的 `presentHomeTaskItem` 用正则拆 `status · id · 提示 · runAt 时间 · 详情` | 改：快照条目带结构化字段 |
| 模块通知 | 输出流里的 `[module:id] message` 行 | **是**：主进程 `parseModuleNotification` 用正则拆出来发系统通知 | 改：结构化事件 |

桌面端其余 `startsWith` 是读工具结果里的错误码（`TOOL_DENIED` 等，属于回执/transcript 格式，在底线内），不动。

## 1. Home 任务条目

- `HomeItem` 增加 `task?: HomeTask`（`status`、`id`、`prompt`、`runAt`、`detail`，值与文本里打印的一致）和 `taskList?: "inbox" | "pending"`（任务列表的标题和读取失败提示）。CLI 文本由同一组字段拼出，与第 1 步 `home.txt` 逐字一致。
- 桌面端 `presentHomeTaskItem(item)` 直接读字段，正则删除。
- 金样例：改动前用旧解析器对所有 Home 分支记录 `apps/desktop/src/renderer/src/__baseline__/home-task-rows.json`，另记录 5 条其他状态/读取失败的行；新路径逐项一致。
- 差异只在病态输入：提示词本身含「 · runAt 」或「最近创建的 scheduled/running」时，旧正则会切错或误替换，现在按字段显示。
