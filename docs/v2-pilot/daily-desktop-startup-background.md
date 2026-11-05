# 日用回归：桌面启动与后台交付

目标：重开桌面后，操作入口等待启动读取结束；后台安排从创建到已读使用同一版本、同一实例验证。独立分支 `codex/desktop-startup-settlement` 基于 `main` 的 `fcee6ed`，与 TG 指引 PR #211 分开交付。

## 1. 改了什么

- `app/runtime-store.ts`：启动先发布 info、草稿，末尾才执行 Home，原先中间 idle 会开放操作。增加 renderer 的 `initializing`，整条启动读取 settled 后释放；错误仍显示，不把读取结束当作成功。records 读取后检查取消，防止已销毁页面向新会话发送 Home。
- `App.tsx`：复用 busy 控制会话、任务和设置；发送、输入框、brief continuation 等到初始化结束，显示正在连接。未改变 Controller 状态、工具权限、批准或重试。
- `rss.tsx`：GUI 创建 RSS 排期时，Chromium 报 UTC 偏移 pattern 的 `[+-]` 在 Unicode v 模式无效；转义连字符，恢复原定格式校验。该失败来自真实 Electron 日志，完整后台流程因零错误检查判失败，未放行该报错。
- 按 Fix Root Causes 修正入口开放时机；按 Prove It Works 回到真实 Electron 验证。比较过延迟草稿、移动 Home，两者不能覆盖全部操作入口。

## 2. 逐条对照验收项

| 项目 | 结果与边界 |
| --- | --- |
| 初始化期间不开放操作 | 已做，两条回归先红后绿；真实 Electron 待验证。 |
| 初始化失败及页面销毁 | 已做，Home 抛错保持错误并解锁；旧页面不能迟到调用 Home、不能释放新页面初始化门。 |
| 后台完整单次闭环 | 待在新隔离实例通过创建入口、完整退出、独立 worker、重开和按钮已读验证。 |
| 真实 TG／收费模型、真实系统通知、日用切换 | 未做，沿用独立授权边界；不关闭完整 issue。 |

## 3. 前后数字

产品 3 文件 `+17/-10`，测试 1 文件 `+38/-1`。两条测试需要完整控制启动 Home、records 延迟、错误和销毁，故测试行数超过产品。既有初始化对象断言仅追加 `initializing: true`，其余期望保留。

## 4. 实际命令和退出码

macOS arm64，新建临时 home，脚本模型，真实模型和 TG 调用均 0。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @serika/desktop exec tsx --test --test-name-pattern='startup settlement|disposed startup' src/renderer/src/runtime-store.test.ts` | 修复前 1，0/2；修复后 0，2/2。 |
| 同文件完整测试 | 0，45/45。 |
| `pnpm build:runtime`；`pnpm --filter @serika/desktop build`；`pnpm typecheck` | 各 0。 |
| 全套、官方 Electron 和单次后台验证 | 待完成。 |

## 5. 与计划不符的地方及理由

- 新 worktree 首次 desktop typecheck 缺 workspace 构建声明而失败；构建后根 typecheck 通过，未修改源码掩盖环境缺失。
- 本轮只处理已复现的桌面启动与后台验证。TG 能力指引继续保留在独立 PR；真实外部验收未运行。原始日志、截图和隔离配置不进入产品 PR。
