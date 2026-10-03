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
- `runWorkTask()` 会把随后启动的主 Run 绑定到该任务；核对时同时检查 `task.runIds` 与 `getRun(runId).workTaskId`。Run 正常结束只把任务推进到暂停/复核，不等于交付或验收完成。
- `submitWorkTaskDelivery()` 仅自动核对当前支持的精确 `shell_exit_zero` 和 `artifact_exists`。Shell 标准同时固定 `command` 与 workspace 相对 `cwd`（workspace 根为 `"."`）；Store 会再次回查真实 `runId + toolCallId` 回执，文件还会重算当前 SHA-256，调用方不能自报 evidence。人工标准不会被模型回复或 Run 成功自动通过，必须由用户明确调用 `recordHumanAcceptance()`；出现 `unknown` 工具或缺失执行回执时进入复核，不能重放。
- 第一批 WT01–WT06 的固定案例、外部 Eval 记录和“尚未运行”的证据边界见 [WorkTask 第一批验收与 Eval 记录](work-task-acceptance.md)。产品 WorkTask 状态与外部 `AcceptanceCaseResult` 是两层记录，前端不得把其中一层的完成映射成另一层通过。

## WorkTask 启动恢复与人工核对（第二批）

- `requestWorkTaskChanges({ id, expectedRevision })` 只将 `awaiting_acceptance` 退回 `paused`，清空所有 criterion 状态、证据引用与说明，保留上次交付及 Run 回执作为历史参考；不调用模型、不重放工具。下一轮仍须显式 `runWorkTask()`，重新提交替换交付快照并重新验收。`recordHumanAcceptance()` 和 Store 验收只接受 `awaiting_acceptance`，暂停/执行中的旧交付不能通过验收。终态不可重开，未知效果仍走 reconciliation；这不是多版本交付历史。

- 控制器首次使用前按固定顺序取得 workspace/Thread 的 WorkTask 进程期锁和 transcript/Thread 的 execution 进程期锁，再把该 Thread 遗留的 `running` Run 标为 `interrupted`：已 `started` 但没有终态回执的工具变成 `unknown`，只有 `requested` 的工具变成 `not_started`。随后才对账该 Thread 的 `running` WorkTask，并在完成前阻止 WorkTask API 和新 Run。锁冲突、坏文件或对账失败均 fail-closed；`shutdown()` 释放两把锁。
- 对账检查任务最新的关联 Run，同时核对 Thread、`workTaskId` 和 `primary` phase。最新回执缺失、外来或含 `unknown` 会把任务置为 `needs_review`；最新回执可说明且没有未知副作用时置为 `paused`。前一个不确定 Run 必须先 reconciliation 才能回到 `paused` 并显式开始下一 Run，因此恢复不依赖可能已经被有界 execution store 淘汰的完整历史。这个过程只收敛本地状态，绝不重新调用模型、工具或重放副作用。
- `needs_review` 只能由用户显式调用 `reconcileWorkTask({ id, expectedRevision, observedOutcome, decision, note })` 处理。`observedOutcome` 是 `applied | partially_applied | not_applied | still_unknown`，说明必须非空；`continue + still_unknown` 会被拒绝。成功的 `continue` 只保存 human report 并把任务改为 `paused`，不会自动调用 `runWorkTask()`；成功的 `cancel` 把任务改为 `cancelled`，但尤其在 `still_unknown` 时不表示旧副作用未发生。
- `cancelWorkTask()` 对 `needs_review` 返回 `WORK_TASK_INVALID_STATE`；前端在这个状态只能展示带观察结果和说明的核对取消入口，不能沿用普通取消按钮跳过记录。
- `task.reconciliations` 是有界的人类观察记录，不是程序验证结果、工具授权或 acceptance evidence，不能直接让 criterion 通过或让任务完成。后续主 WorkTask Run 只会把最近一条作为带警告的参考上下文；调用方仍须明确启动 Run，并重新取得所有写入和 Shell 权限。自动验收只使用最新且可验证的任务 Run，不要求保留无限历史回执。
- 恢复和 reconciliation 都使用当前 `revision` 做 CAS。revision 冲突后重新读取任务和执行回执，不得盲重放旧请求；前端应把 `needs_review`、最新 Run 的 `unknown`/缺失情况、human report 及取消后的残余不确定性直接展示给用户。

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
- 整理 Agent 先 prepare 后 stage；stage 仅进程内暂存。成功 Run 结束后才把待审候选和自动整理游标同锁写入 `memory.json` v3。`consolidation` completed 不等于正式记忆已保存；commit 失败单独报告，不改主任务成功结果。
- Controller 的 resolve 是明确用户审阅操作，不走 `confirm()`；`confirm()` 仍是工具调用的 approvalId 授权。聊天的 `memory_apply_candidate` 使用相同接受实现但走正常 y/n；`n` 只拒绝本次调用，候选仍 pending。
- 重复接受同 candidateId 和原 expectedCandidateRevision 返回原应用回执、`replayed:true`，不重复写。回执里的 memoryRevision 是接受当时的版本，不证明它现在仍未修改或删除。
- v1/v2 文件只读不会迁移，第一次实际成功写入升级 v3。正式记忆最多 512 条、文件 16 MiB；pending 全 workspace 最多 64 条，终态保留最近 256 条。候选不进入主 Agent/worker 参考上下文。
- 本组没有修改桌面仓。前端接线需要独立验证，不能把后端测试映射成 Electron 已验收。

## 按问题选材（B 组）

主 Agent 每次上下文准备从原始本轮用户文本查询，只读取一次正式 Memory。普通路径和压缩预算共用已选 reference prefix；整理 Agent 不接这条 active-only 注入路径。手动 compact 从最近已提交普通用户文本选材，下一轮按新问题重新查询。

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

## 边界

控制器不引入第二条 AgentLoop：主任务与整理共用一条执行路径，确认仍是进程内单个 `beforeToolExecute`。TUI 当前未改走控制器，修改 Run 生命周期时两处都要看。
