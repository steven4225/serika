# v2 试点：待实现清单（报告，不进测试套件）

这份清单不是测试，不计入通过数。它记录第 1 步盘点时发现、但按本轮规则不能在第 1 步做的事，以及后面几步开始前需要确认的地方。

## A. 第 1 步留下的覆盖缺口（要么改产品代码才能补，要么不在本轮范围）

1. 以下落盘 hash 没有单独的黄金样例：都是模块内部函数，不导出就无法单独调用，而第 1 步不改产品代码。
   - `memory-store.ts`：批次回执 `payloadHash`（第 1263 行）、导入回执 `requestHash`（第 1580 行）、导入快照 `importSnapshot`（第 977 行）。
   - `dreaming.ts`：批次指纹 `hash`。
   - `assistant-controller.ts`：dreaming Thread ID（第 248 行）。
   - 桌面端：`conversation-draft-store.ts` 的 `scopeKey`、`telegram-store.ts` 的归档文件名、`backup.ts` 的条目 hash。
   - 做法建议：以后真要改动这些文件时，先导出函数（或者走一遍完整的存储读写），再补样例。
   - 第 3 步之后：`memory-store.ts` 三项和 `dreaming.ts` 批次指纹已补进 `__baseline__/hashes.json`，走公开接口和落盘文件取值，产品代码没改。
   - 第 3 步之后：dreaming Thread ID 已补：`assistant-controller.ts` 里的内联表达式原样提成导出的 `dreamingThreadIdFor`，Controller 改为调用它。
   - 第 3 步之后：桌面端三项（草稿作用域键、Telegram 归档文件名、备份条目 hash）已补进 `apps/desktop/src/main/__baseline__/desktop-hashes.json`，走公开接口和落盘文件取值，产品代码没改。A.1 至此全部有样例。
2. `transcript-codec.ts` 的分块/前缀完整性 hash 没有字面值样例，只有读写往返测试。
   - 第 3 步之后：已补（`encodeTranscriptUpdate` 本来就从 core 导出），见 `hashes.json` 的 `core transcript committed baseHash/payloadHash`。
3. 装配快照不包括 computer 模块：它只能在 macOS 上装配，这台机器上的快照对不上 macOS。
4. 装配快照只覆盖默认入口（不是桌面/Telegram 前台自主执行）。自主执行时的指令（`AUTONOMOUS_INSTRUCTIONS`）和能力报告里的 Shell 授权说明不在快照里；D2 会涉及这里，建议 D2 提交时为自主执行情形补一份快照。
   - 第 3 步之后：已补桌面前台自主执行的一份：`__baseline__/assembly-full-desktop-autonomous.txt`（全模块；配置写 `desktopAutonomy`、`allowDesktopAutonomy`，Run 包在 `beginForegroundExecution("desktop")` / `endForegroundExecution()` 里，和桌面端、Controller 的做法相同）。和 `assembly-full.txt` 相比只差 4 处：指令多一段自主执行说明（`AUTONOMOUS_INSTRUCTIONS`）、`capability_status` 指令行措辞、`/capabilities` 和 `capability_status` 的 Shell 授权说明。Telegram 前台自主执行还没有快照（要绑定 Telegram 私聊和授权回调，另做）。

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

## E. 桌面端 store 测试的已知限制

- `runtime-store.test.ts` 的 `recordErrors` 记录的是错误横幅（store 的 `error` 字段）每次「变成」的消息，不是每次「写入」：连续两次写入同一条错误只记一次。`error` 进 store（`ab23fc7`）之前，测试是直接收集 `onError` 的每次调用，能数出重复。目前没有用例依赖连续相同的错误；以后需要数重复的用例，要在每一步之后直接检查 `getState().error`，或者另行给 store 加写入计数（会改 store 接口，先确认）。

## F. 上下文/记忆第 2 步测量留下的事项（2026-10-21）

- 当前 Command Code `deepseek/deepseek-v4.1-flash-fast` 路由没有查到明确缓存 TTL；不要拿直连 DeepSeek 的“数小时至数天”代替路由保证。第 3 步以真实 cacheRead/input 验收；补查 TTL 需要服务方证据，本轮未发计费探测。
- 旧摘要最大 33,493 估算 tokens；沿用旧边界时 32K 档 176/211 次超过有效输入 26,624。按计划第 5/6 步完成摘要精简与按比例块屏蔽后重放，不能把本次 94.79% 理论前缀比例当作小窗口通过。

## G. 上下文/记忆第 3 步切换日用前

- 日用配置若含已退役的 `modules.memory.queryRewrite`、`semantic`（含 relevance）、`contextView` 或 `contextCompaction.mode/warningRatio` 字段，实验版本的严格配置校验会启动报错。切换日用前须在配置副本中处理这些字段并验证启动；本步不修改日用配置，不加旧字段兼容开关。

## H. 上下文/记忆第 4 步留下的边界

- 单条原文超过抽取阈值时，第 4 步已持久化待重抽并跳过，后续消息继续整理；旧来源重抽不能覆盖更晚值，已知先后不算冲突。消息内分块和屏蔽补抽仍在第 6 步，两档窗口需继续验证。
- 第 4–6 步限定新建 v6 隔离数据；日用路径拒绝写入，v5 文件只读且提示第 7 步迁移。第 7 步前需交 14 行逐条对照表、v5 备份方案及日用副本验证；迁移后冻结 v6。
- 第 4 步真实抽取及第 9 条重放，与第 5–6 步真实模型验收合成一批，在第 6 步完成、第 7 步开工前运行；已批准批次预算 $2，取代旧第 4 步独立 18 次／$0.15 排期；此前暂停，假模型接线结果不能当成模型质量分数。

- 聊天顶部“等待记忆整理（N 条…）”在撤销记忆后仍常驻；第 6 步评估是否改为只在记忆页显示。本轮只记录，不改界面。
- 第 4 步代码审核及独立复现关口已满足：用户提供 bot1 `1ebaffa`，Linux＋Xvfb＋真实 Electron 44.4.5＋假模型，8/8，截图已逐张核对；绑定 smoke SHA-256 `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f`。第 5 步脚本 hash 未变，沿用该独立证据。本步实现及验证见 `cm-step5.md`，结束后停下等审核，获准才进第 6 步；第 7 步开工前交 14 行对照表并停下。

## I. 上下文/记忆第 5 步留下的边界

- 第 6 步已修复：`firstKeptMessageId=null` 的 tip 边界在追加消息后仍按原覆盖前缀 hash 复用。`a null tip boundary remains valid after append while a changed covered prefix fails closed` 覆盖合法追加和原前缀篡改；`cm-replay.mjs` 同步使用该规则。

## J. 第 6 步审核裁决（56ad8d7 后）

- 第 6 步代码／离线接受，真实模型关口仍未通过；不开第 7 步、不做日用迁移。14 条记忆的已批准处置及 thread 写入清单见 cm-step6.md 附表 B/C，仅记录。
- 第 7 步验收固定：迁移后 memory-v6-store.ts 不引用 memory-store.ts，删除旧候选审核／双时态空接口并改完调用方；memory／文档库范围最终仅 workspace，来源与执行 Thread ID 保留。
- 非阻塞：将 context-assembler／memory-observation-policy 的 Asia/Shanghai 合为常量，并明确固定 +08:00 是产品行为变更；清掉 Controller 待整理积压读取原始 store 的旧回退。
- 记忆页待整理段数尚无截图，本轮删去已验证声明；连续同错去重任务（旧记忆14）若继续做，应单独排期。

- 上一批（56fe5cf审核）真实模型已跑，仍未通过：M1 8/18，CF03 2/3、CF05既定检查2/5（3处pastRead正则漏判，原分保留），CE03 0/3、CE05 0/5。后续只在审核后的同一第6步关口处理正文逐字输出、摘要schema／比例预算与检查漏判；不扩第7步。本轮费用及旧未知预留共$0.70550774／$2。

- 第7步迁移：先为获准迁移条目补齐来源身份，再删除删除抑制中“没有身份时退回正文哈希”分支；当前第6步不执行。

- 56fe5cf复核修复后唯一整批（7c5b4116）：M1 11/18、CF03 0/3、CF05 2/5、CE03 0/3、CE05 0/5，四冷进程均执行，整批未过。145次全部HTTP200且用量完整；本轮$0.59343940，合批含旧预留累计$1.29894714。按用户要求已停，不补跑、不做第7步或日用迁移；后续范围须等审核。
