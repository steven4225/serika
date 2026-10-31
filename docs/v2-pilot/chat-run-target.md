# 聊天发现 CLI 与当前 Run Pi 目标

> 2026-11-01 最新结论：专用 TG 默认 runtime 已缩短为 `/private/tmp/s197-tg`；真实 Herdr 启动、连接、两个 offline Pi 就绪及 profile 租约取得/互斥/释放后重取均通过，typecheck 与全测 1900 pass／7 skip／0 fail。桌面 c9a16383 整链 PASS、采用后契约收窄与专用测试 Bot 方向沿用。74ccfd3f 仍为 socket 启动失败、0 Run／0 请求／$0，原现场和归档 hash 不变。真实 TG 完成定义仍未通过，新批等待“继续”；未临停日用、未合并或部署。

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

五分钟演示入口是桌面聊天，前提为已启用 terminal 且隔离 Herdr 内有两个现存 Pi。请求 Pi 生成小文件，选择一次，批准发送，再批准独立文件读取；应在同一 Run 看见核查结果。取消选择或在审批前替换终端身份，应没有输入派发。候选版尚未通过真实 Pi 选择验收，不能据此作为日用已可用的结论。


### 本轮真实验收与脚本修复

原两轮的首次 `list_directory`、Pi 控制、Pi 产物读取在卡片展示后继续，但脚本没有对应决定记录。已保存的宿主回执表明工具实际完成，无法从原证据确定是谁／哪条输入通道批准；没有证据可认定权限绕过。原脚本只在自身无 ID 定位的按钮 click 之后写 decisions，遗漏其他交互的来源。保留原 `failed`、`0 !== 1` 和 screenshots，没有回填 decisions 或放宽断言。

修复只改验收脚本：先记录决定意图，再经原 preload 的 `confirm({approvalId,decision})` 请求宿主；记录实际 accepted 回应，监听原 approval／approval-cleared 事件。未经记录的清除会冻结后续模型请求。真实 Electron + 假模型已核对正确 ID、旧 ID、无效 ID，以及 reload 后的事件观察。此测试说明修复后的记录路径可用，不补算真实 Pi 审批通过。

原 proxy 最后一条 usage 在 footer 保存后才落盘，导致原 footer 仍有 $0.01448064 预留。19 个逐请求行均已 returned，用量齐全；审计重算未结请求为 0，原件 footer 不改。新脚本等待请求 handler 结算后才汇总。`cost-ledger.json` 用行记录记账，不把旧 footer 的预留当实际费用。

原真实脚本及外层 guard 退出 1，guard violations=0、并发事件 253，不能称 guard 通过或日用元数据未变。隔离 Herdr 在核对本目标 idle 后清理，目录已删除；原 Pi 外部文件检查因审批断言失败未到达，只可确认 Serika 已读出正确产物。剩余 5 次请求不足以可靠完成另两个完整场景，未新开批次或刷新额度。

本轮最终离线全测 1881 pass／7 skip，无失败或取消；修复后专项 3/3、标准 Electron 8/8。源码提交 `542e854`，三者启动时均为干净工作区，未在真实模型下重跑修复后的脚本。证据密钥值与常见密钥前缀扫描为零命中。按 Prove It Works 保留产物与请求原件，按 Fix Root Causes 修复观察与结算时序，没有把失败改成通过。

原始 SSE 响应以空行结束，普通 `git diff --check` 对 19 份 response 提示 blank line at EOF；为保持原响应 SHA 未删空行。`git -c core.whitespace=-blank-at-eof diff --check 315f89a HEAD` 退出 0，其余空白检查保留。


### 日用模式复验，2026-10-30 21:43–21:48 +08:00

用户另批 2 Run／24 请求／$0.25，并明确取消旧 Telegram 待批 Run。临时切换 `4bdb22d` 到真实日用 HOME、原配置、原 preload／IPC，候选 Build ID `e45fd69d02c65071`。未合并 PR，未改持久目标、PATH 或权限。先保留原入口、服务与身份，再空闲切换；worker 测试期间暂停，结束后恢复。

| 场景 | 实际结果 |
| --- | --- |
| 普通 CLI | `shell_exec` 返回 `SANDBOX_UNAVAILABLE`，无宿主 fallback。模型随后请求既有、逐次审批的 `terminal_exec`；一次绝对 cwd 被 `INVALID_PATH` 拒绝，PATH 中也没有 Homebrew Node。最终发现 `/opt/homebrew/bin/node`、读取版本／帮助、写文件及 read_file 核查，外部解析 `total:56` 通过。共 6 次 terminal 调用，不符合“少量确认即可完成”的体验预期。 |
| 已有 Pi | `herdr_pi_discover` 两次均返回 8 个已核对 idle 候选，旧配置目标返回会话未运行。模型把 refresh 后随机 candidateId 的变化及 past metadata observations 提示误判为候选失效，未调用 read／control 去触发宿主选择。选择卡 0、采用 0、控制派发 0。业务验收失败，不能把模型最后的 completed 当目标完成。 |
| 审批证据 | CLI 的 6 次终端调用有 5 条脚本精确 approvalId 决定；另一次有卡片清除和执行记录，来源未归因，不补填。后续加原 IPC handler 的 debugger 观察，未替换 handler／preload；Pi 没有任何控制审批或发送。 |
| 费用与恢复 | 12 次模型请求均 returned，用量重算 $0.01904532，非账单核验；两个 Run 已用完，不新开 Run 消耗剩余请求。已恢复原 Build ID `3284971335fa6ff8`，resident idle、worker 正常，配置 hash 及绑定未变，代理停止。候选 release 与回退材料保留。 |

[去除日用内容的审计摘要](evidence/chat-run-target/daily-cc43d65d.json) 由 `node scripts/chat-run-target-daily-audit.mjs /Users/a1-6/Applications/Serika-support/chat-target-daily-8de06471-8064-4e9a-85a7-ecbe8e902857 docs/v2-pilot/evidence/chat-run-target/daily-cc43d65d.json` 生成，退出 0，`node --check` 退出 0。完整原始回执、截图和脚本保存在该本地 support 目录，避免把日用内容传到 PR。产物保留在日用工作区的 `orders-cc43d65d/answer.json`。

初次 `.app` 的 cwd 与 resident 身份不同，页面报启动身份不一致；未产生 Run 或模型请求。统一候选打包入口的 cwd 后连接成功，保留两次启动失败日志。没有修改产品验证规则。

本次复验产品代码增删均为 0，仅新增审计脚本并更新报告、证据和费用账本。审计脚本运行、语法检查及 `git diff --check` 均退出 0，日用密钥值与常见密钥前缀扫描均为零命中。未重跑产品全测及标准 smoke，沿用上述相同产品源码的离线基线，本批真实 Electron 结果单独记为失败。真实失败指向候选含义及选择触发路径的引导：随机选择句柄变化不等于终端身份变化；已核对、多候选且尚未采用时应进入宿主选择。后续修复和新的真实 Run 尚未执行，不能用本报告替代复验通过。


### 阶段 1 选择推进协议，2026-10-31（先于代码）

本轮仅修已知失败，沿用 #197 与当前 Run 状态。真实批尚未授权，不沿用历史剩余额度。

- [x] 读取 pstack/相关原则、恢复分支与原失败；按 bug-fix 分工只读调查 Shell 和审批。
- [x] 复现发现后模型可直接结束的缺口，记录失败。
- [x] Ground：跟踪 terminal tool → AgentLoop → afterToolCall → Controller → desktop/TG；Sketch：确定等待与身份契约。
- [x] Agree：采用下述已获本轮范围授权的协议；Implement：只改选择推进、对应指引和观察器；Scrap：若契约不适配先记录再重画，禁止补第二循环。
- [x] 定向回归 → typecheck → 全测 → 干净源码的隔离 Electron；专项首批失败保留，修观察器后另批 6/6，标准 8/8。
- [x] 提交真实批 Run/请求/费用上限、渠道、断言与停止条件；用户已批准本批并明确允许仅用日用 env 的模型连接。
- [ ] 获准后隔离真实验收，逐项核对完成定义；更新既有 #197 后停止，不合并、不切日用。

**Before / After / Demo**：目前多候选 discover 后模型可结束，用户看不到选择。修后 discover 返回后宿主立即等待选择，选定后同 Run 再向模型提供当前采用状态，控制另批。五分钟入口为隔离桌面聊天或 TG 假 API：已有两个 idle Pi，请求生成小文件；发现后模型请求数保持不变，卡/短码有效一次，选择后同 runId 续跑，批准一次 prompt，fixture 仅一条输入，回读和独立解析产物匹配；拒绝、取消或替换身份必须零派发。

**边界与类型**：保留 `PendingHerdrSelection {selectionId, toolCallId, candidates}`、`RunTarget.adopted/version/calls`。新增宿主 `afterToolCall(input, next)` 只处理已完成的发现，不新增行为循环、持久目标或审批权限。它使用原 `AfterToolCallInput.signal`，处于工具 execute deadline 已 dispose 之后，也不经过暂停 Run 计时的 beforeToolExecute。选择等待消耗原 Run 剩余预算，取消/预算耗尽清除等待且不派发。

**顺序**：discover 执行只做有界发现、原话精确 selector 校验及唯一候选核对；成功后宿主 afterToolCall 在交回模型或处理下个工具前检查当前目标。尚未采用且多候选时必建待选择；旧配置失效或真实身份变化时，即使只剩另一个目标也须明确选择。桌面卡/TG 短码共用此等待。有效选择一次性消费，再 get 核对真实身份，成功才采用；失败/取消停止当前 Run，不让模型重发或选别的。选择不产生操作批准。后续控制按原 toolCallId 冻结目标/正文/version，原确认批准后只用冻结值并再次核对身份。

**发现前的 read/control**：没有已采用目标时不在 beforeToolExecute 中发现或等待，返回明确未派发的 `HERDR_DISCOVERY_REQUIRED`；由 discover 统一拥有发现与阻断式选择。脚本模型先 discover 再 control，避免旧测试仅从 control 触发选择而遗漏本次真实失败。已有唯一匹配与同 Run 已采用目标继续沿用。

**身份**：candidateId 是临时句柄，真实身份为既有 `HerdrTarget` 完整字段。refresh 仅换句柄、真实身份相同时沿用采用/version，不重复选择；真实身份不同则撤销旧采用、清空冻结调用、递增 version 并要求选择。刚核对不等于已采用，句柄刷新不等于目标消失。精确 selector 仅匹配原 Run 用户原话并且唯一匹配才可直接采用。

**方案取舍**：把等待塞进 discover.execute 会被工具 deadline 中断；把等待放 beforeToolExecute 会暂停 Run 计时。采用已有 afterToolCall，原 AgentLoop 顺序、工具超时与 Run 预算保持可检验。

**审批观察**：先记录精确 runId/toolCallId/approvalId、冻结目标与正文和决定意图来源，再调用原 preload/IPC 并记录 accepted；cleared 可先于 accepted 回包，必须关联已有 attempt，最终再核对结果。每条需要批准的实际派发必须对应 accepted allow；每个 accepted allow 必须有执行或明确未执行结果。read 自动允许单记，不造卡。拒绝、选择取消、身份变化分别证明零派发，unknown 停止自动回读、重发、换目标及相关控制清理。原失败原件保持不变，后续复验另批。

#### 阶段 1 当前记录（真实批前）

1. 改了什么：`foreground-herdr.ts` 把选择等待迁到既有 afterToolCall；read/control 未采用时明确未派发。刷新同身份保留采用；refresh 或执行前核对发现身份变化均撤销冻结调用并要求重选。能力提示、桌面卡与 TG 文案同步。Shell 复用可信启动 Node，仍经可执行、canonical、protected path 与 dyld 核对，策略和环境白名单无变更。审批观察记录原事件、精确决定来源、accepted 与双向结论，独立文件读取不能伪装自动允许。
2. 逐条对照：桌面/Controller 假模型已证明发现后停在第一个模型请求、工具已 completed 后才待选、同 Run 一次选择、同身份刷新不重选、批准后单次派发与独立文件核查；取消选择、拒绝、待批取消、身份替换与剩余总预算均有零派发回归。TG 离线 API 已证明 discover 后短码等待、同 Run 单次选择与独立批准、准确正文及取消短码零派发；真实 TG 未测。真实模型证据链仍待新批，不以旧失败或本轮假模型代替。
3. Shell 分支结论：最小启动 PATH 下，仅按 PATH 发现报 `Seatbelt runtime missing`；同环境下修后原 Runner 执行写入，外部解析 `total=56`，exit 0。native 与真实 Electron 的隔离等价最小 PATH 环境均通过，外部独立解析产物均为 `total=56`。旧日用回执只有 SANDBOX_UNAVAILABLE，不能证明本次复现是其唯一历史原因。现有策略下可修的路径已建立；未声称日用 Shell 已恢复。原 `/private/var/select/sh` 的权限拒绝提示仍保留，未为消除此提示改策略。
4. 命令：定向回归先失败 `3 !== 1`，修后相关 20 项通过，新增待批取消与执行失败后重选专项 2/2；TG 3/3，observer unit 1/1。最终 `pnpm typecheck`、`pnpm test` 均退出 0，总计 1898 项，1891 pass / 7 skip / 0 fail / 0 cancelled，来源为干净提交 `f203924`。真实 Electron + 假模型专项复验 6/6、标准冒烟 8/8，来源为干净提交 `541aa14`；两次提交间仅验证脚本和报告变化，产品源码相同。原始预期失败、一次仪器挂在旧 bridge 导致记录为空、一次 nullable Run ID typecheck 失败均保留本地，不改历史结果。
5. 偏离和待办：测试与验收脚本新增行数多于产品，是本轮明确要求桌面/TG、预算、身份失效、审批双向结论及真实 Shell 产物的覆盖所需；不改变旧权限/副作用预期，不删除测试。修改旧 fixture 为先 discover 再 control，并相应增加工具/模型步计数；compaction 检查移到实际 bulk 后的请求，原断言保留。检查过旧约束 Tool side-effect invariants、Thin TUI confirmation、Shell sandbox、Trusted desktop foreground autonomy、Compact desktop execution display。审核复现的 sole replacement 与 file approval 来源漏洞已补回归。按 Fix Root Causes 修宿主边界，按 Prove It Works 核查真实 Shell 产物；审核 trail reviewed inline，真实模型与真实 TG 仍未覆盖。

**本批真实方案，后续已获授权并执行**：仅隔离桌面，2 个任务 Run / 总计最多 24 次上游模型请求（含 Serika、Pi 与任何辅助请求）/ $0.25 硬上限，任一达到即停，不补新 Run、不沿用旧剩余。模型拟沿用 `deepseek/deepseek-v4.1-flash-fast`，测试连接字段仅从测试专用 `~/.serika-test.env` 或显式 `--env-file` 在进程内读取。零请求预检只查文件存在，默认文件当前不存在；未读连接内容，不自动借用日用密钥。第一 Run 使用与日用安全策略等价的隔离 Seatbelt Shell，执行并外部解析 `total=56`，禁止 terminal/host fallback。第二 Run 在独占隔离 Herdr 内先有两个 idle Pi，普通请求触发发现、宿主阻断、一次 accepted 选择、核对采用、同 runId、独立控制批准、冻结目标/正文一致、仅一条 Pi 输入、回读并外部核查文件。真实 TG 和真实压缩不在本批覆盖，不能据此报告通过。任何断言、审批来源、费用结算或运输失败均保存原失败并停止；unknown 立即冻结模型代理，不自动回读、重发、换目标或控制清理。本方案提交时尚未批准；后续授权与运行结论见本节末。

Electron 专项首批 `a3770778` 保留 failed：前五项通过，原 Shell completed 事件为 exit 0，但观察器先等 running 再读一次 snapshot，快速 Run 已结束导致取到空 runId，getRun 返回 ok=false；独立 Shell 产物断言未到达，不能算该项通过。修复仅从原 preload run() 的接受响应取得 runId，后续复验另用目录/编号，不改首批结果。隔离目录先 canonicalize，使夹具声明的既有 workspace autonomy 确实生效；因此独立 read_file 按原规则自动允许并单记，Pi control 卡仍需批准。此前夹具的 /var 别名使声明未生效，旧测试曾多出 file approval；本次不修改产品权限来保持这个夹具错误。


#### 阶段 1 离线关口汇总

离线关口结束时，阶段 1 尚未完成，真实模型请求为 0、费用为 0；当时真实批等待预算批准及测试连接文件。真实 TG 与真实压缩不在拟定批次中，保持未验收。现有 #197 尚未推送本轮提交，按工序在真实验收后更新。

| 关口 | 命令及退出码 | 原始证据 |
| --- | --- | --- |
| typecheck、全测 | `node scripts/chat-run-target-verify.mjs /private/tmp/serika-197-stage1-final-offline`，0；内部两阶段均 0 | [1891 pass / 7 skip](evidence/chat-run-target/stage1-3087f25a/offline/result.json) |
| 专项 Electron 首批 | `node scripts/test-home.mjs --home /private/tmp/serika-197-feature-guard -- node apps/desktop/scripts/chat-run-target-smoke.mjs --output /private/tmp/serika-197-stage1-feature`，1 | [原 failed，未改绿](evidence/chat-run-target/stage1-3087f25a/feature-first-failed/result.json) |
| 专项 Electron 复验 | `node scripts/test-home.mjs --home /private/tmp/serika-197-feature-r2-guard -- node apps/desktop/scripts/chat-run-target-smoke.mjs --output /private/tmp/serika-197-stage1-feature-r2`，0 | [6/6，原 preload / IPC](evidence/chat-run-target/stage1-3087f25a/feature-r2/result.json) |
| 标准 Electron | `python3 /private/tmp/serika-197-stage1-trail/run-standard.py`，0；内部原标准 smoke 退出 0 | [8/8，含重启与 Memory SHA](evidence/chat-run-target/stage1-3087f25a/standard/result.json)、[wrapper](evidence/chat-run-target/stage1-3087f25a/standard/wrapper.json) |
| native Shell | `node scripts/chat-run-target-shell-probe.mjs /private/tmp/serika-197-shell-final`，0 | [真实 Seatbelt、外部产物 56](evidence/chat-run-target/stage1-3087f25a/shell-native/result.json) |
| 真批预检 | `node apps/desktop/scripts/chat-run-target-live.mjs`，0；`node --check apps/desktop/scripts/chat-run-target-live.mjs`，0 | [未读凭据内容、零请求](evidence/chat-run-target/stage1-3087f25a/live-preflight-final.json) |

Electron 版本均为 44.4.5。专项复验与标准 guard 均为 violations=0，但 metadataUnchanged=false，不能报告日用元数据未变。标准脚本 SHA 仍为 `dc93b146f85165710071944d59108a36898c7a60aac37605950aa2264dcbb994`。截图已检查，隔离 Electron 已退出、临时运行目录已清理。

离线归档时相对 `71f9c3d` 的产品变更为 `+47 / -25`，测试与验证为 `+406 / -85`，文档与证据不计入。测试量较大用于复现并核对桌面、TG、身份变化、预算和审批副作用边界。专项两次命令外层均设置 `SERIKA_B2_RECORD_CONCURRENT_HOME=1`。

完整审批观察已在假模型关口核对：发现多候选后宿主等待、有效选择一次、同 Run 采用、独立控制审批、冻结目标和正文、accepted 决定来源、仅一次派发、回读与外部文件核查。拒绝、取消、身份替换均有零新增派发证据；read 自动授权单记。完整原件、首次失败、TG 离线日志及两档压缩回归见 [汇总](evidence/chat-run-target/stage1-3087f25a/summary.json)。最终 hash、截图 hash、源码差异和代码量由 [finalize.py](evidence/chat-run-target/stage1-3087f25a/finalize.py) 核查并写入 [verification.json](evidence/chat-run-target/stage1-3087f25a/verification.json)。该核查只扫描常见密钥前缀，未读取真实密钥，不能声称已按真实密钥值扫描。


真实批启动前，用户已明确授权使用日用 env 的模型连接，并回复“继续”批准既定预算。只读取该文件的模型连接字段，不复制日用数据。真批脚本使用最小启动 PATH，决定文件记录 Codex 在本批授权下的选择与批准来源；unknown 后不再 snapshot、cancel、关闭测试应用或读 Pi transcript，保留现场。凭据预检仅输出存在及端点/模型是否匹配，未输出值。


### 阶段 1 隔离真实批，2026-10-31

**阶段 1 未完成。本批停止，不追加真实 Run。** 运行脚本原件记录 `passed`，事后审计发现“失败即停”未落实，结论为 `incomplete-failure-stop-not-enforced`。原件与旧失败均保留。

1. 改了什么：本批仅使用用户明确授权的日用 env 模型连接，真实密钥只在代理内存读取，不写入隔离 env 或证据。产品代码未再变更。启动前只补验证脚本的最小 PATH、准确决定来源及 unknown 保留现场。新增 `scripts/chat-run-target-stage1-audit.mjs` 从原始请求、响应、事件、决定、transcript 和外部核查记录独立审计，不改运行结果。
2. 逐条对照见下表。业务证据链断言通过，“失败即停”未通过，不能报告阶段完成。真实 TG、真实压缩及日用恢复仍未验收。
3. 实际 2 个任务 Run、19 次上游请求，Serika 16、Pi 3，全部 returned，无 unknown 或未结算请求。按已核对的官方峰时费率保守估算 `$0.01422140`，非账单核验；上限为 2 Run / 24 请求 / $0.25，未沿用旧额度、未补新 Run。已记入 cost-ledger。最终相对 `71f9c3d`，产品 `+47 / -25`，测试与验证 `+507 / -88`，文档证据不计；增加部分用于独立审计完整链及揭示未停止，数字见 submission-verification。
4. 原运行命令为 `SERIKA_B2_RECORD_CONCURRENT_HOME=1 node scripts/test-home.mjs --home /private/tmp/serika-197-stage1-live-guard-a -- node apps/desktop/scripts/chat-run-target-live.mjs --env-file /Users/a1-6/.config/serika/v2-daily.env --run --output /private/tmp/serika-197-stage1-live-a`，退出 0；`node scripts/chat-run-target-stage1-audit.mjs /private/tmp/serika-197-stage1-live-a` 退出 1，明确阻止阶段完成。语法检查、零请求预检及 observer unit 1/1 均退出 0。产品全测与标准 Electron 沿用上面的同产品源码证据，没有为报告重复运行。
5. 偏离：选择后，模型把宿主采用的 pane/terminal 当作用户精确指定，额外调用 discover，原话不含该标识，被 `HERDR_REQUEST_EVIDENCE_INVALID` 拒绝。这次拒绝没有派发外部输入，旧选择也未改变。但观察器只对 unknown/断言/代理失败即时冻结，未捕获 `tool.call.completed` 内的 `output.ok=false`，拒绝后仍发生 10 次模型请求。事后审计确认该缺口即停止，不修改原 `passed`，不把保护性拒绝改写成成功，不在本批补修并复验。

| 完成定义 | 本批直接证据与结论 |
| --- | --- |
| ≥2 发现 → 宿主选择 → 一次有效选择 → 核对采用 → 同 Run | 初次发现 2 个 idle Pi；工具 completed 后出现选择卡，第 7 次模型请求至接受选择前无新请求；选择 accepted 恰好一次，后续原 Run `92d89332-9deb-452f-8a3b-510b5ba6b65c` 继续。冻结目标与所选完整真实身份一致。 |
| 单独批准 → 冻结/批准/派发正文一致 → 仅发送一次 → 回读与独立核查 | `toolCallId=call_00_vuxsSisdPYmcZrLlTrQk6491` 对应 `approvalId=2b1aa1ad-ff6b-48b9-b99e-7ee5950c5b86`；决定文件明确记录 Codex 在本批用户授权下作出 allow，原 preload 返回 accepted；派发 completed，Pi transcript 仅新增 1 条且逐字匹配冻结正文。Serika 回读和外部解析均为 `{sum:14, order:"3a40ff59-blue"}`。 |
| 拒绝/取消/身份变化零派发，句柄刷新与原预算 | 沿用本轮桌面/TG 假模型、领域与预算回归；本真实批没有故意触发这些负例，不扩报真实覆盖。 |
| 原安全策略内 Shell 可执行与产物核查 | 最小启动 PATH，原 Seatbelt；两次 Shell exit 0，写入、独立重算、read_file 与外部解析均为 `total=56`。没有 terminal_exec 或宿主 fallback。未改 Seatbelt、环境白名单或授权规则。已复现 runtime discovery 依赖缺失并验证修复路径，不能把旧日用统一 unavailable 回执推断为唯一历史原因。 |
| 审批观察与只读自动允许 | 宿主卡、runId/toolCallId/approvalId、冻结身份/正文、决定 actor/source、accepted 与派发结论全部关联；read 自动允许独立记录，不补造审批卡。完整链由后处理脚本复核。 |
| 失败即停 | **未通过**。额外 discover 被拒绝后原验证脚本继续运行，后处理审计退出 1。本批不报完成。 |

真实 Electron 44.4.5、原 preload/IPC，启动源码 `f2b24e5` 且 `sourceWorktreeDirty=false`。两个测试主进程 70247、70588 均已退出；本批独占 Herdr 在核对两个目标 idle/done 后停止并删除，隔离目录已移除，没有 unknown。guard passed / violations=0 / changes=60 / metadataUnchanged=false，不能声称日用元数据未变。未合并、未部署或切换日用。CI 当前仍为 `disabled_manually`，不声称远端 checks 通过。

原始 [result](evidence/chat-run-target/stage1-live-3a40ff59/result.json)、[独立审计](evidence/chat-run-target/stage1-live-3a40ff59/stage1-audit.json)、[等待选择时的观察](evidence/chat-run-target/stage1-live-3a40ff59/selection-hold.json)、[归档清单](evidence/chat-run-target/stage1-live-3a40ff59/archive-summary.json)。价格依据为 [Command Code 官方模型页](https://commandcode.ai/models/deepseek-v4-1-flash-fast)，峰时输入/输出/缓存读取分别为每百万 token `$0.32 / $1.16 / $0.03`。下一步需先离线补齐真批的非成功工具结果停止关口，再另批授权复验；本轮在更新 #197 后停止。


后续用户要求跳过离线测试，直接真实验收。按此收窄流程，仅补验收脚本的非成功工具结果停止：原事件观察器立即冻结，并在模型代理入口检查上一工具的顶层 `ok=false`，防止 renderer 事件传播延迟导致下一请求已出网。原失败及审计不变；新批仍需单独批准预算，不复用已用完的两个 Run。当前未新增真实请求。

用户已另批新预算：最多 2 Run / 24 次上游请求 / $0.25，明确跳过离线测试，直接隔离真实验收。以下脚本改动仅为验收停止条件，不改产品逻辑；新批独立记录，不复用旧额度。


### 新批直接真实验收，78ca59ba，2026-10-31

**阶段 1 未完成，本批 failed，已经停止。** 用户另批 2 Run / 24 请求 / $0.25，并要求跳过离线测试。没有跑离线测试、增加新功能或切日用；保留上一批及本批原件。

1. 改了什么：只给真批观察器补上非成功工具结果冻结，并在模型代理入口拒绝携带顶层 `ok=false` 工具结果的新请求，阻止其继续出网。产品逻辑不变。运行后新增 `chat-run-target-stop-audit.mjs` 核对本批实际证据，没有使用假模型重跑。
2. 逐项结果：真实模型在最小启动 PATH、原 Seatbelt 下写入、读取并独立核查 `total=56`，Shell 场景通过。Pi 首次发现 2 个 idle 候选，选择卡出现；约 5 秒后卡被清除，下一请求的宿主上下文显示第一项已采用、selectionVersion=1。脚本没有发出选择决定；用户事后明确确认手动点击第一项，决定来源已归因为用户原生 UI 操作，宿主后续上下文证实采用。运行时 accepted 回应未被观察器记录，不补造。手选、采用和同 Run 继续已有证据，不能归因为宿主绕过等待。随后模型再次提交带 session/pane/terminal 的 discover，但引用的用户原话不含这些标识，被 `HERDR_REQUEST_EVIDENCE_INVALID` 拒绝。停止门立即冻结，拒绝后 0 个上游请求、0 次控制派发、0 个 Pi 模型请求。独立操作批准、发送、回读及产物核查未到达，阶段 1 不报完成。
3. 本批实际 2 Run / 11 次上游请求，全部 Serika，全部 returned，费用按原保守峰时费率估算 `$0.01077680`，非账单核验，已记入费用账本。没有 unknown、未结算请求、补 Run 或重发。上一批 19 次/$0.01422140 与本批分开记录，不改绿、不抵扣或刷新额度。
4. 命令为 `SERIKA_B2_RECORD_CONCURRENT_HOME=1 node scripts/test-home.mjs --home /private/tmp/serika-197-stage1-live-guard-b -- node apps/desktop/scripts/chat-run-target-live.mjs --env-file /Users/a1-6/.config/serika/v2-daily.env --run --output /private/tmp/serika-197-stage1-live-b`，退出 1。事后 `node scripts/chat-run-target-stop-audit.mjs /private/tmp/serika-197-stage1-live-b` 退出 0，只表示原件 hash、费用和拒绝后零请求等证据核对成功，业务结论仍为 `failed-pi-task-incomplete`。没有执行 typecheck、单元/离线回归或标准 smoke。
5. 与预期不符：运行时观察器漏记了用户直接点击原生选择卡的决定来源。脚本准备提交第二项选择时，先检查到整批已 failed，断言拒绝继续，没有写选择文件、没有调用选择 IPC。后处理核对第一项已采用，说明最初“无脚本决定即宿主绕过选择”的推断证据不足，已撤回该归因。用户随后在本聊天回复“是，我手动选了第一项”，补齐了决定 actor 的事后说明；原始 result、stop-audit 及其“运行时来源未记录”的字段保持不变。此说明不是补造当时 IPC accepted 回包。确定需要处理的行为是模型把宿主采用的身份误作用户精确指定而再次 discover。本批不继续修复或复验。

运行于 macOS、真实 Electron 44.4.5、原 preload/IPC，源码 `8388137`、`sourceWorktreeDirty=false`。guard 为 failed / violations=0 / changes=28 / metadataUnchanged=false，失败原件完整保留。两个测试 Electron 进程均已退出。脚本在 frozen 后保留独占 Herdr 现场，没有追加目标回读或控制清理；测试服务 `w-bf1bb63b` 的 server pid 76530 仍在，目录 `/private/tmp/c-RD0jp2` 保留，代理已退出。该服务属于本批隔离现场，无日用替换或绑定变更。

[原始 failed](evidence/chat-run-target/stage1-live-78ca59ba/result.json) · [拒绝后停止审计](evidence/chat-run-target/stage1-live-78ca59ba/stop-audit.json) · [归档与 hash](evidence/chat-run-target/stage1-live-78ca59ba/archive-summary.json) · [保留现场及进程观察](evidence/chat-run-target/stage1-live-78ca59ba/retained-processes.json)。真实 TG、真实压缩及日用 Shell 恢复仍未验收。本轮更新原 #197 后停止，不合并、不部署。

本批归档后，相对 `71f9c3d` 的累计产品变更仍为 `+47 / -25`，测试与验证为 `+603 / -88`，文档和原始证据不计。增加部分用于真批停止观察及原件审计，不增加产品功能面。归档完整性、真实密钥值与常见前缀扫描均通过，见本批 submission-verification；这些提交核查不是真实业务通过结论。


用户后续确认：78ca59ba 的第一项 Pi 是用户在隔离窗口手动选择，非脚本自动选择，也无证据表明宿主自行越过等待。失败点保持为采用后模型多余 discover 的无效原话身份依据；拒绝后零新增请求、零控制派发及本批 failed 结论不变。本次只更正报告和 PR，没有改代码、运行测试或调用模型。

### 采用后继续与原生决定观察，收口协议

当前失败是宿主已经采用目标，模型仍把宿主身份拼进 `discover.requested`，原话校验正确拒绝。修后模型依据宿主明确的 adopted 状态直接 read/control；requested 仍只能取本 Run 用户原话中的精确标识。核对不等于采用，句柄刷新不等于身份变化，选择也不授予操作批准。

| 工序 | 行为与证据 |
| --- | --- |
| 先定协议 | 本节先于代码写入。沿用 pstack 的最小改动、类型约束与实物核查；不改变来源校验、选择状态机、审批或预算。 |
| 修模型契约 | 删除无条件重复发现的指引；afterToolCall 明确返回已采用状态与下一步 read/control。 |
| 补决定记录 | RuntimeBridge 在原 IPC 方法调用前捕获当前 pending/runId，调用后通过既有 MainToRenderer 消息发送原输入、pending、accepted 与宿主决定时间。renderer 观察时间另记。只标 runtime-bridge，因为该方法也被 TG gateway 调用，不能据此臆断渠道或 human。桌面渠道及脚本 actor 由本批入口和原生点击记录另证。选择 accepted 与后续核对采用分别核查。审批采用同一观察路径，覆盖用户原生点击。 |
| 方案取舍 | 使用既有消息流；不替换 preload/IPC，不加 DOM 测试事件或暂停运行的调试断点。验收脚本通过原生选择按钮操作，单独记录脚本 actor；宿主事件记录接受结果。用户手选则按实际接受的候选继续，禁止硬编码第二项。 |
| 隔离演示 | 两个测试 Pi、原生桌面入口：发现后选卡只选一次，同 Run 继续，独立批准一次发送，回读并外部核查 sum=14 与当批 order；Shell 原安全策略核查 total=56。任何失败即停，unknown 保留现场。 |
| 验证与停点 | 按用户后续指示跳过离线、typecheck、全测与假模型，不把历史结果算本改动通过。仅构建真实 Electron 所需产物；构建失败不进真批。前两批额度均用尽，新批另报最多 2 Run / 24 请求 / $0.25，等批准后才调用模型。真实渠道仅桌面，TG 不报通过。 |

本轮任务依次为协议、最小改码、差异审核与构建、新批预算、授权后的隔离验收、原 #197 更新。已查旧约束的 tool 副作用、unknown 回执和 Trusted desktop foreground autonomy 条目；不改授权、Seatbelt 或日用入口。

#### 收口候选已提交，真实复验待授权

1. 改了什么：`1abe19b` 修采用后的模型指引、原生点击观察及宿主选择/审批 accepted 消息。`28a8d1c` 将来源准确标为共享的 runtime-bridge。`e65dc63` 仅在未选 Pi 的零消息核查中允许 transcript 尚不存在，选中目标仍严格核查实际文件。只读审核指出的顶层断言冻结与宿主决定时间已处理。
2. 逐条验收：选择推进与采用后不重复发现，代码已改，真实复验未做；原生选择/审批来源和双向执行结论，观察器已补，真实复验未做；Shell 沿用既有隔离成功证据，本次未新增运行；TG 本次改动未复验，未报真实通过。阶段 1 仍未完成。
3. 相对本轮起点 `f93471e`，产品 `+29/-9`，验证脚本 `+78/-26`，文档不计。没有新增测试用例。验证脚本增加量用于原生决定记录、实际目标映射、同 Run/一次选择/零等待请求/零多余发现/未选目标零消息断言及失败冻结。
4. `pnpm build` 退出 0，最终产品源码 `e65dc63`，前后端 source dirty 均 false，Build ID `c3368d295c3bde2a`。构建日志在 `/private/tmp/serika-197-closure-build.log`；有 Node 弃用提示和第三方 Zod 注释提示，无构建错误。`git diff --check` 退出 0。按用户指示未执行离线测试、typecheck 命令、全测、假模型或 smoke。本轮新增真实模型请求 0，费用 0。
5. 与原工序的偏离为用户明确跳过离线关口；历史通过不计为本改动通过。上一批 failed 与原始观察缺口不改写，新批最多 2 Run / 24 请求 / $0.25 已单独提请批准，未沿用旧额度。真实渠道仅桌面，不覆盖 TG；不合并、不部署日用，旧冻结现场不复用或自动清理。

### 收口候选真实复验，fc56f36f，2026-10-31

**阶段 1 仍未完成。本批 failed，已停止。** 用户明确批准新批 2 Run / 24 请求 / $0.25，允许 Codex 在隔离桌面选择及独立批准操作，沿用日用 env 的模型连接字段。没有复用旧现场或旧额度。

1. 改了什么：本批从干净 `580269f` 构建并启动真实 Electron 44.4.5，Build ID `e5042d5ce091095a`，保留原 preload/IPC。真实运行期间产品与脚本未改。失败后仅扩展原停止审计，核对新宿主选择事件、原生点击、实际 actor、采用快照和到达模型的指引，原 result 保持 failed，不进行产品修复或追加复验。
2. 逐项对照如下。原生选择决定来源的观察缺口已在本批补齐；采用后重复 discover 的行为仍复现，不能报告收口成功。

| 完成定义 | 本批直接证据与缺口 |
| --- | --- |
| 多候选 → 宿主等待 → 一次有效选择 → 核对采用 → 同 Run | 发现 2 个 idle；选卡等待期间 0 新模型请求。Codex 在本批授权下点击第一项原生按钮，宿主原事件 accepted=true 恰好一次。第 8、9 请求系统上下文均有 adoptedTarget、selectionVersion=1；后续 read_file 与选择保持同 Run `048e1e8a-c471-457d-8919-8e27f67fc2c0`。 |
| 单独操作批准 → 一次发送 → 回读与独立核查 | **未到达**。模型先读 blue.json，随后再次 discover.requested，引用“请找一个现有 Pi”，其中没有它提供的 session/pane/terminal。宿主正确返回 HERDR_REQUEST_EVIDENCE_INVALID；控制批准 0、控制派发 0、Pi 模型请求 0，没有 Pi 产物成功结论。 |
| 安全策略内 Shell 可执行与产物核查 | 最小启动 PATH、原 Seatbelt，3 次 shell_exec 均 exit 0，read_file、Shell 计算复核及外部解析均为 total=56，没有 terminal_exec fallback。只证明本批隔离环境可执行，未切日用，也不证明 PATH 是旧统一 unavailable 的唯一历史原因。 |
| 审批观察链与只读自动允许 | 选择关联 runId/toolCallId/selectionId、完整候选身份、原生 click、Codex actor、宿主 accepted/decidedAt 与观察时间。本批无需批文件/Shell 调用按真实自动授权记录，无审批卡不补造；独立控制审批未到达，完整需批链本批未证明。 |
| 失败即停、身份边界与渠道 | 拒绝后 0 新上游请求、0 控制派发，全部请求已结算，无 unknown。未追加负例、TG、压缩或日用验收；历史回归不计本次改动通过。 |

3. 实际 2 Run / 9 次请求，全部 Serika / returned，按批准的峰时费率快照保守估算 `$0.01017308`，非账单核验；未结算请求与预留费用均为 0，已独立记入 cost-ledger。真实运行后产品增删为 0；审计脚本增量为 `+36/-6`，文档与原始证据不计。两个 Run 额度已用尽，不用剩余请求补新 Run。
4. `pnpm build` 退出 0。真实命令 `SERIKA_B2_RECORD_CONCURRENT_HOME=1 node scripts/test-home.mjs --home /private/tmp/serika-197-stage1-live-guard-c -- node apps/desktop/scripts/chat-run-target-live.mjs --env-file /Users/a1-6/.config/serika/v2-daily.env --run --output /private/tmp/serika-197-stage1-live-c` 退出 1。事后 `node scripts/chat-run-target-stop-audit.mjs /private/tmp/serika-197-stage1-live-c` 退出 0，只表示原件 hash、费用、选择归因及停止证据核对通过，业务仍 failed-pi-task-incomplete。按用户指示未跑离线测试、typecheck 命令、全测、假模型或 smoke。
5. 偏离：新指引与当前采用快照确实到达第 8、9 请求，模型仍重复 discover。不能归因为用户选错、没有可用 Pi、宿主漏采用或提示没有送达；当前证据说明这次提示修复不足，未放宽原话校验。两个隔离 Electron pid 18749、19071 已退出；冻结后保留 Herdr `w-dd9d296c` / server pid 19027 / `/private/tmp/c-krWXBl`，未追加目标回读或控制清理，代理已退出。guard failed / violations=0 / changes=43 / metadataUnchanged=false，不能说日用元数据未变。不合并、不部署，在更新原 #197 后停止。

[原始 failed](evidence/chat-run-target/stage1-live-fc56f36f/result.json) · [独立停止审计](evidence/chat-run-target/stage1-live-fc56f36f/stop-audit.json) · [归档与 hash](evidence/chat-run-target/stage1-live-fc56f36f/archive-summary.json) · [保留现场](evidence/chat-run-target/stage1-live-fc56f36f/retained-processes.json)。[提交核查](evidence/chat-run-target/stage1-live-fc56f36f/submission-verification.json)确认原件未变、费用仅入账一次，真实密钥值及常见前缀扫描均零命中；这些核查不改变业务失败结论。

### 采用前后工具装配协议，2026-10-31

本节先于本轮产品代码写入。继承 fc56f36f 已证明的原生选择、采用和同 Run 推进，不重做其诊断。当前用户动作卡在采用后重复 `discover.requested`；本轮只让已采用目标继续 read/control，完成独立审批、一次派发、本次回读与产物核查。五分钟隔离演示入口为构建后的桌面假模型 fixture：两个 idle Pi，选一次、批准一次，观察同 Run 工具链与回执，外部解析本批产物；任何缺失均失败。

| 宿主 Run 状态 | 发给模型的工具契约 | 执行与失效规则 |
| --- | --- | --- |
| 未采用 | 开放 `herdr_pi_discover`。`requested` 仍须含当前 Run 可核对的用户原话及精确身份字段。 | 原 sourceQuote 校验不变。多候选仍由现有宿主卡阻断并采用，选择不授予操作权限。 |
| 已采用且尚无身份失效证据 | 后续每步移除 `herdr_pi_discover` 整个定义，保留现有 read/control 的严格 action 参数，目标由宿主冻结并带入。 | 同一模型响应中残留的 discover 也在执行入口明确失败 `HERDR_TARGET_ALREADY_ADOPTED`，无发现、改选或派发。不得将错误转成成功。 |
| 真实身份核验失败或已接收同 Run Steer | 现有身份失效流程清除采用、冻结调用并递增 selectionVersion；下步重新开放 discover。 | 旧批准不能派发；候选变化后须重新核对及选择，不静默改发。每次 read/control 继续执行原 Herdr 身份核验。 |
| unknown 或 Run 结束 | unknown 继续冻结；结束清除 Run 局部状态。 | 不自动回读、重发、换目标；不复活旧选择或跨 Run 默认。 |

数据流为 `ForegroundHerdrTargets 当前采用状态 → app catalog 的 tools getter → AgentLoop 每步 prepareContext 后读取 tools → 同步生成模型定义和该步执行表 → 既有冻结/审批/身份核验/派发`。每步在 Steer 处理和上下文准备后读取一次工具名称，模型与执行表共用该次结果。discover 入口按实时状态再次拒绝同响应残留调用。无需 core 新 hook、第二循环或配置格式。

比较两案：仅把 adopted 下的 discover 改为 refresh-only schema，仍给模型一个重新发现入口，与本轮“采用后只走 read/control”不符；选择移除整个 discover。全局注销工具会影响其他 agent/Run，选择沿用现有 definition getter，把工具解析移至每步。read/control 参数不新增目标字段。旧“采用后可 refresh 或直接重新指定”的测试预期随本协议收窄，分别改为稳定采用下不可发现，以及身份失效后才重新发现；原话校验断言不放宽。

本轮任务清单：

- [x] 读 AGENTS、失败原件、pstack/Karpathy 及最小改动、领域状态、类型约束、实物核查原则；只读委派追踪装配与失效路径。
- [x] Ground / Sketch / Agree：写明上述两案、工具契约、数据流与已授权范围。
- [x] Implement：按 Run 状态收窄工具及入口；相关单测与完整假模型链。
- [x] 核查原失败路径、差异与注释；typecheck、全测、桌面及 TG 离线回归。
- [x] 干净源码构建隔离 Electron，假模型 read/control 及原审批观察链；任一关口失败即停。
- [x] 报新真批 Run/请求/费用/渠道/成功断言/停止条件；用户随后“继续”批准本批。
- [x] 获准后隔离真实整链；缺回执不报阶段完成。原 #197 更新为最后工序，完成后停止。

查过旧约束的 Tool side-effect invariants、TUI 单次确认和 Trusted desktop foreground autonomy 条目；本轮不改这些审批/授权规则、Seatbelt 或日用服务。Scrap 仅在当前结构无法表达协议时使用，本轮不预设重构。

#### 契约候选离线与隔离 Electron 结果

1. 改了什么：`ForegroundHerdrTargets.availableTools` 按当前采用/halted 状态删工具，`app` 沿用 definition getter，`AgentLoop` 把模型定义与执行表同步移至每步准备之后。采用后的 discover 入口明确拒绝并删除旧 refresh/重新指定采用目标分支，sourceQuote 验证逐字保留。Electron 假模型检查实际收到的工具名，原生选择脚本关联 click、宿主 accepted、候选完整身份与 selectionVersion=1。真批脚本新增 `--pi-only`，省去已过的真实 Shell 实验。
2. 逐条对照：同 Run 多候选选择、采用后不暴露 discover、read/control、单独批准、一次发送、本次回读与独立文件解析由 `foreground-herdr.test` 完整假模型链通过；身份失效恢复发现、旧批准不可用、拒绝/取消零派发及 unknown 停止也通过。TG 离线链新增工具集合与 read 回执断言，85/85 通过。原生 Electron 44.4.5 / macOS / 原 preload/IPC 假模型 6/6，标准 smoke 8/8，均绑定干净 `bb2508d`。首个成功 Run `527f7d92-ad43-46db-a8c2-b8d82df0e42d` 有 2 候选、原生可信 click、宿主 accepted 恰好 1、selectionVersion=1，工具链严格为 discover/control/read/read_file；控制链关联 runId/toolCallId/approvalId、完整冻结目标/正文、决定来源/接受及恰好 1 次派发。替换和拒绝另有零派发结论，选择取消没有控制调用。真实模型整链、真实 TG 尚未验证。阶段 1 未完成。
3. 相对 `57cb173`，产品代码 `+15/-20`，测试/验证 `+77/-33`，不计本报告与证据。验证增量大于产品，用于跨 step 工具契约、来源拒绝、身份失效恢复及原生选择/审批回执的独立核查。未删测试文件或新增 skip。三项旧预期有意收窄：`discovery blocks … refresh keeps …` 改为采用后 read/get 且每步无 discover；`a new explicit selector revokes …` 改为采用后残留 selector 明确失败、保持原采用；`cached exact pane … on refresh` 改为 read/get 证明身份失效后才能重新发现，保留零派发断言。
4. 实际命令：`pnpm typecheck` 退出 0；隔离 `node --test` 的 runtime/Herdr/权限/loop 相关测试 91/91；隔离 `tsx --test` 的 TG gateway/selection 85/85；隔离 `pnpm test` 1891 pass、7 skip、0 fail/cancelled，均退出 0。`node --check` 两个改动的 Electron 验证脚本、`pnpm build`、`node …/chat-run-target-smoke.mjs --output …`、`pnpm --filter @serika/desktop smoke` 均退出 0；`node …/chat-run-target-live.mjs --pi-only` 零请求预检退出 0。运行日志、随机验证 ID、退出码与 SHA-256 见 [offline-summary](evidence/chat-run-target/stage1-contract-2929bb10/offline-summary.json)、[Electron 原件核对](evidence/chat-run-target/stage1-contract-2929bb10/electron-audit.json) 及同目录 commands/log。单测/全测在改动工作树上运行，Electron 单独绑定干净提交。标准 smoke 原件保存在本批子目录，再还原其既有“最新结果”路径，不覆盖历史批次。
5. 偏离与限制：按用户工序先离线、后隔离 Electron、再等待真批授权；本轮真实请求/费用均为 0。十份写保护记录均 passed、零违规，启用了既有并发元数据记录，metadataUnchanged=false，不声称日用元数据未变。只读审核没有具体 correctness 发现；没有新增注释，注释检查内联完成。Electron 假模型若在提供工具前失败，现有 adapter 会隐藏具体 provider 异常，脚本可能只留等待超时；这不会误报绿，失败时须依原始事件判断，不臆断为选择未推进。保留的 Shell 基线脚本 exit 0 且产物正确，输出另含 `/private/var/select/sh` 的 OS 权限提示；本轮未据此修改 Seatbelt，也不重判已过的真实 Shell。标准 smoke 使用仓库 retired-config fixture。隔离进程已退出、临时 fixture 已清理。密钥前缀扫描零命中，旧 fc56f36f 失败原件未改。本地提交仅为干净源码冒烟及证据检查点，远端 #197 依工序待真实验收后更新。

#### 待授权的真实桌面批次

最多 **1 个宿主任务 Run、24 次总模型请求、$0.25 本地预算**。请求数包括 Serika 和选中 Pi，沿用脚本费率预留与核算，费用不是账单核验。模型为 `deepseek/deepseek-v4.1-flash-fast`；只运行 `chat-run-target-live.mjs --pi-only` 的 multiple-pi 桌面链，原 preload/IPC、隔离目录、两个现有测试 Pi，省去已经通过的 ordinary-cli 真实实验。真实 TG、压缩与日用不在本批范围。通过本批也不能报告真实 TG 通过。

授权“继续”后，仅从上一批已用外部 `/Users/a1-6/.config/serika/v2-daily.env` 在进程内读取模型连接字段，不打印或写入凭据；允许 Codex 原生选卡一次，并独立批准该任务冻结的单次 Pi 操作。成功须核对同 runId 的全部完成定义，包括采用后请求工具定义无 discover、没有无效 requested、选中目标外零输入、操作正文/目标冻结一致、一次派发、本次回读和外部精确核对 `sum=14` 及本批随机 order。缺少任一回执即失败。

任何验证失败、宿主拒绝、工具非成功结果、unknown、目标/适用环境变化、请求/费用上限或未结算调用均停止本批；unknown 立即冻结，不自动回读、重发、换目标或清理现场。真实失败保留原 result/request/response，不追加 Run、不改绿。该预算尚未获准，本轮真调用为 0；按工序等待用户“继续”，再运行真实隔离验收，最后更新原 #197 后停下。

### 真实桌面契约验收，c9a16383，2026-10-31

**阶段 1 的真实桌面整链通过；TG 仅离线回归通过。** 用户“继续”批准前节的 1 Run / 24 总请求 / $0.25 批次，原预算提案保留为历史记录。

1. 改了什么：从干净 `d19be49` 构建真实 Electron 44.4.5，使用原 preload/IPC、隔离 Herdr 与两个 idle Pi，只运行 `--pi-only`。真实执行期间未改产品或验证脚本。结束后新增只读 `scripts/chat-run-target-contract-audit.mjs`，从原请求/响应、宿主事件、回执、Pi JSONL 和产物记录独立核查。本批原始 result 未改，旧失败批次保持原样。
2. 逐项对照如下，完整原件见 [result](evidence/chat-run-target/stage1-live-c9a16383/result.json)、[原件独立审计](evidence/chat-run-target/stage1-live-c9a16383/contract-audit.json) 与 [归档 hash / 写保护](evidence/chat-run-target/stage1-live-c9a16383/archive-summary.json)。

| 完成定义 | 本批真实桌面证据 |
| --- | --- |
| ≥2 idle → 宿主选择 → 接受一次 → 核对采用 → 同 Run | Run `5c18bfbd-93d6-425e-8dac-2aaf672c5002`，两个 idle；Codex 根据本批授权原生点击第二项，可信 click 和 runtime-bridge accepted 各 1；等待期间 0 新模型请求；后续 8 个主请求均带所选完整目标及 selectionVersion=1。 |
| 采用后工具/参数收窄 | 首个主请求有 discover，后续 8 个主请求全部无 discover、保留 read/control；实际 discover 共 1 次，无 requested 冒充原话，无无效调用。未改 sourceQuote 规则。 |
| 单独操作审批、冻结与派发一致 | `call_00_FVRdo5zZ5TTL8n8aovH46779` → approval `c46ee452-4605-45f7-88d4-9803a732c71d` → 完整冻结目标/正文 → 原决定输入与宿主 accepted → dispatched=true。一次控制批准、一次控制调用，Pi JSONL 中唯一输入逐字匹配冻结正文，未选 Pi 零输入。 |
| 本次回读与独立核查 | control 的 verified=false 保留，不将发送 ack 当完成。之后 herdr_pi_read/read 包含本批 order；read_file 原回执与脚本外部解析均得 `{sum:14,order:"c9a16383-blue"}`。回执完整，trace 无缺失/截断。 |
| 拒绝/取消/目标变化与 unknown | 本批正常路径无拒绝、失败或 unknown；零派发负例沿用本候选 6/6 隔离假模型及 runtime 相关测试，不伪称真实负例通过。未追加真实负例或第二 Run。 |
| 渠道与停止范围 | 只测真实桌面；TG 离线 85/85，真实 TG 未测。真实 Shell 不重跑，日用、压缩专项未验收。隔离 Electron 已退出，Herdr cleaned、临时目录删除。 |

3. 数字：实际 1 宿主任务 Run、14 次上游请求，其中主模型 9、Pi 4、compactor 1，均 returned。按原批准的脚本峰时费率估算 `$0.01076272`，非账单核验；未结算调用和预留费用均为 0。费用仅追加一次到 cost-ledger。相对候选 `d19be49`，本次产品改动 0，新增审计脚本 137 行，测试/验收内容未因真实运行结果修改。
4. 实际命令与退出码：隔离 guard 下 `pnpm build` 退出 0；`node …/chat-run-target-live.mjs --pi-only --env-file /Users/a1-6/.config/serika/v2-daily.env --run --output /private/tmp/serika-197-contract-live-c6009e35/live` 退出 0；`node scripts/chat-run-target-contract-audit.mjs …/live` 退出 0。两份 guard passed、零违规，metadataUnchanged=false，不声称日用元数据未变。14 对原始请求/响应、截图、result 的 SHA-256 和累计费用均独立核对，密钥常见前缀扫描零命中。产品与先前全测/假模型候选相同，本次未重复全测或追加真调用。
5. 偏离与观察限制：一次最初只读提取器误把第 14 个 compactor 请求当主请求，访问必填 tools 报 KeyError，已暂停结论并只读确认用途；正式审计明确要求每个主请求含 tools，仅识别到的 compactor 可无 tools，其费用仍计入总额。独立复核的附加严格毫秒先后断言也不适用，宿主决定与 tool.startedAt 均为 `08:06:53.207Z`；Pi 唯一实际输入为 `08:06:53.605Z`，晚于批准。未改原始时间，未臆造审批 AgentEvent sequence，未追加 Run。只读复核最终未发现桌面完成定义缺口。按最小改动/实物核查原则保留上述原件和 verified=false，以完整链条作结论；本轮只更新原 #197，不合并、不部署日用。
### 真实 Telegram 补验协议，2026-10-31

本节先于 TG 验收脚本写入。桌面 c9a16383 的 PASS 及既有离线关口沿用。本批仅补真实 TG，最多 1 宿主 Run、24 总模型请求、$0.25 本地核算，包含 Pi 与辅助请求；费用沿用桌面脚本的冻结费率，非账单核验。用户已明确允许从 `/Users/a1-6/.config/serika/v2-daily.env` 在进程内取所需连接字段，并临时停用及恢复日用 TG 接入；不替换或重启日用宿主。

执行顺序为：本地确认日用空闲及 TG 当前状态 → 原 resident API 关闭日用 TG 并等待轮询结束 → 原 DesktopRuntime、TelegramStore、TelegramGateway 与 Bot API 在独立临时目录启动 → 用户真实私聊 `/start <配对码>`，核对与日用已绑定账号一致后原 confirmPairing 接受 → 用户发送本批任务一次 → discover 至少两个 idle Pi → TG `选择 <短码> <序号>` 一次 → 原 selectHerdrTarget 接受且同 Run 采用 → 后续主请求不含 discover、read/control 取宿主目标 → TG 独立批准冻结操作 → 派发一次 → 原 Run 回读和独立读取产物 → 外部核对 Pi JSONL 与本批文件 → 关闭隔离 TG，核对停止后恢复原日用 TG。日用绑定、权限及配置不复制到隔离授权；隔离绑定走真实配对，不手造入站更新或成功回执。

留证包含真实 Bot API 收发的消息号与入站更新、原 runtime-bridge 的选择/审批 accepted、runId/toolCallId/approvalId、冻结完整身份/正文/version、原工具结果、全部模型请求/响应及 SHA-256、用量、Pi 转录和产物。只归档当前配对及任务的消息，排除无关历史。Telegram 的 submitted 仅证明 API 接收，入站选择及批准另证用户动作。read_file 若需确认仍经 TG 逐次批准，不启用 TG 目录免确认授权。

成功必须同 runId、有效选择恰好一次、selectionVersion=1、采用后无 discover、独立操作批准恰好一次、控制派发恰好一次、冻结/批准/发送一致、未选目标零输入、回读含本批随机标识、外部产物精确一致，且每个 accepted 审批有派发或明确未派发结论。失败、拒绝、取消、身份变化、unknown、费用或运输不确定、预算触顶立即冻结，无新 Run。unknown 后不自动回读、重发、换目标或控制清理；通道隔离与日用恢复仍按原设置 API 完成，不重放隔离期间消息。已处理消息的 TG 游标须由真实 getUpdates 回应确认；必要时仅作一次通道交接确认，不转交其中新消息、不调用模型或工具，确认未知则停止恢复并报告，避免日用重放。日用现有 3 条历史 unknown 投递只记数量，不复制、不重发，不归入本批结果。失败原件保持失败。本批无桌面链重跑、真实 Shell、日用部署、合并或 Seatbelt/授权修改。

### 真实 Telegram 补验，d5a887cd，2026-10-31

**本批失败，真实 TG 未通过；已停，未追加 Run。** 用户明确批准 1 Run / 24 请求 / $0.25，并允许临时关闭及恢复日用 TG。沿用桌面 c9a16383 PASS，不重跑桌面链。

1. 改了什么：先写 TG 协议，再新增 `chat-run-target-telegram-live.mjs`，原 DesktopRuntime / TelegramStore / TelegramGateway / Bot API 在隔离 Node 26.4.0、macOS 进程运行，非 Electron 验收。保持原配对和原短码，模型走有总预算拦截的真实代理，两个隔离 idle Pi 已准备。预备整链 auditor 未运行；失败后仅新增只读 stop auditor，未修产品、未修后重跑。运行源码为干净 `935294e`。
2. 逐条对照如下。原始 [failed result](evidence/chat-run-target/stage1-telegram-d5a887cd/result.json)、[停止核查](evidence/chat-run-target/stage1-telegram-d5a887cd/stop-audit.json)、[日用恢复核查](evidence/chat-run-target/stage1-telegram-d5a887cd/daily-restoration-check.json)、[归档 hash / 凭据扫描](evidence/chat-run-target/stage1-telegram-d5a887cd/archive-summary.json) 保留。

| 本批完成定义 | 实际证据与缺口 |
| --- | --- |
| 真实 TG 配对及任务源 | 日用空闲、online；原 resident API 关闭 TG，隔离网关 online 并生成配对码。收到一个 updateId=414513485 / messageId=656 的入站 envelope，未通过验收脚本的入站账号/类型或文本白名单校验，未交 gateway.receive。隔离 owner=null、inputs=0；用户反馈“配对失败”。未建立绑定，未启动任务 Run。 |
| 同 Run 发现≥2 → 短码选一次 → 采用 → 采用后无 discover | 未到达；仅隔离环境预备两台 Pi，不算宿主 Run 内发现或 TG 选择成功。桌面结论及离线回归保持原结论。 |
| 单独批准 → 冻结目标/正文 → 一次派发 → 回读/独立产物核查 | 全部未到达；审批事件、工具事件和模型请求均 0，两台 Pi 本地转录均无用户输入。没有完整操作审批链，不能报告真实 TG 验收通过。 |
| 失败即停 / 恢复 | 入站校验失败后 0 上游请求、0 新 Run、0 Pi prompt；没有追加重试、目标回读或控制清理。隔离 TG 于 16:32:37 +08:00 停止，日用 TG 于 16:32:39 +08:00 恢复。事后只读 resident 查询仍 enabled=true / online，原 pid=36769、绑定及配置 SHA 一致。日用历史 unknown 投递 3 条前后相同，未复制或重发。 |

3. 实际用量 0 宿主任务 Run / 0 模型请求 / $0，未结算 0；费用账只增加本次零支出失败尝试，不改变累计费用。产品增删为 0；验证脚本新增 526 行、删除 0 行，不含文档与证据；验证脚本及报告用于真实 TG 原路径留证，既有全测、离线 TG、假模型、隔离 Electron 结论按用户要求沿用，不重跑桌面或全套关口。
4. `node --check` 两个预备脚本及零请求 import 预检均 exit 0。准备时 `git diff --check` 发现报告末尾空行，删除多余空行后 exit 0，未进行真实调用。真实命令 `node --import ./apps/desktop/node_modules/tsx/dist/loader.mjs apps/desktop/scripts/chat-run-target-telegram-live.mjs --run --daily-pid 36769 --output /private/tmp/serika-197-tg-live-20261031-a` 写出 failed。finally 重复 close Telegram dispatcher 导致 `ClientDestroyedError`，日用恢复已完成；宿主残留进程 pid=96438 随后 SIGTERM 退出 143，未改原 result。`node scripts/chat-run-target-telegram-stop-audit.mjs /private/tmp/serika-197-tg-live-20261031-a 96438` exit 0 仅表示失败停止、零派发与恢复事实核对，不是业务通过。
5. 偏离和观察缺口：首次入站校验只归档 envelope，未归档被拒 payload 或确切失败谓词，无法区分账号、消息类型、文本不符，不能归因为用户发错、TG 产品配对缺陷或网络问题。预备整链 auditor 也未被业务证据执行证明，其中 TG multipart 的投递核对仍需按原 parts/messageId 对照，不能声称该检查器已可验收。本轮不修后复验。按 Prove It Works 核对原件及现场，按 Sequence Work into Verifiable Units 停在失败关口；reviewed inline，未使用额外审核模型。注意事项为入站诊断缺口、重复 close 导致进程收尾失败，以及未运行的整链检查器。保留 `/private/tmp/tg-quC2af`、Herdr `w-83ae148e` / pid=96476 现场，无自动目标清理。不合并、不部署日用、不改权限、沙箱或 Seatbelt。

### TG 入站可观测修复协议，2026-10-31

本节先于修复代码写入。当前只修验收 harness，不发真实 TG/模型请求，不改日用接入，不重跑桌面链。任务顺序为：已读 AGENTS/pstack 与相关原则 → 定位原谓词并恢复指定 update 的已有本地记录 → 原条件零网络复现 → 写下诊断/关闭/游标契约 → 最小 harness 修复及原网关离线证明 → 报新预算并等待指定授权。按 bug-fix playbook 的复现、查因、实现、同路径验证执行；只读代理审核 harness，敏感本地记录由主线程定点读取；不进行真实重跑。

接口草图为 `inspectTelegramInbound({update, context, binding, redact}) -> {update, normalizedText, predicates, failedPredicate, bindingBefore, bindingAfter, forwarded}`。每个 update 在交网关前归档脱敏全文、poll/批内位置、逐项 expected/actual/pass、当前 owner/proposed/thread/offset/run；任一失败先写 result，再停止并最终写入独立 stop-audit。被拒项 bindingAfter 即未转交时的实际状态；通过项在原 receive 前后各取实际状态。保留所有失败条件，不仅记录第一项，不裁剪正文。相较仅在 catch 打异常，这种记录能区分账号、类型、文本、阶段及批内阻断，不需要改产品规则。消息文本与原网关一样 trim，配对/任务/控制按当前阶段匹配，undefined 不能当作任务。

关闭由 `DesktopRuntime.shutdown()` 单一拥有，harness 不再先 close 同一 gateway。恢复前交接游标取原 store.offset 与全部已观察更新的 max(update_id+1)，记录请求和真实确认回应，必须确认后才恢复日用。被拒且未进 receive 的当前 owner 私聊文本也必须计入交接；不归档或转交其他日用内容。无法确认身份/游标的更新使恢复阻断并报告，不盲目丢弃或把测试控制文本交日用执行。

历史补充证据单独归档，不改 d5a887cd 原 result/stop-audit：恢复后的日用记录保存 update=414513485/message=656 的文本“继续，允许临时停用并恢复日用 TG 接入。”，足以复现原文本白名单拒绝；它不是配对命令。恢复后同一记录又绑定日用 Run 94c5e58f-8199-4168-987b-43db4b829904，已有回执显示 completed、1 个主模型步骤、无工具，原隔离代理零请求不能覆盖该额外请求。新证据是事后本地 journal/receipt，不冒充旧 Bot API payload。旧批具体原始 first-failed predicate 与消息发出时间仍不可重造；不推断用户错误、thread 错乱或 token 争用。最小修复保持拒绝此非配对消息，并防止恢复后重放。

重跑前同时消除已知 harness 检查器误判：原网关 `#parts/#flush` 保存 HTML 分片及每片 messageId，整链 auditor 应逐片匹配相同 chatId/messageId/正文/HTML 和 submitted 状态，禁止拿未编码原文匹配最后一片回执。用离线原网关配对发送取得实际 parts/transport，证明旧比较失败、新比较通过及缺片拒绝；此项不改变产品投递或 TG 权限。原网关本身的整链真 TG 仍须下一批证明。

审批数量按控制链的冻结快照计数，与 live driver 一致；read_file 的逐次批准继续由完整 approvalChain 与 TG 来源检查核对，不混算成第二次 Pi 控制批准。离线同时覆盖文件批准与控制批准，旧全审批计数断言应复现误红。

### TG 入站修复离线结果与下一批预算，2026-10-31

1. 改了什么：仅修改验收脚本。`telegram-inbound.mjs` 逐条保存脱敏全文、全部谓词及 expected/actual、首个失败条件、转交标记、绑定前后状态；失败自动写 stop-audit。live 按阶段校验并与原网关一致 trim；关闭仅由宿主拥有。交接游标包含未转交的被拒消息，只有已确认的当前 owner 消息可确认游标；身份不符、运输未知或确认返回新消息时保留全文并阻断自动恢复。success auditor 逐片核对 HTML 投递，并将独立文件批准与单次控制批准分别计数。查过旧约束的 Tool side-effect invariants、模型用量估算、Trusted desktop foreground autonomy/TG 信任，未改产品、审批规则或 Seatbelt。
2. 逐条验收对照见下表。新证据 [verification](evidence/chat-run-target/stage1-telegram-inbound-6caea55d/verification.json)、[原条件复现](evidence/chat-run-target/stage1-telegram-inbound-6caea55d/before.json)、[拒绝原件对](evidence/chat-run-target/stage1-telegram-inbound-6caea55d/offline-reviewed/rejection/stop-audit.json)、[历史恢复证据](evidence/chat-run-target/stage1-telegram-inbound-6caea55d/journal-recovery.json)、[日用回执摘录](evidence/chat-run-target/stage1-telegram-inbound-6caea55d/daily-replay-recovery.json) 与 archive-summary 绑定 hash。

| 本轮要求 | 结果与证据 |
| --- | --- |
| 拒因可复现、全文/谓词/绑定落盘 | 已做：恢复出的指定 update/message 文本执行原谓词，得到 `Unexpected text; no additional Run permitted`；新 `recovered non-pairing text persists...` 保存完整脱敏消息、`text_matches_phase` 及 before/after，result 与 stop-audit 原件 hash 可核验。原始 Bot API payload 与历史 first-failed 谓词仍缺，不能从新 fixture 补造。 |
| owner/thread/token 争用等归因 | 已做定点核查：journal 指定记录匹配当前 owner，消息文本不符本身足以复现拒绝；现有证据不支持归因用户错误、产品配对缺陷或 token 争用。原 gateway 离线实际接受 trim 后配对并建立绑定。 |
| 重复 close 与恢复重放 | 已做：原 gateway + 实际 ProxyAgent 在禁止网络 transport 下，宿主 shutdown 后 dispatcher close=1、模型/网络=0，子进程正常退出。`handoff` 用例证明旧 offset 414513485 不足，须确认到 414513486；陌生/畸形及交接返回新消息阻断恢复。真实 Bot API 交接未重测。 |
| 审计误红及早失败计账 | 已做：生产 formatter 的 HTML 转义/多片两例旧比较均 false，新核对通过、缺片拒绝；控制+文件两个独立批准均保留结论，控制数=1；早失败 receipt 中的 runId 也计入 stop-audit。 |
| 历史零费用说法纠正 | 隔离侧仍为 0；恢复日用后同消息进入 `94c5e58f-8199-4168-987b-43db4b829904`，completed、1 主模型步骤、0 工具。按冻结费率由实际用量复算 $0.009668，非账单核验，单独补账。本轮新真 Run/请求/费用=0。旧 result/stop-audit 均未改绿或重写。 |
| 真 TG 完成定义 | 没做：本轮只到离线关口，未临停日用或调用真实 TG。真实短码→同 Run 采用→无 discover→独立控制批准→一次派发→回读/产物仍待下批；桌面 PASS 保留。 |

3. 前后数字：产品代码 +0/-0，harness +207/-97，测试 +175/-0，不含文档/证据。测试超过产品行数，因为本次修复与复现均在验证脚本。入站/审批最终 7/7，受影响 TG 回归 85/85；两次写入守卫 passed、违规 0；先一次 changes=104、metadataUnchanged=false，最终一次 changes=0、metadataUnchanged=true，不以最终结果覆盖先一次的元数据变化。证据源码为 e6804b5 加 verification 中各脚本 SHA，sourceWorktreeDirty=true，属于离线修复证据，不能冒充干净候选真链。
4. 实际命令和退出码：`node scripts/test-home.mjs --home /private/tmp/serika-197-tg-inbound-guard -- /bin/sh -c 'node --test apps/desktop/scripts/chat-run-target-telegram-inbound.test.mjs apps/desktop/scripts/chat-run-target-approval.test.mjs && pnpm --filter @serika/desktop exec tsx --test src/main/telegram-herdr-selection.test.ts src/main/telegram-gateway.test.ts'` exit 0，早一版局部 6/6 与 TG 85/85；最终追加检查后，经 final-guard 执行两个局部测试文件为 7/7、exit 0。`pnpm typecheck` exit 0；七个脚本 `node --check`、live 零请求 import preflight、两对 stop-audit CLI 核查、`git diff --check` 均 exit 0，原始 stdout/命令在新证据中。首次新增子进程测试曾因 `ai/test` 解析路径错误失败，停止该验证、修成包内 createRequire.resolve 后通过，未改业务断言或重跑真批。
5. 偏离和下一步：按当前用户范围沿用既有全测/假模型/隔离 Electron，不重跑桌面整链。按 Fix Root Causes 保留拒绝非配对文本并修交接重放；按 Prove It Works 保存原件对、实际网关关闭与生产 formatter 证据。只读代理最终核对源码，无额外 Serika 调用。完整 success auditor 尚未在真实 TG 成功原件上执行，不能宣称真链通过。

下一批预算申请为 **≤1 宿主 Run／24 次总模型请求／$0.25**，包含 Serika、选中 Pi 与辅助模型请求，全部计入同一上限，沿用已冻结费率并预留费用。渠道仅真实 TG 私聊 + 隔离 Pi，原 Node DesktopRuntime/TelegramGateway；不测桌面整链或日用部署。仅在用户明确回复“继续，允许临时停用并恢复日用 TG 接入”后临停/恢复原日用 TG，取现有外部 env 的必要字段，不重启宿主。

成功须同 runId：发现≥2 idle → TG 短码接受选择恰好一次 → selectionVersion=1 并采用 → 后续请求无 discover → 独立操作批准且 runId/toolCallId/approvalId、冻结目标/正文、决定来源/宿主接受与派发结论完整 → 只发一次 → 本次回读与独立产物一致，未选目标零输入。文件读取等其余批准逐条保留，不算 Pi 操作批准。拒绝、取消、身份/环境变化、任何验证失败、unknown、未结算或预算到顶立即停；unknown 不自动回读/重发/换目标，不追加真 Run，日用恢复必须先确认隔离停止及交接游标。通过后再更新 #197 并停下等用户决定合并；当前不合、不部署、不扩授权。

### 真实 TG 批次 2856460a，2026-10-31

**配对等待超时，失败即停；真实 TG 未通过。** 用户在本对话批准 ≤1 Run／24 请求／$0.25 及临停/恢复日用 TG，明确授权句不作 TG 入站任务。本批未代发授权句或任务，实际收到 0 条 TG 更新。

1. 改了什么：使用干净候选 `edd5aef` 原 harness 运行，未改产品或脚本；仅追加本次原始失败证据与零支出账目。隔离原 Node DesktopRuntime/TelegramGateway、真实 Bot API 和两台 Pi，非 Electron 验收。
2. 逐条对照：真实配对未完成，隔离 owner=null、inputs=0、inboundChecks=0，确切停止条件为 `Timed out: real Telegram pairing`；没有被拒消息，不能以空数组证明拒因观测真路径已跑过。同 Run 发现、TG 短码选择、采用后工具收窄、独立操作批准、单次派发、回读及产物核查均未到达，不能报阶段完成。两台 Pi 转录核查各为 0 用户输入。隔离宿主/TG 均在 19:38:16 +08:00 停止，日用 TG 在 19:38:17 +08:00 恢复，交接 offset=414513487 已确认；无重复 close 异常，errors=[]。只读 resident 复核原 pid=36769、idle、enabled=true/online、pending=0、review=0、配置 SHA 未变，历史 unknown 仍为 3。完整原件见 [result](evidence/chat-run-target/stage1-telegram-2856460a/result.json)、[stop-audit](evidence/chat-run-target/stage1-telegram-2856460a/stop-audit.json)、[恢复复核](evidence/chat-run-target/stage1-telegram-2856460a/daily-restoration-check.json)、[归档与 Pi 零输入核对](evidence/chat-run-target/stage1-telegram-2856460a/archive-summary.json)。
3. 前后数字：本批 0 宿主 Run／0 模型请求／$0，未结算 0，账目只追加零支出失败条目；产品/脚本/测试 +0/-0。沿用桌面 PASS、离线 7/7 和 TG 回归 85/85，不重做桌面整链。
4. 实际命令与退出码：`node --import ./apps/desktop/node_modules/tsx/dist/loader.mjs apps/desktop/scripts/chat-run-target-telegram-live.mjs --run --daily-pid 36769 --output /private/tmp/serika-197-tg-live-20261031-b` exit 1，按失败正常收尾，无强制终止；`node scripts/chat-run-target-telegram-stop-audit.mjs /private/tmp/serika-197-tg-live-20261031-b` exit 0 仅核对失败原件。只读恢复核查与归档 hash/凭据前缀扫描 exit 0，四份原件逐字复制，result SHA 不变。
5. 偏离与限制：配对窗口内无入站更新，无法从现有证据判断消息是否发送或为何未到达，不能归因用户、网络或产品缺陷。失效配对码已明确撤回使用提示。按失败即停保留 `/private/tmp/tg-VpxiGx` 与 Herdr `w-d6ec34ab` 现场，不自动重跑、清理目标或烧额度。按 Prove It Works 只报告实际恢复与零输入；按 Sequence Work into Verifiable Units 停在配对关口。本批未通过，不更新 #197 为通过状态，不合并、不部署、不扩授权或修改 Seatbelt。

### 配对时机修复协议，2026-10-31

补充只读核对发现：日用 journal 中 `/start E5DC0CF764` 于 19:44 +08:00 收到，晚于本批 19:38 恢复日用。该消息 rejected、runId=null，关联投递正是“未识别的控制指令”。原网关仅在未绑定且当前配对码有效时接受带码 `/start`；日用已绑定时落入未知 slash 指令拒绝分支。这证明该回复来自恢复后的日用路径，不证明隔离配对本身失效。只读取指定配对码，不查其他聊天或发起网络请求。

本轮先改 harness，不启动真批。任务为：已读 pstack/Karpathy、复核时间线与原入口 → 比较方案 → 写协议/接口 → 最小改动 → 离线原网关验证 → 留本地检查点并等手机就绪及新批授权。两种方案中，延长等待不能延长产品五分钟码且仍会提前停日用；采用本批 stdin 一次性就绪握手，无文件残留或新网络入口。

接口为 `waitForTelegramPairReady({input, batchId, signal, record})`：读取唯一精确行 `pair <batchId>`，记录 waiting/accepted/failed 时间与匹配；错误批次、EOF、取消/原等待上限到期均失败。该信号只协调当前已授权批次，不能授予模型/工具/日用接管权限。主线程须先收到当前对话手机就绪确认，再写入，用户不向 TG 发此信号。

数据流为本地 host/gateway 准备好且隔离 disabled、owner=null → 等就绪，日用继续 online → 重查同 PID/identity、idle、online、owner/Thread、pending/review、配置 hash → 临停日用并确认 disabled/idle → 读最新 cursor → 启隔离并生成原五分钟码 → 原配对与任务流程。等待超时沿用原 300000ms，不新增产品期限；不自动续码、不复制日用绑定或放宽审批。等待失败时 dailyPaused=false，宿主只关闭自身；readiness 状态同样进入失败 stop-audit。

### 配对时机修复结果，2026-10-31

1. 改了什么：新增 `chat-run-target-telegram-pairing.mjs` 的本批精确 stdin 握手，live 在临停日用前等待并重查日用；两个 auditor 保留/核对握手时序。产品配对、五分钟有效期、绑定和工具授权不变。按 Laziness Protocol 选择 stdin，不增加控制文件或网络服务；按 Prove It Works 用原网关与真实本地 PTY 分别核对。
2. 逐条对照：已做 `pair readiness rejects...`，错批次/EOF/输入错误/取消均记录失败；已做原网关 lifecycle，等待前 disabled/无绑定/无配对/零发送，假时钟推进 11 分钟仍无配对码，握手后才生成且 TTL=300000ms、原配对成功、host 唯一 close、模型/网络均 0。11 分钟是假时钟证明，不表示真实 readiness 可等待 11 分钟，真实 readiness 超时仍为原五分钟。真实 PTY 的 waiting→本批 stdin→accepted→进程 exit 0 另存证据。未做真实 TG 重试或日用临停，既有桌面 PASS 与 TG 回归 85/85 沿用。新增 [离线证据](evidence/chat-run-target/telegram-pair-ready-333576e2/verification.json)、[迟到消息定点记录](evidence/chat-run-target/telegram-pair-ready-333576e2/late-start-recovery.json)、[PTY 握手](evidence/chat-run-target/telegram-pair-ready-333576e2/pty-result.json)，旧失败 result/stop-audit 未改。
3. 数字：产品 +0/-0、harness +49/-1、测试 +36/-3，不含报告和证据。测试行数超过产品，因为只改验证协调路径。局部 8/8，写入守卫 passed、违规/变化均 0、metadataUnchanged=true；新真实模型/TG 调用及费用均 0，未追加费用条目。
4. 命令：守卫下 `node --test apps/desktop/scripts/chat-run-target-telegram-inbound.test.mjs apps/desktop/scripts/chat-run-target-approval.test.mjs` exit 0；`pnpm typecheck` exit 0；五个改动脚本 `node --check`、live 零请求 import preflight、两个 stop-audit 原件对检查、`git diff --check` 均 exit 0。本地 `node /private/tmp/serika-197-tg-pair-ready/pty.mjs` 经真实 PTY 写入精确本批命令后 exit 0，全程无 TG API。日志、各源码 SHA 和归档 hash 可复核。
5. 偏离与下一步：用户问如何解决接入，当前只修可证明的窗口错位，不将离线握手宣称为真实接入成功，不扩到产品配对改造。下一真批必须先在本对话确认手机已打开 Bot 且就绪，再按既定新批授权启动 `tty=true` 的 harness，看到 pair-ready 后才写本批协调命令。随后给用户新 `/start`，配对接受后才给真实任务正文；授权句/协调命令不发往 TG。仍为 ≤1 Run／24 总请求／$0.25，失败即停，不重做桌面链、不合、不部署、不扩授权。当前保留本地检查点，等待手机就绪及真批授权。

### 专用测试 Bot 通道协议，2026-10-31

本节先于代码。用户已批准替换验收通道策略：专用测试 Bot、独立固定外部 env、首次配对后复用测试绑定；验收期间不临停、不接管、不连接日用 Bot。本地三提交已先推送。当前只做离线适配，完成后报 ≤1 Run／24 总请求／$0.25 并等“继续”才真跑。

任务清单：已读 AGENTS、pstack/Karpathy、相关原则与现有网关/存储/fixture 数据流 → 写协议及接口 → 单一代码 owner 修改耦合 harness/验证 → 主线程核对实际 diff → 离线原网关配对/重启复用及日用零访问证明 → 预算报告并推送。阻塞先处理：先 push 旧提交，再修改；独立工作流：主线程维护协议/证据，代码 owner 独占 harness/测试/auditor；共享状态：测试 profile/env 与日用分离，单一测试宿主持有本批租约；最小拆分：只调整验证脚本，不改产品、桌面入口或沙箱。

调用草图：`loadTelegramTestSettings({envFile, forbiddenBotId}) -> {credentials, botId, owner, profileRoot, runtimeRoot}`，外部默认 env 为 `/Users/a1-6/.config/serika/chat-run-target-telegram-test.env`；`prepareTelegramTestProfile(settings) -> {applicationHome, configPath, workspace, lease}`。配置包含显式 test-only 标识、预期 Bot ID、私聊 user/chat ID、测试模型连接字段；凭据只在内存，模板可入库，真实 env/profile 不入库。token 的 ID 与预期 Bot ID 必须本地一致，且不得等于仓库旧批 2856460a 原件中的共用 Bot ID；实际 getMe 再核对预期身份。只读仓库旧证据作拒绝依据，不读取日用 env、resident、journal 或配置。

比较两种持久化方案：每批复制绑定会伪造/迁移信任；采用固定隔离 applicationHome/config/工作目录，原 TelegramStore 保存首次真实配对的 owner/Thread/offset。Pi fixture 使用固定 `/private/tmp/` runtime 路径，每批全新建立，成功后清理 fixture，profile 在其外保留；失败现场保留并阻断下一批覆盖。只复用渠道绑定，不保存跨 Run Pi 目标或批准。第二次启动必须核对 Bot/owner/Thread 注册及空闲、无待处理/unknown，不自动恢复执行；测试 profile 单宿主租约避免双重轮询。

首次 `pair-ready` 后原 beginPairing→真实用户私聊→原 confirmPairing；复用时跳过配对，断言 owner/Thread 不变。每批预先设置唯一带 batch 随机标识的任务正文，再开启测试 Bot 轮询，按 store 初始 inputs/deliveries 快照计算本批增量，避免旧记录影响“一次任务/一次选择”断言。保留原全文脱敏拒因/绑定 before-after、host 唯一 close、所有已观察 update_id+1 的交接确认；交接只作用测试 Bot，未知或未确认阻断后续测试，不恢复任何日用接入。report/auditor 明确标记 dedicated-test-bot、首次/复用、持久绑定与本批快照，不再要求 daily restore 字段。

离线证明须经过原 DesktopRuntime/TelegramGateway/TelegramStore：首次消息进入原配对并持久化，关闭/重建后原绑定与 Thread/offset 复用且无需新码、无 Run 目标配置；被拒消息及确切谓词仍可落盘；所有 transport 都是显式假 transport，真实 fetch 禁止，测试全过程日用路径零读写、零 resident 连接。桌面 PASS 与采用后 discover 收窄不动。真实 TG 是否完整成功仍由下一批原件证明。

失败收尾保留关闭前的完整 store/Run 回执，关闭后再次读取完整 store/本 Run 回执并分别写入 stop-audit。最终读取失败记录独立阶段，不以关闭前 running 状态冒充最终结论；不触发重放、自动回读目标或第二次派发。

### 专用测试 Bot 离线结果，665b6966，2026-10-31

1. 改了什么：`telegram-live` 删除日用 resident/env/暂停/恢复装配，新增 `telegram-profile` 校验独立固定路径、历史日用 Bot 拒绝和原 flock 租约，复用原 TelegramStore 绑定与注册 Thread。每批随机任务先装配再启轮询，input 增量排除历史，确认 cursor 后持久化。两个 auditor 改验专用通道，失败保留关闭前后完整 store/Run 回执。只改验收脚本和模板，产品、桌面 PASS、sourceQuote、采用后 discover 收窄、审批与 Seatbelt 均未改。查过旧约束 Tool side-effect invariants 和 Trusted desktop foreground autonomy，未将桌面权限传给 TG。
2. 逐条对照：已做 `original gateway persists its first pairing...`，原 DesktopRuntime/Gateway/Store 首次配对→关闭→新宿主复用同一 owner/Thread/offset=2，无第二次配对、无跨 Run 目标配置；两个宿主 close 各一次。已做 `dedicated settings reject...`，拒绝日用 Bot、并发宿主、残留 runtime 和写入前的 symlink；拒因/脱敏全文/绑定前后落盘及游标确认沿用本轮重跑 inbound 测试。已做关闭前 running／关闭后 cancelled 的 stop-audit 字段 fixture，属于审计落盘验证。子进程模型/真实网络/日用路径访问均 0，守卫零违规且元数据未变。真实 TG 发现≥2→短码选一次→采用后无 discover→单独操作批→发一次→本次回读＋独立核查、完整审批链及未选目标零输入均**未做**，等下一真批。证据见 [verification](evidence/chat-run-target/telegram-dedicated-665b6966/verification.json)、[原网关重建复用](evidence/chat-run-target/telegram-dedicated-665b6966/offline/dedicated-original-gateway-reuse.json)、[拒因 result/stop-audit 对](evidence/chat-run-target/telegram-dedicated-665b6966/offline/rejection/stop-audit.json)。
3. 数字：相对 `231dae1` 产品 +0/-0；harness/模板 `+230/-111`，测试 `+97/-1`，不含报告/证据。测试增量超过产品，因为本轮专门修验收隔离与持久化证据，不新增产品能力。相关单测 10 pass、0 fail/skip；typecheck 通过。全测 1891 pass/7 skip、TG 回归 85/85、隔离 Electron 假模型 6/6 与标准 smoke 8/8 沿用已接受候选，未重跑桌面整链。新真实 Run/模型请求/TG API/费用均 0，未追加已花费账目；三份历史真实批 result hash 与 HEAD 相同。
4. 实际命令：`pnpm typecheck` exit 0；守卫下 `node --test apps/desktop/scripts/chat-run-target-telegram-profile.test.mjs apps/desktop/scripts/chat-run-target-telegram-inbound.test.mjs apps/desktop/scripts/chat-run-target-approval.test.mjs` exit 0。六脚本 `node --check`、live 零请求 import preflight、新旧失败原件 stop-audit 只读核对、`git diff --check` 最终均 exit 0。`--check-settings` exit 1 是外部配置缺失前置条件，0 TG/模型调用；Bot ID、固定模型地址/型号已在外部 env 本地补入，仍缺 `SERIKA_TG_TEST_OWNER_USER_ID`、`SERIKA_TG_TEST_OWNER_CHAT_ID`、`COMMAND_CODE_API_KEY`，见 [配置预检](evidence/chat-run-target/telegram-dedicated-665b6966/settings-after-local-fill.json)。真实 env、token、key、profile 不入库。
5. 偏离与限制：独立复核发现失败关闭后缺完整最终快照，已先补协议再补写入及 fixture。复核旧 d5a887cd 原件时，旧 audit 无 binding/receipts/inbound 字段导致 CLI 检查依次报错；三次失败输出保留在本目录 `legacy-audit-*.json`，只修审计可选字段读取，缺失拒因数输出 null，不补造原件或改绿。最终只读检查通过仅表示原件/hash 一致，旧批仍为失败。按 Separate Before Serializing Shared State 拆开 Bot/profile，按 Laziness Protocol 删除接管路径，按 Prove It Works 实跑原网关重建。固定 env 已由用户提供路径，真实身份/连接尚未核验。下一真批仍需配置预检通过及用户“继续”，本轮不合并、不部署、不临停日用。

#### 下一真实 TG 批次预算，待“继续”

最多 **1 宿主任务 Run／24 次总模型请求／$0.25 本地核算上限**，含 Serika、Pi 和辅助请求，沿用已冻结脚本费率，非账单核验。渠道仅 `@serika197_test_4225_bot`＋固定测试 env/profile＋两个隔离 Pi；首次真实配对保留渠道绑定，后续只复用该绑定，Pi 选择/操作批准每 Run 重新产生。用户在 TG 发真实任务正文、选择短码及独立批准，当前对话授权句不作入站任务。

成功必须同 runId 发现≥2、有效选择恰好一次、selectionVersion=1、采用后请求无 discover、独立操作批准/派发各一次、冻结目标/正文一致、未选 Pi 零输入、本次回读和独立产物核查完整，审批链贯穿 runId/toolCallId→approvalId→冻结→决定/宿主接受→派发或明确未派发。拒绝、取消、目标/环境变化、任何验证红、unknown、运输/用量不确定、预算上限立即冻结；unknown 不自动目标回读、重发或换目标，失败保留现场，不追加 Run。真实 TG 通过后更新 #197 并停下，合并另等用户决定。

### 专用测试 Bot 真批启动失败，74ccfd3f，2026-10-31

1. 改了什么：用户随后“不要看预算直接测试”授权启动已报批次，上限保持脚本既定值。启动干净 `e75e0de` 的原验收脚本，未改产品或 harness。准备阶段已在测试 env 补入系统现有 HTTP 代理 `127.0.0.1:7897`，原 Bot API getMe/getWebhookInfo/getUpdates 成功，核对专用 Bot 身份；用户发送唯一标识准备消息后取得 user/chat ID，准备消息完整保存且通过空响应确认游标，未送模型。真实 env/token/key 不入库，未读取或连接日用。
2. 逐条对照：本批停在 `chat-run-target-live-herdr.mjs:setup` 的服务 readiness 断言，服务器原日志为 `local socket name length exceeds capacity of sun_path of sockaddr_un`。固定 runtime 根目录 `/private/tmp/serika-chat-run-target-telegram-test-runtime` 下的隔离 HOME 使启动触及本地 socket 路径限制；尚未执行任何 workspace/Pi 创建操作，state.operations=[]，服务进程已退出。TG 真实配对、发现≥2、一次短码选择、同 Run 采用、采用后无 discover、独立操作审批/完整批准链、发送一次、未选目标零输入、本次回读和独立产物核查均**未到达**，阶段 1 TG 未完成。原件见 [result](evidence/chat-run-target/stage1-telegram-74ccfd3f/result.json)、[stop-audit](evidence/chat-run-target/stage1-telegram-74ccfd3f/stop-audit.json)、[server.log](evidence/chat-run-target/stage1-telegram-74ccfd3f/server.log) 与 [独立归档核对](evidence/chat-run-target/stage1-telegram-74ccfd3f/archive-summary.json)。
3. 数字：本批 0 宿主 Run／0 上游模型请求／$0／未结算 0，cases/transport/inboundChecks 均空，网关与测试绑定尚未建立，Pi 创建/输入均 0。测试 profile 租约已释放，失败 runtime 原样保留，未追加调用或清理命令。产品/harness/测试代码 `+0/-0`；只增加证据、报告和零费用账目。桌面 PASS 与已接受离线关口沿用，无桌面重跑。
4. 命令与退出码：live `--check-settings` exit 0；`node --import ./apps/desktop/node_modules/tsx/dist/loader.mjs apps/desktop/scripts/chat-run-target-telegram-live.mjs --run --env-file /Users/a1-6/.config/serika/chat-run-target-telegram-test.env --output /private/tmp/serika-197-tg-dedicated-live-f18c092a` exit 1。原 stop-audit CLI、result/stop-audit 原件 SHA 核对、旧三批 result hash 核对及归档凭据前缀扫描均 exit 0。原 Herdr state 与日志逐字复制；`kill(pid,0)` 只读核对失败服务进程已退出，没有发送终止信号。
5. 偏离与下一步：前轮离线 gateway 测试未启动真实 Herdr 服务，未覆盖固定长路径导致的 socket 启动失败，不能以 10/10 推断完整 fixture 可用。setup 未返回，所以原 stop-audit.fixtureRetained=null；现场的实际 state/log 单独归档并在 archive-summary 绑定 hash，不补造原 result 字段或改绿。按 Prove It Works 保留真实失败，按失败即停不换目录重跑本批。下一步应先缩短隔离 runtime 路径并离线验证真实服务启动，再启动新真批；本轮只更新 #197 后停止，不合并、不部署、不扩授权/Seatbelt。

### 74ccfd3f socket 修复范围，2026-10-31

本批只缩短专用 TG 默认隔离 runtime，并把真实 Herdr 启动、连接和两个 offline Pi 就绪检查加入离线验证入口。沿用 `setup/addPi/cleanup` 与原 HerdrClient，不增加 socket override，不修改 HOME 归属、工作区授权、选择/审批/unknown 停止契约。原失败 runtime 与证据保留，桌面 c9a16383 PASS 沿用。离线使用合成配置和拒绝请求的本机代理，不读取真实测试 env、不连接 TG、不调用模型；只在全部连接和就绪检查通过后清理本次创建的目标，失败保留现场。完成离线后只报下一真 TG 批预算，不启动真批、不合并、不部署。

### socket 修复离线结果与 TG 预算，2026-11-01

1. 改了什么：`telegram-profile.mjs` 与 env 模板仅缩短默认 runtime，失败目录不复用、不移动。新增 `chat-run-target-telegram-herdr-check.mjs` 使用合成设置、原 `setup/addPi/cleanup` 与拒绝请求的 loopback 代理；总离线入口按 typecheck → 真 Herdr → 全测执行。没有修改产品代码、socket override、HOME 归属、授权、Seatbelt、选择或审批协议。
2. 逐条对照：新长路径独立复现原 `sun_path` 错误，服务已退出、无 workspace/Pi 操作，复现现场保留；短默认路径下真 Herdr 的 `workspace list` 成功，服务器存活，原 HerdrClient 读取两个 Pi 就绪。profile 租约已取得，运行时第二宿主被拒绝，释放后成功重取。清理只用于本次成功且 idle/done 的目标；异常路径不清理。最终专项 [result](evidence/chat-run-target/stage1-telegram-socket-6c3e047a/final-herdr/result.json)、[真实 state](evidence/chat-run-target/stage1-telegram-socket-6c3e047a/final-herdr/herdr-state.json) 与 [总核对](evidence/chat-run-target/stage1-telegram-socket-6c3e047a/verification.json)。74ccfd3f 和桌面 c9a16383 的 52 个归档文件未变；原失败 runtime 的 state/log 与归档 hash 一致，见 [integrity](evidence/chat-run-target/stage1-telegram-socket-6c3e047a/integrity.json)。真实 TG 配对及后续整链本轮没做，等待授权。
3. 数字：产品代码 `+0/-0`；harness 默认配置与模板 `+2/-2`；验证脚本 `+79/-3`。验证代码多于配置改动，用于补上这次确实漏掉的外部进程启动/连接与租约检查。macOS、Node 26.4.0、Herdr 0.8.2 下本轮 0 真实模型请求、0 TG 请求、$0；代理请求也为 0。全测 1907 tests、1900 pass、7 skip、0 fail/cancelled。未新增模型 Run，未向 Pi 输入任务。
4. 命令与退出码：独立长路径复现脚本 exit 0，表示已复现失败，原失败结果仍为 failed；`node scripts/chat-run-target-verify.mjs /private/tmp/s197-socket-work/verification` exit 0，内部真实 Herdr、typecheck、pnpm test 均 exit 0。该总入口执行后仅调整 phase 顺序及输出路径限制，并补显式租约断言；最终 `node apps/desktop/scripts/chat-run-target-telegram-herdr-check.mjs --output /private/tmp/s197-socket-work/final-herdr` exit 0，证据绑定最终脚本 hash。零请求 `--check-settings` exit 0，确认真实测试配置当前使用短 runtime；语法检查、`git diff --check`、原件 hash 核对均 exit 0。
5. 偏离与边界：遵照本轮“不重做桌面整链”，没有重跑桌面整链或标准 Electron smoke，旧 PASS 只沿用原证据；不以本次 Node/假 API 全测替代真实 TG。全测 write guard 为 passed、violations=0，同时观察到并发元数据变化，`metadataUnchanged=false`，不声称日用元数据完全没变。没有修改失败证据、已确认不变量或锁实现。按 Laziness Protocol 仅缩短已有根路径，按 Fix Root Causes 真复现后修路径，按 Prove It Works 启动实际服务并验证连接/租约。改动留在独立工作树，未提交/推送。

五分钟 Demo：本机已装 Herdr/Pi 且 runtime 已构建，`/private/tmp/s197-tg` 没有保留现场时，在本工作树运行最终专项命令并使用新的仓库外 output。约十秒后 result 应为 passed，含真实 workspace_list、两个目标、leaseAcquired/concurrentHostRejected/leaseReleasedAndReacquired=true、modelProxyRequests=0；任一不满足即失败并保留现场。不要删除原失败目录来满足前置条件。

下一批预算提案仍为 **≤1 宿主 Run／24 次总上游模型请求／$0.25 本地上限**，含 Serika、压缩及选中 Pi，沿用冻结脚本费率与预留核算，非账单核验。仅使用专用测试 Bot 与既有测试 env，不临停日用同 Bot；原 TG 配对、发现≥2、一次短码选择、同 Run 采用且采用后无 discover、独立操作审批、单次派发、未选目标零输入、准确回读及独立产物核查完成定义保持。验证失败、拒绝/取消、目标或环境变化、unknown、用量/运输不确定或预算上限立即冻结；unknown 后不自动回读、重发、换目标或控制清理。若再发生基建失败，停下等用户决定是否先合桌面。本轮只报预算，等待用户“继续”，不启动真批、不合并、不部署或扩权。

### 新 TG 批次启动授权，2026-11-01

用户“继续”批准上述 ≤1 宿主 Run／24 总请求／$0.25 批次，并在本对话明确确认手机已打开专用 Bot、已就绪。先将 socket 修复和离线证据提交为真实验收的干净源码，再运行原 dedicated-test-bot harness；不重跑桌面、不接管日用、不合并或部署。离线证据中的 sourceWorktreeDirty=true 保留，不回写为干净；新真实批独立记录实际提交、随机编号和费用。
