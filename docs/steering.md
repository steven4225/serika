# 执行中补充要求（Steer）

## 用户结果

- Before：任务开始后只能停止，或等它结束再改要求；正在等待的旧工具预览仍可能被误确认。
- After：桌面前台任务进行中可输入补充要求，在同一个 Run 的安全边界继续；旧的未执行工具及其确认失效，新的工具仍要重新确认。
- Demo（五分钟）：在隔离工作区建立 `notes/plan.md`，写入「原文不能丢」。让助手删掉原文；在 edit_file 确认出现时，不批准，输入「保留原文，只追加两条行动，修改后读回」并点「补充要求」。旧确认失效；核对并允许新的修改与读回。执行记录应只有一个 primary Run，旧调用为 not_started，正文保留。STOP 仍可取消。

## 边界与状态

只有当前前台 primary Run 接收。启动中尚无 Run ID、整理/经验反思/Skill Run、已结束或取消中的 Run 不接收。WorkTask 原任务与验收合同不被补充要求改写，人工质量条件不能被模型自己通过。

- accepted：host 已保存这条要求，尚未加入执行上下文。
- applied：已加入下一轮执行上下文；不代表模型服务已收到、遵循或完成，也不证明后续上下文准备成功。
- not_applied：结束、取消、超时或重启前未应用。文本可以显式取回；不自动重发、不自动开启新 Run。

每个 Run 最多 8 条，每条最多 4 KiB UTF-8；不增加原步数和时间预算。同一 `id`、相同正文幂等，不同正文冲突。提交携带 `expectedRunId`，迟到请求不会写入新的 Run。IPC/存储结果不确定时先查当前状态，不换 ID 自动重试。

模型生成不强行打断：结果返回后，不派发旧的工具批次。未执行的调用以 `STEER_SUPERSEDED` 保留完整调用/结果配对，回执是 not_started，不冒充失败或未知副作用。已经实际开始的工具先结算；Steer 不取消它，不回滚其效果，不自动重做 unknown 工具。

应用新要求后，正常上下文准备重新检索记忆并计入压缩预算。补充消息以 user 保存，但固定标记 `source: steer`、`memoryConsolidation: exclude`，不会被当作长期偏好自动沉淀。旧授权不复用，TUI、worker 和 Durable 执行本次不增加 Steer。

## 接入

```ts
await controller.steer({ expectedRunId, id, text });
// 快照 canSteer / steers，事件 { type: "steer", steer }
// run() 和 run-result 仍使用原来的 primary / consolidation 契约。
```

执行回执保存状态；进程重启把遗留 accepted 标成 not_applied/interrupted，不重放。Core 的进程内 mailbox 不宣称持久队列或 exactly-once。

## 验证

默认测试用脚本模型与真实文件工具，覆盖旧确认失效、同 Run 新修改与读回、记忆重新选择、重启不重放、取消、预算、结束/派发竞争、重复 ID 和持久化失败。脚本模型不是联网验收，运行时重建也不等于 Electron 真机或 OS 进程重启。

联网验收显式开启，默认测试不会产生这笔模型请求，不允许 mock fallback：

```sh
pnpm build
RUNLOOM_STEERING_ACCEPTANCE=1 node --env-file=.env --test \
  examples/cli/dist/steering-real-acceptance.test.js
```

此入口还检查逐字追加正文，包括空行。模型额外插入或遗漏空行也会失败，不能将「旧操作已拦住」与「精确正文通过」混成一个通过结论。

2026-10-08 真机核对：隔离 Electron 使用 command-code 的 DeepSeek v4.1 Flash，等待 edit_file 确认时从输入框提交 Steer；旧全文替换记为 not_started，新 read_file → edit_file → read_file 均完成且同属 Run `0837fbc0-a5e0-400b-9a67-3518e65c1be0`。独立磁盘核对确认原文保留、只追加两条指定行动，编辑与读回的哈希、字节数对得上。正常退出后重新启动成不同 PID，补充记录仍显示「已加入后续规划」，没有增加 Run 或工具回执。首次仅阅读、模型要求进一步澄清是上一独立 Run，不算 Steer 自动新开 Run。本次未重启日用应用。

附加的逐字排版联网脚本第一次通过，之后两次因空行差异失败；没有隐藏失败、宽松匹配或自动重试。上述真机交互通过不等于逐字排版稳定通过。
