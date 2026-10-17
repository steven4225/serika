# Serika 架构 v2：现状、边界与重构路线

> 状态：进行中（分支 `experiment/architecture-v2`）。本文取代 `docs/architecture-v0.md`。
> 规则：所有 v2 重构只在 `experiment/architecture-v2` 上进行；不修改、合并或同步 `main`，不强推、不改写历史。

## 1. 现状（以代码为准）

| 层 | 目录 | 实际职责 |
|---|---|---|
| Core | `packages/core` | Thread/Run 类型、JSONL transcript store、steering、事件、`hashCanonicalJson` |
| Loop | `packages/ai-sdk-adapter` | `AgentLoop`：model → tool → model 循环（`loop.ts` 963 行，`execute` 约 480 行） |
| 助理领域 + Controller | `examples/cli` | 记忆、任务、WorkTask、上下文压缩、dreaming、RSS、Telegram、权限、`AssistantController`（约 70 个方法）、`RuntimeApp` |
| 桌面端 | `apps/desktop` | Electron 主进程 + React 渲染层；深度引用 `@serika/example-cli/dist/*.js` 共 45 个模块 |
| Eval | `examples/eval` | 离线/真实模型评测、记忆召回、压缩保真度 |

事实上的核心是 `examples/cli`，名字叫 example，但承载了全部产品逻辑。

已知结构问题（重构对象）：

1. God object：`AssistantController`（1849 行）、`RuntimeApp`（`app.ts` 1657 行）、`App.tsx`（1324 行，65 个 `useState`）。
2. Loop 与应用耦合：adapter 内写死应用工具名和中文提示文本；工具抛错直接终止 Run；工具串行；每步重复 clone/convert/prepare。
3. 两套上下文策略并存（8 回合/128 KiB 截断 vs token 预算压缩），token 用 字符数/2 估算，压缩同步阻塞，学习技能/checkpoint 位于前缀前部破坏 prompt cache。
4. 记忆单文件 `memory.json` 混存事实、候选、游标、回执、文档库；只有 workspace/thread 两种作用域；每步最多重复检索 3 次。
5. 约 17 个文件各自实现原子写，16 个各自用 flock。
6. UI 状态由文本流 `recordOutput` 反推；约 15 个手动刷新按钮。
7. WorkTask 把评测 harness 暴露成产品，与定时任务是两套系统。
8. 文档滞后：README 55 KB、AGENTS.md 58 KB，大量内容是变更日志。

## 2. 目标结构（v2 终态）

```text
apps/desktop ─┐
apps/cli ─────┼─> packages/assistant ─> packages/agent-loop ─> packages/core
apps/telegram ┘        (领域：记忆/任务/上下文/沉淀，扩展 API)
```

- `packages/core`：只有类型、事件、transcript 存储、hash，不依赖 AI SDK、Electron 或存储引擎。
- `packages/agent-loop`：参考 pi 的最小循环（目标 ≤ 500 行）。通过 hook 扩展：`transformContext`、`convertToLlm`、`beforeToolCall`/`afterToolCall`、steering、follow-up。hook 不得抛错，错误编码为消息。
- `packages/assistant`：助理领域 + 扩展 API。权限、记忆、任务、上下文组装都以扩展形式挂到 loop 上。
- 桌面端通过事件订阅拿状态，不再解析文本流，不再深度引用 `dist/*.js`。

## 3. 不动的东西

以下是 Serika 的核心价值，重构中只搬位置、不改语义：

- 工具副作用语义：未知结果不伪装成失败；非幂等工具不自动重试；审批先于执行持久化（见 AGENTS.md「Tool side-effect invariants」）。
- verifier 概念。
- 双时态记忆模型的内部语义，以及「事实只能来自用户原话」（`isExactUserQuote`）这条边界。
- 权限模型（会改成扩展形式，但判定规则不变）。
- 现有测试：先保持全绿，再随代码迁移。
- 常驻进程架构、AI SDK adapter 边界。
- `jcs-sha256:v1` hash 输出格式（已持久化）。
- 用户数据路径：userData `@aisdk-agent/desktop`、`.runloom/`、`runloom.json`、`RUNLOOM_*`，在有「新名优先、旧名兜底」的兼容层之前不改。

## 4. 重构路线

每一步：测试全绿才提交；记录前后指标；一步一组提交，提交信息以 `refactor(vN-stepX):` 开头。

| 步 | 内容 | 主要指标 |
|---|---|---|
| 0 | 定边界：本文档、ADR、改名 Serika、移除 durable/postgres | 删除约 5.8k 行无用源码 |
| 1 | 删冗余用户操作：记忆审核队列、手动刷新、模拟按钮、功能开关等；记忆默认自动写入（待确认默认选项） | 用户可见按钮/开关数 |
| 2 | Loop 瘦身（pi 风格 hook，移出应用工具名和文案，工具错误编码为消息） | `loop.ts` ≤ 500 行 |
| 3 | 拆包 + 扩展 API：`packages/assistant`、`apps/cli`；权限扩展（记住选择）；上下文组装器；事件订阅 UI；拆 `App.tsx`。验收见 §4.2 的 A1、A2 | 深度引用 45 → 0；`AssistantController` 方法数 |
| 4 | 统一上下文：裁剪工具输出 → 真实 token 用量 → 后台压缩；稳定前缀排序 | 只剩一套策略；cache 命中率 |
| 4.5 | 去掉用户可见的「工作区」：用户级 home（`~/.serika` / userData）+ 自动识别的项目层；授权目录列表；记忆增加 `user` 作用域；`.runloom/` 一次性导入；Shell 系统级沙箱（见 §4.3）。验收见 §4.2 的 A3 | 「未配置工作区」类拦截数 → 0 |
| 5 | SQLite（`node:sqlite`）：先迁记忆，拆表；表结构按 4.5 的两级设计（`project_id` 可空）；备份改为导出/导入 JSON；保留旧 `memory.json` | `memory-store.ts` 行数；并发写冲突 |
| 6 | 任务重做：`work_task_create` 工具、自动推导校验、宿主执行校验、4 个状态、与定时任务合并 | 状态数 7 → 4 |
| 7 | 沉淀管线：自动整理 + dreaming 合并为一条空闲反思管线，使用隐式信号；增加精确率/撤销率评测 | 撤销率 |

候选补充（参考 OpenClaw / Hermes，待确认后并入对应步骤）：

- 4.5：home 首次启动自动创建，不要求用户配置。
- 4.5：彻底移除记忆审核模式（CLI/工作区配置的 review 写入策略、候选存储与候选工具），与工作区去除一起做。
- 4：用户画像设硬预算，会话开始时冻结注入；事实库改为工具按需检索。
- 7：压缩前先沉淀（pre-compaction flush）。
- 可选：桌面端与 Telegram 共用单一主会话，需要时分出线程。

## 4.1 进度

- 第 0 步：完成（改名、本文档、ADR 0001、移除 durable/postgres）。
- 第 1 步：完成。
  - 已完成：删除「内置功能开关」卡片；删除「找回旧目录里的对话」；记忆默认自动写入（仅限工作区外的配置）；删除记忆审核队列（今日卡片、简报项、提醒、角标）；删除双时间编辑界面（纠正时的适用时间段、「查询某个时点的认知」及桌面端 `queryMemory` 通道；「实际变化」留空表示现在）；删除导入拆分预览（界面、桌面 IPC 与 Controller 端口；存储层的导入与回执保留，第 5 步改造成备份导入）。
  - 保留：浏览器预览页（`*-preview.html`，含「模拟」按钮）只是开发用夹具，不进入产品；没有 Electron 图形环境时可以用它们验证界面，所以不删。
  - 挪到后续步骤（和那一步的改动耦合，单独删会做两遍）：上下文模式选择和手动压缩 → 第 4 步；Telegram 投递核对 → 第 6 步（关系到未知效果的核对，不能先删界面）。
  - 记忆文件夹（记忆页主视图、MemoryLibraryPanel）→ 第 5 步，和 SQLite 拆分一起重做。
- 第 2 步：完成。
  - `loop.ts` 963 → 343 行。中断、模型错误分类、工具错误这三组辅助函数原样拆到 `abort.ts`、`model-errors.ts`、`tool-errors.ts`，逻辑不变。
  - core 新增 `afterToolCall` hook：返回 `feedback`（只追加到下一次模型请求，不进 transcript 和事件）或 `stop`（以 `RUN_LIMIT_EXCEEDED` 结束，已完成的调用保持真实）。hook 本身抛错或返回无效决定按 `INTERNAL` 失败，不重放工具。
  - 防重复查询守卫（应用工具名、中文文案）从 adapter 移到 `packages/assistant/src/no-progress-guard.ts`（当时在 `examples/cli`），作为 `afterToolCall` 挂上；状态从本次 Run 的消息推出，不再存在 loop 里。测试随之迁移。
  - `add` 演示工具只在离线 mock 模型（`createDemoModel()`）下注册，真实模型的工具列表和指令里不再出现它；需要它的自定义 mock 测试显式传 `demoTools: true`。
  - 没做：`beforeToolExecute` 抛错仍让 Run 失败（fail closed）。工具执行失败、拒绝、参数无效本来就编码成工具结果消息；precheck 自身出错不是模型能修的问题，改成消息只会让模型重试。
- 第 3 步（进行中）：
  - 已完成：桌面端对 `example-cli` 内部文件的引用 44 个模块 → 0。`example-cli` 只开放显式列出的公开入口：`.`（`src/api.ts`，宿主用）、`./browser`（`src/browser.ts`，不含 Node 依赖，渲染进程运行时只能从这里取值）、`./testing`（测试夹具）、`./task-worker-entry`（worker 进程入口）。`./internal/*.js` 只留给 `examples/eval` 这类内部评测。`apps/desktop/src/main/package-boundary.test.ts` 防止回退。
  - 已完成：桌面端 IPC 纯转发方法（77 个：当前会话 56、宿主 21）改为一张表 `apps/desktop/src/shared/ipc-forwards.ts`，主进程 `registerForwardedIpc` 和 preload 都由表生成，`ui-contract.ts` 不再为它们各写一个通道常量。新增一个直通方法从改 6 处变成改 3 处（实现、`RendererApi` 声明、表里一行）。有参数校验、副作用或拼装逻辑的通道仍然手写。常驻进程的 `RESIDENT_*` 方法列表是安全白名单，没有并进这张表。
  - 已完成：`examples/cli` 改名搬到 `packages/assistant`，包名 `@serika/example-cli` → `@serika/assistant`。只改路径和包名，源码内容不动；仓库内命令、文档链接、CI 和 lockfile 同步更新。第 1 节「现状」和第 5 节度量基线描述的是改造前，保留旧名。
  - 已完成：工具确认与 Run 授权（`createToolConfirmation`、文件/Shell/网页授权规则）从 `tui.ts` 原样拆到 `tool-confirmation.ts`。`app.ts`、Controller 和桌面链路不再为确认逻辑依赖终端界面文件；`tui.ts` 1468 → 927 行，只剩终端渲染和命令。
  - 已完成（A1）：`createRuntimeApp` 不再接收 argv，改为结构化装配参数：`directory`（transcript 目录）加 `assistant?: AssistantAssembly`（`threadId`、`configPath`，或不带配置文件的 `workspace`/`autoConsolidate`/`todoistEnabled` 简写；省略 `assistant` 即离线 demo）。CLI 在入口把 `--tui` 参数解析成这份结构；桌面端、测试和 eval 直接传值（约 100 处调用一并改写）。参数组合校验不变：CLI 解析时由 `assertAssemblyCombination` 报具体参数，结构化入口由原有的配置解析检查拒绝。模块配置仍是文件路径：配置文件是否位于工作区内是现有的信任边界（自主执行、沙箱、自动记忆、授权都依赖它），不改成内存对象。`assembly.test.ts` 验证同一进程两个实例的 transcript 与工作区互不可见；包内没有进程级可变状态，也不读 home 目录。
  - 已完成：命令行入口拆到 `apps/cli`（`@serika/cli`）。挪过去的是 `index.ts`、`tui.ts`（终端渲染和命令）、`parseTuiArgs`/`TuiArgs`，以及 `tui.test.ts`、`cli-options.test.ts` 的解析部分、启动检查测试和 4 个启动 CLI 进程的测试（原在 `tui-module-config.test.ts`，现为 `cli-entry.test.ts`）。CLI 只从 `@serika/assistant` 的公开入口取值，测试另用 `./testing`；`apps/cli/src/package-boundary.test.ts` 防止回退。留在 assistant 的：`resolveWorkspace`（改放 `resolve-workspace.ts`，worker、定时 Skill、模块配置都用它）；`TuiCommand`/`TuiCompaction`/`TuiResume` 移到 `host-commands.ts`（`RuntimeApp` 的字段类型）；启动检查的装配校验改名 `checkAssistantStartup(assembly | Error)` 留在 assistant，CLI 的 `checkTuiStartup(argv)` 只负责解析参数，解析失败照旧报为阻塞的 config 检查，快照内容不变。没把整份启动检查挪走，是因为它校验的是装配语义（Skill、Hook、数据文件位置），挪走就要把这些内部常量和函数都公开。`tool-confirmation` 的横幅测试测的是确认逻辑，留在 assistant；`src/acceptance/*` 和 `*-acceptance.ts` 都不经过 CLI 入口，也留下。eval 不再解析 argv，直接把 `{ configPath }` 交给配置解析。
  - 已完成：`AssistantController` 按领域拆分，方法数 62 → 顶层 11 个 + 7 个分组。顶层只留对话本身（`getSnapshot`、`getHistory`、`getContextDiagnostics`、`run`、`steer`、`cancel`、`confirm`、`command`、`recordOutput`、`subscribe`、`shutdown`）；其余进分组：`memory`（18）、`workTasks`（12）、`automation`（8）、`dreaming`（4）、`rss`（4）、`recipes`（2）、`runs`（3，`listModelUsage` 由可选改为必需）。各组在 `controller-*.ts`，只通过 `ControllerKernel`（`controller-kernel.ts`）用核心：读空闲/关闭状态、发事件、等 Thread 恢复、`exclusive()` 以 `command` 状态独占执行（`cancel()` 照样能中止）。状态机、Run 引擎、后台整理和学习都留在核心，分组不持有生命周期状态。原来不带中止信号的独占操作（任务结果确认、RSS 确认和订阅修改）改走 `exclusive()`，行为不变。桌面 `RuntimeBridge`、`RendererApi`、IPC 表和 `RESIDENT_*` 白名单仍是扁平方法名，只改了桥接内部对 controller 的调用；`shared/work-tasks.ts` 用 `WorkTaskOperationMethods` 把 IPC 名映射到 `workTasks` 组的方法。eval 脚本和接入文档同步改名。
  - 已完成（权限扩展第一部分，判定规则不变）：新增扩展接口 `RuntimeExtension`（`runtime-extension.ts`：`beforeToolExecute`、`afterToolCall`、命令）和 `composeExtensions`。组合规则：执行前钩子按顺序问，第一个拒绝即返回，全部允许才执行；执行后钩子第一个给出决定的生效；命令重名在装配时报错；只有一个扩展提供的钩子原样使用。权限收进 `permission-extension.ts`：逐次确认（`createToolConfirmation`）、宿主固定免确认的三类调用（自身的 `capability_status`、记忆整理 Skill 声明的工具、工作区任务只读）、`/authorize`、`/authorize-shell`、`/authorize-web` 和 `/permissions`，从 `app.ts` 原样搬出（`app.ts` 少约 150 行）。防重复查询守卫也作为扩展挂上。`RuntimeApp.toolConfirmation` 和 Controller 的用法不变。「记住选择」会改变 AGENTS.md 里「`y` 从不被记住」这条已确认规则，方案待确认后再做。
  - 已完成（权限扩展第二部分：记住选择）：确认卡多一个「允许并在本次对话内记住」（终端输入 `r`），只在后端给出可记住范围时出现。有效期是本次对话：只存在这个对话的助手进程内存里，不落盘、不碰 SQLite；重启、切换对话或改设置重建助手后清空；只对授权时的那个 agent 有效。范围：读取类工具（声明 risk 为 read）按工具名；`write_file`/`edit_file` 按所在目录（不含子目录，两个工具分开记）；`web_fetch` 按网站来源（origin）。一律不能记：Shell（含 Docker 沙箱）、电脑操作 `computer_*`、命令配方 `recipe_*`、记忆 `memory_*`；以后接 MCP 时其工具也必须默认不可记。拒绝不记；「拒绝 web_search 后本 Run 不再 web_fetch/feed_read」仍然优先。Telegram 发起的 Run 既不用也不提供记住的授权。`/permissions` 列出已记住项，`/permissions forget <编号>` 单条清除。接口：`PendingToolApproval.remember?: { label }`，`resolveApproval`/`controller.confirm` 加 `remember?: boolean`（桌面 `ConfirmInput.remember?: true`，桥接层校验后才转发；对不可记的调用带 `remember` 会被拒绝而不是降级成普通允许）；`beginRun(autonomous, source)`。AGENTS.md 第 73 行规则已同步。长期记住留到 4.5 与授权目录列表一起设计。
  - 第 1 步返工（按问卷答复）：
    - 取消审核概念：桌面端不再有候选/待审核界面与通道（删 `listMemoryCandidates`/`getMemoryCandidate`/`resolveMemoryCandidate`，Controller `memory` 组删 `listCandidates`/`getCandidate`/`resolveCandidate`）。自动模式下只保存宿主判定可自动接受的条目；不确定或有冲突的不保存为记忆，只作为内部待定记录留着（不展示、不注入上下文，免得用户明确说过的话直接丢掉；来源算已处理），对话里提示「没有自动保存，原记忆没有被覆盖」。内部待定记录满 64 条后，多出来的直接不存，不再拦住整理。桌面启动时把「已开自动整理、但写入策略不是 automatic」的旧配置改成 `automatic`（显式 `RUNLOOM_CONFIG` 不改写）。
    - 双时间界面只留「编辑」和「删除」：编辑正文走 `correct`，删除确认一次后永久删除；去掉置顶、停用、有效期、撤回/恢复、实际变化、历史抽屉和适用/认知时间展示。聊天里自动记忆的「撤回」仍走 `retract`。
    - 手动补整理直接删除（面板、`consolidateMemory`、`listMemoryConsolidationSources`、Controller 的 `consolidate`/`listConsolidationSources` 和 history 模式）。整理重试用尽时提示「原话仍保留，这段太长没记住，可以分段再说」。
    - `RESIDENT_*` 白名单只删除了上述已删方法，没有新增。
    - 遗留：CLI/工作区内配置仍可用旧的 review 模式，候选存储和 `memory_candidates_list`/`memory_apply_candidate` 工具还在（与工作区信任边界相关）→ 4.5 一并移除。不确定的冲突目前不保存，没有转折词的偏好更新（如先说不加糖、后来直接说加糖）不会生效；是否改成「新的覆盖旧的」、内部待定记录交给第 7 步的反思管线处理，待确认。
  - 已完成（上下文组装器，行为不变）：`prepareModelContext` 从 `app.ts` 的内联闭包拆到 `context-assembler.ts`。按 agent 分流（dreaming 只看最近一批、文本 Skill 只看本次调用、自动整理只看当前用户消息、其他 agent 走八回合选择、主 agent 走主流程）由 `routeModelContext` 负责；主流程 `preparePrimaryContext` 是「引用前缀 → 八回合选择或压缩 → 两条放置规则（当前记忆引用放在当前用户消息前、前台任务引用只在原请求被裁掉时追加）」。引用前缀由 `createReferenceAssembler` 从来源列表组装：来源按给定顺序依次收集（读取与模型调用顺序不变），输出按固定槽位顺序（时间与任务、恢复观察、checkpoint、检索记忆、记忆画像、学到的技能、当前 WorkTask、前台任务），与原来一致；每个槽位只属于一个来源，重复认领在装配时报错；任一来源出错整次准备失败，不跳过。来源：`context-sources.ts`（时间、checkpoint/恢复观察、学到的技能、WorkTask、前台任务）和 `memory-reference-source.ts`（检索记忆与画像共用预算，合成一个来源，semantic 缓存在来源内）。记忆引用快照、学到的技能快照和准备诊断仍由 app 持有，组装器通过回调发布。`RuntimeExtension` 没有新增上下文字段（第 4 步需要组合时再加）；task worker 进程自己的分流未动。`app.ts` 1521 → 1390 行。
  - A2 方向（已确认）：模块从「一包工具」改成自带完整声明的扩展（工具、指令片段、权限事实、能力清单、命令、上下文来源），宿主只汇总，`app.ts`、`tool-confirmation.ts`、`capability-status.ts` 不再按工具名写死；模块只声明事实（授权范围取自哪个参数、确认卡内容、内置默认），判定规则不变。不设信任等级（现在只有内置模块）；以后接 MCP 时由 MCP 扩展把外部工具一律声明为每次确认、不可记住。内置模块不做成 MCP（副作用语义、宿主耦合、进程成本），工具描述与 MCP 的只读/幂等提示可直接对应。不改配置格式；verifier 读取 `shell_exec`/`write_file` 证据的部分不动。
  - 已完成（A2 第 1 步）：`permission-decisions.test.ts` 用改造前的代码生成权限判定快照 `permission-decisions.snapshot.ts`（47 个工具 × 普通/Docker/自主执行/Telegram/Run 文件授权/配置文件授权/Shell 授权/网页授权/拒绝搜索后/记住后/整理 agent 等情形，记录放行、拒绝或确认，是否提供「记住」及文案，普通情形含确认卡文本；另含 `/authorize*` 命令注册组合）。之后每迁一个模块，表必须完全一致；只有确认过的规则变更才允许重新生成。
  - 已完成（A2 第 2 步）：`ModuleContext` 增加 `registerTool(tool, permission?)`（权限事实：授权范围取自哪个参数的网页来源、可按范围记住、可被 `/authorize-web` 按来源授权、拒绝后本 Run 连带拒绝哪些工具）、`addInstructions`、`isAssembled`；`ModuleHost` 汇总出 `toolPermissions`、`toolModules`（工具归属）、`instructions(moduleId)`。web 模块先迁：指令片段从 `app.ts` 原样搬入模块（8 种配置组合下与迁移前逐字一致），`web_fetch`/`web_search` 的来源授权、记住、拒绝连锁改由模块声明，`tool-confirmation.ts` 不再出现 `web_*`/`feed_*` 名字，`/authorize-web` 按是否有工具声明来源授权来注册；`capability-status.ts` 改为按工具的注册归属分组，不再按名字前缀。权限快照不变。
  - A2 第 3 步（逐个模块迁移，每个模块单独验证、单独提交；权限快照保持不变，指令文本与迁移前逐字一致）：
    - 番茄钟：权限事实新增 `defaults.approval: "auto"`（任何 agent 都不需 y/n），`tool-confirmation.ts` 的番茄钟名单删除；指令片段移入模块。
    - 文件：工具声明 `scope: workspacePath/path`、`runAuthorization: "scope"`（`/authorize` 与配置 `fileAuthorizations` 只认声明了路径授权的工具）、`autonomy: "allow"`（自主执行时放行）、写/改按目录记住（`remember: "scope"`），以及 read/write/edit 的确认卡内容；`RUN_AUTHORIZED_FILE_TOOLS` 移到文件模块（配置格式仍用它校验），`createPermissionExtension` 去掉 `fileToolsEnabled`，`/authorize` 按声明注册；web 的 `runAuthorization` 统一为 `"scope"`；指令片段移入模块。唯一可见差异：`/authorize` 填错工具名时提示里的工具顺序改为注册顺序（read_file, list_directory, search_files, write_file, edit_file），已加测试锁定。
    - Shell + 命令配方：`confirmation` 声明改为完整确认卡（可异步，与 app 自定义卡同一约定），文件卡随之调整；`addInstructions` 增加函数形式 `({ autonomous }) => text`，`app.ts` 删除自主执行时对指令的 `replaceAll`，改为分别组装普通/自主两份指令（Shell 主机模式、文件两处措辞由模块自己给出）。`shell_exec` 声明 `remember: "never"`、`autonomy: "allow"`，只有 Docker 沙箱执行器声明 `runAuthorization: "tool"`（`/authorize-shell` 的放行与拒绝据此判断，`shellSandboxMode` 选项删除），Shell 确认卡移入模块；配方工具声明 `remember: "never"`，配方确认卡从 `app.ts` 移入配方模块并补了测试（之前没有）；Shell、配方指令移入模块。权限快照不变（快照测试里去掉配方卡，因为它原本来自 app 自定义卡、从未被快照覆盖）。仍留在宿主：开发任务那段（文件或 Shell 任一装配时出现）。
    - 电脑操作：三个工具声明 `remember: "never"`（`tool-confirmation.ts` 删除 `computer_` 前缀），`computer_check` 确认卡与指令片段从 `app.ts` 移入模块。权限快照不变。
    - 补正：`app.ts` 的自定义确认卡还覆盖了 `shell_exec`、`web_fetch`、`feed_read`、`web_search`（以及后面要迁的 Todoist、记忆、任务、checkpoint）。这几张卡移入 Shell、web 模块；Shell 模块之前搬的是 `tool-confirmation.ts` 内部的备用卡（实际运行时被 app 卡覆盖、用户看不到），现在改为 app 卡，备用卡删除。权限快照只有 `plain-host`/`plain-docker | shell_exec` 两行的卡片文本变成了 app 实际显示的卡片，判定没有变化。
    - 记忆：全部 `memory_` 工具声明 `remember: "never"`（`tool-confirmation.ts` 删除 `memory_` 前缀）；权限事实新增 `defaults.approvalAgents`（列出的 agent 调用时不需 y/n），`memory_prepare_consolidation`、`memory_stage_candidates` 声明 `[AUTO_CONSOLIDATION_AGENT_ID]`，`tool-confirmation.ts` 的自动整理名单删除。记忆确认卡（候选预览、当前条目及线程作用域检查、通用卡）从 `app.ts` 移入模块，模块新增 `writePolicy`、`workspaceRoot` 选项；指令片段移入模块（`memory-instructions.ts`，整理提示词与主 agent 指令共用的提案规则也在这里），逐字比对一致。`app.ts` 两处按 `memory_` 前缀过滤工具名改为按注册归属判断。唯一可见差异：「In automatic memory mode, briefly acknowledge…」这句之前不论是否装配记忆都在指令里，现在只在装配记忆模块时出现，位置移到记忆段开头。权限快照不变。
    - checkpoint：三个 `checkpoint_` 工具的确认卡从 `app.ts` 移入模块（模块新增 `workspaceRoot` 选项），指令片段移入模块，逐字比对一致。没有权限默认值（判定规则不变），权限快照不变。CLI 的 checkpoint 确认测试改为断言模块卡片（测试夹具之前只拿到通用卡）。
    - 任务：安排/提醒确认卡（`task_create`/`task_repeat_create` 带 arrangement 时、提醒的取消/暂停/恢复/停止、改期）从 `app.ts` 移入模块，模块新增 `automationStatus`（后台服务状态，`app.ts` 用 `taskAutomation.status` 提供）、`arrangementDestination`、`schedulableSkills`（已注册的文本 Skill，用于指令里的可定时 Skill 列表）选项；卡片时钟改用模块已有的 `speechClock`（`app.ts` 未传 `now`/`timeZone`，与原 `reminderClock` 相同）。两段指令移入模块，三种 Skill 组合逐字比对一致。没有权限默认值，权限快照不变（任务模块只声明读存储的卡片，不放进测试用的内置声明）。
  - 调整：群聊 bot 开线时间从「第 3 步完成后」推迟到「个人 agent 重构完成、日常稳定后（至少 4.5 之后）」，见 §4.2。A1–A3 仍按原步骤验收。

## 4.2 未来：群聊 bot（独立线）

主线只做「我自己在本机用的助手」。群聊 bot 以后另开一条线，做成独立实例：自己的进程、home 和数据，只用「聊天 + 网页读取」这类扩展，与私人助手不共享记忆、文件或凭据。说话人建模、访客权限、群消息处理、事实归属都只在那条线里做，主线不为它加字段或分支判断。

那条线等个人 agent 重构完成、日常使用稳定后再开（至少在第 4.5 步之后：bot 实例怎样独立存放数据取决于 home 的设计），依赖 `packages/assistant` 的公开接口，形态是新应用（如 `apps/group-bot`）加自己的长期分支。在此之前主线只按下面的 A1–A3 保留边界，不为它做别的工作。

主线为它保留的边界（作为验收标准，用测试保证）：

- A1（第 3 步）助理核心可多次组装、无全局状态：数据目录、模型、扩展列表全部由装配方传入，不写死单例或 `~/.serika`。测试：同一进程两个实例，数据互不可见。
- A2（第 3 步）工具全部是可选扩展：未装配的工具不加载、不注册，而不是加载后靠权限拦截。
- A3（第 4.5 步）home 路径可配置（`--home` / `SERIKA_HOME`），默认 `~/.serika`。

## 4.3 Shell 沙箱（第 4.5 步）

现状：Shell 有 host（逐条确认）和 Docker 沙箱两种模式；桌面/Telegram 自主执行只在未配 Docker 沙箱时可用，即自主执行时命令不经确认直接在本机运行。

目标：

- 使用系统级沙箱（macOS Seatbelt `sandbox-exec`，Linux bubblewrap），不依赖 Docker：只能写授权目录（与 4.5 的授权目录列表同一份配置），拒绝读取 `~/.ssh`、钥匙串、浏览器数据等敏感位置，默认不联网、按域名放行。
- 规则反转：自主执行必须在沙箱里运行。逐条确认的 host 模式保留。
- 沙箱只管 Shell。Todoist、Telegram、记忆写入、`web_fetch` 外带数据仍靠审批和域名白名单；Computer 工具继续逐次审批。
- 在此之前：开自主执行时避免读取不熟悉的网页/RSS。

## 5. 度量基线（`c594574`，改名后、移除 durable/postgres 前）

| 指标 | 值 |
|---|---|
| `packages/core` 源码行数 | 约 5.6k（其中 durable 3926） |
| `packages/postgres` 源码行数 | 1832（未被使用） |
| `packages/ai-sdk-adapter/src/loop.ts` | 963 行 |
| `examples/cli` 源码 / 测试行数 | 33.5k / 41.4k |
| `apps/desktop` 源码 / 测试行数 | 18.0k / 13.3k |
| `assistant-controller.ts` / `app.ts` / `memory-store.ts` | 1849 / 1657 / 2003 行 |
| `App.tsx` | 1324 行，65 个 `useState` |
| 桌面端深度引用 `example-cli/dist` 模块数 | 45 |
| README.md / AGENTS.md | 55 KB / 58 KB |
| 测试 | runtime 1730（20 跳过）；desktop 641 + 12（1 跳过） |
