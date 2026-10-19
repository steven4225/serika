# v2 试点：待实现清单（报告，不进测试套件）

这份清单不是测试，不计入通过数。它记录第 1 步盘点时发现、但按本轮规则不能在第 1 步做的事，以及后面几步开始前需要确认的地方。

## A. 第 1 步留下的覆盖缺口（要么改产品代码才能补，要么不在本轮范围）

1. 以下落盘 hash 没有单独的黄金样例：都是模块内部函数，不导出就无法单独调用，而第 1 步不改产品代码。
   - `memory-store.ts`：批次回执 `payloadHash`（第 1263 行）、导入回执 `requestHash`（第 1580 行）、导入快照 `importSnapshot`（第 977 行）。
   - `dreaming.ts`：批次指纹 `hash`。
   - `assistant-controller.ts`：dreaming Thread ID（第 248 行）。
   - 桌面端：`conversation-draft-store.ts` 的 `scopeKey`、`telegram-store.ts` 的归档文件名、`backup.ts` 的条目 hash。
   - 做法建议：以后真要改动这些文件时，先导出函数（或者走一遍完整的存储读写），再补样例。
2. `transcript-codec.ts` 的分块/前缀完整性 hash 没有字面值样例，只有读写往返测试。
3. 装配快照不包括 computer 模块：它只能在 macOS 上装配，这台机器上的快照对不上 macOS。
4. 装配快照只覆盖默认入口（不是桌面/Telegram 前台自主执行）。自主执行时的指令（`AUTONOMOUS_INSTRUCTIONS`）和能力报告里的 Shell 授权说明不在快照里；D2 会涉及这里，建议 D2 提交时为自主执行情形补一份快照。

## B. 第 2 步（Todoist 试点）开始前需要确认：验收条件和现状对不上

验收要求「去掉 Todoist 后，工具表、指令、能力报告里都没有它，并与第 1 步的快照对得上」。第 1 步快照（`__baseline__/assembly-full-without-todoist.txt`）显示，现在不启用 Todoist 时：

- 工具表里没有 Todoist ✔。
- 指令里还有一句（来自任务模块，不是 Todoist 模块）：「A daily or weekly Todoist briefing still uses todoist-brief and asks when the source is missing; never invent a Todoist source.」
- `/capabilities` 和 `capability_status` 固定列出所有内置模块，包括 `todoist：未启用`。
- `/modules` 里有 `todoist: disabled`、`Todoist 规划时区: 未启用`、`Todoist token: missing/present`。

所以「都没有它」和「与快照对得上」「用户可见文案不变」不能同时成立。需要选一种：

- (a) 验收改为「与快照逐字一致」：Todoist 模块没装配时，上面这些现有文字照旧保留（由宿主或任务模块产出），只要求工具和 Todoist 模块自己的指令不出现。不改用户可见行为。（建议）
- (b) 真的全部去掉：属于用户可见文案变化，要逐条列出，并更新快照。

## C. 第 3 步（Home 结构化）注意事项

- CLI 写出的 Home 前面有一个空行、后面有换行（`__baseline__/home-app.txt`），结构化以后渲染出来的必须逐字一致，包括空行。
- 桌面端现在的解析器按「项目进度：」「Git：」「本地任务：」等前缀拆分；改成结构化消息后，桌面端的展示要用现有桌面端测试证明没变。

## D. 环境

- 仓库声明 `packageManager: pnpm@11.9.0`，这台机器用的是 pnpm 10.34.5；`pnpm install --frozen-lockfile` 和全部测试都正常。
- 快照把进程时区固定为 UTC，并把临时目录替换为 `<ROOT>`、时间戳替换为 `<NOW>`，这样在 macOS 上也能对上。没有在 macOS 上实际跑过（只有这台 Linux 机器），第一次在你的机器上跑如果有差异，需要先看是不是平台差异。

## E. 工具失败行：运行中和历史不一致

**表态：已知缺陷，不是有意设计。** 第 3 步不修（修了会改用户可见文案，需要你先定），金样例 `apps/desktop/src/renderer/src/tool-preview-golden.test.ts` 按现状断言，用例里的 `divergence` 都标 `stance: "defect"` 并指向这一节。

- 现象：宿主让一次工具调用失败时（被拒绝 `TOOL_DENIED`、输入无效 `TOOL_INVALID_INPUT`、结果未知 `TOOL_OUTCOME_UNKNOWN` 等），同一次调用：
  - 运行中（事件 `tool.call.failed`）：`detail` 只有消息，带 `errorCode`；
  - 重新读历史后（`output-error`）：`detail` 是 `CODE: message`，没有 `errorCode`。
- 金样例覆盖了 4 个：edit_file 被拒绝、edit_file 缺 newText、write_file content 不是字符串、write_file 带 edit_file 字段。`STEER_SUPERSEDED` 两边一样，不受影响。
- 根因：渲染层其他地方的惯例都是 `detail` = `CODE: message` 且带 `errorCode`（toolOutcome、rowsFromToolActivity、回执；历史的 `errorText` 来自 `packages/ai-sdk-adapter/src/tool-errors.ts` 的 `${code}: ${message}`）。只有两处偏离：
  - `conversation.ts` `applyEvent` 的 `tool.call.failed`：`detail` 只取 `error.message`；
  - `conversation.ts` `committedToolStatus`（历史 `output-error`）：不设 `errorCode`。
- 用户能看到的差别：经典布局的失败提示走 `failure-copy.ts` `presentFailure`。消息是中文且带前缀码时，摘要相同，历史那边多一个可展开的「详情」；消息是英文时，两边整句不同。
- 建议修法：两边统一成 `detail` = `CODE: message` 并带 `errorCode`——历史从 `errorText` 解析前缀码填 `errorCode`，事件那边 `detail` 加上码前缀。不动 adapter 和回执格式。
- 需要你定：统一后的文案（运行中的失败提示会多出「详情」或换成历史那边的样子），定了以后单独一个提交修，同时把金样例里的 `divergence` 删掉。
