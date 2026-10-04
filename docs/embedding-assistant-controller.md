# 嵌入 AssistantController（桌面等前端接入说明）

本文是 `createRuntimeApp` + `createAssistantController` 的接入契约摘要。行为以源码为准：[app.ts](../examples/cli/src/app.ts)、[assistant-controller.ts](../examples/cli/src/assistant-controller.ts)。

## 稳定导入路径

包通过 `exports` 暴露 `./dist/*.js`（含 `types`）。前端只应使用这些深路径：

```ts
import { createRuntimeApp } from "@aisdk-agent/example-cli/dist/app.js";
import { createAssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
```

包根（`"."`）故意不导出：`dist/index.js` 是会立即执行的 CLI 入口，不是库。

## 必须遵守的接线规则

- **输出必须 tee。** 传给 `createRuntimeApp` 的 `output` Writable 收到的每一段文本（命令输出、模块通知、Home 文本、确认提示），都必须同时转发给 `controller.recordOutput(text)`。不 tee 的话，视图重载后的快照会缺这些内容。
- **`run()` 返回的是启动结果**（`{ ok, runId }`），不是主任务的 `RunResult`。用户任务是否结束，看 `run-result` 事件且 `phase === "primary"`，或快照的 `lastPrimaryResult` / `state.kind === "idle"`。自动整理是另一条 `phase === "consolidation"` 的 `run-result`，不要把它算进用户任务。
- **`confirm()` 只返回 `boolean`。** `false` 统一表示"这次点击不生效"（过期 ID、没有待确认、没装确认模块），没有错误码。按钮侧把 `false` 当"未执行"即可，不要重试到下一次工具上。
- **`command()` 的 Promise 会如实报告失败。** 命令抛错返回 `{ ok: false, reason: "failed", message }`，被取消返回 `{ ok: false, reason: "cancelled" }`；同时仍会发 `error` 事件。只看 Promise 的调用方不会把失败当成成功。
- **待确认从创建那一刻起就在快照里。** 异步 preview（如 `task_reschedule` 先读任务库）期间，`pendingApproval.preview` 为空字符串；preview 写好后会再收到一次同 `approvalId` 的 `approval` 事件。前端应按 `approvalId` 做 upsert 渲染。
- 取消是 abort，不会被写成 deny；`shutdown()` 会先取消活动 Run 再 `dispose()`。

## 较长任务与 Shell 进度（阶段二）

- TUI 配置可设 `run.totalTimeoutMs`（1–1,800,000，默认 120,000）和 `modules.shell.timeoutMs`（1–600,000，默认 30,000）；`run.maxSteps` 仍独立配置。若任务需运行超过默认两分钟，须同时给主 Run 足够预算。工具确认等待继续不计入主 Run 时限。
- Shell 运行时，控制器发 `shell-progress`：`{ phase, runId, progress: { toolCallId, sequence, stream, text, truncated } }`。按 `toolCallId` 分组、按 `sequence` 追加；`stream` 是 `stdout` 或 `stderr`，不保证两个流的操作系统级先后顺序。最多展示现有 64 KiB 输出窗口及 256 个进度事件；`truncated` 表示后续展示不完整。
- 进度只是即时显示，不是工具成功回执，也不会进入模型上下文或 JSONL。最终结果仍看 `tool.call.completed` 中 `shell_exec` 的 `exitCode`、`timedOut`、`cancelled`、`truncated`。页面重载后可以恢复控制器状态和已完成回执，但阶段二不承诺恢复已丢失的实时片段或崩溃中的命令。

## 上下文压缩诊断（只读）

### 工作任务续做

`getWorkTaskContinuation({ id, expectedRevision })` 只读当前 Thread 的任务和最新归属正确的 primary Run。
返回 `WorkTaskContinuation`（`dist/work-task-continuation.js`）：上次提交的交付、未解决项、最新助手结论与最近八个工具身份/状态。
交付摘要最多 2 KiB，产物引用和未解决项各取前四条；`truncated` / `toolsTruncated` 明示省略。
没有最新回执或归属不符时 `receiptUnavailable: true`，不会从旧 Run 凑回执；坏文件返回错误，不显示为空。
工具 `completed` 只代表调用结束，可能包含业务 `ok:false`；实际输出仍须到完整回执核对。
查询不读产物、不调用模型、不创建 Run、不写状态，也不是验收证据。版本过期须重新读任务。

显式 `runWorkTask()` 在新 Run 开始前读取一次以上投影，放入既有 24 KiB 任务参考；目标/约束/验收标准不会被截断。
上次交付是参考，不是当前磁盘事实或新的工具权限。提示模型先读当前文件再修改、保留无关章节、修改后读回；这不是额外的文件工具强制门禁。
核对后仍须启动新 Run，未知副作用不自动重放。质量不合格沿用 `requestWorkTaskChanges()` 回到同一任务，下一轮重新交付与验收。

`ContextDiagnostics.lastPreparationSource` 是可选、进程内的 `{ messageId, workTaskId, runId? }`。
Controller 只给本进程当前 primary 用户消息对得上的实际准备补 `runId`。
桌面必须同时匹配任务 ID 与最新 Run ID 才能显示该任务的准备结果；单有历史有效记录不够。
准备进行中不绑定上一次结果，失败仍显示 failed；手动 `/compact`、退出重启不沿用该身份。
没有绑定不等于历史压缩丢失，准备成功也不证明模型按摘要执行、provider 已收齐或内容质量通过。

再次压缩只合并合法历史摘要尚未覆盖的完整材料；旧摘要仍作为合并输入，新的记录哈希仍绑定完整原始前缀，工具事实仍从完整覆盖范围对账。
上次安全边界落在后来合并成一轮的历史内部时，只取该边界之后的部分，不重新消耗已覆盖材料的合并容量。
四批合并上限、模型重试/超时、摘要校验和预算均保持原值；无效前缀不能走增量捷径。

2026-10-04 续做实测（Command Code，程序限定文件审批，不是 Electron 人工点击）：

- 首次目录 `/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-context-continuity-U98kZs` 保留失败。重启后的读/改/读回都有完成回执，但之后的上下文准备重复合并已覆盖原始前缀，撞上四批容量限制，Run failed、总报告 false；没有提交为完成交付。
- 修复后用新的隔离目录 `/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-context-continuity-EklqnG` 完成整链，预算未变。PID 55067 / 58858，两边配置哈希 `1d8299fdc6f7cac0226b9cd21fac06a5747399442815cca14d3b0e2207f455b6` 相同，WorkTask `85764ff2-4f71-4c8e-8256-c7c73437e323` 相同。
- 六次章节编辑自动触发压缩，之后 `continued`；上次交付与未解决项正常持久化。重启后的实际模型输入含上次未解决项及摘要，重新读盘后 edit_file，再 read_file，外部标记进入新章节，旧章节与保护文件保留。当前产物 14957 字节，哈希与最新归属正确的写入回执一致，自动产物项 passed；任务 awaiting_acceptance，人工 quality not_run。
- 最近摘要估算输入 27735 → 10693 tokens，44873 ms，累计四次摘要请求（包含分批/重试），实际总用量 33756 tokens。重启后最新准备 reused，没有在这条成功链里强求再生成第二条摘要；增量合并修复另有“已覆盖前缀超过四批、旧边界落入后来的完整轮内部”的确定性回归覆盖，不能把两次不同模型输出当成逐字相同的故障复现。
- `report.json.passed` 为 true，只证明这条后端固定场景。`electronAcceptance: not_run`、`taskQuality: not_evaluated`，未接受内容质量，也不保证任意长任务。

固定预算连续链的后端复验入口（真实模型、有费用，默认不运行；也支持已配置的 `RUNLOOM_MODEL=minimax-m3` / `command-code`）：

```sh
pnpm build
RUNLOOM_CONTEXT_CONTINUITY=1 RUNLOOM_MODEL=deepseek node --env-file=.env \
  examples/cli/dist/context-continuity-acceptance.js
```

从新隔离目录开始，固定 32K 窗口 / 4K 输出预留 / 1K 安全余量 / 8K 近期保留 / 4K 摘要输出；最多十二轮真实文件任务触发自动压缩，没有手动 `/compact` 或补造 transcript。自动压缩后继续编辑，等子进程完全退出，再改入外部磁盘标记并启动独立子进程恢复同一 Thread。两边配置哈希必须一致，实际模型输入须带摘要，重新读文件后编辑必须有成功回执，已有正文和保护文件须保留。

终端打印证据目录，保留配置、前后进程报告、模型输入、JSONL 和产物；失败不修改预算继续凑通过。确认仅由验收程序限定在 `notes/work-plan.md`，不是用户在 Electron 点击授权。该入口只能证明后端连续链，不证明 Electron 真机交互、崩溃恢复、任意任务质量或所有模型/预算组合。GUI 封板仍需同一配置下亲自完成自动压缩 → 退出 → 重开 → 继续的链路。

2026-10-03 Command Code 后端固定预算链通过：证据目录 `/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-context-continuity-gM23so`。八轮文件任务自动触发压缩，之后完成 `continued`；PID 41943 退出后，PID 44464 用完全相同的配置哈希 `4c97b745b19bd7831c7ce81ad6d1e760dbc97764cf84702fe9eab9fc1fca20c5` 恢复同一 Thread，先成功读取当前文件，再成功编辑，并在新章节完整保留外部磁盘标记。保护文件未变。模型实际输入带摘要；重启初始 `lastPreparation` 为 null，续跑后为 reused。最近记录估算输入 28136 → 9786 tokens，生成耗时 41045 ms、3 次尝试；真实摘要调用总用量 27769 tokens。这不是一次尝试成功，也不是实际 tokenizer 窗口测量。

失败目录同样保留：`fgq5Gc` 摘要额度耗尽（网关思考未关闭）；`V15Wz7` 模型误用 snake_case 编辑参数；`YCMFlj` 重启章节没有完整复制标记行；`YrGmZJ` 使用不存在的占位文本，未完成编辑。后续只修正接入参数、工具说明与错误反馈，并明确原有编辑和完整标记要求；固定预算、成功回执要求与逐字断言不变。不要合并不同尝试中的局部成功来判 passed。Electron 真实窗口验收另行记录，不由后端报告推断。

同日后续在 Electron 发现另一个实际问题：即使关闭思考，摘要仍可能复述过多文件/操作，连续三次耗尽 4096 输出。当前修复要求摘要在固定预算内写简短续接说明，合并重复内容但保留独特约束和未知效果；SDK `finishReason: length` 无论可见 JSON 能否解析都拒绝安装，按既有有界重试处理。未补造 `version`、未放宽 schema/回执核对、未增加输出上限。

修复后的独立后端复验为 `runloom-context-continuity-Hc8XPL`（与上面相同临时目录父路径），`report.json` 为 passed。九轮文件任务自动压缩后继续；PID 46549 → 46896，配置哈希均为 `f9b5069165a95cfbd787618c72530b45284881d1f2a8b17e2e4963aa929f910b`，预算仍为 32768/4096/1024/8192/4096。摘要估算输入 28005 → 9991 tokens，36135 ms；metrics 的 attempts 为 4（整次压缩分片调用的累计数，不是单片突破三次限制），用量 34707 tokens。重启复用、完整外部标记、先读后改成功回执与保护文件均通过。

### Electron 实测：失败后恢复，不是从头无失败封板

隔离证据目录 `/private/tmp/runloom-foundation-electron-tZCHy1`；桌面源码未改。通过真实窗口输入和逐次审批执行文件任务，不经测试脚本直接 `controller.confirm()`：

- 前八轮完成，第九轮 Run `662d9dcc-8baa-41a0-a918-e777d5476aa8` 因摘要输出耗尽失败，仅有成功读取，无编辑。失败执行回执保留；该轮未提交到聊天 transcript。
- 修复后保持原配置/workspace/Thread，显式发送新任务追加 `ui-section-10`（没有伪称失败的 `ui-section-9` 已补齐），自动生成合法摘要，并完成 `ui-continued`。诊断显示估算 30943 → 9429 tokens、23148 ms、累计 3 次摘要调用、用量 26141 tokens。
- 正常退出 PID 46589 后，由验收侧给测试文件加外部首行标记，再启动 PID 49731。前后配置哈希均为 `a8adb6db155d04be951455165bce7d702824582abd082114dfe7bc8c291ef727`，预算不变；重启面板显示历史有效记录但本进程尚无准备。
- 新 Run 再次弹出读取/编辑审批，先成功读取当前磁盘，再成功追加 `ui-reopened`，其中逐字保留整行 `外部核对标记：ELECTRON_REOPEN_DISK_V2（来自退出后的磁盘，不来自摘要）。`。已有正文与保护文件不变；面板随后显示复用相同摘要记录。

`verify.mjs` 原始无失败门槛未改；另存 `verify-recovery.mjs`、`recovery-before-evidence.json`、`recovery-after-evidence.json`，明确 `cleanFromStart:false`、`recoveryChecksPassed:true`、`fullCleanElectronAcceptance:not_passed`。这是实际桌面**正常退出后的恢复链**，不等于崩溃未知副作用重放、从头无失败链、多次成功率或通用任务质量。记忆面板 accept/reject 的真实点击也不由这份文件任务证据覆盖。

`await controller.getContextDiagnostics()` 返回 `ContextResult<ContextDiagnostics>`（类型导入 `@aisdk-agent/example-cli/dist/context-diagnostics.js`）。该查询只读取当前 Thread 的已提交 transcript 和通过现有前缀校验的压缩记录，不创建 Run、不调用模型、不写 JSONL，也不把摘要正文送进 IPC。

- `enabled`/`budget`/`estimatorVersion` 是实际加载配置；`char-half/v1` 是估算，不是 provider tokenizer 计数。
- `latestValidCompaction` 是历史中仍与已提交 transcript 前缀匹配的最近记录，包含边界、模型、时间与 metrics。没有合法记录是 `null`；读取失败返回 `ok:false`，不能画成“未压缩”。
- `lastPreparation` 仅记录本进程真实准备路径的 `passthrough | reused | written | noop | failed`。重启后为 `null`，不能从历史记录推断本轮已经使用。失败不会把旧的合法历史记录画成新成功。
- `metrics.usage` 不可得时留空，不补零。没有合法记录也不等于当前未做任何上下文处理：关闭模型摘要时仍有既有裁剪路径。
- 手动执行仍用 `controller.command("/compact")` 和现有 idle 互斥；前端在 idle 或 Run 结束后重新查询，不新增压缩事件流。

## 本地执行回执（阶段三）

- 控制器启用独立于聊天 JSONL 的 `execution-records.json`，保存在传给 `createRuntimeApp` 的 transcript 目录中。重启后调用 `await controller.listRuns()`（当前 Thread、最新优先、默认 20 条）和 `await controller.getRun(runId)`；查不到或不属于当前 Thread 返回 `null`。主 Run 和自动整理分别以 `phase` 标识。桌面端不要从聊天 transcript 推断工具是否执行。
- 同一 Thread 同时只能有一个控制器进程。创建控制器后，首次查询或运行会取得进程期占有锁并恢复上次未完成的记录；占有冲突或记录文件损坏会使查询/新 Run 失败，不能绕过后直接重试工具。退出时务必调用 `shutdown()` 释放锁。
- `tool.call.started` 在调用工具前持久化；`completed` 表示工具函数返回，**不等于业务成功**。文件工具仍需看结构化 `ok`；Shell 另看 `exitCode`、`timedOut`、`cancelled`。重启后有 started、无最终回执的工具标 `unknown`，需要人工核对磁盘/外部系统，不能自动重放。只有 requested、没有 started 的工具标 `not_started`。Run 未正常结束标 `interrupted`；完成回执可与失败 Run 同时存在。

文件交付验收不再依赖长正文的展示预览：新的 `write_file` / `edit_file` 成功结果另有
`sha256`，由工具对刚写入的 UTF-8 字节计算，输入和权限不变。`ExecutionToolRecord`
可带 `fileInput: { path, sha256? }`（完整请求时提取；只有新建内容有请求哈希）及
`fileWrite: { path, bytes, sha256 }`（派发后成功回执；写入哈希须匹配请求内容）。
两者是原 v1 journal 的有界可选字段，不保存正文。`inputPreview` / `resultPreview`
仍是 2 KiB 的显示数据。新证据齐全时，正文预览截断不会阻止文件验收；验收仍检查
最新任务 primary Run、最新匹配调用、当前普通非 symlink 文件、字节数与哈希，
写后被改动则失败。旧完整预览保持原验收路径，旧截断记录不补造哈希，仍不能通过。
Shell 不走文件证据路径，命令与 cwd 的完整回执要求不变。
- 文件只保留最多 50 个 Run、每 Run 64 个工具，预览每字段最多 2 KiB、文件最多 256 KiB。预览可能包含工具参数、路径或敏感文本，勿公开同步该目录。记录超限或写失败会阻止尚未开始的工具；工具已经返回后若最终回执写失败，保留已知的 started/unknown 线索并报告错误。它不是 Durable Runtime、事务日志或自动恢复机制。

## WorkTask 接入（第一批）

- 配置 workspace 后，前端可用 `createWorkTask()`、`listWorkTasks()`、`getWorkTask()`、`runWorkTask()`、`submitWorkTaskDelivery()`、`recordHumanAcceptance()`、`reconcileWorkTask()` 和 `cancelWorkTask()` 驱动任务级生命周期。每次更新都传刚读取的 `revision`；冲突后重新读取，不要盲重试旧请求。
- `runWorkTask()` 会把随后启动的主 Run 绑定到该任务；核对时同时检查 `task.runIds` 与 `getRun(runId).workTaskId`。默认在模型准备结束时核对必需自动条件，缺证据最多在同一 Run 内纠正两次；条件满足后自动尝试现有交付提交。`runWorkTask({ completionCheck: false })` 用于显式分段/人工迭代，保持原有暂停/复核行为。Run 正常结束仍不等于业务验收完成。
- `submitWorkTaskDelivery()` 仅自动核对当前支持的精确 `shell_exit_zero` 和 `artifact_exists`。Shell 标准同时固定 `command` 与 workspace 相对 `cwd`（workspace 根为 `"."`）；Store 会再次回查真实 `runId + toolCallId` 回执，文件还会重算当前 SHA-256，调用方不能自报 evidence。人工标准不会被模型回复或 Run 成功自动通过，必须由用户明确调用 `recordHumanAcceptance()`；出现 `unknown` 工具或缺失执行回执时进入复核，不能重放。
- `RunResult.completion` 与执行回执中的同名可选字段由程序提供，普通聊天和成功的手动分段 Run 不带此字段。原因是 `delivered | needs_confirmation | needs_information | budget_exhausted | needs_review`，`corrections` 是本轮补证提示次数，不是新 Run 次数或模型 API 重试次数。`delivered` 表示结束时的程序检查通过，之后仍要落终态回执并重新核验交付；最终以任务的 acceptance/status 为准，不等于人工质量通过。取消保留 `RunResult.status === "cancelled"`，未核对副作用优先显示 `needs_review`。
- `run.completion.checked` 通过原 `run-event` 流显示补证进度；新工具仍逐次确认。`run-result` 在任务暂停/复核及自动提交尝试后发布，不新增桌面 IPC。Shell 成功回执若早于本轮后续文件操作，不能当成当前改动已通过测试。
- 第一批 WT01–WT06 的固定案例、外部 Eval 记录和“尚未运行”的证据边界见 [WorkTask 第一批验收与 Eval 记录](work-task-acceptance.md)。产品 WorkTask 状态与外部 `AcceptanceCaseResult` 是两层记录，前端不得把其中一层的完成映射成另一层通过。

## WorkTask 启动恢复与人工核对（第二批）

- `requestWorkTaskChanges({ id, expectedRevision })` 只将 `awaiting_acceptance` 退回 `paused`，清空所有 criterion 状态、证据引用与说明，保留上次交付及 Run 回执作为历史参考；不调用模型、不重放工具。下一轮仍须显式 `runWorkTask()`，重新提交替换交付快照并重新验收。`recordHumanAcceptance()` 和 Store 验收只接受 `awaiting_acceptance`，暂停/执行中的旧交付不能通过验收。终态不可重开，未知效果仍走 reconciliation；这不是多版本交付历史。

- 控制器首次使用前按固定顺序取得 workspace/Thread 的 WorkTask 进程期锁和 transcript/Thread 的 execution 进程期锁，再把该 Thread 遗留的 `running` Run 标为 `interrupted`：已 `started` 但没有终态回执的工具变成 `unknown`，只有 `requested` 的工具变成 `not_started`。随后才对账该 Thread 的 `running` WorkTask，并在完成前阻止 WorkTask API 和新 Run。锁冲突、坏文件或对账失败均 fail-closed；`shutdown()` 释放两把锁。
- 对账检查任务最新的关联 Run，同时核对 Thread、`workTaskId` 和 `primary` phase。最新回执缺失、外来或含 `unknown` 会把任务置为 `needs_review`；最新回执可说明且没有未知副作用时置为 `paused`。前一个不确定 Run 必须先 reconciliation 才能回到 `paused` 并显式开始下一 Run，因此恢复不依赖可能已经被有界 execution store 淘汰的完整历史。这个过程只收敛本地状态，绝不重新调用模型、工具或重放副作用。
- `needs_review` 只能由用户显式调用 `reconcileWorkTask({ id, expectedRevision, observedOutcome, decision, note })` 处理。`observedOutcome` 是 `applied | partially_applied | not_applied | still_unknown`，说明必须非空；`continue + still_unknown` 会被拒绝。成功的 `continue` 只保存 human report 并把任务改为 `paused`，不会自动调用 `runWorkTask()`；成功的 `cancel` 把任务改为 `cancelled`，但尤其在 `still_unknown` 时不表示旧副作用未发生。
- `cancelWorkTask()` 对 `needs_review` 返回 `WORK_TASK_INVALID_STATE`；前端在这个状态只能展示带观察结果和说明的核对取消入口，不能沿用普通取消按钮跳过记录。
- `task.reconciliations` 是有界的人类观察记录，不是程序验证结果、工具授权或 acceptance evidence，不能直接让 criterion 通过或让任务完成。后续主 WorkTask Run 只会把最近一条作为带警告的参考上下文；调用方仍须明确启动 Run，并重新取得所有写入和 Shell 权限。自动验收只使用最新且可验证的任务 Run，不要求保留无限历史回执。
- 恢复和 reconciliation 都使用当前 `revision` 做 CAS。revision 冲突后重新读取任务和执行回执，不得盲重放旧请求；前端应把 `needs_review`、最新 Run 的 `unknown`/缺失情况、human report 及取消后的残余不确定性直接展示给用户。

## 工作任务草稿与产物预览

桌面可调用以下只读接口，使用当前 Thread 的任务 ID 与当前 `revision`：

```ts
const draft = await controller.getWorkTaskDeliveryDraft({ id, expectedRevision });
const preview = await controller.getWorkTaskArtifact({ id, expectedRevision, path: "notes/work-plan.md" });
```

- 两者返回 `{ok:true,value}` 或 `{ok:false,error:{code,message}}`。旧 revision、跨 Thread、坏存储和读失败不是空结果。查询不创建 Run、不调用模型、不提交交付、不改变验收或 JSONL。
- 草稿只看最新且归属正确的 primary Run，不回退到更早成功的 Run。正常终态且没有未核对工具时才预填助手结论；结论是助手声明，`summaryTruncated` 标注已有回执截断。文件列表只来自每个路径的最后一次成功写入回执；后续失败或未知不能被早先成功覆盖。异常 Run 可有已写文件，但会附警告，不代表完成。
- 产物预览要求 `read-file` 模块启用。仅接受任务声明的 `artifact_exists` 路径或最新 Run 成功写入路径；任意 `delivery.artifactRefs` 不扩大读取权限。复用 workspace 路径、非 symlink、普通 UTF-8 文本和 64 KiB 限制；纯文本展示，不能执行内容或加载 HTML。
- `content/bytes/sha256/readAt` 是这次磁盘读取。`matchesReceipt` 为 true/false/null：匹配最新成功回执、已变更、没有可比较 hash。它不是验收 evidence，不能代替提交时重新核对磁盘，更不是质量通过。并发文件变化仍遵循本地 file tool 的隔离边界。
- UI 可以填未编辑的新表单，不能在异步返回时覆盖用户编辑，不能自动提交或人工通过。退回后的上次交付须标成旧草稿，再显式决定替换。

## 原生 Memory 候选审阅（A 组）

Memory 模块启用且有 workspace 时，`RuntimeApp` 暴露绑定的 `memoryStore` / `memoryConsolidation`，前端只调用 Controller，不能把 Store 或文件路径送进 IPC：

```ts
const page = await controller.listMemoryCandidates({ status: "pending", limit: 20 });
const preview = await controller.getMemoryCandidate(candidateId);
// 用户读完完整预览，明确选择接受或拒绝后：
if (!preview.ok || !preview.value.applicable) return;
const receipt = await controller.resolveMemoryCandidate({
  candidateId,
  expectedCandidateRevision: preview.value.candidate.revision,
  decision: "accept", // 或 "reject"
});
```

- 新接口统一 `{ok:true,value}` / `{ok:false,error:{code,message}}`。模块关闭返回 `MEMORY_DISABLED`；候选只对产生它的当前 Thread 可见，接受后的 workspace 记忆才跨 Thread 使用。
- 列表默认 pending / 20 条，最多 50 条、16 KiB，按 `nextOffset` 翻页。详情最多 64 KiB，包含原话、理由、当前目标（不带 history）、拟保存内容和 `applicable`/`unavailableReason`。不要只展示模型的“候选 1”。
- 只在 pending 且 applicable 的完整预览上启用接受。revision 冲突或 stale 后重新读取，不自动重试。接受/拒绝占用既有 command 互斥，不创建 Run、不请求模型、不写 JSONL；拒绝只改变候选，不改正式记忆。
- `memory-updated` 的 `reason` 为 `proposals | review | write`，只是重读提示，不携带正文。刷新或重启后重新查询 Store，不能从事件或快照推导记忆真相。
- 整理 Agent 先 prepare 后 stage；stage 仅进程内暂存。成功 Run 结束后才把待审候选和自动整理游标同锁写入 `memory.json` v4。`consolidation` completed 不等于正式记忆已保存；commit 失败单独报告，不改主任务成功结果。
- 桌面可以显式调用 `consolidateMemory({mode:"incremental"})` 重试待处理材料，或先用 `listMemoryConsolidationSources(offset?)` 分页查看当前 Thread 的普通用户消息，再调用 `consolidateMemory({mode:"history",messageIds:[...]})` 补整理所选 1–8 条。历史范围由 Controller 绑定并重新核对，不由模型的 prepare 参数选择；缺失、排除、外来消息及整组超预算都会失败，不能悄悄缩小范围。历史补整理不移动自动游标，不声称所有旧对话已经处理。
- 显式整理使用同一个 idle 互斥、整理 Agent 和候选提交路径；没有常驻后台服务或第二条 AgentLoop。每步模型预算 30 秒，总预算 120 秒；失败不推进游标。`getMemoryMaintenance().consolidation` 区分 off/backlog/running/failed/awaiting_review/idle，错误不会当作没有候选。`lastAttempt` 和 `lastSkippedReason` 是本进程诊断，重启后不保留；持久化候选和游标才是存储事实。
- 同 Thread 的相同规范化 pending change 可以复用一条候选，不合并不同事实，不伪造多来源；仍保留首次提案的来源与理由。接受后正式记忆的重复新增检查沿用既有规则。语义上相近但正文或时态含义不同的提案仍须模型比较与人工审核，不保证语义去重。
- Controller 的 resolve 是明确用户审阅操作，不走 `confirm()`；`confirm()` 仍是工具调用的 approvalId 授权。聊天的 `memory_apply_candidate` 使用相同接受实现但走正常 y/n；`n` 只拒绝本次调用，候选仍 pending。
- 重复接受同 candidateId 和原 expectedCandidateRevision 返回原应用回执、`replayed:true`，不重复写。回执里的 memoryRevision 是接受当时的版本，不证明它现在仍未修改或删除。
- v1–v3 文件只读不会迁移，第一次实际成功写入升级 v4。正式记忆最多 512 条、文件 16 MiB；pending 全 workspace 最多 64 条，终态保留最近 256 条。候选不进入主 Agent/worker 参考上下文。
- 本组没有修改桌面仓。前端接线需要独立验证，不能把后端测试映射成 Electron 已验收。

## 按问题选材（B 组）

主 Agent 每次上下文准备从原始本轮用户文本查询，只读取一次正式 Memory。普通路径和压缩预算共用已选 reference prefix；整理 Agent 不接这条 active-only 注入路径。手动 compact 从最近已提交普通用户文本选材，下一轮按新问题重新查询。

当前参考附带本次时间视图与选中数量，在最终发送时移到本轮用户问题旁；旧回复中的“本次为空”或旧 revision 不能覆盖它。移动不重复注入、不重读存储、不增加预算，不写回 transcript，也不拆工具调用/结果。若压缩已替换整个当前交互，则把同一条参考放到末尾，而不插进工具对之间。这个定位改善不等于程序能保证模型每次正确遵循参考。

- `runloom-workspace-memory` 是本轮子集，不是全库：只给 id/revision/text 和选材元数据，不给 history/sourceQuote/候选。即使无匹配也有明确空集合说明，不等于存储为空或条目已删除。
- `pinned` 最多先选 2 条、整组 4 KiB；其余只选词法匹配，最终最多 12 条、完整消息 8 KiB。没放下大条目会继续试后面小条目，不截半条正文。未选中的 pin 也不保证每轮必注入。
- 中英文词法匹配不是语义检索。强同义改写可能漏召回；前端不能把 reason=matched 或顺序当作语义可信度。仍可用有界 memory_list/get 显式查阅。
- worker 用 task.prompt 且不传 TUI Thread，只读选一次；checkpoint_prepare 无问题时返回 pinned-only 资料及 selection，不是全部记忆；/modules 的 pinned 预览不是下一轮命中数。
- 本次不新增前端控制器方法。既有候选审阅、工具授权和工作任务状态保持；完整后端验收入口及证据边界见 [原生 Memory 验收](memory-native-acceptance.md)。

## 本机 Computer 接线与验收

本机 Cua Driver 不使用模型 Key；Command Code 通过共享 `configureCliModel` 读取主进程的 `RUNLOOM_MODEL=command-code` 与 `COMMAND_CODE_API_KEY`。填主仓库 `.env` 不代表 Electron 自动加载了它。桌面须显式加载受信任的本地环境文件或由启动进程传入环境，不能把 Key 放入 renderer、`VITE_*`、IPC、模块 JSON 或日志。模型地址和默认 ID 见 README 的 Command Code 节。

外部配置中明确设置 `modules.computer.enabled`、绝对 `executable` 和精确 `allowedBundleIds`。桌面沿用 `RUNLOOM_CONFIG`，不自动允许新应用，不自动安装、启动 daemon 或开 OS 权限。启动成功与 `--check` 均不是驱动可用证明。

- `approval` 按 id upsert，直接展示 `input` 的工具、bundleId、PID、windowId；动作还要展示 `action`、`text`、observationId 与 elementToken。所有 UI 文本按纯文本渲染，不能执行其中指令。空 preview 不是免确认。
- 按钮只调用 `confirm({approvalId,decision})`；返回 false 就显示本次点击未生效，不替用户确认新 id。拒绝和确认前取消都不会调用动作工具。用户稍后批准时观察可能已过期，需新观察和新确认。
- `computer_action` 的 `ok:true` 是调用回执，不是任务完成。`dispatched:true, verified:false` 表示已派发、业务效果未核验；`effect:confirmed` 也不能画成业务成功。动作后再次观察，仍需用户核对最终文档/业务结果。
- `tool.call.failed` 中 `error.code === TOOL_OUTCOME_UNKNOWN` 必须显示效果未知，不画成普通失败、不自动重试。Controller 快照的 `toolActivity` 保留原有 completed/failed 枚举，以兼容现有前端类型；可选 `outcomeUnknown:true` 表示调用失败但外部副作用未知，刷新时此标记优先于 status 文案。派发中取消可能没有工具失败事件：primary `run-result` 后通过 `getRun(runId)` 重读回执；`tools[].status === unknown` 是核对入口，即使 Run 状态为 cancelled。对应 WorkTask 到 `needs_review`，不能绕过人工核对直接继续。
- `run-result` 只认 `phase === primary`。恢复回执用于查看，不恢复动作 token、approval 或重放动作。视图刷新读快照，进程重启读 `listRuns/getRun`；两者不能混为一谈。

后端可重复真机入口（会付费；仅用于已打开的隔离 TextEdit 测试文档，不保存）：

```sh
pnpm build
RUNLOOM_COMPUTER_ACCEPTANCE=1 RUNLOOM_MODEL=command-code node --env-file=.env \
  examples/cli/dist/computer-native-acceptance.js \
  /absolute/outside-workspace/computer-test.json native-test.txt deny
```

最后参数可选 `input`（插入一次唯一标记）、`deny`（拒绝动作）、`cancel-approval`（确认前取消）。配置只允许 computer 模块、白名单只含 `com.apple.TextEdit`；窗口标题必须唯一。程序用 approvalId 做精确测试授权，其他工具/窗口/文本全部拒绝；前后直接 AX 观察核对，报告写入独立临时目录，正文不进报告，transcript 仍可能含测试文档 UI 内容。每次是独立 Thread/报告，不用重跑覆盖失败。

`backendPassed` 仅指该次场景通过；`sealed` 保持 false。这个程序不是 Electron 人工点击，也不证明磁盘保存、独立视觉、真实派发中取消或 daemon 断连。受控子进程测试证明未知回执持久化、WorkTask 人工核对和不重放，但不能替代上述真实场景。不要为了验收直接终止共享 daemon；真实断连测试应另用独占环境。

## 正式记忆管理与本轮参考

- `listMemories({offset?, limit?})`：默认 20 条、最多 50 条；正文 120 字预览标 `truncated`，页面至多 16 KiB。显示工作区及当前 Thread 的当前版本（包括停用/过期），不混入其他 Thread 私有记忆。候选接受回执仅是当时的写入记录，不能替代此查询。
- `getMemory(id)`：返回完整当前正文、scope、revision、expiry、pin、保存来源，不带 history。来源原话是保存时已核对的 excerpt，不保证原 transcript 仍在。
- `updateMemory({id, expectedRevision, text?, pinned?, status?: "disabled"})`：仅显式用户操作；占现有 idle 互斥，不创建 Run、不调用模型，底层同锁 CAS。拒绝其他字段及无变更输入。版本冲突重读详情，不盲重试；结果不明时也先重读。文本编辑将当前来源变为 manual，旧来源保留在已有有界 history；pin/disable 不改来源。相关更新候选沿用原有失效规则。
- `getMemoryReferences()`：返回本进程最近一次成功 primary 上下文准备的 `{runId, messageId, preparedAt, temporalView:{validAt,knownAt}, selected:[{id, revision, text, reason, assertion?}], truncated, queryTruncated, rewrite}`，或者 `null`。`reason` 是 `pinned` / `matched` / `recall_term` / `rewritten`。断言元数据含 identity、kind、两种时间和 source IDs，不含原话、检索词或原始历史。按当前请求身份绑定；准备失败清空，重启为空。`memory-references-changed` 提醒前端重新查询；下一次准备可能选到新版本。不是模型自报，不证明提供商接收、回答遵循偏好或当前库仍是这些版本。此记录不写 JSONL。

### 时态审核、恢复与遗忘（Memory C）

类型从 `dist/memory-controls.js` 导入；所有操作仅针对工作区/当前 Thread，不改变 Memory 的工具授权边界：

- `getMemoryHistory({id,offset?,limit?})`：最新在前的断言与管理版本，默认 5、最多 10，每页 64 KiB；`nextOffset` 分页。历史中来源为已保存原话，`legacy_partial` 必须显示覆盖不完整。事实适用 `validTime` 与系统认知 `systemTime` 分开呈现。
- `queryMemory({id,validAt?,knownAt?,includeDisabled?})`：显式只读时间视图。返回的空断言不是永久删除证据，未知日期和不完整覆盖不可补造。
- `previewMemoryAction(input)`：读取同一个存储转换的预览，不写库、不创建 Run、不调用模型。`current` / `proposedAssertion` / `warnings` 供用户核对；预览时间是估计，确认时重新校验 revision 并捕获实际写入时间。
- `applyMemoryAction(input)`：严格 `id + expectedRevision + operation`。`correct` 纠正认识，`change` 要求明确 `effectiveAt` 并保留此前事实；`retract` 撤回断言；`metadata` 调整 pin、停用或 expiry；`restore` 选历史 `targetAssertionId`，停用/过期时须显式选择状态/有效期，创建新 revision；`delete` 永久清除本条历史和相关候选内容。渲染器不得传 source、scope、systemTime。确认在 idle 互斥中进行，冲突或结果不明必须重读，不自动重试。
- `getMemoryMaintenance()`：只读待审、停用、过期、重复建议、容量及自动整理状态。`failed` 反映本进程模型/落库失败，不把 model Run 的 completed 当成已保存；重启不保留进程内失败诊断，待处理游标仍由磁盘事实计算。不开启自动清理。
- `run(text,{memoryConsolidation:"exclude"})`：把本条普通用户消息排除于现在和以后整理。不是关闭已有记忆检索，也不删除 transcript。桌面每次发送显式选择，不默改用户配置。
- 当前投影的 `temporalState` 区分 `applicable`、`retracted`、`not_applicable`，不等于管理状态 `active/disabled`。撤回或当前时点无适用断言时，正文为空且没有 `assertion`；前端应显示对应状态，不把它说成旧格式或补造人工来源。历史仍由显式历史查询读取，此字段不写入存储文件。

桌面修改/恢复/删除必须先展示预览再确认。收到 `memory-updated` 或详情 revision 变化就废弃旧预览。候选接受仍使用 candidate revision，不是工具的 `approvalId`。

#### C 组验收记录（2026-10-04）

- 后端真实模型：Command Code、两个独立子进程、同一配置哈希，5 次 primary Run。普通声明、原话候选、显式程序审阅、跨 Thread 召回、真实变化、重启、纠错与 `knownAt` 查询、历史分页、撤回/恢复/CAS、停用/过期、永久删除均通过实际存储核对。程序审阅不是 Electron 点击；该报告的 `electronAcceptance` 保持 `not_run`。
- 另行使用隔离 workspace 的真实 Electron 窗口，通过原生输入核对：变更预览前后磁盘哈希相同；确认后同一记忆从 revision 1 更新为 2，保留变化前的适用区间；撤回后为 revision 3，正常退出重开后显示“已撤回”；选择历史并明确启用/有效期后恢复为 revision 4。
- 正常退出后以同一配置、workspace 和 transcript 目录启动新 Thread，真实模型回答恢复后的“一行结论 + 三条步骤”，引用同一记忆 ID 与 revision 4；本轮参考面板展示实际选择。此查询勾选“本条不整理为记忆”，已提交消息保留 exclusion 元数据且没有相应整理 Run。
- 新 Thread 再普通陈述标题偏好，真实整理只生成 pending 候选。验收操作者亲自点击“接受变更”后，候选成为 accepted/revision 2，正式库新增对应记忆，来源消息 ID 和精确原话一致，待审卡消失。正式记忆详情已重新读取核对，不靠模型的保存声明判断。
- 本机发现并修复撤回投影的状态显示问题，补充回归测试。最终后端 `pnpm typecheck` 与 `pnpm test`：1026 通过、4 跳过、0 失败；桌面 `pnpm typecheck`、145 项测试和 `pnpm build` 通过，两仓 `git diff --check` 干净。
- 上述证据是 C 组核心路径，不覆盖每一种 GUI 操作组合、普遍语义召回或模型输出质量。真实授权恢复探针仍 `not_run`；恢复记忆不恢复工具授权的契约未改变，不把这项写成已真机验证。隔离窗口正常退出不是崩溃恢复测试。

后端可重复入口（显式付费，默认测试跳过真实模型；报告与原生桌面证据分开）：

```sh
pnpm build
RUNLOOM_MODEL=command-code RUNLOOM_MEMORY_TEMPORAL_ACCEPTANCE=1 \
  node --env-file=.env --test examples/cli/dist/memory-temporal-acceptance.test.js
```

可选同义查询改写（配置仍为 v1；不新增 Memory 文件版本；旧配置默认关）：

```json
{ "modules": { "memory": { "enabled": true, "queryRewrite": { "enabled": true } } } }
```

上面是合入现有配置的片段，不是完整配置。仅普通 primary 对话使用已有模型追加一次请求：只发送当前问题至多 4 KiB，不发送记忆正文、来源或候选；最多三个 96-byte 短语，输出校验 1 KiB，256 输出 token，五秒，零重试。同一用户消息仅缓存改写短语，各步仍重读正式记忆。原查询先选、改写补选，同一 12 条/8 KiB 最终预算与原有范围/状态/有效期过滤。解析/服务/超时失败回退原词法并显示 `degraded`；用户取消会中止，不伪装成功。不开启 WorkTask、worker、checkpoint、整理或手动压缩。额外模型请求增加费用与延迟，错误改写也可能误召回；默认关闭不是全自动语义检索承诺。

固定真实模型对比（显式付费；不重试单例、不更改预算）：

```sh
pnpm build
RUNLOOM_MODEL=command-code RUNLOOM_MEMORY_RECALL_ACCEPTANCE=1 \
  node --env-file=.env --test examples/cli/dist/memory-recall-live.test.js
```

2026-10-04 首版提示词实际 2/3，`回顾要怎样组织内容？` 没召回 `复盘…`。依据此失败修改为“不同内容名词/类别同义词”后，新版本同一固定三例 3/3；直问仍中、同义问题补中、天气没有误中。旧失败不作废；三例不证明普遍召回或真实答案质量，Electron 真模型整链仍 `not_run`。

## 边界

控制器不引入第二条 AgentLoop：主任务与整理共用一条执行路径，确认仍是进程内单个 `beforeToolExecute`。TUI 当前未改走控制器，修改 Run 生命周期时两处都要看。
