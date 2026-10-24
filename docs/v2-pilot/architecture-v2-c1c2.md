# 4.5 c1+c2 交付报告

## 1. 改了什么

依据 step4.5 c1/c2、D6–D9 已批准 A，完成两个独立产品提交，合并交审。本步不发版，不升级真实日用数据，不做 S2/S3。

| 步骤 | 产品提交 | 主要文件与原因 |
| --- | --- | --- |
| c1 | `c4aa37e7129520d217c4d12de0433a4da3037610` | `project.ts` 在 H/data/projects.json 注册宿主目录选择；CLI、Desktop 入口与设置接入，项目上下文与目录授权分开 |
| c2 | `09096afdf5799c2e808228344822e7f0d0051098` | `memory-v7-store.ts` 绑定 user/project 作用域，迁移全部调用方并删除 v6 runtime；抽取、进度、文档库与历史上下文统一过滤；新增离线升级和副本演练工具 |

第 0 步只读取得真实配置的三个路径字段：

| 字段 | 路径 |
| --- | --- |
| authorizedDirectory | `/Users/a1-6/Serika-workspaces/personal` |
| desktopAutonomy.authorizedDirectory | `/Users/a1-6/Serika-workspaces/personal` |
| telegramAutonomy.authorizedDirectory | `/Users/a1-6/Serika-workspaces/personal` |

用户指定 Serika 项目为 `/Users/a1-6/Code/agents/serika-v2`，personal 保持日用授权目录。项目选择不自动添加 serika-v2 授权。personal 按自己的 Git 根或明确文件夹识别。

手册 §7 已合并配置 v2 与记忆 v7 升级：停止 → 完整备份 → 两项 dry-run → 配置 upgrade → 记忆 upgrade → 启动核对 → 失败时记忆 rollback → 配置 rollback。另注明需要访问 Serika 项目文件时，用户在设置里手动添加授权目录。见 [完整手册 diff](evidence/architecture-v2-c1c2/43d5102c-ef7a-4812-a1f3-6f38b05929a0/runbook.diff)。

## 2. 逐条对照验收项

下表“已做”表示实现与列明的验证通过。真实模型及用户日用质量验收本轮未运行。

| 验收项 | 结果与证据 |
| --- | --- |
| c1 嵌套目录、worktree、普通文件夹、无目录结果稳定；同名不同路径区分 | 已做，`project.test.ts` 的 `identifies nearest Git/worktree root, explicit folder and no project using metadata` |
| c1 元信息读取不读任意正文、不开 Shell、不调用模型；项目移动显式重绑 | 已做，`identifyProject` 仅 realpath/lstat 目录及 .git 标记；`restores project selection without authorizations, requires explicit rebind after moving` |
| c1 换项目只改变项目上下文、Thread 不变；重启恢复选择而不恢复授权 | 已做，`project-selection.test.ts` 的 `switches only project context and restores selection without modifying configured authority`；v7 Electron 的项目切换及重启检查 |
| c2 显式 v7、唯一当前版本 store/export、无 SQLite | 已做，`memory-v6-store.ts` 删除，唯一运行时为 `V7MemoryStore`；启动拒绝 v6，含可复制的绝对 dry-run/upgrade 命令，`v6 is rejected without writes and diagnostics contain absolute dry-run and upgrade commands` |
| c2 user 跨项目；project 不进入 B/无项目主上下文及 memory_read，文档索引只见本项目 | 已做，`memory-context-scope.test.ts` 的 `real runtime scopes main references and memory_read across A/B/null and cold-restored fixed/update references`；副本演练与真实 Electron 表见下 |
| c2 存储、抽取、冲突、撤回、合并、进度、读取按 scope/project 过滤；同名偏好跨 scope 不误合并 | 已做，`v7 scopes isolate reads, mutation targets, conflicts, merges and extraction progress across projects`；`extraction excludes a foreign-project source and rejects a proposal trying to bind its message ID` |
| c2 来源仍绑定原 Thread/消息；归属不明不写成全局事实 | 已做，host 从原普通用户消息 metadata 绑定 project，模型不能任意绑定来源；升级逐项保留除 scope 外全部字段，未知归属阻止升级，不默认 user |
| c2 CAS、unknown commit、撤回、冷启动不变 | 已做，原 replacement/undo、withdrawal/undo、source-specific deletion、pre/post-rename commit barrier、privacy uncertain acknowledgement 用例迁至 v7 并保留断言；Electron 重启 PID 改变、memory SHA 不变 |
| c2 共享快照预算不增加 | 已做，保留现有偏好/其他条目两组各 4096 字节的共享上限；five-layer/context 测试和 32K、日用窗口 M1 离线脚本模型检查 |
| c2 历史 snapshot/update/tool 结果不带入外项目上下文 | 已做，恢复快照校验 project；过滤 foreign memory-updates，移除模型视图中外项目或无归属旧 Memory 工具 parts；`unknown historical Memory tool output is omitted from project model views without mutating transcript`，原 transcript 不改 |
| c2 完整备份、逐项 dry-run、显式 upgrade、SHA 回执 rollback | 已做，`memory-upgrade.test.mjs` 5 项，含未知项停住、锁/链接/漂移/损坏拒绝覆盖；一致日用副本演练通过 |
| 权限快照 129 行无差异，冻结文件无改动 | 已做，22 个冻结文件逐字节一致，`frozenDiff` 与 `permissionSnapshotDiff` 均为空，无 C-01 待批准项，见 [audit.json](evidence/architecture-v2-c1c2/43d5102c-ef7a-4812-a1f3-6f38b05929a0/audit.json) |

### 日用副本逐条归属

完整只读一致副本共 151 个文件、3 个符号链接、16,675,716 字节。复制前后源清单一致，符号链接保留链接值。升级、生产 Runtime 启动及反序回滚只发生在副本。原始备份、清单、升级和回滚回执留在本机私密目录，仓库只收脱正文结果。

| ID | 类别 | v7 归属 |
| --- | --- | --- |
| `978a1257-96f3-43e4-9991-7468dab39116` | preference | user |
| `41f1d455-ef45-4a87-9f4f-d47435067e35` | preference | user |
| `671b1ca0-e533-4ae7-9fdb-f655af8b39eb` | document | serika-v2 project |
| `0a0f2df1-6496-4e69-ab94-8b6fc2e54dd7` | document | serika-v2 project |
| `f6e52e58-8fb2-4d03-aabc-70482681be29` | preference | user |
| `8291bb0f-cbf3-4d8a-83fd-802c45db1293` | document | serika-v2 project |
| `99c79249-c065-498b-b5a1-980f083f209c` | note | serika-v2 project |

额外 main 分支 note 的项目归属由用户逐项明确批准。结果为总计 7 条、3 偏好、3 文档条目、文档库 3。文档保留 document 类型和来源。

| 当前项目 | 可见条目 | user 偏好 | 主上下文文档索引 | memory_read 可读文档 | 文档库索引 |
| --- | ---: | ---: | ---: | ---: | ---: |
| personal | 3 | 3 | 0 | 0 | 0 |
| serika-v2 | 7 | 3 | 3 | 3 | 3 |
| 无项目 | 3 | 3 | 0 | 0 | 0 |

主上下文显示现有文档索引，正文仍由 memory_read 按需读取。副本演练还检查三条偏好出现在两项目及无项目的真实 Runtime 主请求中，所有来源及除 scope 外条目字段完全相同。完整结果见 [rehearsal.json](evidence/architecture-v2-c1c2/ad8e06a3-2b61-4cf9-965a-6fac69776235/rehearsal.json)。

| 文件 | 升级前及回滚后 SHA-256 | 升级后 SHA-256 |
| --- | --- | --- |
| memory.json | `003ab92ca701275eaa2dc4d55741049d037d81e97ce125280f15ab9c835195aa` | `feddf3ccf89d24e4a18fc16d0f39548e9a0ca638cb56b0d1e079d2f6c952eae3` |
| config.json | `f52db4681f8fe352c0d78ac1f328640130ba1d26ac78b3bac468dc15da300cef` | `512c667b9d7d6e1c06aad7f588bd53abf49ca8f7ea7875b578a89d20ffdc7565` |

回滚后的完整文件清单、SHA、权限模式与备份一致，无多余运行文件。升级备份和回执另存私密 upgrade-records 目录。

## 3. 前后数字

按 `git diff --numstat -M` 统计，产品与迁移/验证工具分列；逐文件数值见 audit.json。

| 步骤/类别 | 新增 | 删除 | 净行数 | 计划净行数 |
| --- | ---: | ---: | ---: | --- |
| c1 产品 | 114 | 7 | +107 | +80～+140 |
| c1 测试 | 91 | 0 | +91 | +60～+100 |
| c1 总计 | 205 | 7 | +198 | |
| c2 产品 | 280 | 208 | +72 | +140～+240 |
| c2 迁移/验证工具 | 324 | 10 | +314 | 原估未单列 |
| c2 测试 | 555 | 288 | +267 | +160～+260 |
| c2 文档 | 36 | 23 | +13 | |
| c2 总计 | 1195 | 529 | +666 | |

c2 产品净 +72 低于预估，原因是绑定 store 后复用既有逻辑并删除旧路径。测试净 +267 超预估上沿 7 行，包含原调用方迁移和当前 Controller fixture。测试新增 555 行高于产品新增 280 行，原因是格式迁移、离线升级/回滚和来源/上下文隔离需要验证；迁移/验证工具另有新增 324 行。

产品与工具共新增 604 行，按运行时作用域、离线升级、独立副本/Electron 验证三类分开。运行时只保留一条 v7 路径。本文与证据交付提交不计入产品提交行数。

旧 store/单作用域 API 的非测试产品源码 rg 命中 0。全范围还剩 33 行：离线 v6 验证及历史导入器、历史 oracle fixture、旧 scope 拒绝负例。逐行输出见 audit.json 的 remainingLegacyMatches，扫描范围为 packages/apps/examples/scripts 的 ts/tsx/mjs，排除 dist/out/node_modules；未保留 v6 runtime。冻结历史文档中的固定链接和旧成绩保持原样。

## 4. 实际命令与退出码

运行环境为 macOS，Node 测试进程和构建后的真实 Electron 44.4.5。全部使用新建临时 home、原 preload/IPC、脚本假模型，真实模型调用 0、费用 0。

| 命令 | 退出码与实际输出 |
| --- | --- |
| `pnpm typecheck` | 0 |
| `TZ=Asia/Shanghai pnpm test` | 0，runtime 1178 pass / 7 既有 skip；desktop 659 pass；desktop scripts 12 pass |
| `TZ=UTC pnpm test`，最后串行重跑 | 0，runtime 1178 pass / 7 既有 skip；desktop 659 pass；desktop scripts 12 pass |
| `pnpm eval:test` | 0，101/101 |
| `node examples/eval/cm-step4.mjs`，不带 live 选项 | 0，M1 16/16，32,768 窗口/有效输入 26,624，以及日用 context 1,000,000/input 256,000 |
| `SERIKA_CM6_EVIDENCE_DIR=/tmp/serika-c2-offline-audit node examples/eval/cm-step6-offline-audit.mjs` | 0，离线容量检查；保留其实际源码提交记录 |
| c1 `pnpm --filter @serika/desktop smoke` | 0，原冻结协议 8/8，干净源码 c4aa37e，见 [原始 result](evidence/architecture-v2-c1c2/e64c463f-ce6b-4c51-8ef0-9e83aab4ba22/result.json) |
| c2 `pnpm build` 后 `node apps/desktop/scripts/electron-scope-smoke.mjs` | 0，获批 v7 协议 7/7，干净源码 09096af，见 [原始 result](evidence/architecture-v2-c1c2/214f3533-9b5f-435a-a740-08e5c2c02c47/electron/result.json) |
| `node packages/assistant/scripts/memory-scope-rehearsal.mjs <一致备份绝对路径> /tmp/serika-c2-final-rehearsal` | 0，升级→启动→回滚及 SHA/条目数/文档库核对通过 |

完整命令日志的摘要、计数、原始日志 SHA 和外层 guard 记录见 [verification.json](evidence/architecture-v2-c1c2/b37f9bc2-bbf6-41d1-ba6b-9d5d24917b52/verification.json)。c1 全套实际为 runtime 1166 pass / 7 skip、desktop 659 pass、scripts 12 pass。离线 audit 在较早本地 c2 提交运行，保留原 sourceCommit，后续只修复新增冒烟脚本的取证。

测试/eval/Electron 使用 `SERIKA_TEST_HOME=<新临时目录>` 和 `SERIKA_B2_RECORD_CONCURRENT_HOME=1`。外层 guard 违规均为 0，日用进程在验证期间自行产生的文件变化单独记录；guard 自测的预期失败只作用于隔离测试目录。

c2 Electron 重启 PID 60507→76457，重启前后 memory SHA 均为 `2135b5f5b658b8c066a835213d6b2d6ab02b2c0032382cf8e54efd51ec5cb29e`，配置授权不变。脚本 SHA 为 `635faefcb5369dabceefd3e5cf201427b913ccba014e74eedab2c215c282e5c3`。截图及 SHA、进程 userData、renderer UA 由脚本原始结果记录。原冻结证据目录没有 diff。

## 5. 与计划不符的地方及理由

- 用户已批准新增 v7 专用真实 Electron 冒烟，因为冻结脚本硬断言 memory version 6。保留原文件字节、原证据和 c1 原协议结果。冻结汇总入口还绑定旧分支及旧冒烟，本轮逐项执行 typecheck、两时区全套、eval、独立 v7 冒烟和离线审计；未运行 `pnpm verify:cm6`，未修改冻结入口。
- 测试断言调整单独说明：所有当前 store version 6→7、隐式 workspace fixture→显式 user，project 文档 fixture 显式绑定项目；constructor 的注入边界移至第三参；旧版本拒绝测试由 v1–v5 扩至 v1–v6；直接 Runtime 来源请求添加宿主项目 metadata。旧值不符合已批准 v7 契约，原 CAS/来源/撤回/unknown 断言保留。
- `memory-v6-store.test.ts` 删除并迁至 `memory-v7-store.test.ts`，原 replacement/withdrawal/source deletion/commit barrier/privacy/capacity 用例均迁移。新增跨项目及 v6 拒绝用例，没有为变绿删除或 skip 行为断言。完整测试改动见 [test-changes.diff](evidence/architecture-v2-c1c2/43d5102c-ef7a-4812-a1f3-6f38b05929a0/test-changes.diff)。
- `cm-step6-live.test.mjs` 中 `actual Controller archives the primary reply before a background summary failure is reported` 原先调用冻结 runChat 写 config v1，当前 Runtime 正确拒绝它。改为 config v2 的直接 Controller fixture，仍断言原回复先归档、backgroundCalls=1、usageCalls=2、后台失败和 passed=false；冻结 helper 不改。
- 初轮验证暴露尚未迁移的 v6 fixture/缺 scope，以及 dist 中陈旧 v6 编译测试，已迁移调用方并清理陈旧生成物。并行 UTC 与 Shanghai/Electron 运行时，一条上下文隔离测试触发既有 15 秒 timeout/cancel；未放宽 timeout 或删除断言，最终串行 UTC 重跑结果见上。
- 两轮 v7 冒烟的取证失败已修复：recentOutput 是累计历史，现按本次 user 消息之后取实际 memory_read 结果；配置 SHA 在启动补齐默认值后取基准。原隔离与授权断言保留，最终 7/7。失败原件保留本机私密目录。
- 本轮未进行真实模型、真实日用升级、服务切换、Linux/Seatbelt 新验收。离线脚本与 Electron 证据证明作用域接线及持久化行为，用户日用质量留到后续审核与 v2-release-2。
