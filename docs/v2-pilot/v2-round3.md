# v2 第 3 轮交付

基线 `f638f46c4e012b13c790222cae694b8b3867fa18`；验证源码 `4f0d083b37eb42e6c751e35cd1e7054de512a696`。只提交 `experiment/architecture-v2`，等待本轮审核。

## 1. 改动

- Computer：设置中发现或输入已安装驱动，用户明确选择允许应用；点击连接检查只执行固定 `list_apps`。保存走既有配置锁、CAS 和 runtime reload/rollback。失踪驱动可停用；冷启动默认保留配置，明确选择才停用重启。修复空参数 `computer_check` 的桌面批准入口；超长 AX 内容只给裁剪后的只读诊断，不给动作 token。
- 浏览器 CLI：通过 `terminal_exec` 读取已安装版本的 help/可信 Skill，复用明确 task space/browser/tab，按新状态操作并观察结果；每一步仍确认。没有另建浏览器执行器。
- Herdr：`herdr_pi_read` 只接受 get/read/wait；`herdr_pi_control` 只接受 prompt、固定键 input、stop。目标由宿主设置捕获，不接受目标字段或任意命令。每次先核对 terminal_id 与 Pi 身份；read 返回前再次核对，失配丢弃正文并要求重选。prompt 只在 idle/done 发送。发送后的失败保持 `TOOL_OUTCOME_UNKNOWN`，不读回、不重发。
- 原 desktop Herdr 元数据子进程实现已迁入共享 `HerdrClient`；旧实现和通用终端中的 Pi 控制推荐路径已删除。通用 `terminal_exec` 保留。设置页和 TG 提示同步展示专用只读例外，避免仍声称所有终端读取都确认。

采用 pstack 的 Model the Domain，将只读与发送动作拆成两个 schema 和权限声明；Migrate Callers Then Delete Legacy APIs 让设置与工具共享一套 CLI 边界；Prove It Works 使用实际假子进程、Controller 与离线 TG API 验证。按 Karpathy 限定改动范围，没有增加行为循环。

## 2. 实际变化与批准清单

| 批准项 | 实际变化 | 结果 |
|---|---|---|
| #182 接入引导与驱动恢复 | 明确路径、应用列表、健康结果、停用及冷启动确认；不安装/注册服务 | 符合 |
| #175 浏览器 CLI | 已安装 CLI 指引；所有调用继续 `terminal_exec` 每次确认 | 符合 |
| Herdr 固定目标、固定动作 | 结构化参数，不允许 command/session/pane/terminal 覆盖；每次身份核对 | 符合，CLI 竞态限制见第 5 节 |
| Herdr 只读免确认 | 桌面/TG get/read/wait 均无审批 | 符合 |
| Herdr 发送每次确认，不可记住 | 连续 prompt/input/stop 即使传 remember 仍各自确认 | 符合 |
| 原 b0 87+2 行不变 | 旧 89 行逐值一致，快照仅追加新行 | 符合 |
| Computer/浏览器在 Seatbelt 外 | 桌面/TG 每次确认；没有 autonomy/runAuthorization 声明 | 符合 |
| 冻结 SHA、S01–S15 不变 | 冒烟、统一检查器、Seatbelt 检查器、旧权限决策快照和三份 Seatbelt 实现逐项 hash 一致 | 符合 |
| 离线与临时 home | 显式 `--home` 入口；子进程 HOME/SERIKA_HOME/RUNLOOM_HOME 指向临时目录；fake driver/Herdr/browser/TG | 符合 |

新增快照行逐条如下。每次确认的行均以同一 Run 连续两次拒绝证明没有继承许可；只读行没有目标时安全返回缺少目标，实际目标核对由假 CLI 集成测试覆盖。

| 新增快照行 | 审批 |
|---|---|
| `round3/desktop/herdr_pi_read/get` | 免逐条确认 |
| `round3/desktop/herdr_pi_read/read` | 免逐条确认 |
| `round3/desktop/herdr_pi_read/wait` | 免逐条确认 |
| `round3/desktop/herdr_pi_control/prompt` | 每次确认，不可记住 |
| `round3/desktop/herdr_pi_control/input` | 每次确认，不可记住 |
| `round3/desktop/herdr_pi_control/stop` | 每次确认，不可记住 |
| `round3/desktop/computer_check/check` | 每次确认，不可记住 |
| `round3/desktop/computer_observe/observe` | 每次确认，不可记住 |
| `round3/desktop/computer_action/action` | 每次确认，不可记住 |
| `round3/desktop/terminal_exec/browser` | 每次确认，不可记住 |
| `round3/telegram/herdr_pi_read/get` | 免逐条确认 |
| `round3/telegram/herdr_pi_read/read` | 免逐条确认 |
| `round3/telegram/herdr_pi_read/wait` | 免逐条确认 |
| `round3/telegram/herdr_pi_control/prompt` | 每次确认，不可记住 |
| `round3/telegram/herdr_pi_control/input` | 每次确认，不可记住 |
| `round3/telegram/herdr_pi_control/stop` | 每次确认，不可记住 |
| `round3/telegram/computer_check/check` | 每次确认，不可记住 |
| `round3/telegram/computer_observe/observe` | 每次确认，不可记住 |
| `round3/telegram/computer_action/action` | 每次确认，不可记住 |
| `round3/telegram/terminal_exec/browser` | 每次确认，不可记住 |

b0 现有行变化数 **0**；新增 **20** 行，合计 **109** 行。快照 SHA-256：`5c21f345323678c3e7b76561270742a8e36b3fdafb01eb0aa2c8095a32597746`。

## 3. 行数

相对 `f638f46`，以下统计截至验证源码提交，不把随后归档的原始日志算成产品或测试源码：

| 类别 | 新增 | 删除 | 净增 |
|---|---:|---:|---:|
| tests-verification | 509 | 34 | +475 |
| product | 429 | 115 | +314 |
| snapshot | 268 | 0 | +268 |

逐文件增删在 `evidence/v2-round3/audit/audit.json` 的 `lineChanges` 中。证据与本报告随后单独提交，不修改验证源码。

## 4. 验证、命令与 hash

所有测试入口使用 `node /private/tmp/serika-v2-round3/run.mjs --home TEMP_HOME …`；包装器只设置隔离 home 并原样传递退出码。

| 命令 | 退出码 / 结果 |
|---|---|
| `node packages/assistant/scripts/v2-round3-verify.mjs --home /private/tmp/serika-v2-round3-audit-H --output /private/tmp/serika-v2-round3/audit-final` | 0 |
| 本轮审计内部 `/bin/sh -c 'pnpm typecheck && pnpm build:runtime' --home /private/tmp/serika-v2-round3-audit-H` | 0 |
| 本轮审计内部 `/bin/sh -c 'node --test packages/assistant/dist/herdr.test.js packages/assistant/dist/herdr-control.test.js packages/assistant/dist/modules/computer-module.test.js packages/assistant/dist/computer-controller.test.js packages/assistant/dist/terminal-control.test.js packages/assistant/dist/permission-boundary.test.js packages/assistant/dist/baseline-assembly.test.js packages/assistant/dist/execution-record-store.test.js packages/assistant/dist/context-compactor.test.js packages/assistant/dist/tui-module-config.test.js' --home /private/tmp/serika-v2-round3-audit-H` | 0; tests=110, pass=110, fail=0, skipped=0 |
| 本轮审计内部 `/bin/sh -c 'pnpm --filter @serika/desktop exec tsx --test src/main/computer-connection.test.ts src/renderer/src/computer-connection-setting.test.ts src/renderer/src/approval.test.ts src/main/telegram-gateway.test.ts src/main/herdr-target.test.ts src/main/module-settings.test.ts src/main/ipc-forwards.test.ts src/main/resident-transport.test.ts src/main/desktop-runtime.test.ts src/main/runtime-ownership.test.ts src/renderer/src/herdr-target-setting.test.ts src/renderer/src/conversation.test.ts' --home /private/tmp/serika-v2-round3-audit-H` | 0; tests=159, pass=159, fail=0, skipped=0 |
| 冻结统一验证内部 `pnpm typecheck` | 0 |
| 冻结统一验证内部 `env TZ=UTC pnpm test` | 0; tests=1820, pass=1813, fail=0, cancelled=0, skipped=7 |
| 冻结统一验证内部 `env TZ=Asia/Shanghai pnpm test` | 0; tests=1820, pass=1813, fail=0, cancelled=0, skipped=7 |
| 冻结统一验证内部 `pnpm eval:test` | 0; tests=101, pass=101, fail=0, cancelled=0, skipped=0 |
| 冻结统一验证内部 `git clone --shared --no-checkout . '<temporary>/smoke-source'` | 0 |
| 冻结统一验证内部 `git checkout --detach 4f0d083b37eb42e6c751e35cd1e7054de512a696` | 0 |
| 冻结统一验证内部 `pnpm --filter @serika/desktop smoke` | 0 |
| 冻结统一验证内部 `node examples/eval/cm-step6-offline-audit.mjs` | 0 |
| `SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-v2-round3/unified-final node /private/tmp/serika-v2-round3/run.mjs --home /private/tmp/serika-v2-round3/unified-H node packages/assistant/scripts/cm-step6-verify.mjs --home /private/tmp/serika-v2-round3/unified-H` | 0 |

冻结统一验证结果：退出 0；干净源码、UTC/Asia/Shanghai 全套、离线 eval、冻结 Electron 冒烟 8/8 与 offline audit 均通过。

| 证据 | SHA-256 |
|---|---|
| 本轮审计 `audit/audit.json` | `cd9d9d3a2fca283fd6da7e212fc3eaf5ad5a08b4ac62afcf0edd83b327151954` |
| 冻结统一验证 `unified/docs/v2-pilot/evidence/cm-step6/verification.json` | `bc10acb7a4bbbe1672eb7b3076eaf9e63fb8b0be03d5d76e086f3bd5c3ca2311` |
| 冻结统一检查器 | `7fc93222da184d9f27cd9fc2601dde208e9a9690cc277b0c879d280d41840ffb` |
| 冻结 Electron 冒烟 | `03a3c7e6d174842edda61770f8f17b7480e6545ee52ffbda2f63a288d07a6c34` |

所有原始文件的字节数和 SHA 在 `evidence/v2-round3/manifest.json`。仅保留本轮产物，排除统一验证复制出的历史 evidence。证据打包前扫描凭据模式，不打印匹配内容。

## 5. 偏差与限制

开发期间的失败均保留或明确标记缺失：初次集成 typecheck 因 client 尚未落盘和工具返回类型推断退出 2；b0 捕获在追加前按预期退出 1；Herdr Controller 测试误用非法 remember 导致等待，终止后修正测试，产品规则未变；首次审计 home 前缀不符退出 1，改命令后通过。Computer 独立树曾解析到旧依赖导出；Herdr 假脚本换行、类型穷尽与 AgentError 断言修复后重跑通过。首份通过的审计之后发现 Herdr UI 仍写读取需确认，主动中止已启动的统一验证并更正文案；首次统一运行仅记录 SIGTERM，不计为通过。最终源码重新跑审计及冻结统一验证。完整命令和失败记录见 development-commands.md、browser/herdr-sources.md 与原始日志。Computer renderer 测试首次错误 cwd 的日志被覆盖，该次只有工具退出记录，未伪称原始日志存在。首次证据打包的凭据扫描把 task- 路径内的 sk- 子串误报，退出 1；核实 10 处均为追踪文件路径后增加词边界，原始报告字节未改，重新打包退出 0。

- 上游 Herdr 的 AgentPrompt/SendKeys 只有 pane target，没有 expected_terminal_id。工具每次发送前核对终端，read 返回前再核对，但 CLI 预检与发送间仍存在终端被人工替换的竞态；不声称提供原子目标锁。没有新增 socket 控制通道。
- 终端只读结果经常见 credential/Bearer/JWT/private-key 格式过滤；没有普适的秘密识别保证。测试凭据随机生成且不归档原值。没有读取或复制真实凭据。
- 没有真实模型、TG 外发、真实 Herdr/Pi、浏览器网站或 Computer 驱动交互；没有服务注册或日用数据读写。本轮证明离线执行链、权限、恢复和 UI 渲染。冻结 Electron 冒烟仍是原有八项，不等于新增功能的真实外部验收。
- 未自动进入日用。提交推送后停止，等待本轮审核。

源码 `git diff f638f46 4f0d083b37eb42e6c751e35cd1e7054de512a696 --check` 退出 0。原始框架日志的空行末尾空白保持原字节，具体位置见 package-checks.json。
