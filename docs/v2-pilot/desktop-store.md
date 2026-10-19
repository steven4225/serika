# 桌面端运行时状态收敛到 store（D1 设计说明，只写设计，不改代码）

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

| 归 store（运行时，来自主进程消息、快照或接口读取） | 留在组件（界面） |
| --- | --- |
| `info`、`state`、`approval` + `decidingId`、`output`、`homeSnapshot`、`error`、`reconnecting` | `mobileDashboard`、`detailsOpen`、`detailTab`、`settingsRoute`、`searchOpen`、`showOutput` |
| 当前这轮：`live`、`lastResult`、`canSteer`、`finalRecord`、`latestPrimaryId`、`latestCompletedPrimaryId`、Shell 缓冲 | `unreadOutput`、`awayFromLatest`、`taskFocused`、`taskResultFocus` |
| 补充要求：回执列表、待核对的补充要求 | 新建任务：`creatingTask`、`createTaskRequest`、`taskDraft` |
| 历史：`storedHistory`、`historyBefore`、`historyLoading`、`historyMessages`、`historyRequest` | 草稿、附件、分栏布局（它们是输入框和窗口的状态，有自己的持久化，不在本次范围） |
| 执行记录：列表、打开的记录、追踪定位、请求计数和定时器 | 滚动位置相关的 ref |
| 对话列表：`threads`、`conversationTitle` | |
| 刷新计数：`memoryRefresh`、`contextRefresh`、`taskRefresh`、`automationRefresh` | |
| 进行中的动作：`sending`、`submittedInput`、`switchingThread` | |

`AssistantPage` 自己的 `useState` 从 29 个降到 13 个（右列前三行）；拆出去的 hook 里的运行时状态（14 个）也一起搬走。

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

- 不加新依赖：用 React 自带的 `useSyncExternalStore` + 手写的小 store（几十行）。
- 每个 `AssistantPage` 挂载时建一个 store、卸载时 `dispose`。身份变化仍由外层 `App` 用 `key` 重挂，所以「换身份就丢掉全部运行时状态」不变。
- `window.runloom` 作为参数传进 store，测试可以直接给一个假的 bridge，不用渲染组件就能测每种消息怎么改状态。这是现在做不到的：`App.tsx` 没有渲染测试，只有读源码的测试。
- 有副作用的读取（历史、执行记录、最终回执、补充要求状态的快照、通知结果路由）变成 store 的动作，带着现在的防过期判断一起搬。
- 界面上的副作用留在组件：新审批到来时收起移动端看板、滚动跟随、输入框聚焦。组件从 store 读值后照旧用 `useEffect` 处理。

## 4. 必须保持的

- **启动顺序和接口调用顺序**：`flows.mjs` 记录了 App 调用每个接口的顺序和参数，作为每一步的验收；`start()` 必须逐行保持现在的顺序。
- **消息处理顺序**：一条消息里多个状态的更新，现在 React 会合并成一次渲染；搬进 store 后是一次 `receive` 里同步改完、只通知一次。最终状态相同，中间不会多出可见的状态。
- **防过期**：`historyRequest` 计数（新的一轮被接收时 +1、卸载时 +1）、`latestPrimaryId` / `latestCompletedPrimaryId` 的比较、执行记录的请求计数，全部原样搬进 store，用普通字段代替 ref，语义相同（ref 本来就是同步读写的）。
- **补充要求**：回执列表和 ref 同步、草稿里带出的待核对补充要求、`canSteer` 只在快照确认后为 true，都不变。
- **读源码的测试**（9 个，用 `readAppSource()`）：`steer-status.test.ts` 按 `const submit = useCallback` … `const busy = state.kind` 截取源码，所以 `submit` 和 `const busy = state.kind !== "idle"` 要留在 `App.tsx` 里相邻，`state` 这个名字也要保留（从 store 读出来叫 `state`）；其余测试匹配的是 JSX 文案和属性（`openSettings("advanced")`、「停止记忆整理」、`<SavedTaskNotice key=…>` 等），JSX 不动就不受影响。
- 用户可见文案、顺序、截图都不变：每一步跑 UI 截图对比（138 项）。

## 5. 分步（每步一个提交，每步都跑截图对比和流程调用顺序）

| 步 | 内容 | 估算 |
| --- | --- | --- |
| 1 | store 外壳 + 只由消息写入的状态：`state`、`output`、`homeSnapshot`、`approval`、刷新计数、`error`；`receive` 先接这些 case，其余 case 仍调原来的 hook | 1 天 |
| 2 | 当前这轮 + 补充要求（`usePrimaryRun`、`useSteerReceipts` 变成 store 的一部分） | 1.5 天 |
| 3 | 历史读取、执行记录、对话列表（带各自的请求计数） | 1.5～2 天 |
| 4 | 启动顺序搬进 `start()`，`AssistantPage` 的订阅 effect 只剩 `store.start()` / `store.dispose()` | 1 天 |

合计 5～6 天。第 3、4 步正好是 D 里「拆启动顺序和历史读取」那一项，建议合并进这个计划，不再单独做。

## 6. 需要维护者决定的

1. 是否按这个计划做；做的话，是否先只做第 1 步看效果。
2. 用手写 store + `useSyncExternalStore`（建议，不加依赖），还是引入 zustand 一类的库。
3. `error` 既被消息写、也被界面动作写：建议放进 store，界面动作通过 `store.setError` 写。
4. 是否把 D 的「拆启动顺序和历史读取」并入第 3、4 步（建议并入）。
