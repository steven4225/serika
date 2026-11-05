# 日用回归：桌面启动与后台交付

目标：重开桌面后，操作入口等待启动读取结束；后台安排从创建到已读使用同一版本、同一实例验证。独立分支 `codex/desktop-startup-settlement` 基于 `main` 的 `fcee6ed`，与 TG 指引 PR #211 分开交付。

## 1. 改了什么

- `app/runtime-store.ts`：启动先发布 info、草稿，末尾才执行 Home，原先中间 idle 会开放操作。增加 renderer 的 `initializing`，整条启动读取结束后释放；错误仍显示。records 读取后检查取消，防止已销毁页面向新会话发送 Home。
- `App.tsx`：复用 busy 控制会话、任务和设置；发送、输入框、brief continuation 等到初始化结束，显示正在连接。初始化不显示停止按钮。Controller 状态、工具权限、批准和重试规则保持原约定。
- `rss.tsx`：真实 Electron 创建 RSS 排期时，Chromium 报 UTC 偏移 pattern 的 `[+-]` 在 Unicode v 模式无效。转义连字符，恢复原定格式校验；未放行该报错。
- 按 Fix Root Causes 修正入口开放时机，按 Prove It Works 核对真实构建和完整回读。延迟草稿、移动 Home 均不能覆盖全部操作入口。

## 2. 逐条对照验收项

| 项目 | 结果与边界 |
| --- | --- |
| 初始化期间不开放操作 | 已做，两条回归先红后绿；真实 Electron 在 32,768 和 1,000,000 窗口各重开 12 次，切换会话并发送一次脚本模型消息，各 12/12，无额外 Run。 |
| 初始化失败及页面销毁 | 已做，Home 抛错保持错误并解锁；旧页面不能迟到调用 Home、不能释放新页面初始化门，见 `startup settlement`、`disposed startup` 两条测试。 |
| 后台完整单次闭环 | 已做，同一隔离实例经真实聊天批准创建一分钟提醒，经 RSS 页面确认订阅及排期，完整退出桌面，独立 worker 等到点执行，重开并逐项点击已读，总计 66.766 秒。提醒、新 RSS、受控次日空 RSS 共 3 个结果回读一致。 |
| 通知失败只重试通知 | 已做，受控通知每项首次失败、第二次提交；提醒与新 RSS 各只有 1 次任务 attempt，worker 模型 Run 始终 1。空 RSS 不调用模型、不通知。3 次已读操作只改变 `acknowledgedAt`，当前磁盘记录逐字段一致。 |
| 真实 TG／收费模型、真实系统通知、launchd、日用切换 | 没做，用户选择“先交本轮 PR，暂不做真实外部验收”。RSS 抓取、模型及通知为受控实现，次日空检查使用受控时钟；提醒及首轮 RSS 使用真实到点时刻。完整 issue 保持未验收状态。 |

五分钟复验入口为隔离 Electron：启动后等“正在连接”结束，切换会话并发送一条消息；聊天创建一分钟提醒并批准，在提醒页确认 RSS 订阅和下一分钟排期；完整关闭桌面，由隔离 worker 执行后重开，查看结果并点已读。前提是测试配置和独立 worker 已备妥；通过标准为单次执行、结果可读、已读不重跑。

## 3. 前后数字

产品 3 文件 `+18/-11`，测试 1 文件 `+38/-1`。两条测试控制 Home、records 延迟、错误和销毁，故测试行数超过产品。既有初始化对象断言仅追加 `initializing: true`，其余期望保留。

原始启动探针在旧版及未修版均观察到切换拒绝；最终同一构建两档各 12 次无拒绝。该次数不证明所有时序均消除。定向测试 46/46；全套 runtime 1,234 通过、10 失败、7 跳过，desktop 663 通过、2 失败。12 个失败均在未修改的 `fcee6ed` 独立复现，最终失败名集合相同，未改旧失败断言或快照。

## 4. 实际命令和退出码

macOS arm64、Electron 44.4.5、原 preload／IPC，新建临时 home。32K 有效输入 26,624；大窗口配置 1,000,000、输入预算 256,000。全部最终 Electron 运行绑定干净产品提交 `106ee17c3d83ea4f56df9b190616484a54692ee5`，后续仅更新本报告。两档重开及后台每次实际加载的前后端 revision、dirty、backend fingerprint 均已核对，源码、脚本、构建和截图 hash 一致，测试进程均已退出。

| 命令 | 退出码与结果 |
| --- | --- |
| `pnpm --filter @serika/desktop exec tsx --test --test-name-pattern='startup settlement|disposed startup' src/renderer/src/runtime-store.test.ts` | 修复前 1，0/2；修复后 0，2/2。 |
| `pnpm --filter @serika/desktop exec tsx --test src/renderer/src/rss.test.ts src/renderer/src/runtime-store.test.ts` | 0，46/46。 |
| `pnpm build:runtime`；`pnpm --filter @serika/desktop build`；`pnpm typecheck` | 各 0。 |
| `pnpm test`；`pnpm --filter @serika/desktop test` | 各 1，分别 10、2 个既有失败；root 命令在 runtime 失败后短路，因此单独跑 desktop。另跑 desktop scripts，0，25/25。 |
| `pnpm --filter @serika/desktop smoke` | 0，真实 Electron＋脚本模型，首组 8 项、任务流程 6 项通过。写入 guard 违规 0，观察到并发日用变化，未宣称日用字节不变。 |
| `TMPDIR=/private/tmp node /private/tmp/serika-startup-native/reopen.mjs <repo> 32768`；同命令参数 `1000000` | 各 0，各 12/12，renderer 错误和警告均 0。 |
| `TMPDIR=/private/tmp node /private/tmp/serika-background-single-run/electron.mjs <repo>` | 0，单实例六阶段通过，renderer 错误和警告均 0。真实模型、TG、OS 通知调用及 launchd 操作均 0。 |

最终证据保留在本机 `desktop-startup-settlement` 验证目录，位于 `/Users/a1-6/.codex/visualizations/2026/11/05/01a1aaf7-9a5c-73d2-80ac-d7521f39021f/`。`final-native-32k`、`final-native-large`、`final-background` 分别保存单次报告及截图；`final-full.json`、`final-desktop.json` 绑定日志 hash，`baseline/comparison.json` 保存基线比较。原始证据不进入产品 PR。远端 CI 查询结果为 `disabled_manually`，没有远端通过结论。

## 5. 与计划不符的地方及理由

- 新 worktree 首次 desktop typecheck 缺 workspace 构建声明而失败；构建后根 typecheck 通过，未修改类型掩盖环境缺失。
- 早期后台脚本曾因 Electron 下载竞争、通知重试按总次数误判及读取隐藏详情失败；各次原始失败保留，修正脚本后均使用新隔离实例重测。另一次完整流程被 RSS 正则报错拦下，随后修复产品。
- 早期脚本未核对实际加载构建，不能据此作最终版本结论。官方冒烟从干净提交重新构建后，增加实际 build 校验，再完整运行两档重开和后台单次闭环；不拼接旧轮通过项。
- 本轮只处理已复现的桌面启动与后台验证。TG 指引保留在独立 PR；真实 Pi 委派、工具链主机路径及真实后台交付仍按原 issue 后续范围处理。未合并、未切换日用。
