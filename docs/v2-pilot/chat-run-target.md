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
| 1 普通 CLI 一句话完成并核查 | 已做离线脚本模型测试 `one ordinary CLI request discovers Node...`：真实 Node 查版本与帮助，读输入、写 `product:56`，另一条命令独立 assert，再读文件。四次既有确认保留。新增真实 Electron + 真实模型任务生成并外部解析 `total:56` 通过；该次没有主动查询 Node 版本／帮助。 |
| 2 无设置发现明确 Pi，只发送一次并核查 | 已做 `unbound multi-target choice...`、精确 selector 测试，以及 Electron `choose-continue-approve-readback-independent-file-check`。离线 Herdr executable 实际派发一次，独立文件读取仍须批准。新增真实 Electron + 真实 Pi：发现、采用、发送一次、Serika 回读文件及结果正确。控制审批来源缺记录，外部文件断言在该缺口处未执行，严格闭环失败。 |
| 3 多候选选择后原 Run 继续 | 已做同 Run 领域测试、Telegram gateway 测试、真实 Electron 选择卡及 reload 恢复。Telegram 使用离线 API fixture，未发真实 Telegram；多候选真实模型场景未运行。 |
| 4 等审批期间目标被替换 | 已做 `a replacement while approval waits...` 和 Electron `new-run-reselects-old-choice-invalid-replacement-blocks-old-approval`，旧批准返回 `HERDR_TARGET_CHANGED`，派发计数不增加。 |
| 5 旧绑定、未派发与 unknown 分流 | 已做 stale binding、server_not_running、binary、CLI、JSON 与字段失败；`unknown dispatch stops...` 断言原 loop 失败、receipt 为 unknown，无回读、重发或自动新 Run。 |
| 6 Run 结束清空，新 Run 不继承 | 已做双 Run 测试及 Electron 第二轮重选；`historical Steer cannot become new-Run target evidence...` 阻止旧 Steer 恢复身份依据。 |
| 7 压缩后保留原任务、目标及有效发现 | 已做 production compaction 路径两档：32,768 与 1,000,000 tokens。32K 断言实际发生 masked pending background，选择与原任务仍在输入中，发现和 prompt 各一次。真实模型压缩续跑未做。 |
| 8 权限和确认未放宽 | 已做 `b0 locks full host decisions...`、baseline assembly、原 desktop 与 Telegram 控制测试；权限快照无修改，控制不可记住，选择不产生批准。 |

## 3. 前后数字

相对 `315f89a`，产品 19 个文件 `+605 / -85`，测试及验证 12 个文件 `+717 / -20`。测试总量超过产品新增量，是因为包含 164 行独立 Electron smoke、45 行可复跑全测 runner 和 15 行脚本模型接线；其余测试新增 493 行，小于产品新增量。没有删除测试文件，没有改权限快照或历史分数。

最终全测 1888 项：1881 通过、7 跳过、0 失败、0 取消。Pi feature smoke 2/2，标准 Electron smoke 8/8。两套 Electron 均为 44.4.5，源提交 `daef7db`，`sourceWorktreeDirty=false`。以上为原离线基线。新增真实验收 2 个任务 Run、19 次请求，其中 Serika 15、Pi 4，按记录用量及公开峰时价格估算 $0.01203572，非账单核验。批准上限 4 Run／24 请求／$2，未沿用旧额度，剩余 5 次未花费。

原离线统计用 `git diff 315f89a daef7db --numstat` 复算；新增后的验证代码统计为 16 个文件 `+1194 / -20`，产品仍为 `+605 / -85`。包含 405 行真实验收主脚本／独占 Herdr fixture、14 行共享审批观察器及 49 行后处理审计脚本。验收代码超过产品新增量，因为真实 Electron、Pi、代理费用限制与失败原件保全都需独立验证，未扩展产品范围。产品是除 `.test.ts`、smoke fixture、脚本和文档外的 TypeScript；测试包含 `.test.ts`、`smoke-model.ts`、两个本轮验证脚本。超过 400 行按上面的 Herdr、Run 状态、交互通道拆分，没有扩展为通用适配层。

旧测试调整仅有 fixture 和类型收窄：Herdr 控制、Telegram 固定目标及 b0 权限对照补离线 session/pane 元数据；`task-module.test.ts` 用 `"reminder" in cancelled` 收窄新增卡片联合类型，原提醒断言保留。未改变旧权限预期。

## 4. 实际命令和退出码

| 命令 | 退出码与证据 |
| --- | --- |
| `pnpm build:runtime`、`node --test packages/assistant/dist/foreground-herdr.test.js`、`pnpm typecheck` | 均为 0，Run 目标回归 9/9；完整复跑也包含这九项。 |
| `node scripts/chat-run-target-verify.mjs /private/tmp/serika-chat-target-final-evidence` | 0，内部 `pnpm typecheck`、`pnpm test` 均为 0；[运行记录](evidence/chat-run-target/offline/result.json)、[完整日志](evidence/chat-run-target/offline/full-test.log)。 |
| `node apps/desktop/scripts/chat-run-target-live.mjs`、`node --check ...` | 0；零请求预检及脚本语法检查。 |
| `node scripts/test-home.mjs --home /private/tmp/serika-run-choice-live-guard -- node apps/desktop/scripts/chat-run-target-live.mjs --run --output /private/tmp/serika-run-choice-live` | 1；[原始真实失败](evidence/chat-run-target/live-bb96e4d0/result.json)，19 次模型请求。外层同时设置 `SERIKA_B2_RECORD_CONCURRENT_HOME=1`。 |
| `node scripts/chat-run-target-live-audit.mjs docs/v2-pilot/evidence/chat-run-target/live-bb96e4d0` | 0；[后处理审计](evidence/chat-run-target/live-bb96e4d0/audit.json) 校验原件 hash、用量、唯一输入与回读结果，结论仍为 incomplete。 |
| `node scripts/test-home.mjs --home /private/tmp/serika-run-choice-observer-guard -- node apps/desktop/scripts/chat-run-target-smoke.mjs --output /private/tmp/serika-run-choice-observer` | 0，外层同时设置 `SERIKA_B2_RECORD_CONCURRENT_HOME=1`；[修复后真实 Electron + 假模型](evidence/chat-run-target/approval-observer/result.json) 3/3，源提交 `542e854`、干净工作区，guard violations=0、并发事件 4。 |
| `node scripts/chat-run-target-verify.mjs /private/tmp/serika-run-choice-final-offline` | 0，`pnpm typecheck` 与 `pnpm test` 均 0；[本轮全测](evidence/chat-run-target/live-final-offline/result.json) 1881 pass／7 skip／0 fail／0 cancelled。 |
| `SERIKA_TEST_HOME=/private/tmp/serika-run-choice-final-standard-guard SERIKA_B2_RECORD_CONCURRENT_HOME=1 pnpm --filter @serika/desktop smoke` | 0，标准真实 Electron + 假模型 8/8；[本轮日志](evidence/chat-run-target/live-final-standard.log)，guard violations=0、并发事件 8。 |
| `pnpm --filter @serika/desktop build` | 0。原依赖有 Node 26 deprecation 与 Zod annotation 构建警告，未升级依赖；Electron 页面与控制台错误均为空。 |
| `SERIKA_B2_RECORD_CONCURRENT_HOME=1 node scripts/test-home.mjs --home /private/tmp/serika-chat-target-feature-guard-local -- node apps/desktop/scripts/chat-run-target-smoke.mjs --output /private/tmp/serika-chat-target-electron-local` | 0，[Pi Electron 记录及截图 hash](evidence/chat-run-target/electron/result.json)、[guard 日志](evidence/chat-run-target/feature.log)。配置 SHA 前后一致；Electron 已退出，隔离目录已移除。 |
| `SERIKA_TEST_HOME=/private/tmp/serika-chat-target-standard-guard-local SERIKA_B2_RECORD_CONCURRENT_HOME=1 pnpm --filter @serika/desktop smoke` | 0，[标准记录](evidence/electron-smoke/result.json)、[构建与 guard 日志](evidence/chat-run-target/standard.log)。包含重启 pid、Memory SHA、renderer UA 和截图 SHA。 |

两套 guard 均为 violations=0，均记录到日用进程的 6 次并发元数据变化。提交的 guard summary 去掉日用文件元数据明细，并保留原始结果 hash；没有改写原始通过状态。截图已人工检查选择卡和冻结正文的审批卡。

原离线验证在 macOS 的隔离临时 HOME、独立数据目录内运行。Electron 使用构建产物与原 preload、IPC，模型为脚本模型，Herdr 为离线 executable fixture。未读取日用 Pi 输出、发送日用输入、改日用绑定、启动日用服务或部署。新增真实验收只启动并清理随机独占隔离 Herdr 服务。guard 的 `SERIKA_B2_RECORD_CONCURRENT_HOME=1` 允许记录日用进程的并发元数据变化；只在 violations 为 0 时通过，不据此宣称日用元数据未变。

## 5. 与计划不符的地方及理由

- 新真实批已按另行授权运行。用户允许仅从日用 env 复制模型连接，密钥只在代理进程内读取，未写真密钥临时文件。普通 CLI 产物通过；Pi 严格审批闭环失败，多候选、真实模型压缩、真实 Telegram 未验收。原失败记录为 [live result](evidence/chat-run-target/live-bb96e4d0/result.json)，后处理 [audit](evidence/chat-run-target/live-bb96e4d0/audit.json) 校验全部请求／响应 hash、用量及唯一 Pi 输入，不能替代缺失审批或外部文件检查。
- 新增独立 feature smoke，标准 `electron-smoke.mjs` 的 hash 保持 `dc93b146f85165710071944d59108a36898c7a60aac37605950aa2264dcbb994`，保留既有独立复现基线。
- 首次 feature smoke 因测试脚本漏处理独立 `read_file` 审批失败；修正脚本后通过，未调整产品权限。一次定向测试使用 30 秒全局超时，取消了正常约 79 秒的 b0 测试；改用 120 秒后通过。
- 主工作树首次 Electron 启动触发依赖包的自动下载，已中止该测试进程，未运行功能断言。随后复用辅助工作树已安装的同版本 44.4.5 本地文件，两套最终冒烟通过；未启动日用服务。
- 最后审查修复两处来源问题：同 Run 明确改目标必须撤销旧采用及审批；旧 Run Steer 不得成为当前目标证据。还为 Telegram 同名候选增加精确目标详情。
- CI 当前为 `disabled_manually`，以提交的本地运行证据为据。PR 交用户审核，不自动合并或部署。

五分钟演示入口是桌面聊天，前提为已启用 terminal 且隔离 Herdr 内有两个现存 Pi。请求 Pi 生成小文件，选择一次，批准发送，再批准独立文件读取；应在同一 Run 看见核查结果。取消选择或在审批前替换终端身份，应没有输入派发。当前可试用 PR，但不能据此宣布全部真实验收通过。


### 本轮真实验收与脚本修复

原两轮的首次 `list_directory`、Pi 控制、Pi 产物读取在卡片展示后继续，但脚本没有对应决定记录。已保存的宿主回执表明工具实际完成，无法从原证据确定是谁／哪条输入通道批准；没有证据可认定权限绕过。原脚本只在自身无 ID 定位的按钮 click 之后写 decisions，遗漏其他交互的来源。保留原 `failed`、`0 !== 1` 和 screenshots，没有回填 decisions 或放宽断言。

修复只改验收脚本：先记录决定意图，再经原 preload 的 `confirm({approvalId,decision})` 请求宿主；记录实际 accepted 回应，监听原 approval／approval-cleared 事件。未经记录的清除会冻结后续模型请求。真实 Electron + 假模型已核对正确 ID、旧 ID、无效 ID，以及 reload 后的事件观察。此测试说明修复后的记录路径可用，不补算真实 Pi 审批通过。

原 proxy 最后一条 usage 在 footer 保存后才落盘，导致原 footer 仍有 $0.01448064 预留。19 个逐请求行均已 returned，用量齐全；审计重算未结请求为 0，原件 footer 不改。新脚本等待请求 handler 结算后才汇总。`cost-ledger.json` 用行记录记账，不把旧 footer 的预留当实际费用。

原真实脚本及外层 guard 退出 1，guard violations=0、并发事件 253，不能称 guard 通过或日用元数据未变。隔离 Herdr 在核对本目标 idle 后清理，目录已删除；原 Pi 外部文件检查因审批断言失败未到达，只可确认 Serika 已读出正确产物。剩余 5 次请求不足以可靠完成另两个完整场景，未新开批次或刷新额度。

本轮最终离线全测 1881 pass／7 skip，无失败或取消；修复后专项 3/3、标准 Electron 8/8。源码提交 `542e854`，三者启动时均为干净工作区，未在真实模型下重跑修复后的脚本。证据密钥值与常见密钥前缀扫描为零命中。按 Prove It Works 保留产物与请求原件，按 Fix Root Causes 修复观察与结算时序，没有把失败改成通过。
