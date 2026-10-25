# v2-release-3

## 改了什么

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
| release-3 固定构建、当前日用副本假模型演练 | 待实施 |
| 真实数据修复、用户验收、服务恢复 | 明确留到后续逐段确认，本轮不执行 |

失败记录位于 `H/data/memory-extraction-failures.jsonl`，追加阶段、宿主错误码、安全消息、Thread/project 和时间。外部 provider 异常不保存原文，避免提示词/响应泄漏；日志读写失败明确可见。记忆列表折叠区显示原因，工程 ID 放诊断详情。已有 smoke 假模型新增合法 no_memory 响应和明确的非法 JSON 负例，演练经过真实抽取和存储。

离线工具 `daily-project-repair.mjs` 固定校验获批的 memory SHA `0f4aa629…` 和 projects 原始字节。只保留 personal 项目；删除唯一发布目录 progress；14 条 null progress 映射 personal。其他记忆字段及 transcript 原样，包含“你好”的旧 memoryProjectId。该消息确实发生在错误发布项目，更正只记录在此，不能改写历史归属。

apply 在 home 外完整备份、核对清单，写 prepared 回执后依次替换两文件，完成再写 applied 回执。失败不自动重试/回滚。rollback 需要 prepared 回执路径及 `--receipt-sha`，只接受两个目标各自处于原始/修复后 SHA，可逆序恢复部分提交；备份也必须校验通过。

## 前后数字

项目选择回归在修复前复现桌面 2 失败、CLI 1 失败；修复后针对性 12/12。新增测试多于新增产品行：产品修改很小，用户要求覆盖首次/空配置/保留 personal/null/悬空 selected/跨进程 CLI，沿用现有移动目录保护用例。

失败记录针对性 runtime 35/35、UI 4/4；覆盖 32K/日用窗口、抽取/校验/真实存储保存失败、重开读取、坏文件诊断和日志写失败。

修复工具产品 171 行，测试 68 行。17 项差异：项目列表与 selected 各 1、旧进度 projectId 14、删除误写进度 1；lastWrittenAt 和既有前缀 hash 均保留。当前 home 副本集成额外覆盖完整备份、锁占用拒绝、错误回执/目标漂移拒绝、部分回滚和原始字节恢复。

## 实际命令和退出码

- 修复前同路径回归：CLI exit 1，桌面 exit 1；两次 home guard 均零写入违规、真实 home 未变。
- `pnpm typecheck`：0。
- `node --test packages/assistant/scripts/daily-project-repair.test.mjs`：0，默认 2/2；`SERIKA_DAILY_REPAIR_FIXTURE_HOME=<临时副本>` 同命令：0，3/3。
- 失败记录 targeted runtime：0，35/35；targeted UI：0，4/4。
- `node --test packages/assistant/dist/project.test.js apps/cli/dist/application-home.test.js packages/assistant/scripts/project-rebind.test.mjs`：0，10/10。
- `pnpm --filter @serika/desktop exec tsx --test src/main/project-selection.test.ts`：0，2/2。

## 与计划不符的地方及理由

- 不提交单独的红测试到 main：按用户“一项单独提交”的要求，在同一提交包含回归和修复，失败日志保存在私密发布记录。
- 未调用真实模型、启用 TG 或服务；真实 Electron 验证和完整测试在本轮结束前追加记录。假模型验证不等于日用验收。
