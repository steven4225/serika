# 阶段一：任务级验收操作指南

本批使用 A01–A09 检查现有能力能否交付任务。测试通过、真实模型通过、用户实际看见结果是不同证据。`completed` 仅表示 Run 正常结束；案例是否通过由下列检查和操作人判定。本指南不宣称九项已经完成。

## 当前证据盘点

| 案例 | 生产入口与已有离线证据 | 可核对的真实证据与缺口 |
| --- | --- | --- |
| A01 文件读取、修改、保存 | TUI 文件工具；`write-file.test.ts`、`edit-file.test.ts` | 旧资料保存、重启、修改记录见 `personal-assistant-roadmap.local.md`；当时临时原件目前未找到，需用当前代码补一次。 |
| A02 拒绝写入或执行 | TUI `y/n`；`tui.test.ts`、`web-loop-acceptance.test.ts` | 旧拒绝写入记录同上；当前原件未找到。检查拒绝后目标文件不存在或原文件不变、同一 Run 不绕过拒绝。 |
| A03 工具成功后 Run 失败 | TUI 已完成操作回执；`tui.test.ts` 覆盖文件、任务、记忆与 checkpoint | 已有真实存储加测试模型的文件落盘检查；真实模型行为另记，不能把 Run 失败写成文件未保存。 |
| A04 搜索、原文、报告 | TUI `web_search`、`web_fetch`、`write_file`；`web-loop-acceptance.test.ts` | 旧 N1/N2 真实记录见 `agent-capability-roadmap.local.md`，所指临时报告当前未找到。Exa 当前主链仍需留可核对的新证据。 |
| A05 小范围代码修复 | TUI 文件与 Shell；相关工具测试及 R6 真实修复记录 | R6 路线图所指临时原件当前未找到；选隔离仓库中的可复现小问题重新核验。 |
| A06 一次性任务改期及拒绝 | `task_reschedule`、`/task reschedule`；`task-store.test.ts`、`tui.test.ts` | 锁内改期、并发、回执已有离线证据。2026-09-26 真实 TUI：自然语言拒绝后原 `runAt` 未变；确认后仍只有 1 条任务、ID 不变、`runAt` 为 `2026-09-29T13:30:00.000Z`，未走取消后新建。这只证明已改期，不证明到期执行或通知送达。`/task show` 后提示符被输出盖住是独立 TUI 体验缺陷，不影响改期结论。 |
| A07 RSS 按需读取 | `feed_read`、`web_fetch`；`feed-read.test.ts`、`tui.test.ts` | M9 的真实 feed→原文，以及拒绝后零请求待补。 |
| A08 M10 workspace 简报 | `task_repeat_create`、worker `--workspace-context`、inbox；`task-worker-context.test.ts`、`task-worker.test.ts` | 本轮真实模型 worker 下半链已通过；真 TUI 创建与 `y/n` 尚未验收，A08 整项待完成。 |
| A09 Memory/checkpoint 跨 Thread | TUI 记忆与 checkpoint；两模块、context 测试 | M3.5 与 M5 的真实报告及原件仍在 `/private/tmp/runloom-m35-live-20C0hd/`、`/private/tmp/runloom-m5-acceptance.Ixj4mf/`。只能证明各自冻结范围；本批组合任务另记。 |

路线图中的历史结论保留，但已清理的 `/private/tmp` 原件不能标为“本次可复查通过”。有原件的旧验收也不自动等于当前提交通过。每项新尝试都记录实际 commit、配置摘要、模型、输入、动作和结果；首次失败单独留档。

## 证据与结果约定

每次尝试使用独立目录，位于被测 workspace 之外：

```text
<evidence-root>/<caseId>/<attemptId>/
  review.json             # start 命令生成；操作人补人工结论和证据索引
  verification.json       # 操作人声明的确定性检查，可选
  evidence/               # 终端记录、脱敏 JSONL、产物或任务前后快照
  result.json              # 验收程序写入，不覆盖旧结果
  report.md                # 同一结果的人类可读视图
```

`result.json` 使用 `examples/cli/src/acceptance/contracts.ts` 的 `AcceptanceCaseResult`：`schemaVersion: 1`，`caseId`、`attemptId`、commit/dirty/modelId/脱敏配置 digest、入口/模型/网络类型、开始结束时间、Run/Thread ID、各项检查、证据路径、失败层、耗时和可获得的 usage。`usage: null` 表示不可得，不填零。`passed` 需要所有必需检查通过；确定失败优先于随后未跑或受阻。修复后新建 attempt，不覆盖第一次失败。不得在报告、配置摘要、终端副本中保存 API key 或完整鉴权 Header。

`review.json` 由 `start` 生成，操作人在任务结束后补 `humanChecks`（检查 ID、状态、证据 ID、理由）、`evidence`（ID、类型、相对路径）、Run/Thread ID、失败归因与可获得的 usage。每个检查 ID 必须对应 `cases.ts` 中的项目；`failed` 记录首次失败，缺模型服务或凭据等无法开始的项目记 `blocked`。

`verification.json` 由操作人写本次期望，格式为 `{ "schemaVersion": 1, "caseId": "A01", "assertions": [...] }`。断言的 `checkId` 必须对应 `cases.ts` 中该案例的自动检查；可用种类为 `file_present`、`file_absent`、`file_sha256`、`json_equals`、`json_compare`。所有路径相对 attempt 目录，JSON 指针采用 RFC 6901。例如 A07 的拒绝请求计数可写为：

```json
{
  "schemaVersion": 1,
  "caseId": "A07",
  "assertions": [
    {
      "checkId": "denied_request_count",
      "kind": "json_equals",
      "path": "evidence/request-count.json",
      "pointer": "/count",
      "expected": 0
    }
  ]
}
```

自动检查只能核对文件与 JSON 快照，**不能单凭复制品证明真实 workspace 没有副作用**。确认预览、报告是否有依据、实际交付是否清楚仍要人工检查；工具回执和磁盘事实不一致时记失败或待核实。

固定判据不能靠改期望值反转：A06 的任务 ID 必须相等、原新 `runAt` 必须不等；A07 拒绝后的请求数必须为 `0`；A08 已执行实例的状态必须为 `completed`。如实际为 `failed`，记录失败证据与原因，另开 attempt 复验。

在仓库根目录运行 `pnpm build` 后，按一次尝试执行：

```bash
pnpm acceptance start "$RUNLOOM_EVIDENCE_ROOT" A07 feed-live-1 deepseek-flash tui real live "$RUNLOOM_TEST_CONFIG"
# 实际执行 TUI/worker；将脱敏证据放入 start 打印的 attempt 目录，补 review.json 和 verification.json。
pnpm acceptance finish "$RUNLOOM_EVIDENCE_ROOT/A07/feed-live-1"
```

`start` 只生成记录骨架，不运行模型；`finish` 读取证据、核对自动检查与人工结论后写 `result.json`、`report.md`，不覆盖同名 attempt。`RUNLOOM_EVIDENCE_ROOT` 应位于被测 workspace 之外。

## 共用真实运行方式

在一次性 workspace 之外放置 TUI 配置文件，`version: 1`，`workspace` 指向该 workspace 的绝对路径；只开启本案例需要的模块。固定 transcript 目录与 thread。以下命令使用已在本地 `.env` 中配置的 DeepSeek，不读取或打印 key：

```bash
RUNLOOM_MODEL=deepseek node --env-file=.env examples/cli/dist/index.js \
  --tui "$RUNLOOM_TEST_TRANSCRIPTS" \
  --thread "$RUNLOOM_TEST_THREAD" \
  --config "$RUNLOOM_TEST_CONFIG"
```

`RUNLOOM_TEST_TRANSCRIPTS`、`RUNLOOM_TEST_CONFIG` 与 `RUNLOOM_TEST_WORKSPACE` 均应指向隔离目录；配置文件放在 workspace 外。操作人看完每次预览后手动输入 `y` 或 `n`。真实模型请求可能花费额度并受 DNS、服务限流影响；这类失败照实记 `blocked` 或 `failed`，不能用后续成功覆盖首次记录。离线受控 HTTP、mock 模型和真实网络分别标注。

## 待补的主验收

### A06：改期及拒绝

配置启用 `modules.task.enabled`。在隔离 workspace 中自然语言创建一个足够晚才到期的一次性提醒，确认 `y` 后记下任务 ID 和原 `runAt`。先要求将**该 ID** 改到另一个未来时间，在 `task_reschedule` 预览输入 `n`；立即核对 `tasks.json` 该 ID 的 `runAt` 未变、没有新任务行，同一 Run 没有再次改调 `task_create`。下一次 Run 再要求同一 ID 改期，在预览输入 `y`，核对 ID 不变、新 `runAt` 落盘、回执只声称已改期。若不点名 ID 而存在多个候选，模型应先查询并澄清。

2026-09-26 真实 TUI 已按上述拒绝与确认路径核对：拒绝后原时间未变；确认后磁盘仍只有 1 条任务，ID 不变，`runAt` 变为 `2026-09-29T13:30:00.000Z`，模型未用 `task_cancel` + `task_create` 代替改期。**改期结论通过。** 未启动 worker、未开 `--notify`，因此不证明到期执行或桌面通知。`cases.ts` 中 `reschedule_behavior` 含 worker 执行时，该项保持未跑，不把整案写成全部检查通过。

如需证明 worker 按新时间执行，先改到更晚、核对文件，再启动同 workspace worker；不要用“马上到期”与 worker 抢锁作为改期成功证据。`/task reschedule` 是直接执行的空闲命令，**没有 y/n**；拒绝场景必须走自然语言工具调用。

空闲 `/task show` 后 readline 提示符有时被命令输出盖住，需再敲回车才看到提示。这是独立 TUI 体验缺陷，不改变上述改期核对。

### A07：feed 到原文与拒绝

配置 `modules.web.enabled: true`、`modules.web.feed.enabled: true`。新 Thread 中给出一条公开 RSS 2.0/Atom 地址，要求列出文档顺序的前几条、选择一条有公开 URL 的条目、打开原文后写一段带实际 `finalUrl` 的说明。对 `feed_read` 和 `web_fetch` 分别看预览并确认；核对标题/摘要没有被当作已读原文，失败或正文截断有标注。

另起一轮对 `feed_read` 输入 `n`。证明“零请求”需要请求计数器或受控 HTTP 服务的请求日志；仅有模型回复或未出现结果，不能证明网络未发出请求。再单独拒绝 `web_search`，检查同一 Run 的 `feed_read` 与 `web_fetch` 均不发请求；该闩不跨 Run。`/authorize-web` 只影响 `web_fetch`，不免除 feed 的确认。

### A08：到点 workspace 简报

同一隔离 workspace 中启用 `memory`、`checkpoint`、`task`。先经现有确认流程存一条有 ID 的 workspace 记忆和一个有版本的 checkpoint；两者内容使用无敏感信息的唯一标记。让真实 DeepSeek TUI 创建一条固定 UTC offset 的 daily 简报，prompt 明确要求“依据、最重要的一件事、15 分钟下一步”，确认 `task_repeat_create`，记录系列 ID 与 `nextRunAt`。让到期时间留足启动 worker 的余量。

到期前在另一终端启动同一 workspace 的 worker，不开桌面通知，不开 Todoist：

```bash
RUNLOOM_MODEL=deepseek node --env-file=.env \
  examples/cli/dist/task-worker-entry.js \
  --workspace "$RUNLOOM_TEST_WORKSPACE" --workspace-context
```

到期后用 `/task inbox` 和 `/task show <occurrence-id>` 检查状态与结果，再用 `/task ack <occurrence-id>` 确认；重启后该条不再出现在 inbox，但仍可 `show`。核对简报实际引用当前 workspace 记忆 ID 与 checkpoint 版本，不能把 checkpoint 写成已核验磁盘状态。`completed` 只表明 worker Run 结束；如 worker 在模型调用前因坏文件失败，核对 `failed` 与 `runId: null`。本案例不验收桌面弹窗。

若只验证 worker 下半链，可显式运行 `task-worker-context-acceptance.test.ts` 的真实模型测试。它经现有 Store 建立隔离 Memory、checkpoint 和每日重复任务，再启动生产 worker，核对结果、inbox、ack 和重启；普通 `pnpm test` 会跳过这项真实请求。该测试没有经过 TUI 的自然语言创建与人工 `y/n`，因此**不能单独使 A08 通过**。本轮下半链报告位于 `/private/tmp/runloom-phase1-20260926.sVyPSB/A08/normal-network-workspace-brief/report.md`，状态仍为 `not_run`；最初沙箱 DNS 失败与正常网络重试分别记在同目录上级的 `worker-dns-incident.md`。

## 收口判断

已有离线覆盖可引用，不为每个案例再写一套生产装配的 mock。真实任务必须走实际 TUI/worker 入口，程序检查产物和状态，人工审阅模型判断与用户反馈。发现断点先记录输入、预期、实际、证据和所属层；只修真实触发的产品问题。若 A01–A09 中仍有必需项 `failed`、`blocked` 或 `not_run`，阶段一只标部分完成。
