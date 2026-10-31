# 架构第 6 步：任务重做草案

状态：2026-10-31 用户与房间已确认 §11 的四项取舍。6a（四状态与单一 TaskStore）已按本稿实施，待合并，记录见 [architecture-v2-step6a.md](v2-pilot/architecture-v2-step6a.md)。6b／6c 未做。本稿仍是映射合同，不是行级补丁。基线起草时为 `main@07aebb4`（2026-10-26）。[当时的静态检查](v2-pilot/architecture-v2-step6-draft.md) 只覆盖文档。

依据：[架构路线第 6 步](architecture-v2.md)、[上下文与记忆计划 §4.1](context-memory-refactor-plan.md)。目标保持 `work_task_create`、自动推导校验、宿主执行校验、任务状态 7 → 4、与定时任务合并。SQLite、S2／S3、架构第 7 步、eval 迁包和 assistant 源码拆分均在本稿范围外。

## 1. 用户能完成什么

**Before：** 普通聊天没有 `work_task_create`。桌面对话式创建先放入一项人工验收，用户仍需进入详情配置程序校验。交办任务与定时任务分别存在 `work-tasks.json`、`tasks.json`，有两套生命周期和结果入口。已有结束前检查、交付提交和回执验证可继续使用。

**After，提案：** 用户说清目标后，助手提出任务、约束和可检查的交付条件，用户在现有确认卡核对后保存。开始任务时沿用当前 Run 入口与工具授权；宿主用真实回执和当前产物执行校验。任务页同时展示交办和定时安排，共用任务记录、四状态和结果查询；各类执行权限仍由各自入口检查。

先看两条使用路径：

1. 用户说“记录一个任务：修复这个项目的 slug 空格处理，保留已有行为，交付代码和回归测试”。助手读取已获授权的相关项目材料，调用 `work_task_create`，确认卡展示目标、约束、程序检查及人工项。保存后明确提示“已创建，尚未执行”；用户从任务页开始执行。
2. 用户说“一分钟后提醒我复核这份改动”。沿用提醒创建工具和确认卡；到点由既有 worker 处理，结果出现在同一任务入口。提醒不获得工程任务的文件或 Shell 权限。

创建任务只记录交办，不把所有普通聊天包装成任务。当前 Run 已经开始时，不能给它补绑新任务；后续显式启动的任务 Run 才在执行记录创建前绑定任务。

## 2. 当前链路与已有能力

以下是基线事实，不是本轮实现结果。

| 入口或所有者 | 当前行为与依据 |
|---|---|
| 桌面对话式创建 | [createAndStartTask](../apps/desktop/src/renderer/src/create-task.ts) 调用 Controller 创建，再显式启动；默认只有一项人工验收 |
| 任务合同 | [work-task-store.ts](../packages/assistant/src/work-task-store.ts) 的 `WorkTask` 保存 Thread、目标、约束、验收、Run 关联、交付及人工核对；`workTaskStatuses` 有七项 |
| 执行准入 | [controller-work-tasks.ts](../packages/assistant/src/controller-work-tasks.ts) 的 `run()` 核对当前 Thread、revision、空闲状态和可执行状态，预留任务槽；执行记录创建前绑定任务 |
| 结束与交付 | [work-task-completion.ts](../packages/assistant/src/work-task-completion.ts) 的 `createWorkTaskFinishCheck()` 可在同一 AgentLoop 内要求有限修正；[assistant-controller.ts](../packages/assistant/src/assistant-controller.ts) 在正常结算且 `delivered` 时已有自动提交交付，再由宿主核验 |
| 程序验收 | [verifyAutomaticCriterion](../packages/assistant/src/work-task-verification.ts) 检查本任务最新 Run 的精确 Shell 回执、文件写回执、当前内容和必要回读；人工质量需要用户明确接受 |
| 崩溃恢复 | [work-task-recovery.ts](../packages/assistant/src/work-task-recovery.ts) 保留缺失、外来及 unknown 回执的人工核对要求；[work-task-store.ts](../packages/assistant/src/work-task-store.ts) 的 `reconcile()` 拒绝在 `still_unknown` 时继续 |
| 定时实例与周期安排 | [task-store.ts](../packages/assistant/src/task-store.ts) v4 保存 `tasks`、`recurringTasks`、尝试、`pendingOutcome`、通知和已读；一次 claim 在同一写入中领取实例并推进周期 |
| 单 worker | [task-worker.ts](../packages/assistant/src/task-worker.ts) 先恢复已落盘结果，再将自己的遗留 running 收为 interrupted；通知失败只重试通知。`--safe-retry` 仅对既有明确允许的只读／无工具任务生效 |
| 来源声明 | [task-module.ts](../packages/assistant/src/modules/task-module.ts)、[scheduled-skill.ts](../packages/assistant/src/scheduled-skill.ts) 保留提醒、只读 Todoist、精确绑定 RSS 和无工具文本 Skill；保存安排与启用服务分开返回结果 |

权限和回执边界还核对了 [旧约束](legacy/agents-constraints-2026-10-20.md) 的 Tool side-effect invariants、WorkTask 恢复／验收、创建幂等、typed arrangements、后台交付及通知条目。旧工作区路径以当前 home／项目规则替代，其余已确认语义继续保留。

## 3. 两种合并形状与推荐

| 方案 | 调用方需要知道什么 | 代价与结论 |
|---|---|---|
| A：统一任务记录与 TaskStore，按任务种类选择既有执行入口 | 同一种创建／查询／生命周期；宿主根据种类核对允许的执行方式 | 一次离线升级和全部调用方迁移。推荐，真正收掉两套任务状态和写入路径 |
| B：保留两个 Store，仅由任务页和 Controller 聚合 | 仍需判断读哪份数据、哪种状态机、如何核对跨文件结果 | 不需要立即升级，但只能合并展示，无法完成“与定时任务合并”的目标。放弃 |

推荐 A。统一写入规则集中到现有 `TaskStore`，Controller 继续承担 Thread、权限和用户操作边界，worker 保留既有调度职责。不开新的任务框架、执行器注册中心或协调服务，也不借此拆分 assistant 源码。

### 数据形状提案

- `home/data/tasks.json` 升为 v5，`tasks` 保存所有单次实例，`recurringTasks` 保留周期安排。`work-tasks.json` 的合同迁入后退出生产读写；源文件只留离线备份。
- 单次实例共享身份、revision、四状态和结果关联。内容按“带交付合同的 WorkTask”或既有 typed arrangement 区分；不同种类只能携带自己的字段和来源，不能靠任意 prompt 选择执行器。
- WorkTask 保留原 Thread 与显式项目归属；来源 Thread、执行 Thread 和 projectId 各有原含义。既有后台实例的执行 Thread 不改成用户交办 Thread，历史缺失归属不从 cwd 推断。
- Run／工具执行回执仍留在原 transcript 目录。TaskStore 保存关联及已验证的交付／验收结果，不复制一套工具执行真相。后台 `TaskAttempt` 仍指整次任务尝试，不改称工具 Action／Attempt。
- `user`／`project` 记忆作用域不变。任务合同和执行指令不自动转成长期记忆；后台来源声明不因共用 Store 而获得全局记忆、其他项目或当前聊天历史。

下列是说明形状的伪类型，不是已新增的 schema 或公共接口：

```text
TaskInstance = 身份 + revision + 四状态 + 按种类区分的任务内容 + 执行/交付关联
TaskContent  = WorkTask 合同 | 既有受信 typed arrangement | 既有 legacy responder
RecurringTask = 现有周期规则 + 启停状态 + 下一次时间
```

本次不新增任意“定时运行工程任务”类型。普通 WorkTask 仍从前台显式执行；提醒、Todoist、RSS、文本 Skill 和现有 legacy responder 保留各自的 worker 准入规则。

## 4. 七状态映射到四状态

推荐四个任务生命周期状态为 `pending`（未完成）、`running`（执行中）、`completed`（已完成）、`cancelled`（已取消）。压缩的是任务生命周期枚举，不是工具结果、验收结果、通知状态或周期安排开关；系统仍须明确展示这些事实。

### WorkTask 映射

| 原状态 | 新状态 | 必须保留的事实与下一动作 |
|---|---|---|
| `ready` | `pending` | 未执行；用户可以开始 |
| `running` | `running` | 活着的执行仍由原 owner 持有。离线升级遇到未结算执行则停止；重启恢复按回执重新判断 |
| `paused` | `pending` | 上次执行与停止原因保留；需要显式继续，不自动排队 |
| `needs_review` | `pending` | 明显展示“效果待核对”；在用户核对前禁止开始、验收完成和普通取消 |
| `awaiting_acceptance` | `pending` | 交付及逐项结果保留；显示“待验收／需修改”，不能直接再次开始。用户接受或明确退回修改 |
| `completed` | `completed` | 保留交付及必需验收证据 |
| `cancelled` | `cancelled` | 保留取消和已有作用记录，不把取消当成没有副作用 |

`pending` 不是可执行许可。宿主根据最新任务归属回执、交付、当前验收结果和人工核对记录推导允许的动作；UI 展示相同结论。缺失或读失败时关闭执行入口，不能降为“尚未开始”。

优先展示效果待核对，其次是待验收／需修改、执行失败／需补信息、待时间、待开始／已暂停。不再落盘一套可独立编辑的“子状态”。旧 `needs_review` 即使回执缺失，也须将原核对要求及迁移来源保留下来；迁移不能伪造用户已核对记录或仅因字面状态改名而解锁。

### 定时实例与周期安排

| 原定时实例状态 | 新状态 | 处理 |
|---|---|---|
| `scheduled` | `pending` | 保留 `runAt`、`retryAt`、来源声明和当前尝试数；到期不等于有执行权限 |
| `running` | `running` | 仅由持有现有 worker 租约的入口结算；遗留执行按持久结果恢复或转为待处理 |
| `completed` | `completed` | 保留原结果及执行证据口径，不把历史“执行结束”追认为工程任务质量通过 |
| `failed`／`interrupted` | `pending` | 保留原失败／中断结果并进入需处理列表。迁移或刷新不能重新领取；原有明确 safe-retry 意图才可继续其既定重试 |
| `cancelled` | `cancelled` | 保留原记录，不再派发 |

周期安排保留 `active | paused | cancelled`，它描述是否产生下一次实例，独立于四个实例状态。每次发生生成新实例；不把已完成实例改回 pending。漏跑规则沿用现有固定偏移规则，typed arrangement 合并到最新应到时刻；既有 legacy 行为按其原口径保留。

### 状态转换与硬门槛

- `pending → running`：前台须显式开始／继续、当前 revision 与原 Thread／项目匹配、Thread 空闲、没有未解决核对或待验收交付。worker 只领取既有允许类型、到期且满足其重试／来源条件的实例。
- `running → pending`：预算耗尽、取消本轮、校验不满足、执行中断、需核对或人工验收未结束。保留停止原因和所有已知结果；取消一个 Run 不自动取消整个任务。
- `running/pending → completed`：前台合同有已提交交付，宿主重新核验全部必需程序项，必需人工项由用户明确接受。后台按既有种类的结果合同结算，界面仍区分“执行已结束”和业务质量。
- `pending → cancelled`：仅显式取消。未解决 unknown 必须走现有人工核对并选择取消；其 unknown 历史不清除。
- `completed/cancelled` 保持终态。运行中取消须先等待实际结算，期间仍显示 running；若留下 unknown，停在待核对，不能直接涂成 cancelled。已交付但未完成验收的退回修改继续沿用同一任务，清空本轮验收结果并保留前次交付供参考。

## 5. `work_task_create` 与自动推导

工具只向普通 primary 聊天提供，worker、后台沉淀和 Skill 不得获得。它只保存手动执行的 WorkTask；现有 `task_create`／`task_repeat_create` 等入口继续表达其 typed arrangement，并调用同一 TaskStore，RSS 仍走其受信绑定入口。

| 模型可提出 | 宿主负责 |
|---|---|
| 明确目标、原请求里的约束和交付物 | 从当前调用绑定来源消息、Thread、项目及 home；不接受模型指定这些身份或执行权限 |
| 基于当前已读项目材料的程序检查及必要人工项 | 校验判别类型、现有限额、相对路径／cwd 的项目归属和目录授权；歧义不能默认选一个目录 |
| 确切文件路径、已确认脚本中的测试命令 | 核对命令依据与来源上下文。无法由当前材料确定时保留人工项或说明缺信息，不虚构可执行测试 |
| 一份有界创建参数 | 生成 ID 和时间，使用既有创建回执与规范请求哈希，落盘后才报告成功 |

程序检查沿用 `artifact_exists`、可选 `requireReadback`、`shell_exit_zero`；“表达清楚／方案合适／改动范围可接受”等人工质量不能因为脚本为零退出码而自动通过。模型只提出检查，宿主判断检查是否有足够证据；不另调一个模型担任裁判。

宿主能够核对命令出处、路径归属和实际回执是否对应，不能据此证明这组测试覆盖了用户的全部意图。验收语义仍须在创建确认中可读，并分别做真实推导质量与人工质量验收。

创建前沿用现有逐次确认，确认卡展示完整目标、约束、程序项和人工项。用户本来就在桌面创建表单提交的动作沿用其明确提交语义；不为已经批准的字段追加第二套审核流程。

创建不运行校验命令、不启动任务或服务、不授予 Shell／文件权限。为避免 current Run 补绑，本稿推荐第一版只“保存后显式开始”，不自动接一个新 Run，也不预先建立待执行 Run 队列。已有桌面明确的“创建并开始”可在创建成功后调用现有前台准入，但不能由创建工具暗中继承。

创建去重建议复用已有 `CreationReceipt`。桌面继续派发前保存 operationId；聊天工具由宿主以当前 Thread／消息／toolCall 身份绑定稳定的创建键，模型不自选键。相同键、相同参数只返回当前实体；不同参数或归属拒绝。新消息重新表达相同自然语言不是相同操作。保存确认不明时只读核对当前记录，不自动重发；不把该能力推广成通用工具重放或 exactly-once。

## 6. 宿主执行校验与结果

沿用 `createWorkTaskFinishCheck()`、`verifyAutomaticCriterion()` 和现有自动提交交付链路。允许的同轮修正次数及 Run 预算沿用现值，不新增模型循环、重试层或预算。模型给出的交付总结只作说明，不能决定完成。

| 检查 | 通过条件 | 失败或不确定 |
|---|---|---|
| 执行归属 | 任务最新 Run、Thread、taskId、phase 相符，执行回执已结算 | 外来、缺失、未结算或 unknown 均转待核对，禁止借旧 Run 通过 |
| Shell | 精确 command＋cwd、成功且未截断的回执、exitCode 0，无超时／取消；之后没有使测试失效的写操作 | 模型自述、旧命令和零散不相干测试不能替代；所需新命令仍走原工具授权 |
| 产物 | 当前正规文件与本任务成功写回执的路径、字节数、SHA-256 匹配；要求回读时还须有写后完整匹配的读取回执 | 原先存在的文件或已变化的产物不通过；路径按当前项目和授权目录重检 |
| 人工项 | 用户针对当前任务 revision／交付明确接受 | 模型、迁移器、通知 ack 均不能代替 |
| 定时来源 | 沿用提醒确定性结果、Todoist 成功 planning 查询、RSS 精确订阅绑定与持久批次、文本 Skill 版本校验 | 不用模型文字冒充来源成功；保留原有无更新不通知等用途规则 |

校验器只读当前回执和产物，不直接派发新 Shell。需补测试时由同一 AgentLoop 在原预算和原权限内执行；权限被拒绝、条件不足、unknown 或预算耗尽即停。前台纯文本任务若没有可证明的程序项，沿用人工交付／验收，不让模型自行接受。

结果查询共用 TaskStore 实例，再按原执行目录查询真实回执。系统通知只表达提交状态，`acknowledgedAt` 只表达用户已读；通知失败不改完成结果、不重跑任务。失败／中断虽然映射到 pending，仍保留原错误并进入现有 attention／inbox 查询，不因过滤条件只看终态而消失。

## 7. 合并时最容易破坏的边界

1. **worker 误恢复前台任务。** 当前 `interruptRunning()` 扫描所有定时 running。共用 Store 后，领取、`listRunning()`、恢复和 `pendingOutcome` 安装必须按任务种类及原执行 owner 限域；worker 不得触碰前台正在运行的 WorkTask。前台也不能替 worker 宣告结束。
2. **两个进程领取同一任务。** 延用现有单 worker 租约、Thread 执行租约和短文件锁；开始转换、revision 校验与 Run 关联在现有创建屏障保护下完成。不得靠 UI 的 busy 状态或进程列表判断归属，不增加多 worker。
3. **把未完成映射成可重跑。** pending 的恢复、待验收和失败门槛全部由宿主执行；迁移不能生成 retryAt、清空 attempts、重建丢失回执或重发结果。人工核对不证明旧副作用未发生，明确继续也只允许后续新 Run，不重放旧调用。
4. **统一数据后扩大权限。** 任务种类与来源由受信入口决定；通用任务工具不能伪造 RSS，worker 不继承前台文件／Shell／浏览器权限。当前主对话、TG、工具批准和项目授权边界全部保留。
5. **沿用旧创建键发生冲突。** 迁移核对两份源中的任务 ID、创建 operationId 和内容哈希；冲突停止并交用户裁决，不自动改 ID、吞重复记录或覆盖结果。

## 8. 离线升级与退出旧路径

这是实施提案，本轮不读取真实 home，也不生成或执行迁移器。

1. 在明确授权的副本中固定源：既有 TaskStore 可读版本、WorkTask v1、引用的执行记录及项目映射，记录完整清单与 SHA。旧版已支持的 v1–v3 定时文件沿用其现有解析语义，不写通用格式猜测。
2. 升级前要求两个执行入口均已停稳，确认副本租约可取得；未结算 running、无法确定的项目、ID／创建键冲突或损坏文件立即停止。已存在的未解决核对作为阻塞事实保留。
3. dry-run 输出逐条映射、数量、ID、原状态／新状态、交付／验收／attempt／pendingOutcome／通知／已读／周期／Run 关联及阻塞。对已完成历史保留原口径，不重新评分或伪造验收。
4. 在新位置生成唯一 `tasks.json` v5，遵守现有文件锁、临时文件 sync、rename、目录 sync 和未知提交规则，复核源字节未变。目标已存在且内容不同就拒绝，不合并目标数据。
5. 同一实施单元迁完 Controller、worker、工具、桌面、备份／恢复和链接查询调用方，删除生产 WorkTaskStore 的第二条写入路径。旧文件只留备份；运行时遇到待升级源明确阻塞，不后台自动升级或双写。
6. 回滚只在未产生新执行／新写入的副本验证：恢复原文件布局和清单，核对 SHA。新版本已有写入或外部效果时停止，另定恢复方案，不把备份覆盖当成撤销副作用。

存储上限和记录容量沿用来源已有约束，不因为合库自行加倍或削减。若两份合法源合计放不进已批准容量，dry-run 必须明确停止，容量取舍另交用户决定；不能截断记录。Run／回执的跨文件提交仍有现有不确定边界，不宣称文件合库就有全链路事务。

## 9. 实施单元与验证关口

§11 已于 2026-10-31 确认。6a 已实现，待用户合并；6b／6c 未实施、未运行。每个单元单独分支、PR 到 main，由用户合并。

| 单元 | 可核对的完成结果与涉及位置 | 依赖与最小范围 | 验证及停止条件 |
|---|---|---|---|
| 6a：任务模型与存储合并 | 四状态、完整映射、唯一 TaskStore、离线 dry-run／upgrade／rollback；现有创建、执行、恢复、结果与通知路径都读新模型。已实现，待合并 | 迁移 `task-store.ts`、`work-task-store.ts` 调用方、Controller、worker、工具、桌面与备份恢复；同批删除旧写入口。未做 6b 的创建工具和确认卡 | `pnpm typecheck`；受影响 Store／recovery／worker／desktop 测试；副本清单、SHA 和回滚对照。任何字段丢失、unknown 解锁、跨 owner 恢复或容量冲突即停，不能进入 6b |
| 6b：对话式创建与自动推导 | 普通 primary 的 `work_task_create`、宿主归属／创建键、可读确认卡、已保存与已开始区分；已有任务页和定时页共用查询结果 | 6a 已合并。改任务模块、装配处、现有 Controller／桌面入口及确认文本；校验推导复用已有模型步骤和宿主 verifier | 实际 Runtime／AgentLoop 工具轮证明保存、拒绝、参数与归属拒绝、精确重放、未知提交只读核对；现有收尾检查不放宽。任一权限快照意外变化即停 |
| 6c：完整操作验收 | 下面五分钟主链、关键失败链、两档窗口与隔离重启证据；任务页可见真实状态和限制 | 6a／6b 已合并。不另建 eval 框架，不迁 `examples/eval`，不改旧 Oracle | 各代码单元末按仓库要求全套测试与真实 Electron＋脚本模型冒烟；使用全新测试 home。真实模型质量另获费用授权后才测；真实日用仍需独立操作确认 |

预计受影响测试包括现有 `work-task-store`、`work-task-recovery`、`work-task-rework`、`work-task-completion`、`work-task-artifacts`、`task-store`、`task-worker`、`task-worker-delivery`、`scheduled-skill`、`task-service-acceptance` 及桌面任务／inbox／通知路由测试。新增用例针对上述实际不变量，不为四个枚举值逐个写无行为测试；不改历史分数或删用例凑绿。

实际命令继续使用 `pnpm typecheck`、显式新测试 home 下的 `pnpm test`、`pnpm --filter @serika/desktop smoke`；不运行 `pnpm verify:cm6`。新功能的冒烟断言必须在实施时写进真实脚本，沿用原 preload／IPC；本稿没有把现有冒烟次数当成新功能证据。

## 10. 五分钟 Demo 与失败判据

这是未来实施验收脚本，不是当前可用功能。交付 6c 前，实施者须提供已构建的真实 Electron 隔离实例：新 home、仅授权的 fixture 项目、脚本模型和手动启动的隔离单 worker。无日用数据、真实模型、真实 TG 或 launchd 注册；预置准备不计为用户操作通过。

### 主链：对话建任务、校验、查看定时结果、重开

1. 入口为桌面“任务 → 创建任务”。fixture 使用现有 [repo-regression-v1](../packages/assistant/fixtures/work-task-eval/repo-regression-v1/request.md) 的独立可写副本，脚本模型按真实工具调用运行。输入 §1 的修复交办，核对确认卡的目标、精确测试命令及一项“改动范围可接受”的人工项后保存。
2. 任务只显示“待开始”，工具调用记录中没有文件写入和测试执行。点击开始，按当前权限确认所需调用；结束后打开交付，看到本任务成功写入／回读、最后一次修改后的测试回执、人工项待验收。未接受前保持 pending，不能显示全部完成。
3. 查看 fixture 当前改动并明确接受人工项。任务变 completed；详情能按当前交付重读产物，通知已读不影响验收。
4. 在同一隔离实例交办“一分钟后提醒复核”，核对并保存。到点后从同一任务入口打开提醒结果；没有工程任务的文件或 Shell 调用，没有真实模型 Run。后台服务是否可用单独显示。
5. 关闭并重开隔离实例。工程交付、提醒结果和两者归属保留；没有额外执行或通知冒充已读。全部步骤从已准备实例开始须能在五分钟内完成。

失败判据：用户仍须手填工程化验收 schema；已保存却暗中执行；无证据就 completed；人工项被自动接受；重开重放旧工具；定时实例获得工程任务权限；结果或核对提示丢失。任一项出现即未通过。

### 关键失败链

另用真实写工具的故障注入场景覆盖“已派发、结果确认不明”，让现有回执路径产生 unknown。任务页必须显著显示待核对，开始、普通取消、自动完成均不可用；重开后仍保留，模型和工具请求数不增加。用户记录核对结果后，明确继续只允许后续新 Run；选择取消也保留旧 unknown 历史。

同库 owner 测试同时保持一个前台任务运行，再启动隔离 worker 的恢复入口：前台任务的状态、Run 与租约必须不变。通知故障测试只允许通知尝试增加，模型／工具尝试不增加。这些是实施时必须新增或迁移的针对性用例，本轮没有运行。

脚本模型只证明真实装配、权限、状态和存储链路；自动推导能否理解真实任务、交付质量和真实日用体验仍需各自验收，不以本 Demo 的 fixture 结果代替。

## 11. 需要确认的取舍

2026-10-31 已确认，四项都按下面的肯定答案执行：

1. 采用 A：统一到现有 `TaskStore`／`tasks.json` v5，不是只聚合两个列表。
2. 接受 `pending | running | completed | cancelled` 四状态，并保留回执／验收驱动的硬门槛及明显的“待核对／待验收”提示。
3. `work_task_create` 不在 6a。6b 再做只保存、由用户显式开始的对话创建；已有桌面“创建并开始”保留。
4. 按 6a → 6b → 6c 交付。存储与所有调用方同批切换。容量冲突先停。真实日用升级和真实模型费用另行授权；本步两者都没有做。
