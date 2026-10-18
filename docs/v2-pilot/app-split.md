# 拆 App.tsx（第 3 步收尾）

`App.tsx` 没有真正渲染它的测试，只有 9 个测试文件读它的源码文本做断言。所以每一步都用
`apps/desktop/scripts/ui-snapshots/` 做前后对比：100 个界面状态 + 18 个脚本化流程状态的归一化 DOM，
以及流程里 App 调用每个接口的顺序和参数。读源码的测试改用 `readAppSource()`（App.tsx 加 `app/` 下拆出的文件），断言内容不改。

| 提交 | 内容 | App.tsx 行数 |
| --- | --- | --- |
| `20019b5` | 顶层 4 块（消息行、身份信息、Home 面板、命令错误）搬到 `renderer/src/app/` | 1310 → 1121 |
| `f17dd39` | `useSplitLayout`、`useThreadList` | 1121 → 1084 |
| `d7f0ec6` | 补流程验证：`flows.mjs`（拒绝、停止、推送事件与 Shell 输出、失败结果、补充要求、切换对话、连接失败与恢复、执行记录），`zcode-preview.tsx` 的 `?lifecycle` 入口 | 不变 |
| `a88a945` | 执行记录：`useRunRecords`（列表、打开的记录、追踪刷新、请求计数和定时器）。hook 本身不声明副作用；记录页加载副作用和订阅清理仍在 App.tsx 原位置，改调 `reloadOpen` / `invalidate` | 1084 → 1038 |
| `fa6c297` | 补充要求：`useSteerReceipts`（回执列表与 ref 同步、待核对补充），`steerReview`（核对接收状态、保留草稿结束核对）、`UncertainSteerNotice`。`flows.mjs` 补两个流程：核对查不到回执 → 本轮结束 → 保留草稿结束核对；核对查到回执 | 1038 → 992 |
| `eb2366c` | 审批：`useApproval`（待确认调用、移动端收起看板的副作用、允许/拒绝）。在 `error` 声明后调用，原位置到这里之间没有副作用 | 992 → 973 |
| `eb9b325` | 输入框：`useConversationDraftState` + `useConversationDraftPersistence`（草稿状态；保存副作用仍在原位置调用）、`useChatAttachments`（附件与切换对话时清空的副作用）、`useBriefContinue`（从手札继续的副作用）。`submit` 留在 App.tsx：`steer-status.test.ts` 按 `const submit = useCallback` … `const busy = state.kind` 截取源码，两处须在同一文件里相邻。`flows.mjs` 补两个流程：从手札继续、带附件发送失败后恢复到草稿 | 973 → 917 |
| 本提交 | 消息订阅只分发：`usePrimaryRun`（实时行、结果行、最终回执、当前 run id、Shell 缓冲；内含 `useSteerReceipts`），按消息类型提供 `onRunState` / `onRunEvent` / `onRunSteer` / `onRunShellProgress` / `isCurrentPrimaryResult` / `finishPrimaryRun`；附件部分是 `settleSentAttachments`。订阅里每个 case 只剩一到几行调用 | 917 → 836 |

按领域拆分到此完成。App.tsx 剩下：启动顺序（订阅、读信息与草稿、快照、历史、记录）、历史读取、`submit`（测试要求与 `const busy` 相邻）、导航/切换对话的小函数和 JSX。
