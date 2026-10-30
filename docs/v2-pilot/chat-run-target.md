# 聊天发现 CLI 与当前 Run Pi 目标

## 1. 改了什么

普通 CLI 继续使用现有 Shell，按安装、版本、帮助、参数、执行、产物核查推进。Pi 使用已运行的 Herdr 目标，聊天选择只保存在当前 Run。

数据流：`beginForegroundExecution(request)` 创建 `ForegroundHerdrTargets` 的 Run 状态 → `herdr_pi_discover` 只读列举并核对目录、session、pane、terminal、Pi 与状态 → 精确原话匹配或唯一健康候选自动采用，多候选等待宿主选择 → `beforeToolExecute` 按 toolCallId 冻结身份、操作正文、选择版本与输入 hash → 原异步审批 preview 展示同一快照 → 原确认通过后，执行器只取冻结快照并再次核对身份 → 原 AgentLoop 回读本次输出、独立核查文件 → `endForegroundExecution` 清空目标和未完成快照。

职责拆为三部分：`herdr.ts` 保留外部 CLI 边界及安全失败分流；`foreground-herdr.ts` 持有 Run 状态、选择与调用快照；Controller、桌面 IPC 和 Telegram 传送选择。`terminal-module.ts` 已删除创建模块时捕获固定 target 的执行路径。设置页的配置 CAS、`bind()`、runtime `#replace()` 均未进入聊天工具。

桌面提供独立选择卡。Telegram 使用 `选择 <短码> <序号>` 或 `取消选择 <短码>`，短码沿用现有五分钟期限，绑定 owner、Thread、Run、selectionId、toolCallId 和完整候选身份；`/confirm` 刷新并撤销旧码。选择后原 Run 继续，控制操作另行批准。配置目标只是线索；旧配置失效时，即使只剩一个其他健康候选，也要用户选择。

检查过旧约束的 Tool side-effect invariants、Thin TUI confirmation、Shell sandbox、foreground Steer、Trusted desktop foreground autonomy 及 compact execution display。原 Shell、Seatbelt、Docker、逐次控制确认和 unknown 停止规则保留。未新增后端、持久配置或行为循环。

## 2. 逐条对照验收项

| # | 结果与证据 |
| --- | --- |
| 1 普通 CLI 一句话完成并核查 | 已做离线脚本模型测试 `one ordinary CLI request discovers Node...`：真实 Node 查版本与帮助，读输入、写 `product:56`，另一条命令独立 assert，再读文件。四次既有确认保留。真实模型未做。 |
| 2 无设置发现明确 Pi，只发送一次并核查 | 已做 `unbound multi-target choice...`、精确 selector 测试，以及 Electron `choose-continue-approve-readback-independent-file-check`。离线 Herdr executable 实际派发一次，独立文件读取仍须批准。真实 Pi 与真实模型未做。 |
| 3 多候选选择后原 Run 继续 | 已做同 Run 领域测试、Telegram gateway 测试、真实 Electron 选择卡及 reload 恢复。Telegram 使用离线 API fixture，未发真实 Telegram。 |
| 4 等审批期间目标被替换 | 已做 `a replacement while approval waits...` 和 Electron `new-run-reselects-old-choice-invalid-replacement-blocks-old-approval`，旧批准返回 `HERDR_TARGET_CHANGED`，派发计数不增加。 |
| 5 旧绑定、未派发与 unknown 分流 | 已做 stale binding、server_not_running、binary、CLI、JSON 与字段失败；`unknown dispatch stops...` 断言原 loop 失败、receipt 为 unknown，无回读、重发或自动新 Run。 |
| 6 Run 结束清空，新 Run 不继承 | 已做双 Run 测试及 Electron 第二轮重选；`historical Steer cannot become new-Run target evidence...` 阻止旧 Steer 恢复身份依据。 |
| 7 压缩后保留原任务、目标及有效发现 | 已做 production compaction 路径两档：32,768 与 1,000,000 tokens。32K 断言实际发生 masked pending background，选择与原任务仍在输入中，发现和 prompt 各一次。真实模型压缩续跑未做。 |
| 8 权限和确认未放宽 | 已做 `b0 locks full host decisions...`、baseline assembly、原 desktop 与 Telegram 控制测试；权限快照无修改，控制不可记住，选择不产生批准。 |

## 3. 前后数字

相对 `315f89a`，产品 19 个文件 `+605 / -85`，测试及验证 12 个文件 `+717 / -20`。测试总量超过产品新增量，是因为包含 164 行独立 Electron smoke、45 行可复跑全测 runner 和 15 行脚本模型接线；其余测试新增 493 行，小于产品新增量。没有删除测试文件，没有改权限快照或历史分数。

最终全测 1888 项：1881 通过、7 跳过、0 失败、0 取消。Pi feature smoke 2/2，标准 Electron smoke 8/8。两套 Electron 均为 44.4.5，源提交 `daef7db`，`sourceWorktreeDirty=false`。全部真实模型调用 0，费用 $0。

统计用 `git diff 315f89a daef7db --numstat` 复算。产品是除 `.test.ts`、smoke fixture、脚本和文档外的 TypeScript；测试包含 `.test.ts`、`smoke-model.ts`、两个本轮验证脚本。超过 400 行按上面的 Herdr、Run 状态、交互通道拆分，没有扩展为通用适配层。

旧测试调整仅有 fixture 和类型收窄：Herdr 控制、Telegram 固定目标及 b0 权限对照补离线 session/pane 元数据；`task-module.test.ts` 用 `"reminder" in cancelled` 收窄新增卡片联合类型，原提醒断言保留。未改变旧权限预期。

## 4. 实际命令和退出码

| 命令 | 退出码与证据 |
| --- | --- |
| `pnpm build:runtime`、`node --test packages/assistant/dist/foreground-herdr.test.js`、`pnpm typecheck` | 均为 0，Run 目标回归 9/9；完整复跑也包含这九项。 |
| `node scripts/chat-run-target-verify.mjs /private/tmp/serika-chat-target-final-evidence` | 0，内部 `pnpm typecheck`、`pnpm test` 均为 0；[运行记录](evidence/chat-run-target/offline/result.json)、[完整日志](evidence/chat-run-target/offline/full-test.log)。 |
| `pnpm --filter @serika/desktop build` | 0。原依赖有 Node 26 deprecation 与 Zod annotation 构建警告，未升级依赖；Electron 页面与控制台错误均为空。 |
| `SERIKA_B2_RECORD_CONCURRENT_HOME=1 node scripts/test-home.mjs --home /private/tmp/serika-chat-target-feature-guard-local -- node apps/desktop/scripts/chat-run-target-smoke.mjs --output /private/tmp/serika-chat-target-electron-local` | 0，[Pi Electron 记录及截图 hash](evidence/chat-run-target/electron/result.json)、[guard 日志](evidence/chat-run-target/feature.log)。配置 SHA 前后一致；Electron 已退出，隔离目录已移除。 |
| `SERIKA_TEST_HOME=/private/tmp/serika-chat-target-standard-guard-local SERIKA_B2_RECORD_CONCURRENT_HOME=1 pnpm --filter @serika/desktop smoke` | 0，[标准记录](evidence/electron-smoke/result.json)、[构建与 guard 日志](evidence/chat-run-target/standard.log)。包含重启 pid、Memory SHA、renderer UA 和截图 SHA。 |

两套 guard 均为 violations=0，均记录到日用进程的 6 次并发元数据变化。提交的 guard summary 去掉日用文件元数据明细，并保留原始结果 hash；没有改写原始通过状态。截图已人工检查选择卡和冻结正文的审批卡。

所有验证在 macOS 的隔离临时 HOME、独立数据目录内运行。Electron 使用构建产物与原 preload、IPC，模型为脚本模型，Herdr 为离线 executable fixture。未读取日用 Pi 输出、发送输入、改绑定、启动服务或部署。guard 的 `SERIKA_B2_RECORD_CONCURRENT_HOME=1` 允许记录日用进程的并发元数据变化；只在 violations 为 0 时通过，不据此宣称日用元数据未变。

## 5. 与计划不符的地方及理由

- 真实模型、真实 Pi、真实 Telegram 验收未运行。旧 30 次额度不沿用；必须另报本轮次数和预算，并等用户“继续”。离线和脚本模型结果只证明接线与边界。
- 新增独立 feature smoke，标准 `electron-smoke.mjs` 的 hash 保持 `dc93b146f85165710071944d59108a36898c7a60aac37605950aa2264dcbb994`，保留既有独立复现基线。
- 首次 feature smoke 因测试脚本漏处理独立 `read_file` 审批失败；修正脚本后通过，未调整产品权限。一次定向测试使用 30 秒全局超时，取消了正常约 79 秒的 b0 测试；改用 120 秒后通过。
- 主工作树首次 Electron 启动触发依赖包的自动下载，已中止该测试进程，未运行功能断言。随后复用辅助工作树已安装的同版本 44.4.5 本地文件，两套最终冒烟通过；未启动日用服务。
- 最后审查修复两处来源问题：同 Run 明确改目标必须撤销旧采用及审批；旧 Run Steer 不得成为当前目标证据。还为 Telegram 同名候选增加精确目标详情。
- CI 当前为 `disabled_manually`，以提交的本地运行证据为据。PR 交用户审核，不自动合并或部署。

五分钟演示入口是桌面聊天，前提为已启用 terminal 且隔离 Herdr 内有两个现存 Pi。请求 Pi 生成小文件，选择一次，批准发送，再批准独立文件读取；应在同一 Run 看见核查结果。取消选择或在审批前替换终端身份，应没有输入派发。真实环境演示仍待单独授权。
