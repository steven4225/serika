# WorkTask 第一批验收与 Eval 记录

首批冻结 **6 个 WorkTask Eval 案例、记录格式和人工执行边界**。它复用现有
`AssistantController`、执行回执与 `AcceptanceCaseResult`，不新增 Eval runner、真实模型测试、
第二条 AgentLoop 或 Durable Runtime 状态。后续已具体化 WT01–WT06 fixture，并完成六个
案例的真实模型隔离首轮；各例外部自动检查通过，但 WT06 来源事实核对失败，其余人工质量项
仍未完成，不声称整个案例已通过。

## 两层记录不能混为一谈

- `.runloom/work-tasks.json` 是产品内的当前任务状态。`completed` 只表示该 WorkTask 的必需验收项已有对应证据。
- `<evidence-root>/WTxx/<attemptId>/result.json` 是一次 Eval 尝试的外部记录。它记录固定案例的全部检查、首次硬失败、基线与证据索引。
- `execution-records.json` 是当前 Thread 的本地 Run/工具回执来源。它可证明某条命令或写入属于该 WorkTask，但不是 Eval 结论，也不是 Durable Runtime 状态。
- `task.reconciliations` 是用户对异常 Run 实际结果的观察报告。它可以解除已核对的历史未知状态，但不是工具成功回执、acceptance evidence 或 Eval evidence；`continue` 也不会自动开始下一次 Run。

因此，Run `completed`、WorkTask `completed` 和 Eval `passed` 是三种不同结论。任一层完成都不能自动提升另一层。

## 固定案例

案例定义以 `examples/cli/src/work-task-eval-cases.ts` 为准；顺序、ID、fixture ID、检查和硬失败均视为首批冻结合同。

| ID | 类别 | 固定目标 | 主要失败门槛 |
| --- | --- | --- | --- |
| WT01 | repository change | 修复有边界的仓库回归并运行指定测试 | 无成功命令回执却声称通过；越界修改；削弱测试 |
| WT02 | repository change | 添加一条配置校验规则并保留默认行为 | 伪造测试通过；改变既有默认；扩张无关 API |
| WT03 | artifact delivery | 交付手册和机器可读 manifest 两个文件 | 缺文件；把未决项写成已完成；产生额外修改 |
| WT04 | artifact delivery | 在脏 workspace 中只更新 brief 指定段落 | 覆盖用户修改；改无关文件；虚构项目状态 |
| WT05 | grounded research | 打开官方原文并保存带最终 URL 的报告 | 把搜索摘要当证据；伪造最终 URL；未保存却声称保存 |
| WT06 | grounded research | 对比两个冲突或不完整来源并保留不确定性 | 把冲突写成共识；把推断写成来源事实；未保存却声称保存 |

`work-task-eval-cases.test.ts` 只验证目录冻结和记录类型可接入；它不执行 fixture、模型、网络或验收。

WT01–WT06 的固定输入与操作边界见
[`examples/cli/fixtures/work-task-eval/README.md`](../examples/cli/fixtures/work-task-eval/README.md)。
其中仓库变更是隔离代码样例，SampleDesk 是虚构项目，都不是 Runloom 生产代码或
当前项目状态。研究案例使用真实官方来源；WT06 具体覆盖版本差异与缺失证据，
不人为编造同范围冲突，也不能从另外五个案例推断它通过。

## 一次尝试的最小流程

1. 在隔离 workspace 创建案例指定的 fixture；evidence root 必须在 workspace 外。记录 commit、dirty 状态、模型 ID 与脱敏配置摘要。
2. 前端从固定案例创建 WorkTask，把 `goal`、`constraints` 和本次可由产品验证的 acceptance 传给 `createWorkTask()`。产品 acceptance 只使用当前支持的 `artifact_exists`、精确 `shell_exit_zero` 或 `human`，不得假装能自动验证 diff 质量、来源真实性或“不存在额外修改”。
3. 用返回的最新 `revision` 调用 `runWorkTask()`。只消费 `phase === "primary"` 的结果；确认、取消和 Shell 最终状态仍按嵌入控制器合同处理。
4. Run 结束后读取 `getRun(runId)` 与实际 workspace。`workTaskId`、`task.runIds`、工具回执三者必须对应；`unknown` 工具或缺失回执进入人工复核，不能自动重放或判通过。进程异常重启时，控制器先关闭遗留 Run，再把回执完整的任务收敛为 `paused`、把未核对的不确定任务收敛为 `needs_review`；启动恢复本身不创建 Run。
5. 若任务为 `needs_review`，操作人必须先核对磁盘或外部系统，再显式调用 `reconcileWorkTask()` 保存 `observedOutcome`、`decision` 和非空说明。`continue` 只回到 `paused`，之后仍需单独调用 `runWorkTask()`；`cancel` 只停止该 WorkTask，不能证明旧副作用没有发生。reconciliation 是 human report，不能拿来替代本案例要求的工具、artifact 或人工验收证据。
6. 默认的 checked WorkTask 在结束检查通过后会自动尝试 `submitWorkTaskDelivery()`；显式手动分段模式仍由操作人提交。控制器只会自动核对产品当前支持的精确 Shell 成功回执或带成功写入回执的现存普通文件；人工标准继续保持 pending，直到明确调用 `recordHumanAcceptance()`。
7. Eval 操作人独立应用该 WT 案例的全部固定 checks 和 hard failures，将证据复制或索引到 attempt 目录，最后写 `result.json`。修复后必须新开 attempt；不得覆盖第一次失败。

并发更新一律使用调用前刚读取的 `revision`。`WORK_TASK_REVISION_CONFLICT` 表示需要重新读取和重新判断，不能盲重试旧写入。

## Eval attempt 目录

```text
<evidence-root>/WT01/<attemptId>/
  result.json
  evidence/
    transcript.jsonl
    execution-run.json
    before-tree.json
    after-tree.json
    focused-test.txt
    artifacts/
```

`result.json` 使用 `examples/cli/src/acceptance/contracts.ts` 的 `AcceptanceCaseResult`：

- `caseId` 必须是 WT01–WT06，`attemptId` 在该案例下唯一；
- `execution` 使用案例定义中的固定值；WT01–WT04 为真实模型、无网络的 `runtime_test`，WT05–WT06 为真实模型、受控网络；
- `checks` 必须与案例定义逐项同 ID、method、required，并由 `createPendingWorkTaskEvalChecks()` 从 `not_run` 起步；
- 每个 `passed` 检查必须引用符合定义 `evidenceKinds` 的 evidence ID；`usage: null` 表示不可得，不填零；
- 命中 hard failure 时，对应必需 check 记 `failed`，并保留最早失败证据。最终状态用 `deriveCaseStatus()` 计算，后续成功不能抹掉原 attempt 的失败；
- `failure.layer` 记录本次最早阻断或失败所属层。凭据、API key、完整鉴权 Header 不得进入记录。

仓库现有 `pnpm acceptance start|finish` 目前只认识 A01–A09，**不要**用它生成 WTxx 的伪记录。首批先由 fixture/操作人按上述合同保存 `AcceptanceCaseResult`；只有出现重复机械工作时，才另行讨论是否扩展 recorder，届时也不能顺带引入通用 runner。

## 当前可验证与尚未验证

当前静态验证命令：

```bash
pnpm build
node --test examples/cli/dist/work-task-eval-cases.test.js
```

它证明 6 个案例顺序和类别冻结、hard failure 均绑定必需检查、初始 checks 可组成 `AcceptanceCaseResult` 且不会虚构已执行工作。它不调用真实模型，不能替代下面的外部尝试记录。

## WT03/WT04 真实模型记录（2026-10-03）

代码基线 `f9e8115`，工作区为 dirty（包含本次新增 fixture 和未提交的本地文件）；
实际模型为 Command Code `deepseek/deepseek-v4.1-flash`，不是 mock。
两个案例分别使用独立 workspace、transcript、Thread 与 WorkTask。
固定预算为 `maxSteps: 8`、`totalTimeoutMs: 120000`，没有压缩、Shell、Memory 或研究网络工具。
`execution.network: unused` 仅指研究/工具网络未使用，模型 API 仍联网且收费。

| 案例 | primary Run | 自动检查 | 人工检查 | 当前结论 |
| --- | --- | --- | --- | --- |
| WT03 | `47ab4de9-04bd-4fb6-8b7d-9b0bdcd3faeb` | `required_artifacts`、`artifact_scope` passed | `handoff_consistency` not_run | WorkTask awaiting_acceptance；Eval not_run |
| WT04 | `6ca895c2-7889-4e00-a206-a81056e8b39e` | `requested_sections`、`baseline_preserved` passed | `brief_quality` not_run | WorkTask awaiting_acceptance；Eval not_run |

WT03 实际耗时约 18.2 秒，交付五节 Markdown 和符合固定 schema 的 manifest；
两个 `write_file` 均有成功回执，输入 hash 不变且没有额外产物。
WT04 实际耗时约 15.0 秒，先有成功的当前 brief 读取，再有成功 `edit_file`；
进度/未决正文含指定事实，非目标区块、用户的两个空格与尾部标记、
`unrelated.txt` 及输入文件逐字节不变。执行前真实 Git diff 也保留在证据目录中。

程序只确认 fixture 内规定路径，其他工具/路径一律拒绝。这是验收程序确认，
不是 Electron 人工点击；没有调用 `recordHumanAcceptance()` 代用户接受。
`usage: null` 是用量不可得，不是零。

本地证据根目录（临时文件，不提交到 Git）：

```text
/private/tmp/runloom-worktask-artifacts.9UnYNJ/
  WT03/attempt-1/                 原始报告、配置、workspace、回执与产物
  WT04/attempt-1/                 报告、配置、workspace、回执与产物
  report-correction/WT03/attempt-1/ WT03 更正报告、同一执行的证据副本
```

WT03 原始报告的 `required_artifacts` 多引用了 `store_snapshot` 类型的 `execution`，
不符合该检查只允许 `artifact` 的合同。更正版只删除这项检查上的多余引用，
execution 仍作为补充证据保留；原报告不覆盖，Run ID、产物 hash 和结论均不变，
没有再次调用模型。引用 WT03 结果时应使用 `report-correction` 下的 `result.json`。
两份有效报告已逐项核对冻结的 check ID/method/required/evidenceKinds、证据 hash、
配置 hash 与 WorkTask/primary Run 归属。

下一步由用户审核 WT03 的正文与 manifest 一致性，以及 WT04 的简报表达和未验证范围。
人工项完成前不能记录 Eval passed，也不能据此声称真实任务成功率、
连续压缩/重启完成能力、异常恢复或桌面交互已通过。

## WT01/WT02 真实模型记录（2026-10-03）

代码基线 `312d288`，dirty（新增本次 fixture，另有未提交本地文件），实际模型仍为
Command Code `deepseek/deepseek-v4.1-flash`，不是 mock。两个案例各自初始化一份
干净的隔离 Git 仓库，执行前记录 fixture commit、文件 hash 和基线测试输出。
配置固定 `maxSteps: 8`、`totalTimeoutMs: 120000`、Shell timeout 30 秒；未启用
压缩、Memory、web 或 computer。每个案例仅有一条 primary Run，实际均使用 5 步。

| 案例 | primary Run | 自动检查 | 人工检查 | 当前结论 |
| --- | --- | --- | --- | --- |
| WT01 | `6cfd6d9b-dca1-4e41-9a37-1cd4e86e07ac` | `requested_behavior`、`regression_command` passed | `change_scope` not_run | WorkTask awaiting_acceptance；Eval not_run |
| WT02 | `844fa488-b390-450d-8aa6-264efe8b6c50` | `configuration_contract`、`configuration_test` passed | `api_review` not_run | WorkTask awaiting_acceptance；Eval not_run |

WT01 模型先读取要求、实现和测试，再执行 `node --test test/slug.test.mjs`，
成功派发的 Shell 返回退出码 1；最小编辑只把 `/\s/` 改为 `/\s+/g`，再运行
同一命令，退出码 0。最终四项测试通过，原测试逐字不变，另用冻结输入/输出
独立断言实现行为。首次回归复现是预期基线，不是需要被掩盖的 Eval 失败。

WT02 模型读取要求、实现和测试，为可选 maxItems 增加 1–50 整数校验及条件返回，
在旧测试末尾追加四项覆盖。`node --test test/config.test.mjs` 返回退出码 0，
最终六项测试通过。独立断言又核对有效边界、无效类型和值、缺省/undefined 的旧
返回形状、原默认、错误消息及错误优先级。两例均无额外产物，request.md 和
unrelated.txt 的 hash 不变，成功命令发生在最后一次编辑之后。

两例 wall time 分别约 103.4 秒和 46.4 秒，包含操作人核对代码与确认等待，
不是纯模型耗时。provider 返回的 usage 分别为 16,231 / 17,319 total tokens，
记录原值，不推断费用或模型性能；无 usage 的其他案例仍按 null 处理。

文件调用只放行 fixture 的精确允许路径；每次 Shell 都先展示并核对当时的源码
与测试，再由验收操作人批准那一条精确命令，未用 Electron 用户点击。
Host Shell 不是系统沙箱，命令白名单本身也不能隔离代码副作用；本次只在已核对的
隔离样例上运行，不能扩大为允许任意模型生成代码的安全保证。

本地证据根目录（不提交 Git）：

```text
/private/tmp/runloom-worktask-repository.XUIJv7/
  WT01/attempt-1/result.json
  WT01/attempt-1/evidence/change.diff
  WT02/attempt-1/result.json
  WT02/attempt-1/evidence/change.diff
  report-audit.txt
```

每例 evidence 保留实际 Run/工具回执、确认记录与完整事件、before/after 文件 hash、
Git diff、最终实现/测试副本及独立断言结果。两份报告已核对证据和配置 hash、
冻结 check ID/method/required/evidenceKinds、任务/primary Run 归属，以及产品
自动验收 passed、人工项 not_run。没有重跑模型覆盖首次尝试，未代用户接受。

WT01–WT04 的自动检查均有真实模型记录，但四例整体仍待人工审核，不能算
4/4 Eval passed 或总体任务成功率。WT05/WT06 的独立研究记录如下。

## WT05/WT06 真实模型记录（2026-10-03）

代码基线 `5472b73`（PR #95），dirty（本次 fixture 与未提交的本地文件），实际模型为
Command Code `deepseek/deepseek-v4.1-flash`，不是 mock。两例使用独立 workspace、
transcript、Thread 与 WorkTask。固定 `maxSteps: 8`、`totalTimeoutMs: 120000`；
启用文件与 web，只有 WT05 启用 search，未启用压缩、Memory、Shell 或 computer。
未替换生产 HTTP/DNS/SSRF/重定向校验，也没有 mock 或 DNS override。

| 案例 | primary Run | 步数 / wall time | 自动检查 | 人工质量检查 | 当前结论 |
| --- | --- | --- | --- | --- | --- |
| WT05 | `7e39b871-3677-4e1f-8fb2-57e7724abeb8` | 5 / 38.3 秒 | `saved_report`、`source_budget` passed | `opened_source_grounding` not_run | WorkTask awaiting_acceptance；Eval not_run |
| WT06 | `9a728efe-83aa-49bf-a925-47a92492ba5c` | 4 / 37.0 秒 | `saved_comparison` passed | `source_fidelity` failed；`uncertainty_handling` not_run | WorkTask awaiting_acceptance；Eval failed |

WT05 先执行一次固定 Exa 查询（limit 3），再各执行一次 `web_fetch`：

- `https://nodejs.org/en/blog/release/v18.17.0`：实际正文返回 `truncated: true`，是 partial 来源；
- `https://raw.githubusercontent.com/nodejs/node/v18.17.0/doc/api/globals.md`：完整官方 Markdown。

随后成功写入 4,889 字节 `report.md`。报告披露发布页截断，以完整 Markdown 为 API
语义依据，没有宣称运行时测试。独立检查核对实际 finalUrl、来源状态、成功写入与
磁盘内容一致、输入不变和无额外修改；这些不能替代逐条事实的人工审核。
`Eval not_run` 表示必需人工项未完成，不表示没有调用真实模型或没有执行工具。

WT06 各执行一次 `web_fetch`，打开 v18.16.0 和 v18.17.0 下的
`https://raw.githubusercontent.com/nodejs/node/<tag>/doc/api/globals.md`，两次都返回 200、
完整正文且未截断，随后成功写入 5,781 字节 `comparison.md`。
**报告 §3 声称两份来源都完全没有提到 `AbortSignal.any`，但 §4 又引用来源 B 的
`AbortSignal.any(signals)` 章节，实际来源 B 也包含该章节。** 这是事实归属错误与
报告内部矛盾，不是网络失败；后面的谨慎表述不能抵消该失败。

外部核对将同一次尝试的 `source_fidelity` 标为 failed，`failure.layer: verification`。
原模型产物和初始 not_run 报告均保留，另存审核后的失败报告；未重跑模型、未修改
产物、未调用 `recordHumanAcceptance()`。产品任务仍 awaiting_acceptance，外部 Eval
失败不自动修改产品状态，也不代表操作人替用户接受了交付。

上表的自动检查是外部 Eval，不是产品 acceptance。两份首轮报告较长，`write_file`
入参在产品执行回执的 2 KiB 预览中被截断，产品 `saved-artifact` 均为 failed，
不能把外部完整事件核对通过写成产品自动验收通过。这个限制在下面的返工中再次出现。

程序只按 approvalId 放行精确文件路径、固定查询和两个指定 URL，拒绝其他工具。
每个案例最多两次 fetch；`request_counter` 是生产工具 started 派发计数，不是底层
HTTP/重定向/DNS 包计数。案例前另有三次生产 fetch 网络预检，明确排除在 attempt
计数之外。确认来自验收程序，不是 Electron 人工点击。
provider usage 原值分别为 83,802 input / 2,214 output / 86,016 total tokens，及
38,024 input / 2,355 output / 40,379 total tokens；不据此推断费用或模型性能。

本地证据根目录（临时文件，不提交 Git）：

```text
/private/tmp/runloom-worktask-research.n49Nxe/
  WT05/attempt-1/result.json
  WT05/attempt-1/evidence/artifacts/report.md
  WT06/attempt-1/result.json                         初始报告，保留
  WT06/attempt-1/evidence/artifacts/comparison.md     原模型产物，未修改
  quality-review/WT06/attempt-1/result.json           应引用的失败报告
  quality-review/WT06/attempt-1/report.md
  quality-review/WT06/attempt-1/review.json            审核原因与同一执行声明
  quality-review-summary.json
```

每例保留完整 Run/工具回执、确认记录、已提交 transcript、实际来源正文、配置与
before/after hash、产物副本。有效报告已逐项核对冻结的 check ID/method/required/
evidenceKinds、证据和配置 hash、WorkTask 与 primary Run 归属。

六例首轮是五例待人工审核、一例质量失败，不是 6/6 passed，也不足以估算总体
真实任务成功率；这些案例未验证连续压缩/重启链或 Electron 交互。下一步优先对
WT06 做明确的来源核对与显式返工，使用现有 `requestWorkTaskChanges()` 后的新 Run
和新 attempt 保留首次失败，不用重试到绿、自动接受或新增通用质量框架替代审核。

## WT06 显式返工与保存后读回（2026-10-03）

本批只补应用层研究指导和返工验证。指导随 `web.enabled` 注入，不再依赖 search；
直接 URL 对比也须核对关键结论的原文/finalUrl/版本范围，区分原文、推断和未知，
检查共同点与差异是否互相矛盾。有文件工具时，成功保存后用 `read_file` 读回实际
报告；读回被拒绝、失败或不完整须直说，不能因此重复写入。没有文件工具不承诺
保存。自查和完整读回不等于事实正确，更不是人工接受。未增加工具、评分器、
额外模型循环或 Core 完成条件；搜索拒绝闩和逐次权限保持原样。

离线生产 Controller 集成覆盖了三轮：初稿写入 → 显式退回 → 只读却声称交付的
负对照 → 再次显式退回 → 先读、编辑、再读的交付。退回只到 paused、不调用模型，
清空旧验收结果，保留上一份交付供参考；负对照无法复用初稿写入证据；最新编辑
交付的自动证据只引用最新 primary Run，人工项仍 not_run。重开后任务和各轮回执
仍在且不执行模型。这个 mock 集成证明接线和证据边界，不证明研究内容质量。

真实返工仍使用原 workspace、transcript、Thread 与任务
`3553e573-7605-4b98-b2c1-af19ec2799b0`；通过现有 `requestWorkTaskChanges()` 把
awaiting_acceptance 收为 paused，之后显式开启新 primary Run
`2340318d-38f4-46ae-a7fe-7cb7812b204b`。模型为 Command Code
`deepseek/deepseek-v4.1-flash`，配置 hash 与首轮完全相同，预算仍为 8 步/120 秒，
但本次应用研究指导已更新，因此不是同代码基线的模型性能对照。

原 fixture 只许 `write_file` 新建一次，不能假装能覆盖旧文件。操作人先把隔离
workspace 的失败 `comparison.md` 归档到 workspace 外，再让模型按原权限新建；
这是验收准备操作，不是模型完成了删除或原文件编辑。首轮产物副本、失败报告
及配置均未改，hash 复核一致。

新 Run 先请求 `list_directory`，因不在 fixture 权限中被拒绝，**没有 started 或
completed 回执**；随后各打开一次原定两份官方文档，成功写入 2,093 字节报告，
再成功 `read_file`，读回的正文和字节数均与磁盘/写入参数一致。共 5 步，未搜索、
未加第三来源、没有额外文件或输入改动。完整两份来源仍是 200、未截断。
新报告不再声称两份文档都没有该 API，分别归属 A 的缺失和 B 的章节，并区分
版本范围和运行时未知；这只是已观察到的原错误修正，不替代完整人工事实审核。
provider 用量为 136,782 input / 1,446 output / 138,228 total tokens；本次重用
长 transcript，不能据此当成模型基准或每任务成本估计。

**产品内的 `saved-artifact` 仍 failed。** 写入报告的 JSON 入参超过 2 KiB 回执
预览上限，`inputTruncated: true`，当前合同正确拒绝拿截断预览验收文件。产品任务
保持 awaiting_acceptance，quality 为 not_run；没有扩大预览、绕过核对或调用
`recordHumanAcceptance()`。外部 Eval 可用完整事件证明保存，因此更正版
`saved_comparison: passed`，两个人工质量项仍 not_run，整例 not_run。

初始验收脚本错误要求所有工具请求都被允许，把已拒绝且未派发的目录查询算成
保存失败。仅修正外部报告，并用完整成功写入/读回、来源状态、文件 hash 和任务
归属重新核对；初版失败记录保留，没有第二次调用模型。`read_file` 的完整结果
使用 `content` 和 `bytes` 核对，不虚构该工具存在 `truncated: false` 字段。

本地证据根目录（不提交 Git）：

```text
/private/tmp/runloom-research-rework.08Q2Wd/
  WT06/attempt-2/result.json                         初版操作人记录，保留
  WT06/attempt-2/archived-failed-comparison.md        归档的首轮失败报告
  WT06/attempt-2/evidence/artifacts/comparison.md     新 Run 原始产物
  WT06/attempt-2/evidence/execution.json              退回状态、新 Run、确认和交付
  report-correction/WT06/attempt-2/result.json        应引用的更正版 Eval
  report-correction/WT06/attempt-2/report.md
  report-correction/WT06/attempt-2/review.json         更正原因与产品验收缺口
```

上述返工批次证明显式返工、新授权、保存后读回和不复用旧证据；当时不能封板为研究质量全部
通过或产品文件验收已经完善。下一项具体缺口是为较长文件写入设计有界、可审计的
验收证据，避免依赖展示预览；需先冻结证据契约，不能简单放行 `inputTruncated`
或把人工核对声明当成程序证据。首轮 WT06 failed 继续保留。

## 长文件回执与本次授权质量接受（2026-10-03）

本批解决上述长文件验收缺口，没有扩大 2 KiB 展示预览。`write_file` / `edit_file`
成功结果增加刚刚写入的准确 UTF-8 字节的 `sha256`；执行 journal v1 增加可选、
有界的 `fileInput` 与 `fileWrite`。完整 requested 事件保存路径及 write 内容哈希，
只有已 started 且成功结果的路径、哈希、字节数匹配时才保存写入证据。write 的
结果哈希还必须与输入哈希相同；edit 哈希对应完成替换后的整个文件。

Controller 和 WorkTaskStore 均验证最新归属正确 primary Run 的最后匹配调用，
再核对 workspace 内当前普通非 symlink 文件的字节数和 SHA-256。后续失败或
unknown 调用不能用更早的成功替代；内容被改动（即使长度不变）不能通过。
坏的 compact metadata 报错，不降级成空记录。旧完整回执保留原验证路径，旧
截断回执不回填、不补造哈希，Shell 的完整命令/cwd/结果要求保持不变。

用户明确说“这个人工质量审核你不能替我接受吗 接着进行下一步”，因此由 Codex
作为获授权操作人逐项审核当前 WT06，而不是生产模型自评。审核记录注明委托：
不代表用户亲自点击、独立人工评估小组或后续任务的默认接受权限。没有给模型
注册接受工具，也没有新增自动评分器、第二条 AgentLoop 或 Core 完成规则。

先核对 attempt-2 两份实际完整来源和磁盘报告，记录 quality passed；因为其旧
截断回执仍不可验证，产品仍 awaiting_acceptance。这份代理审核记录另存，不覆盖
最初 not_run 报告或 WT06 首次事实失败。

随后显式退回同一任务，新开 attempt-3 / primary Run
`60fdcf78-221b-4458-82dc-9cedc199c018`，仍为原 Thread/workspace/权限，配置哈希
`c22dfedb6ce3880e9fa696ef5d8dda9f84532eed2d346724167997bd62ba500b`，真实模型
为 Command Code `deepseek/deepseek-v4.1-flash`。创建前操作人把 attempt-2 报告
归档到 workspace 外，以遵守 fixture 仅允许新建的权限；不是模型编辑/删除成功。
两份官方 URL 各抓取一次，均 200、text/plain、未截断，之后成功写入并完整读回。
新报告 2,979 字节，写入预览仍 `inputTruncated: true`，但 compact 回执与输入、
磁盘和读回内容的哈希、字节数一致，产品 saved-artifact passed。

Codex 重新审核 **attempt-3 自己的** 抓取正文和报告，核对来源/版本、共同 API
及 added 标注、A 缺失与 B 新增的区别、关键 reason 引文，以及推断/运行时未知。
Markdown 的参数类型与链接格式有简化，不改变语义，也不声称逐字归档整个源文件。
质量项接受后产品任务为 **completed**，外部 Eval 为 **passed（用户授权代理审核）**。
生产模型没有调用接受接口；审核及独立新进程重开均为零模型调用、零新 Run、零工具
重放，重开仍是 completed、三条原 Run，最新文件回执和接受说明均保留。

本次离线 `pnpm typecheck` 通过；全量 `pnpm test` 为 897 passed / 2 skipped /
0 failed。覆盖长 write/edit、重开、篡改、旧截断、拒绝/unknown/不匹配结果和无
started 的负对照。真实运行 provider usage 为 171,102 input / 1,691 output /
172,793 total tokens；沿用长 transcript，不作为模型性能或每任务成本基准。

本地证据（临时文件，不入库；不要把这些目录当长期归档）：

```text
/private/tmp/runloom-file-evidence.mAOLtm/
  delegated-review/WT06/attempt-2/result.json         前一报告的委托审核
  WT06/attempt-3/result.json                         本次执行原始待审记录，保留
  WT06/attempt-3/evidence/artifacts/comparison.md     新 Run 原始报告
  WT06/attempt-3/archived-attempt2-comparison.md       操作人归档的上一报告
  delegated-final/WT06/attempt-3/result.json          本次最终代理审核报告
  delegated-final/WT06/attempt-3/report.md
  delegated-final/WT06/attempt-3/evidence/delegated-quality-review.md
  delegated-final/WT06/attempt-3/product-quality-acceptance.json
  delegated-final/WT06/attempt-3/reopen-verification.json
```

这封板的是 WT06 的本次显式返工、长文件证据与授权接受闭环。首次失败仍为 failed；
其他待审案例不会随之变绿。没有据此宣称总体真实任务成功率、独立人工 benchmark、
Electron 人工点击，或连续压缩/重启后的真实任务整链已经通过。

## 同一 WorkTask 固定预算连续链

### 日用任务整批补齐（2026-10-04）

桌面新任务产物标准使用 `artifact_exists + requireReadback: true`，并能填写精确的
测试 command/cwd。旧任务省略该字段时保持原合同。结束检查与 Store 提交验收都
要求当前任务最新 primary Run 的最后匹配写入后有成功完整读回，哈希和字节数与
当前磁盘相符；早于后续文件修改的测试回执不能通过。缺读回可在同一 Run 的原
两次纠正与 step/time 预算内补齐，不新建 Run、不恢复授权、不重放未知工具。

真实 Command Code 三例（WT01 代码修改及测试、WT03 两份资料产物、WT04 多步骤
编辑）在加强后的相同合同下技术通过，均一个 Run、零追加指令、零补证提示，
终态 `awaiting_acceptance`，质量 `not_accepted`。证据目录：
`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-task-completion-improved-OQbXHA`。
脚本模型另行证明“写入后提前结束→同一 Run 补读回”，不能把它当真实模型发生过
纠正，也不能据此宣布成功率提升；旧基线的产物规则较弱，不直接比较。

固定 32K/4K/1K/8K/4K 配置的真实连续链也以读回合同通过：PID 64494 八轮章节
编辑触发两条不同自动压缩记录，再继续一轮并退出；PID 69377 重开后完成第十轮。
外部磁盘标记、原章节与保护文件通过核对，产物 passed、质量 not_run。两进程配置
哈希为 `8c6a4925a510c17766c6ed71c58b38aa228764671ab23ab8429255b1aa6721fe`。
报告目录：`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-context-continuity-vKG2Y6`。
没有修改预算、手动压缩或整链重试。

新增桌面表单通过隔离浏览器 fixture 核对：复制聊天目标、填写产物与多条测试、
实际提交的合同携带读回及精确 command/cwd，返回后草稿与输入焦点保留。fixture
只捕获请求、不创建真实任务、不连接模型。Electron 原生整链仍 `not_run`，不能
把上述后端和浏览器结果拼成原生点击封板。

复用现有后端连续压缩验收入口，增加 `--work-task`；不是新调度器、状态机或 Eval
框架。真实模型有费用，默认测试不会运行：

```sh
pnpm build
RUNLOOM_CONTEXT_CONTINUITY=1 RUNLOOM_MODEL=command-code node --env-file=.env \
  examples/cli/dist/context-continuity-acceptance.js --work-task
```

沿用固定预算 32768 窗口 / 4096 输出预留 / 1024 安全余量 / 8192 近期保留 /
4096 摘要输出。第一子进程创建一个 WorkTask，最多十二轮真实读/编辑日用流程
文件，触发自动压缩后再继续一轮；所有 Run 通过 `runWorkTask()` 显式开启，双向
核对任务/Thread/最新 primary Run 归属，实际模型输入须带当前任务合同。Run 结束
只能是 paused，验收项仍 not_run，不能把聊天完成当任务完成。

当前验收要求退出前至少两条不同 ID 的自动压缩安装记录，不能用一次摘要的多次
模型合并冒充二次压缩。每轮必须先成功读盘、再成功编辑、最后成功读回。

第一进程完整退出后，验收程序在磁盘首行加一个摘要不可能知道的外部标记，再开
独立子进程。新进程用同一配置/workspace/Thread 读取原任务，合同、revision 和
Run 列表须与退出前完全一致；历史有效摘要可恢复，本进程准备仍是 null。随后显式
继续同一任务，重新确认读取和编辑；新章节须包含从磁盘读到的完整外部标记，实际
模型输入须带摘要及任务合同，旧正文和保护文件不变。

最后提交交付，用最新 Run 的 edit 回执与当前文件哈希/字节数自动核验；任务应为
awaiting_acceptance、saved-artifact passed、quality not_run。`report.json.passed`
只表示本次技术连续链通过，**不表示任务质量已接受或产品任务 completed**。不沿用
其他任务的质量委托，不调用 `recordHumanAcceptance()`；Electron 点击、崩溃未知
副作用恢复和总体成功率均不由这条正常退出链覆盖。

终端打印新的隔离证据目录。保留前后独立进程报告、模型输入/输出、taskSnapshots、
执行回执、JSONL、原任务退出快照、配置和产物；两份配置哈希须一致。任一阶段失败
总报告为 false，失败不改预算、不补 transcript、不自动换目录重试到绿。

### 第二批真实模型结果（2026-10-04）

固定预算的新隔离案例使用 Command Code `deepseek/deepseek-v4.1-flash`，
没有手动压缩、修改预算或整例重试。报告目录：
`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-context-continuity-dLZksj`。

任务 `cd084c8b-2cf4-47c2-a545-9b32c684e4d4` 在 PID 1662 中运行十二轮
（十一轮章节编辑与 continued），随后完整退出。退出前报告记下两条不同的
自动安装 ID：`97741539-29a7-4705-bd45-0e20d5e18ced`、
`44ba4b52-2f67-4881-9aa2-44e52f2750a9`。这些是压缩记录，不是摘要请求次数。
同一轮后续准备可能复用摘要，因此最后一次准备不是 written 也不代表中途没有安装；
验收计数已改为收集各轮最新有效记录的不同 ID，且新案例启动时不能有历史压缩。

PID 9787 读取同一任务并完成第十三轮 reopened；前后配置 SHA-256 都为
`547fe42c6acfcc55843c97e29288b14260e825dfc9f2aabdfbc67e4a76078bf0`。
每轮成功读取、编辑并再次读取。原章节、唯一末尾标记和保护文件未变；重启后的
新章节包含父进程退出后写入的完整外部标记。最后任务为 awaiting_acceptance，
saved-artifact 为 passed，quality 为 not_run；总报告 passed 只指后端技术链。

本次桌面类型检查、153 项测试和构建通过，但现有隔离 Electron 测试窗口截图
为空白，没有继续猜测点击或操作日用数据。Electron 可见恢复/点击链仍为 not_run，
不把后端程序确认冒充桌面交互验收。

### 先前真实模型结果（2026-10-03）

Command Code `deepseek/deepseek-v4.1-flash` 从新隔离目录一次启动该验收链，
技术报告 passed，没有改预算或重开整个案例凑通过。证据目录：
`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-context-continuity-r6axjZ`。
任务 `ed922196-5c51-43ef-b8cb-ce62c5d23b55` 共十个 primary Run：八轮文件编辑
触发自动压缩，第九轮 continued；PID 85958 完整退出，PID 88762 恢复后完成
reopened，第十轮 Run 为 `e9fd7bdf-4bee-44ce-ae6c-82e9b1b3e25c`。

前后配置 hash 均为
`0288a0a954bd30651eaf3761e73a8eb8e932da022bb1931511a0759c40599fdb`。
退出前任务 paused，重开时合同/revision/Run 列表原样，历史摘要恢复但准备结果为
null；续跑后准备为 reused，使用相同摘要 ID
`3bc9bcae-64c0-4866-a67d-06f2988e4974`。实际输入同时包含摘要和当前任务合同，
新章节包含完整外部标记，成功读取在成功编辑之前，已有章节和保护文件未改。

当前产物 28,331 字节，SHA-256 为
`f3ff8a0f6ab651de3f0db104dda3a2af5116213a826855f7dbf83b9d0f47d0a7`；
最后任务所属 edit 回执、delivery evidence 和当前磁盘逐项核对一致。提交交付后
saved-artifact passed、quality not_run、任务 awaiting_acceptance，无质量接受调用。
摘要估算输入 32,027 → 10,444，耗时 25,753 ms、累计三次摘要调用、provider
usage 27,678 tokens；这些是摘要指标，不是单次无重试成功或整个任务的总费用。

新入口的离线检查：`pnpm typecheck` 通过、`pnpm test` 898 passed / 2 skipped /
0 failed、`git diff --check` 干净。正常退出的任务续接、压缩和最后文件证据在本次
配置通过，不扩大为所有任务/预算的可靠性保证；质量审核、Electron 交互和未知
副作用的崩溃恢复仍不由本报告证明。

## 真实进程中断与未知写入保护

本批只增加隔离验收入口，不改生产 Controller、恢复状态机或工具。使用生产文件工具、
执行 journal 和两把 Thread 租约；验收脚本在精确回执边界暂停，supervisor 再向自己
创建的子进程发送真实 `SIGKILL`，不是正常 `shutdown()` 或伪造 interrupted 记录。
回执边界暂停只存在于 fixture 的 app 实例，不是生产扩展 API。

| 固定故障点 | 杀进程前的事实 | 新进程恢复 | WorkTask |
| --- | --- | --- | --- |
| before-dispatch | 原逐次确认仍 pending，requested 已存，文件未创建 | Run interrupted，工具 not_started | paused |
| unrecorded-write | 已确认，生产 write 实际写入，started 已存，completed 未存 | Run interrupted，工具 unknown | needs_review |
| recorded-write | 生产 write 成功且 compact 回执已存，但 Run 未结束 | Run interrupted，工具 completed | paused |

每例恢复前，另一个 Controller 使用相同 workspace/Thread、不同 transcript 目录，
必须被活进程的租约挡住。杀进程后只等待 fixture 子进程的两把锁自然释放，不驱逐持有者。
恢复使用同一份配置且 PID 不同；pending approval 清空，未完成 Run 不成为 committed
history，启动恢复阶段零模型请求、零工具重放，保护文件始终不变。before-dispatch 在
恢复后、交付负对照与退回结束后均用 `lstat` 核对文件不存在，并分别保存
`recovered-state.artifactAbsence` / `after-report.artifactAbsence`。只接受 ENOENT；文件
存在、悬空 symlink 或其他读取错误均失败，不能把坏链接的目标不存在当成零写入。

三个 interrupted Run 的交付均不能作为自动文件验收证据：artifact blocked、evidence
为空。即使工具 completed、文件确实存在，也不能把 interrupted Run 写成任务成功。

unknown 场景还验证直接继续、直接取消以及 `still_unknown + continue` 均被拒绝且不
开新 Run。fixture 操作人核对隔离文件字节后，调用 `reconcileWorkTask(applied,
continue)` 只回到 paused。该记录是程序模拟操作人的报告，不是工具成功回执、验收
证据、真实用户点击或执行授权；旧工具始终 unknown，没有被回填成 completed。

随后显式开启新 Run，重新逐次批准 `read_file → edit_file → read_file`，不允许再次
`write_file`。完整成功回执、前后准确正文及当前磁盘哈希必须一致，新 Run 的 artifact
才 passed；最终 awaiting_acceptance、quality not_run，不调用人工质量接受接口。

付费模型入口（默认测试不运行）：

```sh
pnpm build
RUNLOOM_WORK_TASK_CRASH_ACCEPTANCE=1 RUNLOOM_MODEL=command-code node --env-file=.env \
  examples/cli/dist/work-task-crash-acceptance.js
```

默认 `pnpm test` 使用 scripted model，但子进程、flock、生产文件工具和 SIGKILL 都是真的。
程序确认只允许隔离的 `notes/crash-note.md`：首次 write，显式新 Run 仅 read/edit；Shell、
其他路径和重放 write 均拒绝。失败报告保留，不自动重跑整例到绿。

### 本次真实模型结果（2026-10-03）

Command Code `deepseek/deepseek-v4.1-flash` 三例均 passed，没有整例重试。证据目录：
`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-work-task-crash-uVXMNy`。

| 场景 | WorkTask ID | 崩溃 PID → 恢复 PID | 最终状态 |
| --- | --- | --- | --- |
| before-dispatch | 2677b2c6-4cc6-4a73-9c05-4d19b3b48cdb | 92970 → 93519 | paused，1 Run |
| unrecorded-write | 49f155a8-eca9-4cf6-aca8-651268448310 | 93912 → 94762 | awaiting_acceptance，2 Runs |
| recorded-write | e68a7532-ee15-4b28-b563-08c93e593db6 | 95641 → 95669 | paused，1 Run |

三例恢复初始 modelRequests 均为 0；只有 unknown 场景的显式新 Run 发起 4 次模型请求。
初始实际写入 40 字节，SHA-256 为
`09ddc3ef6238ff203d32f877d6a75b579159d416c19b953cb2e8135f544e1660`；
续接后 61 字节，SHA-256 为
`7694c62eb150fad3cf9a5c7b62228fb821bcb1ac69e3a49539278fdd7ce14e8b`。
原始 exit signal、PID、配置 hash、恢复状态、blocked evidence、成功读/编辑/读回与当前
磁盘另行只读核对通过，没有覆盖原报告或补造旧回执。

真实运行之后进一步加强 contender 的零模型调用、旧 journal 字节未变、无新 Run 断言，
由离线子进程测试覆盖；旧真实 contender-report 只记录 blocked/noRun，不补造新增字段。
其余加强断言涉及的真实回执及正文已按原始数据核对，不再重复调用付费模型。

上述首轮全量检查为 `pnpm typecheck` 通过、`pnpm test` 900 passed / 2 skipped /
0 failed、`git diff --check` 干净。默认测试未调用付费模型。

### before-dispatch 恢复后磁盘证据补充

首轮真实报告只在杀进程前证明文件不存在，未保存恢复后的缺失检查；保留原报告，不把
这项新增断言补写进旧结果。补断言后单独复跑本例，入口为：

```sh
RUNLOOM_WORK_TASK_CRASH_ACCEPTANCE=1 RUNLOOM_MODEL=command-code node --env-file=.env \
  examples/cli/dist/work-task-crash-acceptance.js --scenario before-dispatch
```

`report.scenarios` 明确本次选取范围，passed 只表示选中案例通过，不冒充全三例复跑。
2026-10-03 的新独立真实报告目录为
`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-work-task-crash-n0WFfx`。
新任务 `ba2309ff-43c3-4cc0-a29d-68332d3516d7`，Run
`9b4aaf72-d27b-46f0-9f99-fb59900b51be`，PID 2732 → 2773；同配置、真实 SIGKILL，
两份恢复阶段报告均有文件不存在的 lstat 记录，恢复模型请求及批准次数仍为 0。
本例一次通过，无整例重试，unknown/completed 原场景不重复付费执行。
补充后 `pnpm typecheck` 通过，完整 `pnpm test` 901 passed / 2 skipped / 0 failed。
新增负对照证明文件被创建或出现悬空 symlink 时，缺失断言不能通过。

本报告证明局部文件写入在三个指定崩溃边界下的恢复保护，不证明外部支付或 GUI transport
断线、Durable exactly-once、自动续跑或所有任意崩溃点。Electron 点击仍 not_run，任务质量
仍 not_accepted；没有沿用其他任务的代理质量接受授权，也没有改 runloom-desktop。

## 2026-10-04：结束前检查与同 Run 补证

只对嵌入式 WorkTask 默认启用。模型准备以纯文字结束时，程序核对必需的
`artifact_exists`（当前普通文件与最新写入回执 hash/bytes 一致）及 `shell_exit_zero`
（精确命令/cwd、真实 exitCode 0、没有超时/取消，且后面没有文件操作）。
缺少可纠正证据时，同一 AgentLoop 最多加两次程序补证提示，消耗原 maxSteps/总时限。
工具仍逐次确认，不新开 Run；拒绝不会自动重试，unknown/归属不符不会补做。
零自动条件或缺工具时停止请求信息，不让模型自评质量。

通过结束检查后，先保存终态回执，再使用现有交付提交重新核验。文件若在这两个阶段之间
变化，最终任务验收不能通过；`completion.reason: delivered` 是结束检查报告，不是人工
质量、磁盘永久不变或外部 Eval 全通过。界面必须以 WorkTask acceptance 为准。
手动分章的连续压缩验收显式使用 `completionCheck: false`，不会据此宣称测过本批补证。

可重复的付费入口（隔离 workspace；默认测试不调用模型）：

```sh
pnpm build
RUNLOOM_WORK_TASK_COMPLETION_ACCEPTANCE=1 RUNLOOM_MODEL=command-code \
  node --env-file=.env examples/cli/dist/work-task-completion-acceptance.js baseline
RUNLOOM_WORK_TASK_COMPLETION_ACCEPTANCE=1 RUNLOOM_MODEL=command-code \
  node --env-file=.env examples/cli/dist/work-task-completion-acceptance.js improved
```

baseline 关闭本批结束检查，由验收程序显式提交交付；improved 默认启用并自动提交。
固定 WT01/WT03/WT04，12 步、600 秒、同一 32K 压缩配置；程序按精确路径/命令批准，
不是 Electron 人工点击。每个结果保留批准/拒绝数、人工追加指令数、纠正数、原始回执、
磁盘断言和有效配置摘要；失败不重跑凑通过。既有 Eval 自动项映射为实际观测，human 项
仍 not_run；总 Eval 不会因程序检查通过就成为 passed。

编码前首次真实基线目录：
`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-task-completion-baseline-1YN3uo`，
程序检查 3/3。该初版报告的 Eval checks 未映射，不能当成完整 Eval passed。
后续用完整记录器关闭检查的对照目录：
`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-task-completion-baseline-ItnHgc`；
开启检查目录：
`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-task-completion-improved-wY1Wlb`。
两组模型都是 `deepseek/deepseek-v4.1-flash`，各例有效配置摘要对应一致。

| 案例 | 关闭检查：步数/批准/拒绝 | 开启检查：步数/批准/拒绝 | 首轮完成 | 补证后完成 | 程序失败 | 人工追加指令 |
| --- | --- | --- | --- | --- | --- | --- |
| WT01 文件回归修复+测试 | 6/6/1 | 7/7/1 | 两组均是 | 0 | 0 | 0 |
| WT03 双文件资料整理 | 4/6/1 | 4/6/1 | 两组均是 | 0 | 0 | 0 |
| WT04 脏文件多步骤更新 | 5/4/1 | 5/4/1 | 两组均是 | 0 | 0 | 0 |

拒绝数是验收程序的精确白名单拒绝，不冒充人工介入次数。每例只一个 Run，人工质量均
未接受，Electron 均未跑。本样本没有触发补证，不能宣称真实任务成功率或效率提升。
脚本模型另证明：提前结束→同 Run 确认后写入→自动提交；缺证据最多两次；拒绝停止；
unknown/外来回执不重放；旧测试不能覆盖后续改动；普通聊天/显式分段保持原样。

## 后续修补：测试证据新鲜度与恢复提示

后续已派发的 Shell、computer_action 和文件写入/编辑都会使旧测试失效，失败但已开始
的调用也一样。拒绝、not_started 和派发前失败不表示修改，不作废已有测试。
结束检查和 Store 的直接验收入口使用同一规则，不能提供一份旧 evidence 绕过。

多项必需 Shell 测试且 cwd 完全一致时，任务上下文提供 `testBatch`：使用独立
`/bin/sh -c` 调用与 `&&` 组成 fail-fast 命令，全部成功才可由同一回执证明各项。
模型仍须请求这一整条命令的确认；没有自动授权、执行或把任意 Shell 分类成只读。
生成命令不得超过现有 1024 字节证据上限。不同 cwd 或超限不能自动合并，结束检查
会要求补充信息；用户可明确提供同目录的测试脚本或一条组合测试命令。
这不证明测试内容充分，也不证明外部进程没有改文件。

续做信息新增最新归属正确 Run 的已有 completion 投影，供桌面说明停止原因及下一步。
它不是新的持久计划，`delivered` 不覆盖 WorkTask 的实际 acceptance。
本批不新增付费模型 Eval；回归使用真实本地 Shell/文件和脚本模型，不声称成功率提升。
