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

## 边界

控制器不引入第二条 AgentLoop：主任务与整理共用一条执行路径，确认仍是进程内单个 `beforeToolExecute`。TUI 当前未改走控制器，修改 Run 生命周期时两处都要看。
