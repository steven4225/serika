# 第 4 步：试点复盘报告

基线 `9fa8678` → `20180c1`，分支 `experiment/architecture-v2`。所有测试都在本机运行（Linux，Node 24），没有 CI，也没在 macOS 上跑过。
最新结果：typecheck 通过；runtime 1755 个测试，1735 通过，20 跳过；desktop 605 个全过；scripts 12 个（11 过，1 跳过）。

## 1. 每个改动动了哪些文件、为什么

| 提交 | 产品代码 | 测试 / 快照 / 文档 | 为什么 |
|---|---|---|---|
| `a569ca2` 第 0 步 | 无 | `docs/architecture-v2.md` §4.4 | 写下范围、护栏、不做的事和步骤表 |
| `7d026bb` 第 1 步 | 无 | 路径、hash 的锁定测试和样例；`docs/v2-pilot/paths.md`、`hashes.md` | 后面每步都能证明路径和 hash 格式没变 |
| `2e1e45a` 第 1 步 | 无 | `baseline-verifier.test.ts`、`receipt-invariants.md` | 把回执和 verifier 的不变量 I1–I5 落到测试上 |
| `e389c9d` 第 1 步 | 无 | 装配快照（三种配置）、Home 快照、`pending.md` | 第 2、3 步的「逐字一致」验收依据 |
| `3ecfefe` D2 | `shell-module.ts`、`foreground-autonomy.ts`、`capability-status.ts`、`telegram-gateway.ts`、`capabilities.tsx`、`telegram-panel.tsx` | 权限快照只变 1 行；两组自主执行集成测试改成逐条批准 | 没有沙箱时本机命令逐条确认；文案跟着改，不能继续说「无需确认」 |
| `61ed013` 第 2 步 | `todoist-module.ts`、`tui-module-config.ts`、`app.ts`、`capability-status.ts` | `todoist-module.test.ts`、`todoist.md` | Todoist 的配置、token、状态行、能力条目归模块 |
| `119797c` / `86fe8fb` | 演示：`todoist-module.ts` 和 `app.ts` 一行，然后 revert | `assembly-full.txt` | 验收：加、删一个工具只动模块文件和装配处一行 |
| `e53f746` 第 3 步 | `home.ts`、`api.ts`、`browser.ts` | Home 结构化样例；用旧解析器记录的桌面金样例 | 结构化快照成为唯一来源，CLI 文本逐字一致 |
| `20180c1` 第 3 步 | `app.ts`、`ui-contract.ts`、`runtime-bridge.ts`、`desktop-runtime.ts`、`App.tsx`、`sidebar.tsx`；新增 `home-view.ts`、`names.ts`；删除 `renderer/src/home.ts` | `home-view.test.ts`、`home-message.test.ts` | 桌面端改收结构化消息，删掉解析器 |

全程未改：AI SDK 适配边界、常驻进程架构、工具副作用语义、回执格式、verifier 判定、记忆语义、数据路径、配置格式、hash 格式。权限快照只在 D2 变了 `autonomous | shell_exec` 一行。

## 2. 发现的接口问题

1. **新增模块的改动点比「一行」多。** 在已有模块里加工具只动模块文件（演示提交证明了）。但新增一个模块至少要改这些地方：
   - `app.ts` 的模块列表；
   - `app.ts` 的 `instructionsFor`（指令顺序是按模块 id 写死的）；
   - `BUILTIN_MODULE_IDS` 和配置 schema；
   - 桌面端 `runtime-bridge.ts:228` 写死的模块 id 列表，以及 `capabilities.tsx` 的名称表。

   要做到「装配处一行」，需要让模块自己声明指令的位置，并让桌面端从 runtime 读模块列表。
2. **后台 worker 写死了 Todoist 工具集。** `task-worker-entry.ts` 要求「正好是 `todoist_list_tasks` v1 read」，而且自己读 `process.env`。这是安全检查，应该保留；但 Todoist 模块一加工具，worker 就得跟着改。可以考虑由模块导出「后台允许的工具集」，worker 只做校验。
3. **跨模块依赖目前是零散的可选参数。** 例如：任务模块的 `todoistPlanningAvailable` / `checkTodoistPlanningAvailable`、checkpoint 的 `getMemorySelection` 和 `captureGitPin`、recipes 的 shell 配置，以及 `ModuleContext.isAssembled()`（todoist 和 web 用它判断 read-file 是否在场）。这些参数都带类型，但没有统一形状，查起来要翻 `app.ts`。
4. **Run 状态还是闭包里的可变变量。** `createRuntimeApp` 里有 15 个 `let`：`autonomousRun`、`foregroundEntry`、`foregroundTaskRequest`、`activeWorkTaskMessage`、`currentMemorySource` 等，分散在 840 行的闭包里。这正是 RunContext 要解决的问题。
5. **状态事件仍然是文本。** 例如：
   - 「任务停止原因」只用 `recordOutput` 写一行文本（`assistant-controller.ts:424`）；
   - Shell 进度、模块通知也走输出流；
   - Home 的任务条目是结构化的，但桌面端 `presentHomeTaskItem` 还在从条目文本里拆字段（`reminder-copy.ts:263`）。
6. **`capabilityStatus` 的位置参数越来越多**，现在有 6 个（第 6 个是这次加的 `moduleEntries`）。下次再加就该改成参数对象。
7. **第 1 步已知缺口没补**（见 `pending.md`）：
   - 部分内部 hash 没有取样；
   - computer 模块只能在 macOS 上测；
   - 自主执行时的指令没有快照。D2 改了这段文本，目前只靠集成测试断言。

## 3. 下一步候选和成本（估算，供你决定）

| 候选 | 内容 | 估计 | 风险 / 护栏 |
|---|---|---|---|
| 「任务停止原因」结构化事件（第 3 步的可选项） | 控制器发 `{ type: "task-stop", reason, cancelled }`，桌面端直接显示；CLI 仍写原文本 | 约 1 天 | 低。桌面端已经有 completion 投影，收益有限；文本必须逐字不变 |
| 跨模块接口 | 给跨模块事实定一个统一的带类型形状，在装配入口一次传入；模块自己声明指令位置；桌面端从 runtime 读模块列表 | 3～4 天 | 中。指令顺序必须用装配快照证明逐字不变；不能变成服务注册表 |
| RunContext | 把那 15 个闭包变量收进一个每次 Run 一份的对象，按「装配期 / Run 期」分开 | 4～6 天 | 中高。涉及自主执行、记忆来源校验和 Steer；必须保持权限快照和回执测试不变。建议先只出设计说明 |
| 记忆生命周期 | 统一记忆存储的创建、整理、关闭和失败恢复 | 5 天以上 | 高。直接碰双时态语义和用户原话来源校验，这一轮明确不做；要做得另设验收 |
| dataDir 重映射 | 按 `paths.md` 的清单引入可配置的数据根目录 | 3～5 天 | 高。会改数据路径；需要迁移方案和你的确认 |
| 状态事件 | Shell 进度、模块通知、停止原因统一成结构化事件，文本输出由它格式化（套用 Home 的做法） | 2～3 天 | 中。可以沿用「先录金样例、再删解析器」的方法 |

建议顺序：先做跨模块接口（直接解决问题 1、3），再做状态事件（复用第 3 步的方法），RunContext 先只出设计说明。记忆生命周期和 dataDir 等你单独决定。

## 4. 工时

所有步骤都在估算内完成，没有触发「超出 50%」的停止条件。中途只停下来过一次：第 2 步的验收条件和文案冲突，已按你选的 (a) 处理。
