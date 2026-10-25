# v2-release-3

## 改了什么

- 固定源码/标签目标：`be13d5d55fae6a03e677cc23bb9a1b97d1a5ecae`，附注标签 `v2-release-3`。发布目录 `/Users/a1-6/Applications/Serika-releases/be13d5d55fae6a03e677cc23bb9a1b97d1a5ecae/`；入口 `Serika.command`，env 仍为 `~/.config/serika/v2-daily.env`，Node 为 `/opt/homebrew/Cellar/node/26.4.0/bin/node`。
- 分项提交：项目 `dc7fa1a`；失败记录 `a21def7`、记忆页入口 `cae0458`；修复工具 `f076122`。其余提交为演练、测试前提和文档。
- 私密发布记录 `/Users/a1-6/Serika-release-records/release3-20261025T033214Z` 包含构建日志、发布核对、完整演练回执和服务恢复预案。演练回执 `release-rehearsal-2/result.json`；其中 `repair.receiptPath/receiptSha256` 为副本修复回执，不能用于真实 H 回滚。
- 原完整备份 `/Users/a1-6/Serika-release2-backup-20261025030415`、阶段 3 回执目录 `/Users/a1-6/Serika-v2-release-2-upgrade-20261025030415` 保留。真实 release-3 修复备份/回执与用户核对结果尚无，本轮报告后停止，后续依次确认退出 → 完整备份/dry-run 并停 → apply 并停 → 用户启动验收。
- 两个服务仍 disabled/unloaded。桌面启动查询状态，未注册时建立进程内宿主，不自动 enable/bootstrap。新 plist 仅准备在私密记录 `service-restore-v3/`，尚未安装。验收通过后先再次核对无写入者和 TG 边界，再替换 plist、显式 enable、bootstrap，最后核对新发布路径、PID 和 readiness。若 resident 会自动恢复 TG，必须报告并停，不能违反“不启用 TG”。
- worker 通知 helper 仍依赖 `Serika-support/917ee15…`；旧发布目录及 Serika-support 不可删除。Node 路径带 Cellar 版本，brew upgrade node 后需要重建入口与 plist。


- `v2-release-2` / `983e8d394ad2e7367532e550b2df9681b39ca70d` 状态：**项目选择缺陷，未完成验收**。标签保留，旧发布及备份保留；两个日用服务继续 disabled、未加载。
- 项目选择：桌面恢复有效已存选择，包括 null；首次/悬空 selected 使用配置显式 projectDirectory，无该配置则无项目。selector 删除 cwd 参数。目录移动/删除仍保留原登记并提示离线重绑，用户已确认。
- CLI 仅按 cwd 识别本进程项目，不写 projects.json。解析配置单独提供 configuredProjectDirectory，避免把单一授权目录的隐式值当成用户配置。

## 逐条对照验收项

| 项目 | 当前证据 |
|---|---|
| 发布目录 cwd 首次进入 personal；无配置为无项目；已有 personal/null 保留 | 已做，`project-selection.test.ts`，真实 DesktopRuntime + 假模型，零模型调用 |
| CLI 在其他目录运行不改变桌面选择 | 已做，`application-home.test.ts` 启动实际 CLI 子进程；保留 registry 原始字节 |
| 目录移动保护 | 已做，`project.test.ts`、`project-rebind.test.mjs`；原选择保留，离线重绑/rollback 仍可用 |
| 整理失败落盘和界面原因 | 已做，`memory-extraction-log.test.ts`、`memory-extraction-failures.test.ts`；当前 Thread/project 日志重启可读，损坏存储不拦诊断 |
| 定点离线修复工具及回滚 | 已做，`daily-project-repair.test.mjs` 默认 2/2、当前 home 副本集成 3/3；未应用真实数据 |
| release-3 固定构建、当前日用副本假模型演练 | 已做，实际发布目录 cwd；真实 Electron + 假模型，4 次启动，老 Thread 整理 0 + 0 次 |
| 真实数据修复、用户验收、服务恢复 | 明确留到后续逐段确认，本轮不执行 |

失败记录位于 `H/data/memory-extraction-failures.jsonl`，追加阶段、宿主错误码、安全消息、Thread/project 和时间。外部 provider 异常不保存原文，避免提示词/响应泄漏；日志读写失败明确可见。点击提示中的“查看记忆”后，记忆页直接显示失败记录折叠区；设置中的管理记录也可查看原因，工程 ID 放诊断详情。已有 smoke 假模型新增合法 no_memory 响应和明确的非法 JSON 负例，演练经过真实抽取和存储。

离线工具 `daily-project-repair.mjs` 固定校验获批的 memory SHA `0f4aa629…` 和 projects 原始字节。只保留 personal 项目；删除唯一发布目录 progress；14 条 null progress 映射 personal。其他记忆字段及 transcript 原样，包含“你好”的旧 memoryProjectId。该消息确实发生在错误发布项目，更正只记录在此，不能改写历史归属。

apply 在 home 外完整备份、核对清单，写 prepared 回执后依次替换两文件，完成再写 applied 回执。失败不自动重试/回滚。rollback 需要 prepared 回执路径及 `--receipt-sha`，只接受两个目标各自处于原始/修复后 SHA，可逆序恢复部分提交；备份也必须校验通过。

## 前后数字

项目选择回归在修复前复现桌面 2 失败、CLI 1 失败；修复后针对性 12/12。新增测试多于新增产品行：产品修改很小，用户要求覆盖首次/空配置/保留 personal/null/悬空 selected/跨进程 CLI，沿用现有移动目录保护用例。

失败记录针对性 runtime 35/35、UI 4/4；覆盖 32K/日用窗口、抽取/校验/真实存储保存失败、重开读取、坏文件诊断和日志写失败。

本轮代码合计产品 +347/-46，测试及演练脚本 +396/-18；其中演练脚本 156 行。测试行多于产品行是用户明确要求多进程项目选择、数据备份/回滚、真实副本重启及失败负例，未按字段机械铺设用例。

修复工具产品 171 行，测试 68 行。17 项差异：项目列表与 selected 各 1、旧进度 projectId 14、删除误写进度 1；lastWrittenAt 和既有前缀 hash 均保留。当前 home 副本集成额外覆盖完整备份、锁占用拒绝、错误回执/目标漂移拒绝、部分回滚和原始字节恢复。

## 实际命令和退出码

- 修复前同路径回归：CLI exit 1，桌面 exit 1；两次 home guard 均零写入违规、真实 home 未变。
- `pnpm typecheck`：0。
- `SERIKA_TEST_HOME=/private/tmp/serika-release3-full-final2 pnpm test`：0；runtime 1194 pass / 7 skip，desktop 661 pass，scripts 12 pass，合计 1867 pass / 0 fail / 7 skip。
- `node scripts/test-home.mjs --home /private/tmp/serika-release3-scope-guard -- node apps/desktop/scripts/electron-scope-smoke.mjs`：0，10/10；真实 Electron 44.4.5、原 preload/IPC、假模型。
- 独立 clone、frozen/offline install、`pnpm build`、显式缓存安装 Electron：各 exit 0；安装与构建 home guard 零违规。
- 实际发布目录 `release3-rehearsal.mjs --source-home /Users/a1-6/.serika --output <私密记录>/release-rehearsal-2`：0。修复仅作用于完整副本，4 次 Electron 启动均为 personal；原 Thread 1292 条消息，游标停在 index 1289，首次/重启整理调用 0/0。人为触发 validate / MEMORY_EXTRACTION_JSON_INVALID，日志与主记忆页重启后可读，renderer error/warning 0。
- `audit-release3.mjs`、`audit-boundaries.mjs after`：0；2338 个依赖链接全部在独立发布内部，真实 H 与 release-1/2 完整 SHA/type/mode/symlink 清单不变，两个 job disabled/unloaded，无相关进程。
- `node --test packages/assistant/scripts/daily-project-repair.test.mjs`：0，默认 2/2；`SERIKA_DAILY_REPAIR_FIXTURE_HOME=<临时副本>` 同命令：0，3/3。
- 失败记录 targeted runtime：0，35/35；targeted UI：0，4/4。
- `node --test packages/assistant/dist/project.test.js apps/cli/dist/application-home.test.js packages/assistant/scripts/project-rebind.test.mjs`：0，10/10。
- `pnpm --filter @serika/desktop exec tsx --test src/main/project-selection.test.ts`：0，2/2。

## 与计划不符的地方及理由

- 首次全套 runtime 1193 pass / 1 fail / 7 skip，唯一失败是路径基线未包含获批新日志；`__baseline__/paths.txt` 只新增 `memoryFailures = H/data/memory-extraction-failures.jsonl`，不改旧路径或行为断言。
- 旧冻结 Electron 脚本硬断言 memory v6，沿用 c1+c2 已批准的独立 v7 `electron-scope-smoke.mjs` 协议，原冻结脚本不改；不运行 `pnpm verify:cm6`。

- 不提交单独的红测试到 main：按用户“一项单独提交”的要求，在同一提交包含回归和修复，失败日志保存在私密发布记录。
- 桌面 resident transport 旧 fixture 只设授权目录却假定存在项目。按用户确认的“无 projectDirectory 为无项目”，给该 fixture 显式配置它原本使用的 workspace；保留保存文档成功断言，定向复现通过，完整重跑通过。
- 演练脚本修正路径尾斜杠、使用 app.quit 正常退出、将默认 5 秒等待改为既有 120 秒后台/Run 上限。失败现场全部保留。发布目录首次演练因隔离 HOME 缺 Electron 二进制而尝试下载；正常停止本次安装子进程后，显式指向已有缓存完成校验安装，再用新副本重跑通过。
- 未调用真实模型、启用 TG 或服务。上述假模型验证不等于日用验收。

证据：[项目隔离 10 项](evidence/architecture-v2-c1c2/b2b1206d-e551-4a32-afdc-36371db57ce0/electron/result.json)；[实际发布副本演练](evidence/release3/ad9b77fb-d32f-407e-a993-fd23d623ba08/result.json)。失败记录折叠/展开均已查看截图，无裁切；尺寸 1104×52 → 1104×246，214325 个像素变化，变化区域对应展开的安全错误、时间与诊断入口，详见同目录 pixel-comparison.json。公开证据只导出运行字段和裁剪面板，不包含日用记忆正文及原 Thread ID。
