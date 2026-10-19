# 桌面端运行时状态收敛到 store（D1 设计说明）

范围：`apps/desktop/src/renderer/src/App.tsx` 的 `AssistantPage`，以及从它拆出去的 `app/` 下的 hook。
目标：把「主进程推来的运行时状态」放进组件之外、由消息订阅驱动的 store，`App.tsx` 只读取；组件里只留界面状态。
行号以 `b84e3e2` 为准（`App.tsx` 在 `c204d60` 之后没有改动）。

## 1. 现状

- `App.tsx` 835 行，33 个 `useState`：外层 `App` 4 个（身份代次、初始设置、外观），`AssistantPage` 29 个。
  拆出去的 hook 里还有：`usePrimaryRun` 4 个 + `useSteerReceipts` 2 个、`useApproval` 2 个、`useRunRecords` 3 个、
  `useThreadList` 3 个、草稿 5 个、附件 2 个、分栏布局 3 个。
- 消息订阅在 `AssistantPage` 的一个 `useEffect` 里（232–301 行）：按消息类型分发到 10 来个 setter 和 hook 回调；
  同一个 effect 里还有启动顺序（303–350 行）：订阅 → 读信息 → 读草稿 → 运行时恢复提示 → 通知结果路由 →
  快照两次 → 最终回执 → 历史 → 再取快照恢复补充要求状态 → 执行记录 → Home。
- 防过期靠闭包里的 `cancelled`、`historyRequest` 计数器、`latestPrimaryId` 这类 ref；身份变化时外层 `App` 用
  `key={identityGeneration}` 整个重挂 `AssistantPage`，这些状态随之丢弃。

## 2. 分类

切分规则：第一批只搬「只被消息、快照或启动读取写入，界面动作不写」的状态，一次搬完；消息和界面混写的状态不进第一批。

| 第一批（第 1 步） | 后续步骤 | 不进第一批，归属另定 | 留在组件（界面） |
| --- | --- | --- | --- |
| `state`、`output`、`approval`、`homeSnapshot`、`info`、`memoryRefresh`、`contextRefresh`、`taskRefresh` | 当前这轮（第 2 步）：`live`、`lastResult`、`canSteer`、`finalRecord`、`latestPrimaryId`、`latestCompletedPrimaryId`、Shell 缓冲 | `error`：消息和界面动作都写（`setError` 在 `App.tsx` 里有几十处） | `mobileDashboard`、`detailsOpen`、`detailTab`、`settingsRoute`、`searchOpen`、`showOutput` |
| | 补充要求（第 2 步）：回执列表、`uncertainSteer`（`submit` 也写，441/447/462 行） | `automationRefresh`：界面也写（657、791 行） | `unreadOutput`、`awayFromLatest`、`taskFocused`、`taskResultFocus` |
| | 历史（第 3 步）：`storedHistory`、`historyBefore`、`historyLoading`、`historyMessages`、`historyRequest` | `reconnecting`：只由界面上的重新连接动作写（523–526 行） | 新建任务：`creatingTask`、`createTaskRequest`、`taskDraft` |
| | 执行记录（第 3 步）：列表、打开的记录、追踪定位、请求计数和定时器 | | `useApproval` 里的 `decidingId`（确认按钮的进行中状态） |
| | 对话列表（第 3 步）：`threads`、`conversationTitle` | | 草稿、附件、分栏布局（输入框和窗口的状态，有自己的持久化，不在本次范围） |
| | 进行中的动作：`sending`、`submittedInput`、`switchingThread` | | 滚动位置相关的 ref |

- `canSteer` 不进第一批：结果消息（276 行）和启动时的快照（341 行）都写它，它属于当前这轮，跟 `usePrimaryRun` 一起在第 2 步搬。
- 第 2 步：`createRuntimeStore({ bridge: () => window.runloom, onError: setError })`。bridge 在调用时才读 `window.runloom`（和原来内联代码一样）；`error` 仍不在 store 里，最终回执读取失败的提示经 `onError` 交给 `App` 的 `setError`，文案不变。`latestPrimaryId`、`latestCompletedPrimaryId`、Shell 缓冲是 store 内部的普通字段，`App` 用访问器读（`runtime.latestPrimaryId()` 等）。
- `approval` 进 store；`decidingId` 和防重复点击的 ref 留在 `useApproval`，`decide` 改为从 store 读 `approval`。
- 已知接缝：`applySnapshot`（178–183 行）同时写 `state` / `approval` / `output` 和当前这轮的快照（`applyRunSnapshot`）。当前这轮归第 2 步，所以第 1 步里 `applySnapshot` 仍是一个函数：内部写 store，再调 `applyRunSnapshot`。第 2 步起 `applySnapshot` 只是 store 的一个方法，一次写完这些字段、只通知一次。
- 第 1 步做完，`AssistantPage` 里的运行时 `useState` 从 29 个降到 22 个（另加 1 个只持有 store 实例），`useApproval` 从 2 个降到 1 个。

## 3. 方案

```ts
// renderer/src/app/runtime-store.ts
interface RuntimeStore {
  getState(): RuntimeState;                 // 不可变快照，每次变化换一个新对象
  subscribe(listener: () => void): () => void;
  receive(message: MainToRenderer): void;   // 现在 onMessage 的 switch，逐 case 搬过来
  start(): Promise<void>;                    // 现在的启动顺序，原样搬过来
  dispose(): void;                           // 现在 effect 的清理：cancelled、historyRequest+1、invalidateRecords、取消订阅
  // 动作：reloadHistory、loadOlderHistory、loadRecords、openRecord、decide、setError …
}
function useRuntime<T>(select: (state: RuntimeState) => T): T; // useSyncExternalStore
```

- 用 React 自带的 `useSyncExternalStore` + 手写的小 store（几十行），不引入 zustand 一类的库。理由：不加依赖，而且需求很小（一个快照对象、订阅、按消息改值）。
- 每个 `AssistantPage` 挂载时建一个 store、卸载时 `dispose`。身份变化仍由外层 `App` 用 `key` 重挂，所以「换身份就丢掉全部运行时状态」不变。
- `window.runloom` 作为参数传进 store，单元测试给一个假的 bridge，不用渲染组件就能测每种消息怎么改状态（`App.tsx` 现在没有渲染测试，只有读源码的测试）。
- 有副作用的读取（历史、执行记录、最终回执、补充要求状态的快照、通知结果路由）变成 store 的动作，带着现在的防过期判断一起搬。
- 界面上的副作用留在组件：新审批到来时收起移动端看板、滚动跟随、输入框聚焦。组件从 store 读值后照旧用 `useEffect` 处理。

## 4. 必须保持的

- **启动顺序和接口调用顺序**：`flows.mjs` 记录了 App 调用每个接口的顺序和参数（`calls-*.txt`），每一步都比对。
  - 有依赖的调用（后一个用到前一个的结果，或必须等前一个完成，例如 `start()` 里按 `await` 串起来的启动顺序）先后必须保持。
  - 互不依赖的调用可以换序，但要在提交说明里逐条列出：哪个流程、哪两个调用、为什么换序，并写明原始行为（真实 Electron 里原来的顺序）是否实测过。
  - 页面（HTML 快照）必须一致。
  - 换序的来源：store 的更新经 `useSyncExternalStore` 以同步优先级渲染，依赖 store 字段的 effect 可能比原来走 `setState` 时更早触发。预览里的假接口立即返回，换序在预览里能看到；真实 Electron 里接口要走 IPC，原来的顺序未实测。
- **消息处理顺序**：一条消息里多个状态的更新，现在 React 会合并成一次渲染；搬进 store 后是一次 `receive` 里同步改完、只通知一次。最终状态相同，中间不会多出可见的状态。
- **防过期**：`historyRequest` 计数（新的一轮被接收时 +1、卸载时 +1）、`latestPrimaryId` / `latestCompletedPrimaryId` 的比较、执行记录的请求计数，全部原样搬进 store，用普通字段代替 ref，语义相同（ref 本来就是同步读写的）。
- **补充要求**：回执列表和 ref 同步、草稿里带出的待核对补充要求、`canSteer` 只在快照确认后为 true，都不变。
- **读源码的测试**（9 个，用 `readAppSource()`）：`steer-status.test.ts` 按 `const submit = useCallback` … `const busy = state.kind` 截取源码，所以 `submit` 和 `const busy = state.kind !== "idle"` 要留在 `App.tsx` 里相邻，`state` 这个名字也要保留（从 store 读出来叫 `state`）；其余测试匹配的是 JSX 文案和属性（`openSettings("advanced")`、「停止记忆整理」、`<SavedTaskNotice key=…>` 等），JSX 不动就不受影响。
- **过渡态**：1b–1d 之间允许同一条消息的处理既写 store、又调原来的 hook，提交说明写清楚哪些 case 是这样。1b 开工前用 React 19.3 实测过（生产和开发构建、store 先写或 hook 先写、在 setTimeout / message 事件 / await 之后触发）：同一个回调里的 `useSyncExternalStore` 更新和 `setState` 合并成一次提交，不会多出中间渲染，所以过渡态不需要额外处理。
- **双写期一致性断言**：同一字段既由 store 写、又由 App 自己的 `useState` 写的期间（1c 起是三个刷新计数，到 1d 删掉双写为止），`app/dual-write-check.ts` 在开发构建里每次提交后比较两边的值，不一致就 `console.error("[runtime-store] dual-write mismatch …")`，不抛错、不影响界面。每次截图验收同时收集浏览器 console 错误，这一类必须为 0。1d 删双写时一起删掉（已删，第 1 步之后没有双写字段）。
- 用户可见文案、顺序、截图都不变：每一步跑 UI 截图对比（138 项）。

## 5. 分步（每个提交都跑 typecheck / test:runtime / desktop test、截图对比和流程调用顺序，单独推送）

| 步 | 内容 | 估算 |
| --- | --- | --- |
| 1a | 只新增 store 模块（`app/runtime-store.ts`）+ 单元测试（假 bridge），不改 `App.tsx`。desktop 的测试 glob 不含 `app/`，测试文件放在 `src/renderer/src/` 下 | 1～1.5 天（1a–1d 合计） |
| 1b | `state`、`output`、`approval` 一起搬；`applySnapshot` 保持一个函数（内部写 store 并调 `applyRunSnapshot`），不拆到两个提交里；`decidingId` 留在 `useApproval`，`decide` 从 store 读 `approval`。风险最大，单独验收 | |
| 1c | `homeSnapshot`、`info` | |
| 1d | `memoryRefresh`、`contextRefresh`、`taskRefresh` | |
| 2 | 当前这轮 + 补充要求（`usePrimaryRun`、`useSteerReceipts` 变成 store 的一部分） | 1.5 天 |
| 3 前 | 补 `edit_file` / `write_file` 预览的金样例，覆盖两条路径：历史（`rowsFromHistory` + `annotateHistoryTools`）和运行事件（`applyEvent`，第 2 步起由 `app/runtime-store.ts` 的 `onRunEvent` 调用，原来在 `primary-run.ts`）。原来 `fileChange` 只在 `conversation.test.ts`、`personal-conversation.test.ts` 里各出现 1 次。已补 `tool-preview-golden.test.ts`：同一次调用分别走运行事件（经 store）和历史两条路径，除 `key`、`historical` 外逐字段相等、三种布局的 HTML 只差「本次调用 / 历史记录」；已知差异（宿主拒绝或输入无效时，运行中 `detail` 只有 message 且带 `errorCode`，历史里 `detail` 是 `CODE: message`、没有 `errorCode`）按现状写进用例，未改。第 3 步开工前请审查者确认覆盖范围 | 含在第 3 步内 |
| 3 | 历史读取、执行记录、对话列表（带各自的请求计数） | 2～2.5 天 |
| 3 后 | 清理 ZCode 改编代码：计划和文件清单见 `zcode-cleanup.md`。第 3 步做完、审查过之后才动；跟第 4 步谁先谁后到时再定。不在 D1 合计里 | 另估 |
| 4 | 启动顺序搬进 `start()`，`AssistantPage` 的订阅 effect 只剩 `store.start()` / `store.dispose()` | 1.5～2 天 |

合计 6～7.5 天。D 里「拆启动顺序和历史读取」那一项并入第 3、4 步，不再单独做；第 3、4 步的预算给历史读取的防过期判断（`historyRequest` 计数、`latestPrimaryId` / `latestCompletedPrimaryId` 比较、卸载时 +1）留了余量。

## 6. 已决定的

1. 按这个计划做 store；第一批按第 2 节的切分规则一次搬完，拆成 1a–1d 四个提交。
2. 手写 store + `useSyncExternalStore`，不引入库。
3. `error` 不进第一批（消息和界面动作混写）；`automationRefresh`、`reconnecting` 同样不进第一批。它们放到哪一步、界面写入怎么接，到时再定。
4. D 的「拆启动顺序和历史读取」并入第 3、4 步，预算上调到合计 6～7.5 天。
5. 工具标签和图标（`approval.tsx` 的 `TOOL_LABELS` 等）这次不动。
