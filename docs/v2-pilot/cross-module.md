# 跨模块接口（architecture-v2 §4.4 之后，用户确认开始）

目标：第 4 步复盘里列出的跨模块接口问题，在不改变任何输出的前提下收口。输出（系统提示、工具清单、能力状态、桌面端显示）逐字不变。

## 改动

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `packages/assistant/src/module-host.ts` | 新增 `InstructionPlacement`（`lead` / `body` + 排序值）和 `sectionInstructions(section)` | 指令顺序原来由 `app.ts` 手写拼接，新模块要改装配入口；现在模块自己声明位置 |
| `packages/assistant/src/modules/*-module.ts`（10 个） | 每个模块加一行 `placement` | 排序值复刻原拼接顺序（见下表） |
| `packages/assistant/src/app.ts` | `instructionsFor` 改用 `sectionInstructions("lead")` / `sectionInstructions("body")`；任务模块接 `todoist.planning(...)`；删除 `checkTodoistPlanningAvailable` 内联块；`capabilityStatus` 调用改为参数对象 | 装配入口只负责传值，不再知道模块间细节 |
| `packages/assistant/src/module-facts.ts`（新） | `TodoistPlanningFact` | Todoist → 任务模块的事实有类型、集中一处，任务模块不依赖 Todoist 模块 |
| `packages/assistant/src/modules/task-module.ts` | 新增 `todoistPlanning` 选项 | 替代原来 app 里的布尔值和回调两个零散参数 |
| `packages/assistant/src/modules/todoist-module.ts` | 新增 `planning(check?)` | 由提供方构造事实 |
| `packages/assistant/src/capability-status.ts` | `CapabilityStatusInput` 参数对象 | 原来是位置参数，新增字段容易错位 |
| `apps/desktop/src/main/runtime-bridge.ts` | 改用 `BUILTIN_MODULE_IDS` | 原来手写一份模块 id 列表 |
| 测试：`module-host.test.ts`、`task-module.test.ts`、`todoist-module.test.ts` | 排序、事实传递、复核失败按不可用处理 | 新接口的单元测试 |

## 指令位置

| 分区 | 排序值 | 模块 |
| --- | --- | --- |
| lead | 100 | recipes |
| body | 100 | read-file |
| body | 200 | pomodoro |
| body | 300 | computer |
| body | 400 | shell |
| body | 500 | web |
| body | 600 | memory |
| body | 700 | checkpoint |
| body | 800 | todoist |
| body | 900 | task |

同分区按排序值升序；排序值相同时按注册顺序（稳定排序）。

## 验收

- 第 1 步的装配快照（`assembly-full.txt`、`assembly-full-without-todoist.txt`）不变。
- 演示：新增一个只读模块 `demo-echo`（body 850）只需新文件 + 装配入口一行，快照里指令出现在 todoist 与 task 之间；随后 `git revert`。

## 未解决

- 可配置的内置模块仍需同时改 `BUILTIN_MODULE_IDS` 和配置 schema（配置格式在护栏内，不动）。
- 能力清单仍按内置模块 id 列出；改成列出全部模块会多出 recipes，属于可见变化，不做。
- 桌面端 `capabilities.tsx` 的显示名仍是手写（用户可见文本，不动）。
- task worker 进程仍硬编码 Todoist 工具。
- checkpoint 的依赖（`getMemorySelection`、`captureGitPin`）本来就是有类型的函数注入，不改。
