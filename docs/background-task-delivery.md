# 后台任务执行与交付（第三批）

本批复用单 worker、TaskStore 和 scheduled-responder，不允许后台改代码、运行 Shell、发送外部消息或继承桌面授权。桌面窗口关闭后继续执行，需要用户显式启用独立 macOS LaunchAgent；仅创建任务不能启动服务。

## 执行与恢复契约

- `tasks.json` 写入升级为 v4；v1–v3 可以只读加载，首次修改才升级。任务 ID 与原始 `runAt` 保持稳定。
- 每次 claim 持久化一条 `attempts`，记录序号、Run ID、开始/结束、状态及错误。每个任务最多三次尝试。
- worker 得到 handle 后记录 Run ID；记录失败会取消 handle 并停止，而不是继续隐形执行。
- 终态结果先保存 `pendingOutcome`，再 finish。重启只安装与该任务当前 Run ID 对应的已记录结果；没有结果回执的遗留 running 收成 interrupted，不从 JSONL 文本推断成功、不自动重放。
- 结果产生到回执保存之间仍有崩溃窗口，该情况保持 interrupted。这里不是 Durable Runtime，也不承诺 exactly-once。
- `--safe-retry` 默认为关。显式开启后，仅对 `MODEL_UNAVAILABLE`、`MODEL_RATE_LIMIT`、`MODEL_TIMEOUT` 做最多三次完整 Run 尝试，间隔 1 秒、5 秒；只适用于当前无工具/只读 Todoist 的 worker。认证、配置、存储失败、未知结果及崩溃中断不自动重试。
- 重试使用 `retryAt`，不改原始 `runAt`，也不取消再创建。睡眠/关机/未登录期间不保证准时；恢复后沿用现有重复任务漏跑只补一次规则。

## 通知契约

`--notify` 开启时，任务 finish 与 `notification.status = pending` 在同一笔 TaskStore 写入中完成。

| 字段 | 意义 |
| --- | --- |
| `pending` | 有待提交的通知意图 |
| `submitted` | OS 命令成功返回，不证明用户看见 |
| `failed` | 通知提交失败；`nextAttemptAt` 非空时可以重试 |
| `acknowledgedAt` | 用户主动确认，与通知提交独立 |

通知最多三次，失败退避 1 秒、5 秒；只重试通知，不再调用模型。第三次失败保留在存储和健康统计中。ack 后不再发新的通知；已经在途的 OS 调用无法撤回。OS 接受与状态写入之间崩溃可能重复弹窗，任务 ID 用于识别，不宣称恰好一次。

默认弹窗只显示任务 ID/状态，完整 prompt、结果、workspace Memory 都不放进锁屏通知。完整结果仍在 inbox。`completed` 只表示 Run 正常结束，不等于业务验收通过。

## 手动 worker

从主仓库运行；这会长期占用当前终端，停止用 Ctrl+C：

```sh
pnpm build
RUNLOOM_MODEL=deepseek node --env-file=.env \
  packages/assistant/dist/task-worker-entry.js \
  --workspace /绝对/物理路径/workspace \
  --workspace-context --safe-retry --notify
```

`--workspace-context` 会让该进程领取的全部任务读取 workspace Memory/checkpoint，不受 TUI 模块开关控制；资料会进入模型和任务结果。`--todoist` 仍只有只读查询能力。

## 桌面接入 API（不修改桌面仓）

```ts
import { createTaskWorkerService } from "@serika/assistant/dist/task-worker-service.js";
import { readTaskWorkerHealth } from "@serika/assistant/dist/task-worker-health.js";
import { createTaskStore } from "@serika/assistant/dist/task-store.js";

const service = createTaskWorkerService({
  workspace, nodePath, workerEntryPath, workingDirectory,
  launchAgentsDirectory, uid, envFile,
  workspaceContext: true, safeRetry: true, notify: true,
});
// 启用/禁用只能由明确的用户动作触发，不要在 app 启动时默认调用。
await service.enable();
const serviceStatus = await service.status();
const health = await readTaskWorkerHealth(workspace, createTaskStore(workspace));
await service.disable();
```

所有路径必须是绝对物理路径，不接受 symlink（Node 安装路径先由调用方 realpath）。`envFile` 只保存路径，不读取/拷贝其中的凭据到 plist。launchd 不继承交互式 shell 的模型环境，使用外部 env 文件配置模型。不得把 API key 放进参数、plist、日志或 IPC。LaunchAgent 用 workspace 哈希 label，只管理该 workspace 的服务，不影响其他服务。

`status()` 返回 launchctl 注册状态、PID 与有界命令结果；查询失败不能包装成健康。`health.ownership` 用实际 flock 探测，`heartbeat` 只是观察，不证明存活。健康文件记录当前任务、最近处理和失败；未 ack 结果/通知失败统计来自 TaskStore，不从桌面缓存推断。

接线限制：

- 健康查询在锁空闲时会短暂取得再释放 flock，可能与 worker 启动竞争；桌面不要在服务刚启动时高频轮询。遇到竞争导致退出时，launchd 按 10 秒节流重新拉起。
- `enable()` 对已注册服务只返回状态，不更新已有 plist。修改开关或路径需要用户显式 `disable()` 后再 `enable()`。
- 无完成回执的崩溃任务由恢复路径标记 interrupted，进入 inbox，但不自动创建 pending 通知；通过 inbox 和健康计数发现，不承诺弹窗。

## 验收边界

离线测试覆盖旧文件升级、尝试上限/退避、持久回执恢复、不确定执行不重放、通知失败独立重试、终态不重执行、服务定义无凭据、路径拒绝、健康及锁观察。已有真实子进程测试验证第二个 worker 被锁拒绝及 SIGKILL 后锁释放。

系统封板仍需真实隔离 workspace + 真模型 + macOS：

1. 显式 enable，关闭桌面窗口，到点结果进入 inbox。
2. 杀死服务 worker，launchd 重新拉起，未确定执行不重放。
3. 终态写盘后、通知前崩溃：重启只补通知；OS 提交失败：inbox 不丢。
4. submitted 不画成已看见；ack 后退出未确认列表。
5. 睡眠/离线恢复符合漏跑规则；任务结果按既有 Eval 格式另行验收。

单元测试和 mock launchctl 不代表这些系统场景已经通过。实现时不自动在开发者机器安装服务、不把桌面尚未接线当成交付完成。
