# 上下文与记忆：第 0 步功能盘点

## 1. 改了什么（文件和原因）

结论：完成第 0 步盘点，等待用户确认清单与第 5 段裁决；未进入第 1 步。唯一执行依据是 `docs/context-memory-refactor-plan.md`。本报告记录源码事实，不以提交存在推断已在日用进程加载。

| 文件 | 改动与原因 |
|---|---|
| `docs/context-memory-refactor-plan.md` §3 | 原 32 行扩为 CM01–CM68：拆开合并描述的能力，补入来源/导入/时态/撤回/后台/数据兼容/相邻入口，每项标保留、改、删、延后并附源码或提交证据；不修改 §2、§4、§6 决策 |
| `docs/v2-pilot/cm-step0.md` | 本步唯一报告：逐 PR 复核、v5 字段、按步骤替代的旧约束及待裁决冲突 |

基线：`origin/main=cfb46dddd182887ed41a3129d99b8c5e46747278`；实验分支开工 HEAD=`438f5ff791002cd911c30fab062b9c2d759158a3`，已 fetch 并 fast-forward。本步在 `/Users/a1-6/.codex/worktrees/cm-step0/aisdk-agent-framework` 的 `experiment/architecture-v2` 执行；原 main 工作区及其未提交改动保留。

证据简写沿用计划 §3：`M:` 是 **cfb46dd** 的 `examples/cli/src/`，`A:` 是 **438f5ff** 的 `packages/assistant/src/`，`D:` 是相应分支的 `apps/desktop/src/`。本报告中的代码行号固定于这两个提交；`L:n` 是 `docs/legacy/agents-constraints-2026-10-20.md:n`。同名文件不代表同一功能已接入。

## 2. 逐条对照验收项

| 验收项 | 状态与证据 / 检查名 |
|---|---|
| 先读 AGENTS、再读计划；实验分支 HEAD 至少 438f5ff | 已做：read-standing-rules、read-confirmed-plan、branch-baseline；见第 4 段命令；本表非套件名的检查名均指手动源码/文档检查 |
| 从 main 导出完整功能清单、补齐 §3、每项四选一及依据 | 已做：feature-inventory，CM01–CM68 共 68 项；来源覆盖记忆模型/全部写入口、来源校验、检索与消费方、上下文/压缩、日志/诊断/UI，以及边界相关外部能力 |
| 复核 §0 的“不在实验分支”，逐 PR 写依据 | 已做：pr-presence-audit，下表 9 个 PR；逐个检查 merge ancestry，并检查实际实现及调用点 |
| 盘点 §2.7 v5 所需字段 | 已做：v5-schema-audit，下表 16 项，区分已有、部分已有、缺失 |
| 盘点将被取代的旧约束并按步骤分组 | 已做：legacy-rule-map，下表按步骤 1–7 和后续边界分组，逐条列出行号及替代部分 |
| 列出未裁决的规则冲突，交用户拍板 | 已做：conflict-audit，第 5 段 C01–C12；没有选择其中一方实施 |
| 文档提交并推送到实验分支 | 已做：本报告与计划 §3 同一提交推送；最终提交号由交付消息给出；不创建 PR |
| 不写产品代码、不开始第 1 步 | 已做：docs-only-scope；产品/测试代码 diff 均为 0，无模型调用、数据迁移或日用进程重启 |

### 2.1 第 0 节逐 PR 复核

9 个提交均不是 `438f5ff` 的祖先。这只证明提交未合入；以下另查实际行为。#172 先合入 #171 的源分支，再由 #171 squash 进入 main，不能拿 #172 自己的 merge SHA 判断 main 是否包含它。

| PR / main 证据 | 复核结论与实验分支证据 |
|---|---|
| #171 `d370fd3` | **新增改动未进入；基础恢复已有。** A:foreground-autonomy.ts:9 已保留原请求与 metadata.source=steer 的修正；:25 在原请求被压缩掉时追加到末尾。缺少 main 的近期工具回执附带及正确放置；A:context-compactor.ts:408 仅有旧 completed 文件行动合并，没有 M:context-compactor.ts:182 的 projectHistoricalReceipts；无 herdr-target.ts/local-terminal.ts。§0 整体“不在”需细化为“该 PR 的增量不在，#170 基础在” |
| #172 `684b915`、`e5a04d6`，经 #171 `d370fd3` | **未进入。** main 的 AUTONOMOUS_EXCLUDED_TOOLS、AUTONOMOUS_CONSOLIDATION_NOTE、历史回执投影、精确 Shell 守卫不在 A:foreground-autonomy.ts / context-compactor.ts / app.ts。实验 A:no-progress-guard.ts:9 只覆盖 read_file/list_directory/search_files/web_fetch/web_search，不能替代 main `packages/ai-sdk-adapter/src/loop.ts:471` 的 Shell 观察/无工具收尾 |
| #174 `197ea64` | **未进入。** A:memory-library.ts:53 仍用正文首行作旧条目标题；实验 D:renderer/src/memory-library.tsx:167 无条件显示“重新读取文档”，main 同行只有 error 时显示。这两项修正都缺；既有 refreshToken 逻辑已在，不能称“没有刷新能力” |
| #175 `2f1589d` | **未进入。** main M:local-terminal.ts:11–14 是 ego-browser CLI 指引与 TaskSpace 复用；实验无 local-terminal.ts 及对应装配。A:browser.ts:1 是给 renderer 导出的纯函数集合，名称不能证明浏览器操作能力 |
| #177 `724436d` | **未进入。** main M:local-terminal.ts:18–20 增加现有 Pi agent get/read/prompt 和 Herdr PATH 处理；main M:foreground-autonomy.ts:92 有 TRUSTED_TELEGRAM_INSTRUCTIONS，TG Host 增加 channelTelegramToolApprovalSkipped。实验无 Herdr 目标文件及这些信任绑定入口。普通 TG 配对/手机确认属于已有能力 |
| #180 `f0a9114` | **未进入。** 实验树无 qq-config/entry/gateway/host/store、onebot-api、docs/qq-group-mode.md。按计划只保留群消息身份与不抽个人记忆约束；群接入延后 |
| #182 `62bcdc0` | **首次接入与恢复增量未进入；基础 CUA 已有。** 实验无 computer-connection.ts、computer-startup-recovery.ts、renderer/computer-connection.tsx，也无 main 新的 DriverError 分类/discoverComputerApps。A:modules/computer-module.ts:141、168、200 已有 computer_check/observe/action（来自 #164 `18e1e1d`），因此不能写成“实验没有 CUA” |
| #184 `4809b03` | **连续补充与跨端续聊增量未进入。** 实验 D:main/telegram-gateway.ts:447 只识别显式“调整”；:478 普通忙时消息直接拒绝。main :485–487 会将普通补充交给 #steer，另有 resident 跨 Thread 事件订阅和 renderer snapshot-sync；这些增量不在实验。不能把已有 channelSubscribe 当成完整跨端同步 |
| #185 `cfb46dd` | **未进入。** 该修复依赖 #184 的 source.steerId/#steer 路径；实验没有这条路径，仍在 D:main/telegram-gateway.ts:451 为显式调整发确认文案。main :518、:564–572 的成功静默/只报未应用未移入 |

§0 的基线日期陈述：main 仍是 cfb46dd；实验“最新 4005ada”已过时，开工实际为 438f5ff。该段是历史计划基线，本轮用本报告和 §3 的固定 SHA 补正观察，不重写其已确认原则。

### 2.2 v5 字段与存储能力

main 与实验的 `memory-store.ts` 字节完全相同（`git diff origin/main:examples/cli/src/memory-store.ts HEAD:packages/assistant/src/memory-store.ts` 为空）。以下只是 schema 和读写路径盘点，没有打开日用 memory.json；不推断生产数据一定已是 v5。

| 要求 | 已有 / 缺口及证据 |
|---|---|
| F01 格式版本 | 部分已有：A:memory-store.ts:104 的 version=4\|5；:1522 仅显式 library mutation 升为 5；空文件仍为 4（:497）。尚无本计划的一次性迁移 |
| F02 “被哪条取代” | **缺。** A:memory-store.ts:90 的 MemoryRecord、A:memory-temporal.ts:14 的 MemoryAssertion 无 replaces/replacedBy/supersededBy；versions.assertionId（Store :80）只是版本引用，不能表达跨条目取代或多条合并 |
| F03 是否置顶 | 已有：MemoryRecord.pinned 必填（Store :94），版本快照也有（:84）；Entry.pinned 是可选投影（:58）。字段存在不代表桌面有置顶入口 |
| F04 用户消息编号和原话摘录 | 已有：MemorySource.conversation={threadId,messageId,quote}（Store :37）；Assertion.sources 数组（Temporal :23）；isExactUserQuote（A:consolidation.ts:109）提供精确子串校验 |
| F05 确认式来源的用户肯定+助手提议两段 | **缺。** MemorySource 仅 manual/legacy/conversation；conversation 没有助手消息 ID/摘录/配对类型。validateSource（Store :354）只返回这三个字段，不能借塞额外属性持久保留配对关系 |
| F06 从哪条消息开始生效 | 部分已有：sources.messageId 与 validTime.from 可用；**无独立的生效消息引用**，不能从多源 sources 或双时态边界无歧义还原本计划的新含义 |
| F07 三类知识及当前项目归属 | **缺。** scope 只有 workspace/thread（Store :33）；kind 只有 preference/fact/event/note（Temporal :6）。这两者都不等价于用户偏好/项目笔记/记忆文档；project 身份与落地在后续 4.5，迁移需裁决 C07 |
| F08 文件夹、标题、文档正文顺序 | 已有：library.revision、folders、documents[{id,title,folderId,entryIds,scope}]（A:memory-library.ts:7–10）；正文由有序 entryIds 投影（:43–49），不是第二份事实。迁移需保留顺序和元数据 |
| F09 每 Thread 抽取进度 | 部分已有：ConsolidationCursor={threadId,throughMessageId,prefixHash,lastBatchId,updatedAt}（A:memory-candidates.ts:29）；缺屏蔽块的抽取状态/待补抽关联，现有指针不能直接证明新管线无跳段 |
| F10 进度与写入同次提交 | 现有能力可复用：commitCandidateBatch 同一 MemoryDocument 写 candidates/entries/cursor/receipt（Store :1259、:1292 起）；新单写路径尚未实现，不能称已满足 M1/M2 |
| F11 两次失败、待重抽、空闲再试一次 | **缺新状态。** 现有 outcomes.attempts 是逐消息 1–3 次，第三次 not_saved/retry_exhausted（Store :499–515）；没有按原文段的待重抽清单/空闲重试记录/“N 段没整理”计数 |
| F12 撤回/不确定状态、撤销关联 | 部分已有：Assertion.state=asserted/retracted，CAS/history/restore 在；**无结构化“不确定”标记或新取代链的撤销关联**。是否用正文标注由 M1 落地，不能把旧 candidate 当新审核队列 |
| F13 隐私/删除排除记录 | **缺。** 当前只有消息 metadata.memoryConsolidation=exclude（A:consolidation.ts:9），没有消息 ID+排除时刻+原因类别的记录及所有读取方统一过滤；该记录未必放在 Memory 文件，不在第 0 步指定路径 |
| F14 单一写入路径 | 尚未满足：Store 仍有 add/update/revise/restore/delete、commitCandidateBatch、changeLibrary/confirmImport（Store :216–296）；模型工具/Controller/自动处理均有入口。M2 要收敛写入实现，保留所需调用入口不等于保留多套持久化规则 |
| F15 锁/CAS/原子提交及未知提交 | 已有：flock、revision 校验、临时文件 fsync→rename→目录 fsync（Store :1966–1992）；post-rename 报 MEMORY_COMMIT_UNCERTAIN。不能把“待重抽”用于重试不确定写入 |
| F16 高版本只读不写 | 仅“拒绝”已有：Store :997 对未知版本抛 MEMORY_VERSION_UNSUPPORTED；没有可展示的只读模式。旧 v5 读取也不会完整保留新增语义（:723 严拒未知 record 字段、:1029 重建顶层对象）；C06 必须先定版本与旧进程策略 |

明确缺口：取代关系、确认式双段来源；其余已有字段要按新语义重新接线。当前表/只追加操作日志、SQLite 仍按计划延后，不据此新建 schema。

### 2.3 会被计划取代的 legacy 条目（按实施步骤）

本轮只盘点；`docs/legacy/agents-constraints-2026-10-20.md` 不改。步骤落地时按 L:6 标“已取代（步骤、提交）”或删对应部分。下表对长条目只替换列出的行为，权限、CAS、来源真实性、未知效果、I1–I5 部分仍有效。

| 步骤 | legacy 定位 | 将被替代的具体部分 → 计划依据 |
|---|---|---|
| 1 / 4a | L:144 用量观察 | bounded optional metadata、不保存输入、没有向量记录 → §4.1 不裁剪/输入/各段 hash/向量；原 journal 边界未裁决，C03 |
| 2 / 离线重放 | L:115、139 的现行选择/重建描述 | 作为旧组装基线保留到对照完成；新组装器只离线计算，不把重放当真实模型调用或执行恢复；§4.2。该步不提前删除行为约束 |
| 3 / 4b | L:115 默认检索与 12条/8KiB；L:117、118、120、121 的检索部分；L:155 follow-up rewrite | 按问题选记忆、改写/向量/相关性/RRF/冷启动、kind tie-break → §2.1–2.4 固定全量偏好/笔记与索引、仅超额关键词按需读 |
| 3 / 4b | L:119 contextView；L:132、133 注入位置；L:195 请求引用位置 | 派生画像/续办视图、checkpoint/resume/任务引用前置 → §2.1 ②快照与⑤当前消息；请求和真回执清单由步骤 5 接续 |
| 3 / 4b | L:131 八回合遗漏摘要；L:139 的 opt-in、/compact 入口与固定选择 | 8 回合/128KiB、手动模式 → §3 CM40/41/48、§6.5 自动按比例；哈希校验、工具配对不拆保留 |
| 3 / 4b | L:124 /modules 的“生产 selector 可注入数”；L:143 的旧 compaction 诊断字段 | 改用五层实际快照/准备状态口径；静态预检只读、诊断不触发模型的规则保留 |
| 3 / 4b + 后续方法重做 | L:94“ordinary chat 无直接 Memory 工具”；L:86 自动写入/候选边界 | 固定参考改为快照；直接写工具在 M1 引入；候选写入口到 M2 停掉。§2.4 已有方法只读索引，同时停新 dreaming；后续架构第 7 步再做 |
| 4 / M1 | L:90 generic literal 更新；L:112 四种已知属性；L:121、122 话题/句式及从现在变更 | 已知槽/场景/值的补丁门槛、不同值 review-only → §2.4 条件正文、不同属性分开、§2.5 原话时间与不确定/双有效值诊断；来源/CAS 校验仍保留 |
| 4 / M1 | L:93 自动分类/pending；L:94 生命周期；L:111 host prepare/stage；L:112 单步抽取及 coverage | 新 proposal 的 host 分类+内部 pending/来源算已处理、每轮 Hook/启动补 Run、8 turns → §2.5 阈值或空闲触发、全文块、确认式来源、§2.6 无工具非 agent 队列；pending 持久结构步骤 7 清理 |
| 4 / M1 | L:114 oversized/3 次重试；L:126 要求用户重新短述及 30s/120s Run | too_large/retry_exhausted 终止、依赖用户拆分解堵、consolidator Run → §2.3 全文保留、§2.7 两次失败待重抽/空闲再试，显示未整理段；现有超时不能直接套为新队列参数 |
| 4 / M1 | L:123 的内容无效转 review、候选/多源 proposal；L:153 hosted memory_add | 多源候选、内容失败留 review、当前用户 direct add 原样正文 → §2.5 一个写工具/确认式来源；用户原话验证保留，确认式为已明确授权的扩展 |
| 5 / 4c | L:131 工作摘要；L:139 单份递归摘要；L:195 进程内原请求引用 | → §2.2 分段、远期索引、不可模糊清单；保存时精简行动，完成/未执行各 8，失败/未知全留；旧工具/附件占位 |
| 5 / 4c | L:165 WorkTask 续办的注入位置 | 只改引用位置/与清单配合；最新 owned Run、不可恢复权限及证据核验仍保留 |
| 6 / 4d | L:139 同步 compaction/单条用户超长不替换；L:131 omitted-turn 重建 | → §2.3 非阻塞块屏蔽、超长头尾/外存、一次超限重试；§2.6 后台摘要两轮间安装；配对边界/原文/既有 hash 协议保留 |
| 6 / 4d | L:98 transcript-only 表述；L:123 exclude 只约束沉淀；L:143 历史诊断读取 | 原始提交日志保留，新增 §2.8 排除投影，组装/压缩/抽取/搜索/编号读/诊断/导出/eval 均过滤；聊天界面例外；不修改原文、回执记录不重放 |
| 7 / M2 | L:111、112、113、114、123、126 的候选/覆盖/重试持久契约 | candidates/accepted/rejected/stale、candidate receipt replay、coverage 重试写入口、review 配置兼容 → §2.7 单路径、进度/待重抽、删除旧结构；来源验证/未知提交不删除 |
| 7 / M2 | L:116 双时态唯一事实源、64 assertions/版本、change/correct/restore；L:117、125 时态编辑/查询 | → §6.1 来源生效/取代链；§6.3 一次性迁移保留旧文件；旧 disabled/expired/legacy_partial 映射见 C07 |
| 7 / M2 | L:93、113、117、123、125 的 pin/scope/历史管理；L:187、188 文档条目 | 去候选依赖和旧 review/时态操作面；保留文件夹/标题/entryIds 顺序、手动编辑/导入与原子 CAS；§2.4–2.7；自动合并/置顶见 C09 |
| 7 / M2 | L:189 仅 library mutation 才 v5、旧进程拒读 | → §2.7/§6.3 一次性版本迁移；版本只读政策见 C06，不能原版本默默新增再被旧写入丢掉 |
| 后续 4.5 / worker | L:115、136 的 worker 词法 workspace-only 快照 | 本计划删除旧检索但项目归属后续落地；消费方承接见 C12；不把用户 home/项目数据路径提前纳入本轮 |

已查且继续保留的安全边界：L:71–82 工具副作用不变量；L:98–101 transcript/Run/WorkTask 回执；L:105–110 TUI/工具确认与授权；L:127–129 Shell/Docker/网页；L:132–138 checkpoint/worker/通知/RSS 中的权限及未知效果部分；L:149 hash；L:157、159、163、165、167 的 verifier/续办证据；L:169、171 Computer Use；L:193–194 前台授权与执行预算。L:193 与现行 D2 冲突，单列 C01。它们不随记忆旧规则整条删除。

治理条款另已由当前 AGENTS 接管：L:13–17、27–40、174–176、180–183 的确认/提交/全套快照/全面状态测试/文档管理，按当前 AGENTS §1–5 执行；本计划明确允许的行为变更不再套用 L:40“行为变化必须无”。不把这些治理更新计作产品实现。

## 3. 前后数字

| 指标 | 本步前 → 本步后 |
|---|---|
| 新增/删除产品代码行数 | +0 / -0 |
| 新增/删除测试代码行数、测试文件 | +0 / -0；未新增、修改、删除测试或快照 |
| §3 功能行数 | 32 → 68：保留 13、改 38、删 10、延后 7；四种去向逐行填写 |
| 逐 PR 复核 | 9 个，全部提交未合入；其中 #171/#182 有更早的基础能力，不能整项判不存在 |
| v5 字段/能力盘点 | 16 项；关键新增字段尚未实现 |
| 未裁决冲突 | C01–C12，共 12 项；源码缺口与规则冲突分开描述 |
| pnpm test 实测 | runtime：1759 tests / 1746 pass / 0 fail / 13 skipped；desktop：658 / 658 / 0 / 0；desktop scripts：12 / 12 / 0 / 0；合计 2429 / 2416 / 0 / 13 |
| 缓存率/首字耗时/调用均值/摘要 tokens | 本步未采集；计划第 1 步才扩展日志与基线，不把计划 §1 旧数字当本轮实测 |

## 4. 实际命令和退出码

以下在独立实验 worktree 执行；第一个 status/worktree 命令在原 checkout 执行。命令产生的测试临时文件不属于日用数据，未执行真实模型、浏览器、CUA 或 TG 发送。

| 命令 / 检查名 | 退出码与观测 |
|---|---|
| `git status --short --branch`、`git worktree list`、`git remote -v` | 0；原 checkout 是 main 且有未提交修改，选择隔离 worktree |
| `cat AGENTS.md`，再 `nl -ba docs/context-memory-refactor-plan.md`（分段），`nl -ba docs/legacy/agents-constraints-2026-10-20.md`（分段） | 0；standing-rules / confirmed-plan / legacy-rule-map |
| `git fetch origin`；`git switch experiment/architecture-v2`；`git pull --ff-only origin experiment/architecture-v2`；`git log -1 --format='%H %s'` | 0；分支从本地旧引用 fast-forward 到 438f5ff |
| `git ls-remote origin refs/heads/main refs/heads/experiment/architecture-v2` | 0；提交前再核对远端分别 cfb46dd、438f5ff |
| `gh pr view 171 --json number,title,mergeCommit,commits,state,baseRefName,headRefName`；同命令 PR=172 | 0；两者 MERGED；#172 base 是 codex/local-terminal-control，#171 base 是 main |
| `for commit in d370fd3 f0791ec 197ea64 2f1589d 724436d f0a9114 62bcdc0 4809b03 cfb46dd; do if git merge-base --is-ancestor "$commit" HEAD; then git show -s --format='%h present %s' "$commit"; else git show -s --format='%h absent %s' "$commit"; fi; done` | 循环 0；每次 ancestry=1，9 项均 absent；另用 git show/git grep 检查实现 |
| `git diff origin/main:examples/cli/src/memory-store.ts HEAD:packages/assistant/src/memory-store.ts --stat` | 0，空输出；schema 主文件相同，未据此假定 UI/宿主装配相同 |
| `git show 3ecfefe --stat`；`git show 197ea64 -- apps/desktop/src/renderer/src/memory-library.tsx examples/cli/src/memory-library.ts`；`git show 62bcdc0 -- examples/cli/src/modules/computer-module.ts` | 0；D2 授权变化、#174 标题刷新、#182 相对旧 CUA 的增量 |
| `pnpm install --frozen-lockfile --offline` | 0；pnpm 11.9.0，754 包本地复用，下载 0；lockfile 未改 |
| `pnpm typecheck` | 0；runtime 与 desktop 两个 TS 配置检查结束 |
| `pnpm test > /tmp/serika-cm-step0-test.log 2>&1` | 0；本步最后一轮全量，计数见第 3 段；日志保留在本机 /tmp |
| `git diff --check`；文档结构/证据路径/编号检查 | 0；仅两份文档，CM01–CM68 连续且证据存在，五段报告完整 |

检索备注：`git grep/rg` 无匹配时的 1 用作缺失观察，不算测试失败；一次查询不存在的 `packages/memory` 目录返回 2，后续定位实际 `packages/assistant/src`；一次 zsh 未匹配 no-progress glob，后改为明确目录检索；一次查询不存在的 automation-skills.ts 返回 128，未用其输出作证据。首次文档审计发现 main 的确认实现应引用 tui.ts:353，已修正错误的 tool-confirmation.ts 路径后重新检查。

运行环境实测为 macOS（Node v26.4.0），不沿用 AGENTS 中“Codex 环境是 Linux”的假设。全量套件含模拟/确定性验证；**未运行 32K 与日用大窗口的真实模型验收，未在常驻 Electron/手机端验收**。未改 UI 或装配文本，不运行额外像素对比；无付费 eval。I1–I5 所在测试随全量原样执行，没有改断言/删除用例。

## 5. 与计划不符的地方及理由；待用户裁决

本步没有产品实现偏离。为交付完整盘点，报告超过 AGENTS §5“一屏表格”的建议长度；功能清单只在计划 §3 保留一份。main 的“导出”通过固定提交只读完成，没有合并、cherry-pick 或移植 main。legacy 只盘点，尚不标“已取代”，避免文档声称未来步骤已经落地。

以下冲突在后续触及对应规则前等待用户裁决。**C03 会影响第 1 步；本轮按用户要求交付到第 0 步。** 问题是具体差异，不把计划已明确裁决的简化重复送审。

| 编号 / 最早关联步骤 | 两边的规则与证据 | 计划尚未裁决的点 |
|---|---|---|
| C01 / 外部权限边界 | main #170 和 L:193：可信前台可免确认主机 Shell；实验 `3ecfefe`、A:modules/shell-module.ts:105–113、架构 §4.4 D2：无沙箱时每条主机 Shell 要确认 | 计划只采纳上下文需求，没改 Shell 权限；后续采用哪一授权基线？本步保留实验现状，不按 main 恢复授权 |
| C02 / TG 接入边界 | main #177 `724436d`：恰当绑定的 TG owner 可显式 toolApproval=skip，所有已注册工具免逐次确认；实验 TG 无此策略，L:108 不继承 remembered grants，D2 Shell 仍逐条问 | §0 把 #177 列作需求而 §3 延后外部能力，未决定是否接受这个额外权限策略及与 D2 的关系；跨端续聊不自动取得这项授权 |
| C03 / 步骤 1 | L:144：用量只存 bounded metadata、禁止 prompt/raw response retention；A:model-usage.ts:20 限 128 调用；A:execution-record-store.ts:658–662 会裁剪，L:194/原 journal 又限 8MiB。计划步骤 1 要“不裁剪、输入、各段 hash、向量调用” | “输入”是完整请求还是 token/段计数？保存在现有执行回执中还是单独日志？是否授权突破旧 journal 格式/容量？计划未给新日志路径、保留范围及排除过滤办法。需在第 1 步实施前裁决 |
| C04 / 步骤 4 | A:modules/memory-module.ts:523、L:108/153：Memory 写工具逐次确认且不能记住；L:94/automatic 路径普通聊天无直接工具。§2.5 增加显式聊天写工具、即时生效且不设审核，§5 又不允许额外弹窗 | 新增/取代/撤回工具是否将明确用户话语直接视作授权，还是保留旧逐次 tool approval？“不审核”本身没裁决“工具审批”；权限行为不能自行解释 |
| C05 / 步骤 3–4 | main/实验 Memory 读取工具也逐次确认（L:108；A:modules/memory-module.ts:523）；§2.4 要文档/方法按需工具读，§3/§2.5 又说 memory_ 合为一个仅增/取代/撤回工具；自主固定层不带聊天整理工具 | 写工具数量已定，独立只读的文档/方法/历史工具面与审批、可用于哪些运行模式尚未定。不能为“一个工具”删掉按需读，也不能自行把读工具全部免确认 |
| C06 / 步骤 7 | L:189 与代码是高版本拒读；§2.7 写“高版本只读不写”，同时“先保留 v5，缺字段加一次迁移”。旧 v5 parser 会丢顶层新字段或拒 record 新字段（A:memory-store.ts:723、997、1029） | 是否升级新版本号、旧进程是拒绝还是可读展示？如何防已支持 v5 的旧写者丢新字段？不能通过给现有 v5 原地加字段声称已有版本保护 |
| C07 / 步骤 7 | L:116、123、125：disabled/expired/retracted、未来有效段、legacy_partial、恢复各有语义；旧 scope 有 Thread，§2.4/§6 改成三类知识和摘要，并要求迁移前后有效事实/文档一致 | 旧 Thread 记忆如何转入摘要、无项目身份的 workspace 事实归哪类、disabled/expiry/未来时段如何保留而不复活？不能一律转个人偏好或丢历史来满足简化；旧文件只备份也不等于有效事实一致 |
| C08 / 步骤 6 | L:123 / A:consolidation.ts:9 的 exclude 只禁沉淀，仍可出现在对话/压缩；§2.8 新排除要所有模型/搜索/诊断读者跳过、界面可见 | 旧 exclude 是否升级为全读排除？两种意图不同，不能无声扩大；旧记忆中的 sourceQuote/历史副本及既有方法引用如何同步过滤，计划只明确原消息和由其抽取的记忆，未定这些派生副本 |
| C09 / 步骤 4/7 | L:112 禁 LLM 合并腾容量、L:113 pin 只能显式用户操作；A:memory-store.ts:23/Temporal :4 存储硬上限 512/16MiB/64 assertions。§2.4 授权自动合并并保留置顶优先 | 自动合并已经获准，不再问“可否合并”；未定合并含置顶记录时新记录的 pin/撤销归属，以及到达硬存储上限但不能删除时如何写入。4KiB 注入超限改按需查不解决磁盘容量，不能自行改上限或丢旧记录 |
| C10 / 步骤 4/6/7 | 旧更正/变更/撤回/恢复/永久删除不同（A:memory-controls.ts:13–19、L:125）；实验 D:renderer/src/formal-memories.tsx:105–113 的删除不可撤销。§2.5 三操作和一句话撤销；§2.8 隐私撤回保留原文 | “这条记错了”取代后撤销是否恢复旧值、重抽是否可再生成已撤回事实；现有永久删除按钮是否同时创建排除记录？计划没有把删除与撤回等同，不能自动改成全部可逆或全部排除 |
| C11 / 步骤 3/5 与跨端后续 | L:107 普通 busy 输入拒绝；main #184 同 owner 当前 TG Run 的普通补充是 Steer；§2.4 已采纳同 Thread 多端追加，§4“后续接入”又把 #186 多对话列为后续 | 同一 Run 的 TG 普通补充需求本身已确认；未定是否在这 0–7 步接好跨端事件/入站持久关联，还是后续通道步骤。不能将 TUI busy 全面改成队列，也不能声称只移动上下文就已满足跨端需求 |
| C12 / 步骤 3 与后续 4.5 | L:115/136、A:task-worker-context.ts:25：worker 每任务只读一次 workspace-only 词法快照；§2.4 改全量用户偏好/当前项目笔记，对话作用域删除，而项目身份落地后续 4.5 | 删除旧检索后 worker/checkpoint_prepare 如何消费新三类记忆、是否继续 workspace-only，以及 shared preferences 在多项目间的选择尚未定。不能让 worker 自动继承主聊天/跨项目数据或直接丢掉已有任务上下文 |

已由计划裁决、无需再拍板：去向量/相关性/改写、去 review 与候选写入、双时态简化、对话记忆入摘要、取消长任务开关、保留文档、阈值按窗口比例、允许后台合并、确认式来源、屏蔽后补抽、隐私撤回重建、SQLite 和新 dreaming 延后。原计划 §3 误把“进程已有部分能力”写成“不在”的事实已在本步补正。

另有实施排期依赖：§2.4/2.5 的合并和周 TG 简报没有单列验收步骤；§2.7 失败进度在 M1 使用、存储清理在 M2，需在当前步骤内选择最小实现且保持可用，不能双路径长期并存。它们不授权第 0 步先建后台队列、日志或 schema。用户确认本报告前，不开始第 1 步。
