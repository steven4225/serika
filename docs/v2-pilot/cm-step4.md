# 上下文与记忆：第 4 步（复审修正及关闭竞态修复）

## 1. 改了什么

基线 `8c572bb85d9716254325a1aac490b3980eb438c1`，仅在实验 worktree 实施。依据计划 §2.4、§2.5、§2.7、C04/C09/C10，及用户明确批准的最小 v6 前置、1,200 行产品新增上限：

- `memory-v6-store.ts` 是唯一写路径；旧 `memory-store.ts` 只读 v1–v5。v6 使用文件锁、CAS、临时文件 fsync → rename → 目录 fsync；写入和抽取进度同次提交，rename 后错误保留 unknown，禁止自动重发。新字段见附表 A。
- `memory-write.ts`、`modules/memory-module.ts`：普通聊天只有 `memory_write`（新增／取代／撤回／撤销），免逐次确认，宿主绑定本条用户来源。确认式来源保存用户确认及相邻助手提议；正文逐字核对，保留否定与条件。自主、worker、后台不给该工具。
- `memory-extraction.ts`、`app.ts`、Controller：以有效窗口比例或空闲 30 分钟触发，一块一次无工具、不开思考、无模型请求重试、30 秒期限的抽取；原文在前、任务在后，工具仅名称／状态，附件仅说明，带 Thread／项目及已有时间／渠道。前台先取消并等待后台实际结算；成功后继续处理达到阈值的积压。停旧 Memory Skill、候选和 review 写入口；旧类型／读取结构留第 7 步清理。
- `experimental-data.ts` 与桌面启动接线：在创建 profile、journal、锁之前拒绝日用根目录及子目录（含符号链接别名）；覆盖用户指定的 `~/.config/@aisdk-agent/desktop` 和本机实际 `~/Library/Application Support/@aisdk-agent/desktop`。桌面状态由实际 extraction 生命周期导出；备份校验同时识别只读旧格式与新 v6。
- `memory-factual-receipts.ts` 从来源、取代链和撤回状态派生轻回执；UI 显示“有 N 段没整理”；`examples/eval/cm-step4.mjs` 提供隔离的两档窗口抽取／重放验收，默认不联网，计费模式必须显式批准。

使用 Karpathy 指南限定本步范围；查过 legacy 约束原行 90–114（来源／自动沉淀／候选）、108/110（确认边界）、194（自主执行）。计划 C04 只改变记忆工具；Shell、TG 和其他工具权限未扩大。I1–I5 的定义、verifier、回执格式及对应锁定测试未修改。

## 2. 逐条对照验收项

| 项目 | 结果与证据 |
|---|---|
| 单一写工具、普通聊天限定、免逐次确认 | 已做：`memory-m1-acceptance.test.ts` 实际 Controller 工具轮；`modules/memory-module.test.ts` 工具表和宿主来源；自主请求无 writer；后台 tools 为空 |
| 确认式来源、短应声、外部资料边界 | 已做：`C04 binds the specific confirmation; short acknowledgement and external evidence fail`；“嗯”“好吧”、工具提议、网页原文不能通过宿主来源检查；真实抽取质量未验证（本轮暂停） |
| 比例阈值、空闲 30 分钟、原子进度 | 已做：`consolidation-runtime.test.ts` 两档阈值和原子提交；`M1 idle trigger waits exactly 30 minutes`；第三次仍失败保留待整理；取消不推进。屏蔽后的补抽按用户要求留第 6 步 |
| C09 注入／磁盘上限 | 已做：磁盘 512 条／16 MiB；自动写预留至少一个完整条目及同等序列化字节（最低沿用单条 2 KiB 限制）；明确记住仍试实际上限，失败结果立即回到同轮模型并要求当场告知。`automatic extraction reserves space; explicit remember still tries the actual hard limit`；4 KiB 快照预算不拒绝磁盘写入 |
| C10 取代、撤回、撤销、界面删除 | 已做：新 ID 取代链、可撤销撤回、CAS；删除只保留来源消息＋该正文 hash 的抑制记录，其他记忆仍可从该消息提取；跨重开测试见 `memory-v6-store.test.ts`。桌面 IPC 预览不写盘／不启动 Run。隐私排除整段仍第 6 步 |
| 真冲突只在诊断，不同属性不冲突 | 已做：同 scope／subject／attribute 异值分组；home/company 独立属性。store 及 `cm-step4.test.mjs` 两档用例；不创建审核候选、不自动选一条 |
| 前台平均 ≤1.5，后台单列 | 已做 fixture：两条普通消息、3 次实际 mock-provider 请求，平均 1.5；后台该组 0。另一组后台 1 次请求，有独立 purpose、duration、usage 和 hash；并非真实模型质量或所有任务的平均值承诺 |
| v5 只读，无升级／旁路文件 | 已做：v1–v5 读后字节不变；每类写拒绝并提示“需要迁移（第 7 步）”；不创建锁、备份、v6 旁路。`memory-store.test.ts`／`memory-v6-store.test.ts` |
| 隔离目录、日用根目录启动拒写 | 已做：新 v6 临时工作区及路径／符号链接保护测试；不启动或重启日用进程，不迁移日用文件。见下方验证边界 |
| 第 9 条离线真实重放 | **未跑：用户要求先独立复现 Electron 冒烟。** 原来源及相邻普通助手消息冻结为本地 0600 文件；原用户要求移除一条限制，旧条目却强化了该限制。预演只验证接线；真实是否仍记反没有结论 |
| 证据随仓库提交 | 已做：`evidence/cm-step4/{foreground,background,plan,verification}.json`，仅用量、调用元数据、判定与哈希，无聊天／记忆正文、提示词、响应文本、凭证。含私人原文的 replay 文件不入库 |
| 快照／像素／不变量 | 已做：历史 baseline 未重录，非 Memory 指令、工具 schema、权限决定逐项比对；I1–I5 原测试运行。ego-browser 隔离渲染真实组件的前后快照；1440×900，变化 1,391 像素，bbox `(320,94)–(499,106)`，只在待整理文字；不是原生 Electron 验收 |

**验证边界：第 4 到第 6 步只在新建的 v6 测试数据上验证过，日用数据还没验证。** 这句话是用户指定的本阶段验证边界；本次实际只实施第 4 步，不宣称第 5／6 步已完成。旧数据迁移、14 行逐条对照表、v5 备份和日用验证仍在第 7 步。

## 3. 前后数字

相对基线，产品 **+1128 / −1042，净 +86 行**；测试 **+511 / −8755，净 -8244 行**。整文件退役 24 个；85 个旧测试块更名／退役的原名在附表 C。最终完整测试为 **1,802 pass / 0 fail / 11 skipped**（运行时 1,159、桌面 631、脚本 12）；离线 eval 77/77，guards 5/5 组。
产品及测试行数统计含 eval 脚本、不含文档／证据／历史 baseline。新增产品未超过批准的 1,200 行，新增测试少于新增产品。冻结历史快照、Oracle 和历史分数不重录；退役测试名单及断言改变见附表 B/C。

阈值：32,768 窗口、有效输入 26,624 → 3,328 estimated tokens；日用有效输入 256,000 → 31,999，小于 32,000 的压缩块。token 估计沿用 char-half，不当作供应商实测 token。前台 fixture 3/2=1.5；后台 fixture 1 次独立计量。真实模型请求 **0**、费用 **$0**；18 次两档预演都是 scripted responses，不计真实通过率。

## 4. 实际命令和退出码

工作目录 `/Users/a1-6/.codex/worktrees/cm-step0/aisdk-agent-framework`。

| 命令 | 最终结果 |
|---|---|
| `pnpm typecheck` | 0 |
| `pnpm test` | 0；1,802 pass / 0 fail / 11 skip |
| `pnpm eval:test` | 0；77/77（含两档 16 场景的 M1 接线及 unknown 停批） |
| `pnpm eval:guards` | 0；5/5 组 |
| 6 个 Memory 定向文件，`node --test --test-timeout=15000` | 0；19/19 |
| `node examples/eval/cm-step4.mjs`，指定隔离 replay fixture 与仓库 evidence 目录 | 0；18/18 预演，真实 0 次 |
| `git diff --check`；不变量／历史 baseline 的 `git diff --exit-code` | 0 |
本轮命令、退出码、用例数量及本地日志 SHA-256 存于 `evidence/cm-step4/review-final.json`；`verification.json` 为前一检查点历史，不依赖 `/tmp` 中的内容存续。中间失败没有当成通过：

- 旧写路径回归最初 301 fail／2 cancelled；停旧功能后清理专属测试，没有重录基线。
- full4 运行时 1,154 pass／2 fail：Memory registeredTools 的旧断言，按批准的单 writer 更新；定向 baseline 5/5。
- desktop1 的旧 Skill 状态判断、v6 备份校验、旧 immediate consolidation、候选来源回执及双时态断言失败；修状态／备份实际接线，其他改为本步契约。
- full5 运行时通过、桌面 background composer 断言失败：后台现在不创建 Run，Controller 实际为 idle，命令入口也保持 idle 语义；更新旧断言。
- full6 及首轮 guards 的新增 fixture 固定 1 秒轮询在负载下超时；改为等待实际 Controller 完成事件。证据定向测试也有一个 1 秒 Promise.race 超时，改为等待 extraction 的实际 updated 事件，命令保留 15 秒 test timeout。
- eval1/3 依赖已退役的候选／时态写接口；退役其 integration 入口并列清单，新增两档 M1 suite。M1 harness 首次对含 undefined 的 SDK request 直接做 JCS hash 失败；先投影成 JSON 值再 hash，未改 hash 协议。
- C09 新增通知断言首轮误把 ModuleHost 回调的第一个参数 moduleId 当正文；按实际 `(moduleId, message)` 签名修测试，产品通知路径已正确绑定。
- 桌面 preemption fixture 首次配置缺 `enabled`、误用 `contextBudget`，按现有严格 `contextCompaction` schema 修正；无网络调用。像素比较初次系统 Python 缺 PIL，改用已安装的 Codex runtime Python，不安装依赖。

## 5. 与计划不符的地方及理由

最小 v6 提前由用户明确批准；只保留计划已确定字段及 #166 已有导入回执，不加入操作日志／双时态。旧类型、只读解析和历史纯 Oracle 留待第 7 步清理；所有正式写入仅 v6。旧 live 记忆验收入口明确拒绝执行，避免对 v6 跑旧候选 Oracle 后产出误导分数；历史 Oracle／分数不改。

**尚存限制**：超长单条原文持久化到 `progress[].pending` 后跳过，后续消息继续抽取，记忆页计入待整理总数。空闲时只重抽当前窗口能容纳的完整原文；消息内部切块与屏蔽衔接仍留第 6 步。计划的后台合并仍第 7 步；完整隐私排除／重建仍第 6 步。无原生 Electron／常驻进程验收；fixture 证明路径与存储边界，真实抽取和第 9 条效果暂停，等待冒烟独立复现。

### 附表 A：v6 实际落盘字段清单（迁移前可按批准范围补字段，迁移后冻结）

| 字段 | 一句用途 |
|---|---|
| `version` | 固定为 6，使旧程序拒读更高格式 |
| `lastWrittenAt` | 上次原子提交时间，用于已有时钟倒退保护 |
| `entries` | 保存记忆及仍需撤销引用的取代／撤回条目 |
| `entries[].id` | 稳定引用条目、文档正文和轻回执 |
| `entries[].revision` | CAS，拒绝覆盖已经变化的目标 |
| `entries[].uncertain` | 布尔值，模型判断同条用户原话自相矛盾时为 true；手动编辑后为 false，界面和提示词分别显示 |
| `entries[].text` | 保存偏好、笔记或文档正文，条件和否定留在原文 |
| `entries[].category` | 区分 preference／note／document 三类 |
| `entries[].identity.subject` | 原话的明确主体，供诊断分组 |
| `entries[].identity.attribute` | 明确属性，独立的家／公司等分开 |
| `entries[].identity.value` | 具体值，供同属性异值诊断及确认对应 |
| `entries[].scope.kind` | 沿用 workspace／thread 作用域，新增聊天记忆使用当前 workspace |
| `entries[].scope.threadId` | 只读历史或显式条目所属 Thread；新临时信息不写 Thread 记忆 |
| `entries[].pinned` | 现有显式置顶，自动写不获得置顶权限 |
| `entries[].state` | active／disabled／superseded／retracted 的当前状态 |
| `entries[].createdAt` | 条目提交创建时间，区别于用户原话时间 |
| `entries[].updatedAt` | 条目最后改变时间，支持显示和现有投影 |
| `entries[].sources` | 条目保存的来源列表；撤销来源也保留在此生成回执 |
| `sources[].kind` | manual 或 conversation，手动编辑不能伪造对话来源 |
| `sources[].threadId` | 用户证据所在 Thread |
| `sources[].messageId` | 用户原话的消息编号，确认时绑定确认消息 |
| `sources[].quote` | 用户精确原话，不用助手／工具文本冒充 |
| `sources[].sentAt` | 原话时间，作为该来源的生效时间依据；未知为 null，不编造 |
| `sources[].proposal.messageId` | 与用户确认相邻的助手提议编号 |
| `sources[].proposal.quote` | 助手自己的提议摘录，配合用户明确具体值的确认 |
| `entries[].replaces` | 本条取代的旧条目，供撤销恢复 |
| `entries[].supersededBy` | 旧条目被哪条取代，供当前态和回执生成 |
| `entries[].withdrawal` | 撤回的用户／手动来源，字段结构同 sources；没有独立操作日志 |
| `progress[].threadId` | 每 Thread 独立抽取进度 |
| `progress[].throughMessageId` | 主整理消息边界，已明确挂入 pending 的超长来源允许越过；未知为 null |
| `progress[].prefixHash` | 边界前原文的既有 JCS hash，防止换原文后继续推进 |
| `progress[].pending[].messageId` | 未抽取的超长原始消息，供后续完整重抽并统计待整理段数 |
| `progress[].pending[].prefixHash` | 挂起消息及其之前原文的 JCS hash，防止原文变动后误重抽 |
| `progress[].retry.throughMessageId` | 待重抽段的终点，不代表已处理 |
| `progress[].retry.prefixHash` | 待重抽段的原文绑定，变动时拒绝写入 |
| `progress[].retry.failures` | 已提交失败次数 1–3；两次后等空闲一次，三次仍保留待整理 |
| `suppressed[].threadId` | 删除抑制标记的证据 Thread |
| `suppressed[].messageId` | 删除抑制标记的证据消息，不排除整条消息 |
| `suppressed[].memoryHash` | 被删除正文的 JCS hash，禁止同来源再抽相同正文；不保留被删内容 |
| `library.revision` | 既有文档库 CAS |
| `library.folders[].id` | 既有文件夹稳定编号 |
| `library.folders[].name` | 既有文件夹名称 |
| `library.documents[].id` | 文档稳定编号 |
| `library.documents[].title` | 文档标题，固定层仅放索引 |
| `library.documents[].folderId` | 文档所属文件夹，null 表示未归档 |
| `library.documents[].entryIds` | 正文分块的有序引用，不另存一套正文 |
| `library.documents[].scope` | 文档作用域，kind／threadId 含义同条目 |
| `importReceipts[].operationId` | #166 已有导入幂等编号，精确重放不再写入 |
| `importReceipts[].requestHash` | #166 已有请求指纹，同编号换内容拒绝；格式不改 |
| `importReceipts[].threadId` | 导入发起 Thread，防止跨 Thread 复用编号 |
| `importReceipts[].items[].id` | 已导入或已存在的条目编号 |
| `importReceipts[].items[].status` | saved／existing，显示实际保存结果 |
| `importReceipts[].committedAt` | 导入提交时间，不是通用操作日志 |

`progress`、`suppressed`、`library`、`importReceipts` 是上述记录的容器；`identity`／`proposal` 可省略，`withdrawal`／`retry` 可为 null。手动来源只有 kind，没有原话。v6 不落盘 assertion、versions、有效时间／系统时间区间、候选或审核队列；旧 Controller 读取类型仅返回派生视图。

**“不确定”字段来源**：计划 §2.5 的同条用户原话矛盾标注，由用户在本轮明确批准改为 `uncertain:boolean`。正文不加任何前缀、仍逐字绑定用户原话；该字段只表达原话内部矛盾，不表示来源缺失或目标不明。界面显示独立提示，固定参考快照、按需读取和抽取提示词传递独立字段。迁移前允许补字段，日用迁移后冻结。

### 附表 B：退役测试文件（逐个）

以下文件专测退役的候选／review 写入口、旧语义词法补丁、Memory Skill 或双时态写入；新测试覆盖 v6 来源、CAS、容量、原子进度和 unknown。旧格式读取、纯时态类型测试及 I1–I5 不在删除范围。

- `packages/assistant/src/app-memory-explicit-transition.test.ts`
- `packages/assistant/src/app-memory-generic-facts.test.ts`
- `packages/assistant/src/app-memory-phase-b.test.ts`
- `packages/assistant/src/app-memory-runtime.test.ts`
- `packages/assistant/src/app-run-state.test.ts`
- `packages/assistant/src/assistant-controller-memory-phase-b.test.ts`
- `packages/assistant/src/memory-candidate-store.test.ts`
- `packages/assistant/src/memory-candidate-temporal.test.ts`
- `packages/assistant/src/memory-consolidation.test.ts`
- `packages/assistant/src/memory-correctness.test.ts`
- `packages/assistant/src/memory-everyday-preference.test.ts`
- `packages/assistant/src/memory-explicit-change.test.ts`
- `packages/assistant/src/memory-generic-facts.test.ts`
- `packages/assistant/src/memory-historical-conflict-contract.test.ts`
- `packages/assistant/src/memory-per-fact.test.ts`
- `packages/assistant/src/memory-proposed-scope-review.test.ts`
- `packages/assistant/src/memory-retry-limit.test.ts`
- `packages/assistant/src/memory-review-lifecycle-acceptance.test.ts`
- `packages/assistant/src/memory-store-write-boundary.test.ts`
- `packages/assistant/src/memory-temporal-boundary.test.ts`
- `packages/assistant/src/memory-temporal-store.test.ts`
- `packages/assistant/src/memory-write-truth.test.ts`
- `packages/assistant/src/modules/memory-everyday-module.test.ts`
- `packages/assistant/src/modules/memory-temporal-module.test.ts`

### 附表 C：修改旧断言／删除测试块

| 文件或测试组 | 旧断言 → 新契约及依据 |
|---|---|
| `memory-store.test.ts`、`memory-factual-receipts.test.ts`、`consolidation-runtime.test.ts`、`modules/memory-module.test.ts` | v4/v5 可写、候选／Skill／双时态 → 旧格式只读、v6 单 writer、实际来源／取代链／原子进度；原安全边界有新格式回归 |
| `app-memory-instruction-budget.test.ts` | Memory Skill 存在 → 无 Memory Skill，普通写规则有界 |
| `app.test.ts`、`scheduled-skill-acceptance.test.ts` | automatic 隐藏写工具、可调度 Memory Skill → 普通单 writer、后台无工具、旧 Skill 拒绝注册 |
| `assistant-controller.test.ts`、`hook-skill-acceptance.test.ts`、`steering-controller.test.ts`、CLI prepare/stage 用例 | 候选审核和沉淀 Run／Hook → 删除退役入口专属断言；文本 Skill／Steer／WorkTask mutex 继续测，M1 用实际 extraction 取消和进度测试 |
| `memory-controls.test.ts` | 双时态转移、历史时间恢复、候选队列 → 删除这些入口的用例，保留输入伪造／idle mutex；桌面 v6 IPC 测取代／撤回／撤销／CAS |
| `memory-import.test.ts`、`memory-library.test.ts` | 可写 expiry、v5 版本、同 ID 修正文档、候选提交 → disabled fixture、v6／新 ID 取代链、候选拒绝；#166 原子幂等／容量／unknown 继续测 |
| `memory-management.test.ts` | 文本编辑同 ID/rev2 → 新 ID/rev1，旧条 superseded；引用新鲜度仍测 |
| `model-usage.test.ts` | 短聊天立即沉淀 → 阈值前无后台请求；chat／compaction 独立计量继续测 |
| `task-worker-context.test.ts`、`transcript-maintenance.test.ts` | 候选可写／需先覆盖才清物理日志 → 候选拒绝、无旧沉淀 Run；原 committed transcript／worker 隔离保持 |
| `tool-confirmation-remember.test.ts` | memory_list 权限 → memory_write 普通工具资格；其他 remember 权限未变 |
| `permission-decisions.test.ts`、`baseline-assembly.test.ts` | 全部旧 Memory 行完全相等 → 只列明批准的 Memory 工具／指令替换；非 Memory schema／指令／权限精确不变；历史快照不改 |
| `baseline-hashes.test.ts` | 运行退役 v4 批次写 hash 样本 → 从活动写样本移除；原 golden 未变，其他仍可达 hash 原样比较，新 v6 存储另测 |
| 桌面 `automation-bridge`、`background-chat`、`desktop-runtime` | auto 状态来自 Hooks、即时沉淀 Run／候选 → extraction 生命周期、阈值／取消、普通 memory_write／跨 Thread 重开；修真实状态接线 |
| 桌面 `memory-temporal`、renderer `memory-factual-receipts` | rev2 双时态恢复／候选 finalize → v6 新 ID 取代、撤回／撤销、来源生成“已保存”轻回执 |
| `examples/eval/provider*`、`cases.json` | 四个旧候选场景及 deferred receipt helper → 退役，使用 `cm-step4.test.mjs` 两档 8 场景的生产 extraction＋store；通用聊天／拒绝／预算场景保留 |
| `examples/eval/e2e.test.mjs` 的 restore pending fixture | 先批准候选再恢复 → 候选写入口已停，此 integration 用例删除；v6 undo 在 store／桌面 IPC 覆盖 |
| `memory-transition-acceptance.test.mjs` 的 runner integrates、`memory-everyday-acceptance.test.mjs` 的 production Controller | 12 个旧候选／同 ID 时态 live integration → 两个旧 integration 用例删除、入口拒绝；历史纯 Oracle 测试和已有分数原样保留 |

<details>
<summary>退役／更名块的原测试名（相对基线自动核对）</summary>

- `apps/cli/src/tui.test.ts`：allows only the consolidator's prepare and stage without prompting
- `apps/desktop/src/main/automation-bridge.test.ts`：reports automatic memory from enabled Hooks, not merely the available manual Skill
- `apps/desktop/src/main/desktop-runtime.test.ts`：uses generated daily identity, saves eligible proposals automatically, recalls in a new Thread, and reopens either history
- `apps/desktop/src/main/memory-temporal.test.ts`：temporal desktop IPC previews without writes, preserves history and requires explicit restore choices
- `examples/eval/e2e.test.mjs`：restore fixture explicitly approves only the matching real pending coffee source before exercising restoration
- `examples/eval/memory-everyday-acceptance.test.mjs`：production Controller and Store with no-memory transport fixture expose positive misses without network
- `examples/eval/memory-transition-acceptance.test.mjs`：runner integrates real Controller, committed sources, MemoryStore and report collection without network
- `examples/eval/provider.test.mjs`：expected deferred fault inspection still rejects unknown writes, missing receipts, changed sources and live mode
- `examples/eval/provider.test.mjs`：provider rejects consolidation commit failure rather than reporting chat success
- `packages/assistant/src/assistant-controller.test.ts`：AssistantController memory candidates
- `packages/assistant/src/assistant-controller.test.ts`：accepts ordinary chat during background consolidation but waits for cancellation and finalization
- `packages/assistant/src/assistant-controller.test.ts`：counts rejected prepare and stage requests so schema failures cannot bypass the batch protocol
- `packages/assistant/src/assistant-controller.test.ts`：does not start the automatic model when the pending candidate queue is full
- `packages/assistant/src/assistant-controller.test.ts`：forwards read-only context diagnostics without starting a Run or recovery
- `packages/assistant/src/assistant-controller.test.ts`：keeps the Run busy until candidates commit and notifies before its result
- `packages/assistant/src/assistant-controller.test.ts`：labels primary and consolidation results separately and cancels consolidation
- `packages/assistant/src/assistant-controller.test.ts`：persists invalid host JSON attempts across Controller restarts without silently declaring memory saved
- `packages/assistant/src/assistant-controller.test.ts`：preempts automatic consolidation before its Run handle arrives without consuming a second authorization
- `packages/assistant/src/assistant-controller.test.ts`：reports a failed candidate commit without turning a completed primary Run into failure
- `packages/assistant/src/assistant-controller.test.ts`：resumes current-Thread backlog on startup and cancelled staged proposals do not advance its cursor
- `packages/assistant/src/assistant-controller.test.ts`：runs the shared prepare-stage-finalize protocol and persists only pending proposals
- `packages/assistant/src/assistant-controller.test.ts`：shows a persisted oversized-memory disposition in plain language without replay duplication
- `packages/assistant/src/assistant-controller.test.ts`：shows persisted retry exhaustion without reporting it as too-large or silently complete
- `packages/assistant/src/consolidation-runtime.test.ts`：completes the native prepare-stage-commit-review path through the existing AgentLoop
- `packages/assistant/src/consolidation-runtime.test.ts`：does not commit a marker when consolidation input is too large
- `packages/assistant/src/consolidation-runtime.test.ts`：feeds committed material to the next model step without writing memory
- `packages/assistant/src/consolidation-runtime.test.ts`：memory consolidation Runtime integration
- `packages/assistant/src/consolidation-runtime.test.ts`：saves a confirmed candidate with committed-user provenance in the next Run
- `packages/assistant/src/hook-skill-acceptance.test.ts`：empty startup backlog emits no running state or model request and admits immediate manual and primary Runs
- `packages/assistant/src/hook-skill-acceptance.test.ts`：explicit hooks: [] disables followups but manual memory Skill saves, persists and recalls in another Thread
- `packages/assistant/src/hook-skill-acceptance.test.ts`：external memory Skill hook and manual execution share exact-source validation and automatic commit
- `packages/assistant/src/hook-skill-acceptance.test.ts`：model failure after staging is not a successful memory Skill commit; retry still processes the source
- `packages/assistant/src/hook-skill-acceptance.test.ts`：program opt-out survives JSONL and an invalid excluded source cannot advance the memory Skill cursor
- `packages/assistant/src/memory-controls.test.ts`：distinguishes retracted and out-of-range views from disabled or legacy records without exposing current facts
- `packages/assistant/src/memory-controls.test.ts`：keeps private historical scopes out of history, query, restore and maintenance
- `packages/assistant/src/memory-controls.test.ts`：previews exact temporal transitions without disk writes, rejects stale confirms, and paginates full sources
- `packages/assistant/src/memory-controls.test.ts`：reports a failed candidate write even when its model Run completed, and preserves backlog after restart
- `packages/assistant/src/memory-controls.test.ts`：requires explicit disabled/expired restore choices, creates a revision and never revives deleted memory
- `packages/assistant/src/memory-factual-receipts.test.ts`：a completed extraction with a failed durable commit cannot produce a saved or pending receipt
- `packages/assistant/src/memory-factual-receipts.test.ts`：a reopened exhausted extraction receipt tells the remaining truth instead of calling it too-large
- `packages/assistant/src/memory-factual-receipts.test.ts`：real Controller projects persisted saved, pending, deferred and too-large outcomes beside their exact source; restart does not duplicate
- `packages/assistant/src/memory-import.test.ts`：changed preview or capacity rejects the entire batch; disabled and expired entries are never revived
- `packages/assistant/src/memory-library.test.ts`：automatic consolidation retains v5 folders and document titles while new facts remain unfiled
- `packages/assistant/src/memory-library.test.ts`：keeps Thread scope, excludes expired documents from active counts and rejects forged ownership
- `packages/assistant/src/memory-store.test.ts`：WorkspaceMemoryStore
- `packages/assistant/src/memory-store.test.ts`：does not create the memory file on read, then persists ordered CRUD across reopen
- `packages/assistant/src/memory-store.test.ts`：does not let other threads or expired entries consume the injection budget
- `packages/assistant/src/memory-store.test.ts`：enforces text and entry-count limits independently of injection budget
- `packages/assistant/src/memory-store.test.ts`：normalizes v1 on read and upgrades the file on the first mutation
- `packages/assistant/src/memory-store.test.ts`：rejects changes to another thread and uses the caller clock for expiry
- `packages/assistant/src/memory-store.test.ts`：rejects malformed or forged conversation source without changing stored memory
- `packages/assistant/src/memory-store.test.ts`：reports malformed, unsupported, duplicate, and symlinked storage instead of treating it as empty
- `packages/assistant/src/memory-store.test.ts`：round-trips verified conversation provenance through updates and revision history
- `packages/assistant/src/memory-store.test.ts`：serializes concurrent updates and rejects the stale revision
- `packages/assistant/src/memory-store.test.ts`：stores scope, lifecycle fields, expiry, and bounded revision history
- `packages/assistant/src/modules/memory-module.test.ts`：binds conversation provenance to a committed user message before writing
- `packages/assistant/src/modules/memory-module.test.ts`：binds current projection reads and fallback consolidation to the module Thread and clock
- `packages/assistant/src/modules/memory-module.test.ts`：binds thread scope to the active thread and omits revision history
- `packages/assistant/src/modules/memory-module.test.ts`：createMemoryModule
- `packages/assistant/src/modules/memory-module.test.ts`：declares never-remembered calls, consolidator auto-approval, cards and policy-worded instructions
- `packages/assistant/src/modules/memory-module.test.ts`：exposes a top-level object input schema for provider tool calling
- `packages/assistant/src/modules/memory-module.test.ts`：host-bound memory_add ignores model source IDs and validates quotes against only the current user
- `packages/assistant/src/modules/memory-module.test.ts`：includes disabled memories and fails the run before sending oversized material
- `packages/assistant/src/modules/memory-module.test.ts`：keeps definite Memory write rejections as ordinary structured failures
- `packages/assistant/src/modules/memory-module.test.ts`：keeps disabled and expired current memories but excludes another thread during consolidation
- `packages/assistant/src/modules/memory-module.test.ts`：keeps the legacy 32-entry material fixture within its old context budget
- `packages/assistant/src/modules/memory-module.test.ts`：pages by final serialized bytes without truncating entries
- `packages/assistant/src/modules/memory-module.test.ts`：paginates visible memories and keeps private current and historical versions out of model tools
- `packages/assistant/src/modules/memory-module.test.ts`：passes message-reader failures and cancellation through
- `packages/assistant/src/modules/memory-module.test.ts`：passes store failures through unchanged
- `packages/assistant/src/modules/memory-module.test.ts`：prepares incremental user, assistant, and tool evidence without writing
- `packages/assistant/src/modules/memory-module.test.ts`：prepares recent committed text turns and all memories without writing
- `packages/assistant/src/modules/memory-module.test.ts`：raises unknown outcome for non-idempotent writes but returns candidate commit uncertainty for safe receipt replay
- `packages/assistant/src/modules/memory-module.test.ts`：registers consolidation only when a bound message reader is supplied
- `packages/assistant/src/modules/memory-module.test.ts`：registers the memory tools with the frozen metadata
- `packages/assistant/src/modules/memory-module.test.ts`：rejects incremental consolidation outside the automatic consolidator
- `packages/assistant/src/modules/memory-module.test.ts`：rejects unbound or unreadable conversation provenance without writing
- `packages/assistant/src/modules/memory-module.test.ts`：returns history and a conversation quote while list still omits history
- `packages/assistant/src/modules/memory-module.test.ts`：routes all CRUD calls through the same store instance
- `packages/assistant/src/modules/memory-module.test.ts`：routes memory_get to store.get and passes MEMORY_ENTRY_NOT_FOUND through
- `packages/assistant/src/modules/memory-module.test.ts`：routes stable candidate ids through the Store with the current Thread and clock
- `packages/assistant/src/modules/memory-module.test.ts`：stages through the run service and forbids model-owned state, Thread ids and pinned fields
- `packages/assistant/src/modules/memory-module.test.ts`：validates consolidation turns and rejects unbound identifiers
- `packages/assistant/src/modules/memory-module.test.ts`：validates the required add and update inputs
- `packages/assistant/src/steering-controller.test.ts`：Steer rejects auxiliary consolidation instead of mutating its invocation

</details>

### 附表 D：已暂停的真实抽取与第 9 条重放

脚本 `examples/eval/cm-step4.mjs` 已零网络预演，18/18 仅表示 scripted 接线通过。8 场景：“嗯”“好吧”、网页结果、工具结果、明确确认、同属性真冲突、家／公司独立属性、同句矛盾；另加第 9 条原文和相邻普通助手回复。两档窗口各一遍，**最多 18 次请求**，输出各最多 1,024 tokens，30 秒／次，无重试、不补样，不调用 embedding、主聊天或工具。

2026-10-21 通过 ego-browser 只读核对 [Command Code 官方模型页](https://commandcode.ai/models/deepseek-v4-1-flash-fast)：`deepseek/deepseek-v4.1-flash-fast` 输入 **$0.16/M**、cache read **$0.02/M**、输出 **$0.58/M**。脚本固定此模型／官方 endpoint，禁止 redirect；凭证只从已有保护环境读取。

每请求输入预演上界不得超过 26,624 estimated tokens；按每次实际输入保守预留 32,768 tokens、全额 1,024 输出且完全无缓存算，18 次 **$0.1050624**，本批申请预算 **$0.15**。这是 token 假设下的估算，非供应商账单封顶；输入／usage／费用超界或传输失败立刻停，不再派发后续请求；缺失 usage 保持 unknown 并保留 planned 分母。用量 × 单价核算，不按免费额度抵扣。

只将 usage、耗时、输入／输出 hash、宿主写入检查结果提交仓库；第 9 条私人原文保留本地 0600 文件。第 9 条任何留存必须保留完整问句中的撤销意图，不能再次强化原有限制；不以模型成功措辞判分。**用户最新指令暂停真实验收；本轮不执行 `--approved-live`。此前的 18 次／$0.15 批次不作为当前执行授权。**


### 本轮复审修正（第一件）

- **单元测试／假模型脚本**：`M1 oversized source is persisted pending while the following ordinary source extracts` 证明超长来源落盘挂起、主游标到后续消息、后续记忆保存，重开仍统计 1 段。
- **单元测试／假模型脚本**：`M1 oversized old source replay is superseded by the newer value without a conflict` 在扩大窗口后重抽完整旧来源；旧值 `state=superseded`、`supersededBy` 指向较新值，较新值仍是唯一当前快照，冲突数为 0。宿主按原消息序号判断，来源先后不明的同属性异值只作诊断，不能借重抽覆盖现值；不依据抽取完成时间判断新旧。
- **单元测试**：`C04 binds the specific confirmation; short acknowledgement and external evidence fail` 同时验证独立 `uncertain:true` 保留原文、添加旧前缀反而被拒。`v6 replacement/undo, withdrawal/undo, conflict diagnostics and source-specific deletion survive reopen` 验证字段实际落盘和投影。
- **真实 Electron／真实模型**：本次第一件未运行正式验收；真实模型请求 0、费用 $0。后续第二件使用独立 Electron 脚本；此前浏览器预览仅是组件渲染证据，不作为桌面验收。

#### 离线 eval 84 → 77 的完整核对

计数口径都是 `node --test *.test.mjs` 顶层测试数：**84 − 9 + 2 = 77**；不是把一个场景拆成不同计数，也不是模型质量通过率变化。历史纯 Oracle／既有分数未改。新测试内部的两档 16 场景只计为一个顶层测试。

| 退役的顶层测试（9 项） | 原因／现行覆盖 |
|---|---|
| `offline provider: 明确咖啡偏好自动保存且来源正确` | 旧候选批次协议停用；M1 实际 extraction＋v6 store 场景代替 |
| `offline provider: 相反新偏好待审核，不能自动双活` | 审核队列已退役；现在同属性双有效值只进诊断 |
| `offline provider: 纯提醒不入记忆，有意 no_memory 可推进游标（不测试调度）` | 旧 candidate/coverage 协议停用；M1 接线检查无记忆结果推进进度；真实语义仍未跑 |
| `offline provider: 故障注入：只提取提醒片段，剩余偏好不能被游标消费（offline only）` | 旧 staged receipt 故障注入停用；现行 deferred 不推进来源，失败次数／取消和原子进度有运行时测试 |
| `expected deferred fault inspection still rejects unknown writes, missing receipts, changed sources and live mode` | 只检查旧候选 fault-inspection 回执；现行 unknown 停批及 hash/CAS 检查代替 |
| `provider rejects consolidation commit failure rather than reporting chat success` | 旧整理 Run finalize 入口停用；现行后台与前台不共用 Run，提交屏障测试代替 |
| `restore fixture explicitly approves only the matching real pending coffee source before exercising restoration` | pending 审核入口停用；v6 store／桌面 IPC 覆盖撤销 |
| `runner integrates real Controller, committed sources, MemoryStore and report collection without network` | 旧时态变更 runner 不能写 v6，已显式拒绝；保留其纯 Oracle |
| `production Controller and Store with no-memory transport fixture expose positive misses without network` | 旧候选 everyday runner 停用；保留纯 Oracle，M1 两档接线代替 |

新增两项：`M1 extraction and persisted source/conflict evidence at 32K and daily windows (scripted, no semantic score)`；`M1 usage-unknown provider failure stops the quoted batch after one dispatch`。证据附计数及名称 hash，可按 84−9+2 复算。

#### 保留规则与现行测试

| 规则 | 测试名（测试类型均为单元测试／假模型脚本） |
|---|---|
| 用户精确原话、相邻确认、短应声／外部内容不得充当来源 | `C04 binds the specific confirmation; short acknowledgement and external evidence fail`；M1 两档 web-only／tool-only／ack 场景 |
| 当前 Thread 范围、页面字段不可伪造范围／来源 | `exposes current entries, CAS edits, explicit pin/disable, source semantics and Thread isolation without a Run`；`rejects renderer-owned sources, scope, system time and unrecognized fields` |
| 取代链、当前目标 CAS、过早来源不得覆盖较新值 | `v6 replacement/undo, withdrawal/undo, conflict diagnostics and source-specific deletion survive reopen`；`M1 oversized old source replay is superseded by the newer value without a conflict`；`malformed, unsupported, duplicate and symlinked files fail closed; stale concurrent CAS has one winner` |
| 撤回／撤销恢复及陈旧 revision 拒绝 | `v6 replacement/undo, withdrawal/undo, conflict diagnostics and source-specific deletion survive reopen`；`v6 desktop IPC previews without writes, replaces, retracts, undoes and permanently deletes with CAS` |
| 永久删除抑制原来源再次生成同条记忆，保留其他来源资格 | `v6 replacement/undo, withdrawal/undo, conflict diagnostics and source-specific deletion survive reopen`（删除后对同源正文重写仍为空，抑制记录持久化） |

现行保护在新写路径上有对应测试；上述表不把退役的候选／双时态专属行为称作仍然存在。字段格式变动仅在已批准的迁移前 v6 范围内。


#### 首轮失败记录（保留历史，不作为修复后结论）

首轮第一件全套验证失败时按要求停止；用户随后明确授权诊断并修复关闭竞态。第二件、第三件在第一件提交推送前未开始。第 3／4 节现已更新为修复后结果；本表保留首轮失败历史。

| 验证方式 | 命令／结果 |
|---|---|
| 单元测试 | `pnpm typecheck` 退出 0；6 个 Memory 定向文件 19 pass／0 fail |
| 假模型脚本 | `pnpm eval:test` 退出 0，77／77；`pnpm eval:guards` 退出 0，5 组；两档抽取／第 9 条 scripted 重放 18／18，真实请求 0 |
| 单元测试 | `pnpm test` **退出 1**：运行时 1,158 pass／0 fail／11 skip；桌面 630 pass／1 fail；后续 scripts 未跑 |
| 单元测试失败 | `src/main/telegram-gateway.test.ts:230` 的 `package2: desktop phone buttons grant nothing and stop remains a control`；清理临时 transcript 目录时报 `ENOTEMPTY`。当时未独立复现，后续诊断和修复见下节；未改该测试 |
| 真实 Electron | 正式冒烟脚本未开始；早先临时窗口探测不计为冒烟结果，已退出并删除其隔离目录 |
| 真实模型 | 未跑，费用 $0；遵从用户暂停指令 |

本轮源文件哈希、日志哈希、每组计数、eval 分母算式及相对 8c572bb 的行数存于 `evidence/cm-step4/review-fixes.json`。`verification.json` 保留上一检查点历史，首轮以 `review-fixes.json` 为准，最终以 `review-final.json` 为准；证据未包含聊天、记忆、提示词、响应或凭证内容。


#### 关闭竞态：先复现，再修复

**单元测试／假模型脚本**：原 `telegram-gateway.test.ts` 不改，外置 fs 探针包裹 `DesktopRuntime.shutdown()` 和 mkdir/open/rename，重复原 `package2: (desktop|expired) phone buttons` 两项，4 个并行进程、12 次独立运行。修复前 1 个进程复现同一 desktop 测试的 `ENOTEMPTY`，总计 60 次文件操作晚于 shutdown 返回；修复后同样 12 次独立运行（24 项测试）无失败、返回后文件操作 0。诊断重复仅用于复现竞态，不是失败重试策略。

- 实际残留为 `profile/transcripts/<Thread>/model-calls-2026-10-21.jsonl`、`.model-calls.lock`；另有尚未完成的 execution record 原子替换。
- 调用链：原 `model-usage-observer.ts:32–39` 的 abort listener 启动未被 shutdown 等待的 `finish` Promise → `ExecutionRecordStore.finishModelCall()` → `ModelCallLog.finish()`（`model-call-log.ts:46`）→ `#append()`（同文件 `57–65`）重新 mkdir／打开锁及日志；原 Controller shutdown 只等 Run task，没有覆盖这条取消收尾链。
- 测试 fixture `telegram-gateway.test.ts:63` 明确 `memory.enabled=false`，因此本次不是 pending 清单或后台抽取写入。外置探针只记录文件操作／调用栈，不读取正文、密钥。
- 修复：用同一个 pending Promise 集合追踪 observer 的开始及收尾写入；Controller 取消并等待 foreground/background 后，再等待这些实际 Promise 结束才释放 lease／返回。未改回执格式、状态判定或工具权限；没有重试、sleep，也没有改现有测试。

可复算证据见 `evidence/cm-step4/shutdown-reproduction.json`（各进程退出结果、晚于 shutdown 的操作和堆栈、探针／日志 hash），全套修复后结果另列。

**修复后最终结果（单元测试／假模型脚本）**：`pnpm typecheck`、`pnpm test` 均退出 0；运行时 1,158 pass／0 fail／11 skip，桌面 631 pass／0 fail，scripts 12 pass／0 fail，合计 1,801 pass／0 fail／11 skip。11 项是既有可选测试，未新增 skip。离线 eval 77／77、guards 5 组及定向 19／19；真实模型请求 0、费用 $0。正式 Electron 冒烟作为第二件在本提交推送后实施。


#### 第二件首轮失败记录（下节已纠正）

- **真实 Electron + 假模型**：`pnpm --filter @serika/desktop smoke` 启动构建后的主入口，原 preload／IPC 未替换。Electron 44.4.5；进程 PID、userData、renderer userAgent、file URL、脚本 SHA-256、源码提交及截图 hash 在 `evidence/electron-smoke/result.json`。启动无配置错误、普通消息收到回复两项完成。
- **复现与原因**：最初脚本把按钮名写为“发送”，实际 aria-label 是“发送消息”，已纠正；假模型最初把宿主第五层附注并入 sourceQuote，触发来源校验，已只取原始用户文本 part，未放松宿主校验。随后真实 `memory_write` completed、真实 `listMemories` 返回 1 条，但主记忆页没有该条目，断言失败。`memory.tsx:7–10` 仅在 managementOnly 渲染 FormalMemories，主页面只装配 MemoryLibraryPanel；`memory-library.tsx:184–185` 仅渲染文件夹和文档。失败截图可见对话已保存，而记忆页只有空文档库。
- **未完成／证据缺失，整体失败**：记忆页显示、撤销消失、完整重启持久化、日用路径拒写、日用配置副本实际报错清单；不把这些列为通过。隔离进程完整退出，临时目录已删除；日用进程／env／TG 数据未使用，日用配置副本检查尚未运行；无真实模型请求，费用 $0。macOS 已复现；Linux/Xvfb 未运行。
- **停下依据**：补主页面偏好／笔记列表涉及用户可见行为，按用户最新指令及 AGENTS §2 停下来确认。拟最小改动：记忆页展示当前偏好／项目笔记，保留现有文档库，按 v6 uncertain 布尔值显示标记，不改存储或权限。第二件代码／证据当前保留在工作区，未提交推送；第三件尚未开始。第一件已提交推送 `75f25e4`。
- **审核查询**：`gh issue list --repo steven4225/serika --state all` 及精确标题搜索未找到“experiment/architecture-v2 审核记录”；没有创建 issue 或发送评论。


#### 第二件交付：恢复并验证现有路径

**改了什么**：核对 `V6MemoryStore.getLibrary/readLibraryDocument → memoryLibraryDocuments`，已经使用 v6；保留的散条目投影按首个非空行生成标题并放入“未归档”。上一轮脚本没有进入该文件夹，误判为缺少列表。没有新增页面或列表；仅在现有条目／正文旁显示 `uncertain` 小标记，并在只读文档投影传递该字段，落盘格式不变。`formal-memories.tsx` 已通过真实 listMemories IPC 列出 v6；目前只提供编辑／删除，没有撤销按钮，因此冒烟走现有文档库显示和普通聊天撤销。

**逐条对照验收**：真实 Electron 44.4.5 + 假模型，构建产物、原 preload/IPC；启动无配置错误、聊天回复、进入“未归档”显示记忆、完整退出重启后记忆仍在且 hash 不变、聊天撤销后当前文档消失、日用路径规则拒写、日用配置临时副本启动报错共 7 项完成。主进程 PID/Electron/userData/home、renderer UA/file URL、重启 PID/记忆 hash、每项截图 hash、提交号/未提交源码 hash/脚本 hash/构建产物 hash 均见 `evidence/electron-smoke/result.json`。这是 macOS 真实 Electron 的假模型冒烟；Linux/Xvfb 提供同一命令入口，尚无 Linux 运行证据；真实模型未跑，仍待外部独立复现。

**前后数字**：本步在 1,200 行批准上限内；最终数字见 `evidence/electron-smoke/verification.json`。全套 1,802 pass／0 fail／11 项既有 skip（运行时 1,159、桌面 631、scripts 12）；文档投影 9／9、renderer 3／3。原生冒烟 7／7，真实模型 0 次／$0。

**命令与退出码**：`pnpm test`、`pnpm --filter @serika/desktop typecheck`、两组文档测试、`pnpm --filter @serika/desktop smoke` 均退出 0；计数和日志 hash 随仓库证据保存。复现入口：macOS 用最后一条命令；Linux 用 `xvfb-run -a pnpm --filter @serika/desktop smoke`。Linux 若无本机日用配置，必须用 `RUNLOOM_SMOKE_DAILY_CONFIG=/绝对路径/配置副本.json` 指定受信任副本；缺少任何必需证据即失败，无自动重试／sleep。

**差异与失败处理**：所有 RUNLOOM 路径、HOME/XDG 目录均在新临时根下；macOS Electron 的 native home 不随 HOME 自动改变，`RUNLOOM_DESKTOP_TEST=1` 下显式采用隔离 HOME。前期仅隔离 profile 时遗留的 12 个测试 resident identity 目录经身份及仅有 identity 文件核对后已清理，证据只留目录摘要／文件 hash。日用路径拒写用隔离 HOME 中的标准日用目录和哨兵验证：拒绝错误可见，目录仍只有原哨兵，hash 不变；不遍历真实日用数据树。日用进程未重启，日用 env/TG 数据未读。仅按用户要求读取日用配置 JSON，副本路径全部改成临时目录、信任绑定脱敏、其他模块关闭，未提交副本。实际启动只显示 `Invalid TUI config schema`；同一生产 `readTuiModuleConfig` 逐项拒绝六个字段，全部移除后通过：`modules.memory.queryRewrite`、`modules.memory.semantic`、`contextCompaction.mode`、`contextCompaction.warningRatio`、`herdrBinding`、`telegramAutonomy.toolApproval`。未修改日用配置或其权限；未为显示错误改产品校验语义。


#### 第三件交付：长期规则与账本

**改了什么**：AGENTS 新增验证分类、每步原生冒烟及必需证据、测试专用密钥与费用上限、保密扫描、审核 issue 处理；纠正旧条目中“Codex 环境固定 Linux”的假设，要求报告实际平台。全文 12 KiB 以内。

**逐项对照**：费用账本 `evidence/cost-ledger.json` 从用户指定已用 $0.36 起算，第 4 步真实模型请求 0、费用 $0，累计 $0.36；$1/步、$5/计划上限已写入规则。尚未启用真实请求，不读取或复制测试密钥。证据提交前完成密钥前缀扫描，无命中；截图未包含配置／设置页，日用配置副本已随临时根删除。

**数字**：本件产品／测试代码均 +0/−0；完整 Step4 产品 +1128/−1042，测试 +511/−8755（相对 8c572bb，统计口径同上）。文档检查点再次运行真实 Electron＋假模型冒烟 7／7，当前被测产品提交 e37a542，具体 pid／hash 见更新后的 result.json。

**命令**：`pnpm --filter @serika/desktop smoke`、证据 hash／账本复算／前缀扫描、`git diff --check` 退出 0。产品全套测试沿用第二件 1,802 pass／0 fail／11 既有 skip；本件仅文档和证据更新，未重复全套。

**限制与审核**：`gh issue list --repo steven4225/serika --state all --search 'experiment/architecture-v2 审核记录 in:title'` 未找到匹配 issue；未编造审核结论，也未创建 issue／发表评论。按用户要求，本件提交推送后停止；第 5 步、付费模型验收均未开始。冒烟的外部独立复现仍未取得，不能用本次重复执行替代。


#### 独立复现后纠正：v6 回执与冒烟断言

**改了什么**：按 §2.5 从 v6 来源和取代链直接生成回执，删除旧候选／coverage 回执投影；三个现有聊天布局在原话旁显示一行小字与“撤销”，使用现有 Controller 操作和 revision CAS，不改存储格式、工具来源校验或 I1–I5。查过旧约束的 Tool side-effect invariants、M-Local 回执／未知效果、formal-memory management／Temporal Memory C，以及 `receipt-invariants.md`。冒烟新增成功回执项，每项均检查可见 alert、error、warning 和失败状态；仅两项负例放行各自预期错误。日用配置 ENOENT 使用仓库脱敏样例，证据标“样例”；启动前强制干净源码。

**逐条对照**：真实 Electron 复现旧 bug：写入后无错误提示断言失败（1 条红色告警），截图与用户报告相符。触发链（修复前 b30dcc5）：`assistant-controller.ts:407–411` 写成功即发 memory-updated → `runtime-store.ts:553–554` reloadHistory → `runtime-bridge.ts:278–284` → `controller-memory.ts:47` 读当时的 committed transcript → `memory-factual-receipts.ts:25–28` 找不到尚未随 Run 提交的来源，返回不可核实；`runtime-store.ts:307` 经 onError 留下全局告警。三个聊天 renderer 同时漏掉 memoryReceipts 展示。最小回归在 v6 写成功、transcript 未提交时读取回执，旧代码失败、新代码成功；重启、原话挂载、分页、跨 Thread 和坏文件告警仍覆盖。正式原生冒烟从干净提交 `70b58bf` 运行，`sourceWorktreeDirty=false`，8/8 检查完成，8 张截图 hash、主进程身份、renderer UA、重启前后 pid／相同记忆 SHA-256、脚本／构建 hash 已提交在 `evidence/electron-smoke/result.json`。成功回执无告警，重启后点回执“撤销”，文档消失；日用路径规则拒写，隔离哨兵不变。每项 unexpectedErrors=0，两项负例各只允许其预期错误。

**前后数字**：旧 7/7 遗漏回执检查，不能作为回执正常的证据；本次目标 8 项并逐项断言无意外错误。受影响 renderer／真实 bridge 测试 8/8；全套 1,802 pass／0 fail／11 既有 skip（1,159＋631＋12），产品 +1198/−1097，测试 +528/−8757（相对 8c572bb，沿用源码／CSS／JSON 口径，含样例配置；未超过 1,200 行上限）。本次修正产品 +98/−83、测试 +23/−8；正式原生结果与全部数字见 `verification.json`，可逐项相加复算。真实模型请求 0、费用 $0，累计仍 $0.36。

**命令与退出码**：旧构建 `node apps/desktop/scripts/electron-smoke.mjs` 加无告警断言后退出 1（真实 Electron＋假模型）；v6 回执回归旧代码退出 1。修复后受影响 renderer／bridge 测试退出 0；`pnpm typecheck`、`pnpm test` 均退出 0，计数／日志 hash 见 `verification.json`。正式 `RUNLOOM_SMOKE_DAILY_CONFIG=/tmp/runloom-smoke-config-missing-70b58bf.json pnpm --filter @serika/desktop smoke` 退出 0，真实 Electron 44.4.5＋假模型，macOS 实测。脏工作区运行脚本退出 1，拒绝在创建临时目录、启动 Electron 或写证据前继续。

**差异与限制**：修改旧测试断言：原“缺少 transcript 就不可核实”为错，v6 记录在写入时已校验来源，应直接投影；坏文件仍报错，当前 Thread 限制仍保留，未删保护测试。第 4 到第 6 步只在新建的 v6 测试数据上验证过，日用数据还没验证。配置分支主动指向不存在的路径，实际使用仓库“样例”，7 个退役字段逐一由生产解析器拒绝，全部移除后通过；不是本轮日用配置的实测结论。新版 Linux/Xvfb 尚未在本机运行，不能把用户上一版的独立 6/7 视为本版通过。查询审核 issue 仍无匹配。付费验收继续暂停，提交推送后等审核。
