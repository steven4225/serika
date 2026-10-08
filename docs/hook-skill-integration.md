# Hook + 定时任务 + Skill：统一接入

手动调用、生命周期 Hook 和定时调用共用同一份已登记 Skill 定义、版本核对与 AgentLoop。仍使用原来的 Controller、Thread 租约、执行回执、TaskStore 和 worker，没有新增调度器或常驻反思进程。提醒、Todoist 和 RSS 保留原有类型化来源与兼容路径，不声称已全部改写成通用 Skill。

## 用户可见结果

- **Before：** 记忆整理触发固定在程序里，不能用配置选择已登记 Skill；桌面没有统一入口查看这些规则或手动运行它们。
- **After：** 外部可信配置可以登记 Skill、选择 Hook。桌面「工作区 → 自动安排」可查看能力与规则，手动执行无工具文本 Skill，预览并确认单次/每日/每周排期，暂停或取消后续执行，并在原收件箱读取实际结果。记忆仍按已提交用户原话验证，最终写入仍由既有策略决定。
- **五分钟 Demo：** 使用隔离 workspace、固定 transcript 和真实模型，在桌面命令入口运行 `/skills`、`/hooks`；发送一条长期偏好，等整理结束，再新建对话询问该偏好。自动写入模式应能在正式记忆中看到记录，并在新对话的参考记忆里看到同一 ID。review 模式需先接受候选。此 Demo 需要宿主载入下面的配置，而不是向普通对话粘贴 JSON。

## 配置

配置与外部 Skill 包都必须在 workspace 外。未修改任何日用配置；在隔离配置中试用后再由用户选择启用。

仅使用内置记忆 Skill 的最小配置（替换 workspace 的绝对路径）：

```json
{
  "version": 1,
  "workspace": "/absolute/path/to/personal-workspace",
  "modules": {
    "memory": {
      "enabled": true,
      "autoConsolidate": true,
      "writePolicy": "automatic"
    }
  },
  "automation": {
    "hooks": [
      {
        "id": "memory-at-open",
        "event": "thread.ready",
        "handler": { "type": "skill", "id": "memory-consolidate" }
      },
      {
        "id": "memory-after-chat",
        "event": "primary.completed",
        "handler": { "type": "skill", "id": "memory-consolidate" }
      }
    ]
  }
}
```

省略 `automation.hooks` 保留原记忆默认触发；显式 `hooks: []` 禁用所有自动触发，手动 Skill 仍可用。`autoConsolidate` 允许登记记忆执行能力，并不覆盖这个空数组。`writePolicy: "review"` 只提出候选，不自动接受。`automatic` 也不是所有提案都自动写入：不明确、缺分类、历史范围等仍留待审核。

仅接受 `thread.ready` 和成功的 `primary.completed`。辅助 Skill 完成不会再触发主任务完成 Hook。普通聊天抢占后台 Skill，等其实际取消/收尾后再启动；手动运行和管理操作仍须空闲。没有待整理增量的新 Thread 不会为了空整理进入运行状态。

## 外部 Skill 包

通过可信配置明确登记，不自动扫描目录。每包包含 `skill.json` 和 `SKILL.md`，每份文件不超过 16 KiB，最多 32 包。

```json
{
  "version": 1,
  "id": "brief",
  "description": "把用户提供的文字缩成一行结论和两条行动",
  "kind": "text",
  "tools": [],
  "limits": { "maxSteps": 1 }
}
```

`SKILL.md` 示例正文：

```text
仅根据本次输入，输出一行结论和两条可执行行动。
不要编造事实或声称执行过工具。输入缺少信息时直接说明。
```

把登记项加到上述配置的 `automation` 中：

```json
{
  "skills": [
    { "id": "brief", "directory": "/absolute/trusted/skills/brief" }
  ],
  "hooks": []
}
```

`text` Skill 仅收到本次显式输入。Hook 调用的输入仅是宿主生命周期 metadata，不包含对话正文、记忆、checkpoint 或历史；因此不能把这个例子说成自动对话总结。没有文件、Shell、MCP 或任意脚本权限。

`memory-consolidate` 包只允许 `memory_prepare_consolidation`、`memory_stage_candidates`，必须开启记忆与 `autoConsolidate`。它使用宿主选出的已提交来源，不能通过显式输入伪造素材。指令必须遵守现有 prepare → stage 协议；自定义指令也不放宽来源、游标和 CAS 校验。

包 hash 覆盖规范化声明、工具、预算和完整指令。登记可带 `expectedHash` 固定版本；每次运行还会重读包核对启动 hash。改文件后旧进程返回 `SKILL_CHANGED`，不创建 Run，须重载并核对新版本。符号链接叶节点和 workspace 内包被拒绝。

## 桌面和嵌入调用

桌面在现有工作区抽屉内展示自动安排，不新增并列应用。命令选择器仍支持：

```text
/skills
/hooks
/skill brief 今天要先核对报表，再给客户发修改说明。
/skill memory-consolidate
```

这些命令属于 `AssistantController.command()`，不是普通模型对话，也不是 TUI 本次新增命令。`/hooks` 的最近记录最多 30 项，仅属于当前进程；重启后的 Run/tool 结果仍查既有执行回执。

```ts
const diagnostics = controller.getAutomationDiagnostics();
const skill = diagnostics.skills.find(item => item.id === "brief");
if (skill) {
  const started = await controller.runSkill({
    id: skill.id,
    expectedHash: skill.hash,
    input: "今天的计划……"
  });
  // started.ok 仅表示启动成功，不是完成或内容正确。
}
```

后续完成看 `run-result` 和诊断。`text` Run 的 phase 为 `skill`；记忆 Skill 为 `consolidation`，不得渲染成 primary 任务完成。模型 Run 完成但记忆 finalize 失败，Skill 诊断仍为失败，游标不推进。包 metadata 不返回指令正文或包路径。

## 定时调用

配置中显式启用 `modules.task.enabled: true`，再登记上面的 `brief` 包。没有登记包时桌面显示真实空状态，不自动安装默认包或修改日用配置。

只允许登记的无工具 `text` Skill 排期，输入必须非空且不超过 4 KiB。保存单次时间或固定 UTC 偏移的每日/每周规则，不能同时指定两者。`memory-consolidate` 依赖当前 Thread 的已提交来源与游标，不能定时调用；仍由 Hook 或显式维护入口处理。

```ts
const saved = await controller.scheduleSkill({
  id: skill.id,
  expectedHash: skill.hash,
  input: "今天先核对报表，再准备客户说明。",
  runAt: "2026-10-08T09:00:00+08:00"
});
// saved.value.task 与 saved.value.service 分开：保存成功不代表服务启用成功。
if (!saved.ok) throw new Error(saved.error.message);
const overview = await controller.getAutomationOverview();
if (saved.value.task) {
  await controller.changeAutomationSchedule({
    id: saved.value.task.id, kind: "once", action: "cancel"
  });
}
```

列表读取和变更返回值同样必须处理 `ok` 分支。循环安排操作为 `kind: "recurring"`，支持 `pause`、`resume`、`cancel`；单次只支持取消。列表有界，已结束结果在持久收件箱，不从结果按钮重新执行。

也可在普通对话中要求模型创建已登记的 Skill 安排，仍走现有 `task_create` / `task_repeat` 和逐次工具确认。宿主核对登记与 hash，模型不能通过名称扩展工具权限。排期保存以下声明：

```json
{
  "kind": "skill", "source": "none", "notification": "always",
  "declarationVersion": 1,
  "skillId": "brief", "skillHash": "<64位小写SHA256>"
}
```

worker 必须使用同一份可信配置，绝对路径位于 canonical workspace 外且配置的 workspace 完全匹配：

```sh
RUNLOOM_MODEL=command-code node --env-file=.env \
  examples/cli/dist/task-worker-entry.js \
  --workspace /absolute/path/to/personal-workspace \
  --config /absolute/trusted/config.json
```

执行前重读包并核对固定 hash。包变化、未登记或配置缺失会明确失败，不调用模型、不退回旧 responder。每次只传本次显式输入，不注入 Memory、checkpoint 或历史，不注册文件、Shell、MCP 工具；新 Skill 安排不进入整个 Run 的 `--safe-retry`。

嵌入宿主在用户确认排期后可显式登记原 launchd 服务。plist 只记录可信路径与开关，凭证仍在现有外部 env 文件。已登记服务参数不同必须先显式停用再启用，不自动替换。桌面还核对 launchctl 实际加载参数，旧缓存不能冒充配置相同。后台服务沿用非 symlink 路径保护：前台可读取的 symlink 配置不因此获得后台启动资格，会明确提示改用外部非 symlink 配置，不暗中改变相对 workspace 基准。终态、通知、ack 与恢复仍用原 TaskStore；通知提交不等于用户收到，未完成执行不自动重放。

**五分钟排期 Demo：** 用上面启用 task 并登记 `brief` 的隔离配置打开桌面，在「工作区 → 自动安排」选择 `brief`，输入两件真实待办，选择两分钟后的单次时间，查看预览并确认。安排应先显示待执行；同配置 worker 到点运行后，刷新原收件箱，应看到 Skill ID/版本、`completed` 与实际文本。修改包再安排旧版本应明确失败而不是输出旧 responder 文本。未启用后台服务时显示保存成功但服务不可用，不能将此算作到期执行通过。

## 验证入口和边界

静态 `--check` 验证登记包、hash 和 Hook 引用，不启动模型、Store、Run 或 worker，不创建 transcript：

```sh
pnpm build
node --env-file=.env examples/cli/dist/index.js --check --config /absolute/path/to/config.json
```

默认测试使用脚本模型，真实模型验收显式开启，费用请求上限五次，不重跑整个案例、不允许 mock 回退：

```sh
RUNLOOM_MODEL=command-code RUNLOOM_HOOK_SKILL_ACCEPTANCE=1 \
  node --env-file=.env --test examples/cli/dist/hook-skill-real-acceptance.test.js
```

真实案例验证外部记忆包由配置 Hook 调用、自动写入与精确来源、游标、关闭并重开 Controller 后新 Thread 的当前参考和实际回答。它不证明 OS 进程重启、Electron 点击链或通知。

定时 Skill 真实模型验收（有费用，最多三次请求；同一逻辑调用不重试，不允许 mock 回退）：

```sh
RUNLOOM_MODEL=command-code RUNLOOM_SCHEDULED_SKILL_ACCEPTANCE=1 \
  node --env-file=.env --test examples/cli/dist/scheduled-skill-real-acceptance.test.js
```

它验证同一登记包的手动/定时实际回答、生产 worker 循环、结果入库、ack 重开仍保留与不重放。worker 子进程锁、SIGTERM 和重启由默认离线验收另测，使用脚本模型并明确标注。真实模型、子进程、Electron 点击、launchd 和系统通知分别报告，不能相互冒充。

本批另完成了隔离 Electron 原生点击：选择 `simple-plan`、输入、查看预览、确认单次排期；同配置独立生产 worker 在到点后用真实 Command Code 模型完成一次，桌面收件箱打开结果并标为已读，记录仍保留且只有一次 Attempt。后台服务未配置的提示正确显示。查看结果会同步重读上方安排列表，避免结束结果旁仍显示旧的待执行快照。此真机链没有安装 launchd、没有发送系统通知，也没有验证关窗口后服务持续运行；这些仍需单独封板。
