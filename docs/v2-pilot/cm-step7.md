# 上下文／记忆第 7 步交付

## 1. 改了什么

完成 unknown 失败轮历史修复，以及计划 M2 的 v6 存储收口和获准的真实数据副本迁移。源码提交 `52636cd`，基线 `c8fade7`。第 0–6 步按用户本轮确认已验收，第 7 步交 bot1 审核，日用迁移未开始。

unknown 旧行为有意只提交正常返回的对话，最迟在 `265d8677` 的旧测试中明确固定。没有发现丢弃用户请求是为了重试的证据。现在非幂等工具结果未知时，AgentLoop 返回带回执的 failed outcome，Runtime 经唯一 `store.save()` 提交用户原话和工具回执，Run 仍为 `failed / TOOL_OUTCOME_UNKNOWN`。压缩的宿主清单保留对应原请求和 Steer，避免下轮只看到 unknown 却丢失“不读回”的约束。实际触发路径为 `packages/ai-sdk-adapter/src/loop.ts:252` → `packages/core/src/runtime.ts:363`；压缩保留点在 `packages/assistant/src/compaction-records.ts:71`。

存储调用统一到 `memory-types.ts` / `memory-v6-store.ts`。删除旧候选、双时态存储及其 Controller、IPC、CLI 入口，条目与文档库仅有 workspace 范围。新 `memory-merge.ts` 沿用抽取生命周期，在积压结束且固定快照超额时才尝试合并，取代链承担回执及撤销。

## 2. 逐项对照验收

以下为离线代码验证和真实数据副本核对；本轮没有真实模型质量复测。

| 要求 | 已做及可复核证据 |
| --- | --- |
| unknown 后下轮看到用户原话和回执 | `unknown write failure retains the original request and receipt in the next request, compaction and cold restart`，实际 Runtime、AgentLoop、JSONL，检查下一次 provider prompt；32,768 与 1,000,000 两档 |
| 压缩后、冷启动后仍保留 | 同用例覆盖失败轮进入已压缩前缀、重新打开 JSONL；工具只执行一次，Run 仍失败 |
| 备份先于演练和实际副本迁移 | [迁移结果](evidence/cm-step7/result.json)：源为 v4，222 个文件，267 个清单项；配置、identity、drafts、workspace、transcripts 一并归档；tar 留在私有目录，仓库仅提交清单和 SHA |
| 完整回滚核对 | [备份清单](evidence/cm-step7/backup-manifest.json) 与 [回滚清单](evidence/cm-step7/rollback-manifest.json)，文件集合、SHA、mode、条目数逐项相等；旧条目 14、assertions 20、候选 25、游标 14、回执 13、transcript 文件 164 |
| 14 行裁决 | 1、12 保留；9 保留并将授权实施／测试例外写入正文；10、11、13 转项目文档；2–8、14 不迁。得到 3 条偏好、3 份项目文档；见附表 A 与结果 `realData.rows` |
| 来源、旧文档元数据、历史不生效 | 核验保留 source quote 确为对应 Thread 用户消息原文；旧游标先验证旧前缀 hash 再转新协议；保留 exclusions。原库无 folder/document；已有标题、顺序、归属、pin 的保留由迁移测试验证。旧候选及历史只归档，不进入 v6 当前事实 |
| 一条写入路径、旧接口删除 | v6 store 不再 import `memory-store.ts`；旧结构源码和空入口已删。v1–v5 产品读写均返回 `MEMORY_MIGRATION_REQUIRED`，写前拒绝且不创建锁；一次性迁移脚本与产品路径分离 |
| workspace 与 Thread 来源区别 | schema 仅 workspace，撤回／撤销恢复的仍是 workspace；source、进度与执行记录继续保留 Thread ID。管理视图只返回来源种类，不带原 quote/messageId |
| 自动合并、置顶、撤销 | `overflow merge inherits real bound sources and pin state; cold undo restores every original`，两档；stale CAS、漏条件、取消、after-rename 未知提交分别断言拒绝／停下，不自动重试 |
| 统一验证与冒烟 | 统一脚本退出 0；UTC 与 Asia/Shanghai 各 1,755 通过／0 失败／7 跳过，eval 101／101，真实 Electron＋假模型冒烟 8／8；[统一证据](evidence/cm-step7/unified/docs/v2-pilot/evidence/cm-step6/verification.json)、[Electron 结果](evidence/cm-step7/unified/docs/v2-pilot/evidence/electron-smoke/result.json) |

## 3. 前后数字

相对 `c8fade7` 到 `52636cd`，不含报告及生成证据。完整逐文件计数见 [code-stats.json](evidence/cm-step7/code-stats.json)。

| 分类 | 新增 | 删除 | 净变化 |
| --- | ---: | ---: | ---: |
| 产品源码 | 396 | 4,956 | **−4,560** |
| 测试源码 | 482 | 1,718 | **−1,236** |
| 迁移／验证工具 | 232 | 517 | −285 |
| package.json | 1 | 1 | 0 |

产品口径为 `src` 中非 `.test` 文件，包含退役的 acceptance harness；测试包含 `.test.ts` 与迁移 `.test.mjs`；scripts 与 examples/eval 的非测试工具另列。记忆模块口径是 `packages/assistant/src` 下所有 `memory*.ts`，排除 `.test.ts`，包括 `modules/memory-module.ts`：23 文件／5,153 行 → 18 文件／1,153 行，净删 4,000 行。

测试新增 482 行超过产品新增 396 行，原因是 unknown 的跨请求、压缩、冷启动及两档装配，以及迁移备份／回滚与提交未知边界。产品新增分散在既有 Runtime/loop、v6 store、抽取接线；独立 merge 文件负责单次提案，types 文件只承载当前共享契约。

两个时区各 1,755 通过／0 失败／7 跳过，总数 1,762；eval 101／101。runtime 1,127 项、desktop 623 项、脚本 12 项，逐组计数可从统一证据相加。计数下降来自候选、双时态和 Thread 范围功能退役，不沿用旧基线 1,802。逐文件退役清单与改断言原因见附表 B。

## 4. 实际命令和退出码

| 命令／运行 | 退出码和结果 |
| --- | --- |
| `pnpm typecheck`，干净 dist 后 | 0 |
| runtime / loop / compactor / compaction-runtime / merge / migrate 定向 `node --test` | 0，130 通过／0 失败／0 跳过 |
| 修复首轮门禁发现的旧测试后，dreaming / computer-module / no-progress-guard 定向 | 0，53 通过／0 失败／0 跳过 |
| backup / baseline 定向；memory-library 定向 | 0，分别 22／22、9／9，失败与跳过均 0 |
| `pnpm eval:test`，旧入口清理后定向 | 0，101／101；3 组历史 Oracle 定向 24／24，未改判定块 |
| `node packages/assistant/scripts/cm-step7-migrate.mjs <日用源> <独立输出目录>` | 0，运行 `d1ce257e-b408-4bfd-9538-b09148afdaae`，先演练／回滚核对，再迁移真实备份副本 |
| `SERIKA_CM6_VERIFY_OUTPUT=<仓库外目录> node packages/assistant/scripts/cm-step6-verify.mjs` | 0，runId `88794d3b-5b02-4800-85c1-06b6248ac8bd`，逐命令时间／退出码／输出 hash 见统一证据 |
| `git diff --check`、冻结工具 SHA 核对、提交材料密钥前缀扫描 | 0；三个冻结 SHA 一致，交付材料密钥前缀扫描未命中，见 [最终核对](evidence/cm-step7/final-checks.json) |

本轮统一证据的输出根为 `evidence/cm-step7/unified/`，其中保留脚本生成的完整 `docs/v2-pilot/evidence/...` 目录；JSON 的 `file` 字段相对此输出根解析。第 6 步旧证据未覆盖。冒烟输出目录随脚本一并带出的历史 README、第 4／5 步文件不是本次结果；当次以 `result.json`、`cm-step6-run.json`、`cleanup.json` 及对应截图为准。最终报告／证据提交不改源码，验证绑定源码 `52636cd`。

复算行数用 `git diff --numstat c8fade7 52636cd`，分类规则及每文件数字已写入 code-stats。Linux 复现统一脚本会自动使用 `xvfb-run -a -s '-screen 0 1440x900x24'`。本轮执行平台为 macOS；真实 Electron 使用原 preload／IPC 和假模型，从干净临时检出启动，测完删除临时目录。

## 5. 偏差、限制与审查提醒

- 用户明确授权迁移真实数据的独立副本。`v6-review/workspace` 留在 `~/.serika-cm7-review-20261022-final` 私有迁移目录供审核；没有启动该副本，没有激活配置。备份配置仍有原绝对路径，不能当作新日用入口启动。日用原目录、main 和运行进程未由本轮改动。
- 实际源是 v4，SHA 为 `0a3b46794629c9b2ca9437f2d79321321c3bad2548d57a35271da5f97df629a8`，与第 6 步早期取样 SHA 不同。脚本绑定当前实际文件及已批准的 14 行，不做通用旧格式猜测。旧格式完整保留为只读 `.pre-v6`，没有把它虚称为 v5。
- 第一轮迁移因运行中的 worker 自然更新 health 文件而在最终源比较中失败，未据此宣称完成。最终运行只允许并报告 `workspace/.runloom/task-worker-health.json` 心跳变化，其余业务文件仍逐字一致。早期备份保留，最终证据以本报告 runId 为准。
- 统一验证首轮退出 1，3 个旧测试未同步，保留 [失败证据](evidence/cm-step7/verification-first-failed.json)。两个 direct-loop unknown 断言改为 failed outcome，同时保留一次模型／一次工具、不 replay 检查；Thread 私有 Memory 用例随范围退役删除。之后重新提交并重跑完整门禁。
- 合并保守限制为同 category 且完全相同 literal subject/attribute/value，只去重复字面子句；宿主验证条件、例外及否定子句集合相同。它没有承担跨身份语义归并，也不自动裁决冲突值；仍超 4 KiB 就按需读。此边界与真实模型合并质量应分别审核。
- 桌面阶段首轮退出 1，19 个备份测试和 1 个历史 hash 样本仍使用 v1 Memory。保留 [第二轮失败证据](evidence/cm-step7/verification-second-failed.json)。备份夹具改经真实 v6 Store 写入；当前备份正文必须等于源文件，SHA 必须等于源字节的独立 SHA-256。历史 `desktop-hashes.json` 未改；其退役的 v1 backup 样本从当前执行样本中移除，草稿与 Telegram 的金样继续比较。
- 第三轮两个时区 pnpm test 均退出 0，随后 eval 因 5 个入口的旧存储 import 失败，见 [第三轮证据](evidence/cm-step7/verification-third-failed.json)。仍供冻结检查器使用的 M1 入口改接现有 v6 Store；旧 Memory acceptance 工具保留历史纯 Oracle 与分数，删除退役的执行／取证依赖，不将旧时态真值改成 v6 当前值。
- 为保留旧消息可读与旧外部 Memory Skill 的拒绝保护，留下历史识别和拒绝 guard；没有注册旧写入口。旧 checkpoint 的 optional 字段仍可读，不再生成。`cm-replay.mjs` 依赖已删双时态 as-of 接口，一并退役，历史测量报告保留。
- 统一 runner 的 `sourceHashes` 对经 Git 确认已删除的文件记 `null`，避免删除旧结构后 ENOENT；其他读取错误仍失败。checker、Oracle、手动故障工具与冒烟脚本均未改。
- 已查旧约束的 non-idempotent unknown、不自动重试、不能冒充普通失败、JSONL 完成轮历史约定。本次只对用户明确要求的 unknown 保存原请求与回执，未放开普通模型失败提交。
- 修复面向之后发生的 unknown 轮次；此前已经丢失的用户消息没有从缺失记录中重造，日用历史仍保持原样。
- 本轮真实模型调用 0、费用 $0；既有合批累计 $1.72338444，余 $1.02661556。SQLite、日用迁移和三个非阻塞问题另列 pending。第 6 步本轮不重新评分。

[决策轨迹](evidence/cm-step7/decisions.tsv) 的 loggedAt 是记录时间。pstack 的最小改动原则使 unknown 沿用唯一提交点；先迁移调用方再删旧 API 使旧结构整条退出；可复跑工具和真实产物验证原则使迁移采用完整清单／SHA／回滚，冒烟从临时干净检出生成。审查时重点核对新的 failed outcome 提交语义、合并子句保全规则，以及副本迁移的来源与游标前缀绑定。

### 附表 A：14 行执行裁决

| 旧行 | 实际处置 |
| --- | --- |
| 1 | 偏好，保留原文及来源 |
| 2 | 丢弃 |
| 3 | 丢弃 |
| 4 | 丢弃 |
| 5 | 丢弃 |
| 6 | 丢弃 |
| 7 | 丢弃 |
| 8 | 丢弃 |
| 9 | 偏好，正文追加“明确授权实施或测试时不适用”，保留原来源并标明 manual 修订 |
| 10 | 项目文档，去掉旧 HEAD／补丁号等一次性内容 |
| 11 | 项目文档，注明与现行计划冲突时以计划为准 |
| 12 | 偏好，保留原文及来源 |
| 13 | 项目决策文档 |
| 14 | 丢弃，后续连续同错事项另排 |

### 附表 B：测试退役与旧断言调整

删除以下完整测试文件，其产品实现属于本步退役范围：

- `apps/desktop/src/main/memory-temporal.test.ts`
- `packages/assistant/src/automatic-memory-acceptance.test.ts`
- `packages/assistant/src/hook-skill-real-acceptance.test.ts`
- `packages/assistant/src/memory-controls.test.ts`
- `packages/assistant/src/memory-everyday-observation-policy.test.ts`
- `packages/assistant/src/memory-fact-identity.test.ts`
- `packages/assistant/src/memory-instruction-live.test.ts`
- `packages/assistant/src/memory-temporal-acceptance.test.ts`
- `packages/assistant/src/memory-temporal.test.ts`

仍保留文件中的旧契约调整：

| 测试／位置 | 旧断言与调整原因 |
| --- | --- |
| loop 的 3 个 unknown 用例；computer-module 的 `stops the existing AgentLoop...`；no-progress 的 `unknown write outcomes...` | reject → failed outcome；停止／不重放语义保留，新增回执断言。Runtime `does not save...unknown` → `saves the original request...`，保存次数 0 → 1，正是本次 bug 修复 |
| compactor `CE05 ... retains goals...` | checklistTokens 193 → 264，因为必须保留 unknown 对应用户原话；C5 193 → 409，并断言真实 `checklist_overflow` 原因；没有放宽总预算 |
| `v1-v5 are readable without upgrading...` | 产品旧格式只读兼容 → 所有旧格式读写均要求迁移；一条 v6 产品路径的计划要求 |
| `memory-library` 的 `keeps Thread scope...`，dreaming 的 `does not consume Thread-private Memory experience...` | Thread scope 断言退役；library 保留停用文档 active 计数和伪造归属拒绝检查，dreaming 另一旧 Thread 依赖恢复用例改为当前 disabled 依赖抑制 |
| `memory-v6-store` 撤销回执 | `restore` → `undo`，使用当前 v6 操作名；所有恢复条目仍为 workspace |
| CLI 旧 consolidation 生命周期测试块、`automatic lifecycle triggers only after an eligible completed primary` | 旧候选整理路径退役；新抽取生命周期已有接线测试。运行期间拒绝普通输入用例保留 |
| 桌面 consolidation receipt 与旧 assertion／future-effective／undo-preview 测试块 | 移除候选回执和双时态预览断言，当前 v6 receipt 另有测试；bridge 的 primary/consolidation phase 改为仍在使用的 primary/text Skill |
| 3 组历史 Memory eval preflight | 保留全部 24 条历史纯检查，各加 live + 占位凭证仍明确拒绝已退役执行入口的断言；没有改写旧 Oracle 为 v6 判定 |
| backup 夹具／`matches __baseline__/desktop-hashes.json` | 退役的 v1 Memory 不再经过产品备份入口；原金样文件不改，新增 v6 实际备份字节及 SHA 对照，安全拒绝断言均保留 |
| `memory-management` | 来源检查改为仅 sourceKinds；实际 Controller 断言无 sourceQuote 和 messageId，避免卡片依赖退役 assertion |

未以冻结检查器改分或 fixture 模型结果声明真实模型验收。定向首跑曾因删除源码后 dist 残留拾到退休测试而失败；清理生成目录后再构建，统一验证使用此干净产物及临时检出。
