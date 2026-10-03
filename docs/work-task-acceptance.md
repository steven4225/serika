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
6. 调用 `submitWorkTaskDelivery()`。控制器只会自动核对产品当前支持的精确 Shell 成功回执或带成功写入回执的现存普通文件；人工标准继续保持 pending，直到明确调用 `recordHumanAcceptance()`。
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
