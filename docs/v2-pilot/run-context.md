# RunContext 设计说明

范围：`packages/assistant/src/app.ts` 的 `createRuntimeApp`（从第 217 行开始）里那 15 个 `let`。第 1～3 节是盘点和方案，
行号是改动前（`8ec46fe`）的。进度见第 5 节：第一阶段已完成，第二阶段不做。

## 1. 盘点：15 个 `let` 是谁写、谁读、在哪清空

它们分成四类，生命周期不一样，不能一起塞进「每次 Run 一份」的对象里。

### 1.1 装配期（创建 app 时定下来，之后不再按 Run 变化）

| 变量 | 写 | 读 | 清空 | 说明 |
| --- | --- | --- | --- | --- |
| `registeredAutomation`（251） | 654：`automation` 建好后赋值 | 463/465：任务模块 `checkSkillArrangement` 里查 Skill、`prepare` | 不清 | 前向引用：任务模块比 automation 先建，工具调用时才读 |
| `usageEnabled`（307） | 970：`enableExecutionRecords()` 设为 true | 718：`observeModelUsage` 的 `enabled()` | 不清 | 单向开关，和 `executionRecordAdapter.enable()` 同时打开 |
| `redrawAfterModuleNotification`（315） | 1033：`registerNotificationRedraw` | 480：模块通知写出后调用 | 1042 `dispose`、1048 装配失败 | 界面回调，与 Run 无关 |

### 1.2 每次 Run 一份（前台 Run 期间有值，结束时清空）

| 变量 | 写 | 读 | 清空 |
| --- | --- | --- | --- |
| `autonomousRun`（238） | 1018：`beginForegroundExecution` 按入口算：desktop → `desktopAutonomyEnabled`；telegram → 线程匹配且 `telegramAutonomyEnabled()` | 398 每条 shell 命令的超时；673 `primaryInstructions()`（也被压缩器 `fixedContext` 用）；682 `capability_status`；774 前台任务来源；910 catalog 给主 agent 换指令、128 步 / 30 分钟上限 | 1022 `endForegroundExecution` |
| `foregroundEntry`（240） | 1017 | 682/683：有入口时 `capability_status` 报本次 Run 的自主状态和入口，没有时报 `desktopAutonomyEnabled` | 1022 |
| `foregroundTaskRequest`（239） | 1019：自主执行时 `structuredClone(request)`（原始请求，不随补充要求更新） | 774：前台任务来源，原请求被裁掉时才追加 | 1022 |
| `activeWorkTaskMessage`（313） | 977：`workTaskContext.begin` | 770 `workTaskActive`；773 WorkTask 来源；830 跳过记忆来源；836 诊断里的 `workTaskId` | 979：`workTaskContext.end` |
| `currentMemorySource`（314） | 832：主 agent 准备上下文时写 `{ message, signal }` | 425 记忆模块 `getCurrentUserMessage`：`signal` 已中止就返回 undefined（`isExactUserQuote` 的来源校验） | 926：**每一步**、**任何 agent** 的 `prepareModelContext` 开头都先清空 |

### 1.3 续做观测（跨 Run：两次 Run 之间 `/resume` 检查，下一次 Run 消费）

| 变量 | 写 | 读 | 清空 |
| --- | --- | --- | --- |
| `pendingResumeObservation`（659） | 943 `resume.inspect` | 954 `beginRun` 提升为 active | 950 `clear`、955 `beginRun` |
| `activeResumeObservation`（660） | 954 `beginRun` | 663–671 `activeResumeMessage`（checkpoint 来源） | 951 `clear`、959 `endRun` |
| `resumeMismatchReported`（661） | 667：checkpoint 变了，输出一次提示 | 665 | 956 `beginRun` 重置 |

### 1.4 上下文诊断（「最近一次」，Run 结束后还要能读）

| 变量 | 写 | 读 | 清空/置空 |
| --- | --- | --- | --- |
| `memoryReference`（751） | 755 `publishMemoryReference` | 1004 `getMemoryReferences`（复制） | 引用失败、压缩失败时发布 null |
| `learnedSkillReference`（752） | 761 学到的技能来源 `onReference` | 1011 `getLearnedSkillReferences`（复制） | 852/865 置 null |
| `lastUncompactedPreparation`（777） | 846/855 | 995 `getContextDiagnostics` | 不清 |
| `lastPreparationSource`（778） | 872（`finally`） | 992 `getContextDiagnostics` | 840 每次准备开始、989 手动压缩 |

## 2. 现在一次前台 Run 的顺序

`assistant-controller.ts` 和 `controller-work-tasks.ts` 决定了这些 begin/end 的先后，它们**不是同时开始的**：

1. 执行 WorkTask 时：`workTaskContext.begin`（`controller-work-tasks.ts:173`）在提交 Run 之前；提交失败立即 `end`。
2. `resume.beginRun()`（controller 941）在 `executeRun` 之前，`endRun()` 在它的 `finally`。
3. `executeRun` 里：`beginForegroundExecution(entry, message)`（309）→ 返回值交给 `toolConfirmation.beginRun(autonomous, source)`（权限这边自己存一份）。
4. Run 中每一步：适配层先把补充要求（steer）作为 `role: "user"`、`metadata.source: "steer"` 的消息加进去，再调 `prepareModelContext` → 清空 `currentMemorySource` → 主 agent 路由重新取**最后一条用户消息**（补充要求之后就是补充要求那条）。
5. `executeRun` 的 `finally`：`workTaskContext.end`（有 WorkTask 时）→ `toolConfirmation.endRun()` → `endForegroundExecution()`；外层 `finally` 再保险 `workTaskContext.end` 一次。

同一时间只有一个前台 Run（controller 的忙碌互斥）；后台整理、Skill Run 不调 `beginForegroundExecution`，但会经过 `prepareModelContext`，所以也会清空 `currentMemorySource`。

## 3. 方案

### 3.1 不进 RunContext 的

- **装配期**：`registeredAutomation` 换成一个只能赋值一次的延迟引用（或调整装配顺序，让任务模块拿到 automation 的 getter）；`usageEnabled` 改读 `executionRecordAdapter` 自己的开关（它已有 `enable()`）；`redraw` 留在 app 的通知出口。
- **续做观测**：`pending` 跨 Run，留在 app 层；只有 `active` + `mismatchReported` 属于 Run。
- **上下文诊断**：语义是「最近一次」，Run 结束后界面还要读，收进 app 层一个 `ContextObservations` 对象（四个字段 + 现有的复制/发布逻辑），不跟 Run 一起清空。

### 3.2 第一阶段：收拢成一个对象，生命周期一点不变（已完成）

```ts
interface RunState {
  foreground: { entry: "desktop" | "telegram" | undefined; autonomous: boolean; request?: UIMessage } | undefined;
  workTaskMessage: UIMessage | undefined;
  memorySource: { message: UIMessage; signal: AbortSignal } | undefined;
  resume: { observation: ResumeObservation; mismatchReported: boolean } | undefined;
}
```

- app 里只有一个 `const currentRun: RunState`，读的地方全部改成 `currentRun.foreground?.autonomous === true` 这类读取；现有的 begin/end 方法（`beginForegroundExecution`、`workTaskContext.begin/end`、`resume.beginRun/endRun`）**各自只清自己那一段**，调用方和调用时机都不动。
- 这样第 2 节的顺序、提前开始的 WorkTask、跨 Run 的 `pending` 观测都不受影响，对外接口不变。
- 行为变化：应为无。验收：权限快照 `permission-decisions.snapshot.ts`、`apps/desktop/src/main/foreground-autonomy.test.ts`、`modules/memory-module.test.ts`（`isExactUserQuote` 来源）、`steering-controller.test.ts` / `steering-real-acceptance.test.ts`、装配快照全部不改。
- 估算：1～1.5 天。

### 3.3 第二阶段：真正「每次 Run 一份」（用户决定：不做）

由 controller 在 Run 开始时创建 `RunContext`，显式传给 app（`app.beginRun(ctx)` / `app.endRun(ctx)`），结束时整体丢弃。这会改变第 2 节的顺序（WorkTask 要在 Run 创建之前就挂上，resume 的 begin 要并进来），所以要重排 controller，测试要补。估算 3～4 天（与复盘报告的 4～6 天合计一致）。

### 3.4 不管哪个阶段都必须保持的

- **自主执行**：`autonomous` 只在 `beginForegroundExecution` 时算一次；shell 超时、主 agent 指令、步数/时间上限、`capability_status`、前台任务来源都读同一个值；`toolConfirmation` 拿到的是这个函数的返回值，不能出现第二个来源。没有前台入口时 `capability_status` 继续报 `desktopAutonomyEnabled`。
- **记忆来源校验**：`memorySource` 按**步**覆盖，不是按 Run；每一步、任何 agent 先清空；只在记忆开启、写入策略不是 automatic、有用户消息、没有 WorkTask 时写；`signal` 中止后读不到。
- **补充要求（steer）**：RunContext 不碰 steer 本身。补充要求进来后，下一步的记忆来源就是补充要求那条消息（现状如此，不改）；`foreground.request` 仍是原始请求的副本，不随补充要求更新。
- 回执格式、权限快照、记忆存储格式、已落盘路径都不涉及。

## 4. 维护者的决定

1. 只做第一阶段。
2. 后台 Run 的上下文准备也会清空记忆来源：现在前台和后台不会同时跑，所以没有影响。保持现状，用测试 `packages/assistant/src/app-run-state.test.ts` 锁定；要改就是行为变化，另行确认。

## 5. 进度

- 第一阶段完成：`autonomousRun`、`foregroundEntry`、`foregroundTaskRequest`、`activeWorkTaskMessage`、`currentMemorySource`、`activeResumeObservation`、`resumeMismatchReported` 收进 `currentRun`（`RunState`），各自的写入、读取、清空位置不变；`autonomousRun()` 只是读 `currentRun.foreground?.autonomous`。
- 留在原处：`pendingResumeObservation`（跨 Run）、四个上下文诊断变量（「最近一次」）、三个装配期变量。§3.1 里对它们的整理（延迟引用、改读 adapter 开关、`ContextObservations`）没有做，收益小，以后需要时再说。
- 新增测试 `app-run-state.test.ts`：前台记忆写入等确认时，另一个 agent 走一步模型调用，确认后这次写入找不到来源（「没有可绑定的当前用户消息」），什么都不保存。改动前后都通过；去掉 `prepareModelContext` 里的清空后会失败（已验证）。
