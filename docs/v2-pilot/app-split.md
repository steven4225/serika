# 拆 App.tsx（第 3 步收尾）

`App.tsx` 没有真正渲染它的测试，只有 9 个测试文件读它的源码文本做断言。所以每一步都用
`apps/desktop/scripts/ui-snapshots/` 做前后对比：100 个界面状态 + 18 个脚本化流程状态的归一化 DOM，
以及流程里 App 调用每个接口的顺序和参数。读源码的测试改用 `readAppSource()`（App.tsx 加 `app/` 下拆出的文件），断言内容不改。

| 提交 | 内容 | App.tsx 行数 |
| --- | --- | --- |
| `20019b5` | 顶层 4 块（消息行、身份信息、Home 面板、命令错误）搬到 `renderer/src/app/` | 1310 → 1121 |
| `f17dd39` | `useSplitLayout`、`useThreadList` | 1121 → 1084 |
| `d7f0ec6` | 补流程验证：`flows.mjs`（拒绝、停止、推送事件与 Shell 输出、失败结果、补充要求、切换对话、连接失败与恢复、执行记录），`zcode-preview.tsx` 的 `?lifecycle` 入口 | 不变 |
| 本提交 | 执行记录：`useRunRecords`（列表、打开的记录、追踪刷新、请求计数和定时器）。hook 本身不声明副作用；记录页加载副作用和订阅清理仍在 App.tsx 原位置，改调 `reloadOpen` / `invalidate` | 1084 → 1038 |

接下来按领域拆：补充要求、审批、输入框与发送；消息订阅只负责分发。hook 在原来声明副作用的位置调用，保持副作用顺序。
