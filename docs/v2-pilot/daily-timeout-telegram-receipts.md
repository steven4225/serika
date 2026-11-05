# 日用超时、Telegram 回执与目录授权检修

## 改了什么

基于日用固定源码 `fcee6edf11e526e2b6da90906f5f56aebc3df3ee`，在 `codex/daily-timeout-receipts` 隔离分支修改。按 Fix Root Causes 先复现，按 Prove It Works 验证真实调用路径。已查旧约束的 Trusted desktop foreground autonomy、Compact desktop execution display，以及现行 Tool side-effect invariants。

- `ai-sdk-adapter`、主助手装配：原先模型整段输出受 30 秒绝对时限限制。改为主助手首个有效输出／后续无进展计时，非空文本、推理和工具参数续期；`run.modelTimeoutMs` 默认 30 秒，总 Run、工具与后台预算保留。
- `execution-record-store`、`telegram-run-result`：保存结构化 Run／工具错误码，手机显示明确原因和实际工具回执汇总；未知效果时不显示模型的成功宣称。
- `telegram-directory-authorization`、Gateway、Store：已绑定私聊通过 `/directories`、`授权目录 只读 /绝对路径`、`授权目录 读写 /绝对路径`管理共享目录。实际原卡确认、五分钟有效、身份／Thread／配置／目录绑定、CAS、保存后回读，未知结果不重试。
- `directory-access`、配置解析与保存：用户已明确采用实际绝对路径规则。卡片、保存及后续执行均拒绝权限目录被祖先符号链接重定向，重开配置也拒绝。v2 相对／别名／大小写不规范声明需重新选择；读取不自动修改配置。

## 逐条对照验收项

| 项目 | 实测证据 |
| --- | --- |
| 活跃模型输出超过单次计时仍能完成 | adapter 回归先红 0/2 → 绿 2/2；空片段不续期 |
| 配置确实接入主助手，总预算仍生效 | `uses the configured model inactivity deadline…`，停滞 MODEL_TIMEOUT 80 ms、持续输出 RUN_TIMEOUT 240 ms |
| 超时／拒绝原因跨重开保留 | execution-record-store 19/19，结构化 PATH_OUTSIDE_WORKSPACE 超出预览仍保留，字符串不猜测 |
| TG 已返回失败、成功写回执和效果未知分开 | Gateway recovery 参数用例、formatter；completed Run 内工具错误仍显示原因 |
| 目录卡真实入站到配置保存 | 真实 DesktopRuntime／Store＋假 Telegram API，原卡／拒绝／过期／CAS／权限替换／更深规则／重启／重放；零真实模型与 Telegram 请求 |
| 卡片及共享目录均防止祖先链接重定向 | 卡片／save 先红 0/2 → 绿 2/2；direct／configured 回归先红 0/2 → 绿 2/2，两目录文件 39/39 |
| 32K 与日用大窗口 | 原有假模型 discovery／compaction 套件覆盖 32,768 与 1,000,000；未进行真实模型长输出或真实日用 TG 验收 |
| 实际 Electron／preload／IPC | macOS Electron 44.4.5，最终源码 task-surface 假模型六项通过；完整 smoke 受 clean-source 门槛阻塞 |
| 日用保护 | 所有 guarded 测试无越界写入；resident 自身心跳写入被单独记录，未伪称日用元数据无变化 |

五分钟人工 Demo，待构建切换后在已绑定私聊执行：`/directories` → 为已存在的临时目录发送只读授权命令 → 点原卡 → 收到“已保存并核对” → 再次 `/directories` 核对只读；重复点旧卡不重复写。该流程本轮只做隔离 API 验证，没有向真实 TG 发送。

## 前后数字

相对 `fcee6ed`，产品 TypeScript 14 文件增加 261 行、删除 50 行；测试 TypeScript 24 文件增加 463 行、删除 71 行。测试新增量高于产品代码，是因权限卡需要真实 Runtime／Store／磁盘往返夹具，以及身份、重开、未知保存、祖先链接等持久化边界。未删除测试或更新 golden。

旧断言的已确认改动：Gateway failed／cancelled 文案由“看桌面”改为具体回执；interrupted／unknown 不再期望模型的成功文字；配置相对授权正例改为明确拒绝并验证 canonical 正例，符号链接拒绝消息匹配“重新选择目录”。其余正例只替换目录 fixture 为真实绝对路径，Docker 用相对 `projectDirectory` 保留原沙箱前置条件，业务断言保留。最终全套设 `TMPDIR=/private/tmp`，让新 fixture 从实际绝对路径创建，不使用 macOS `/var` 系统别名。

## 实际命令和退出码

- `pnpm typecheck`：0，最终源码复跑同样为 0；`pnpm build`：0。
- 相关五文件隔离测试：144/144，0；目录两文件 39/39，0；CLI／terminal fixture 三文件 16/16，0；独立只读目录复核 4/4，0。
- `pnpm test`：1，最终运行时 1,258 项中 1,241 通过、10 失败、7 跳过；10 个失败全部在未修改的固定日用 release 实跑复现。
- `pnpm desktop:test`：1，目录规则修改前全套 680 项中 678 通过、2 失败，2 项在固定 release 实跑复现。规则修改后复跑为 677 通过、3 失败，多出一项 Docker fixture 仍依赖相对授权路径；已改用规范权限路径和相对 projectDirectory 保留原断言，定向复跑 1/1、退出 0。没有声称修 fixture 后又跑出全套绿色。
- `pnpm --filter @serika/desktop smoke`：1，构建通过，源码未提交触发 `sourceWorktreeDirty` 必须为 false 的门槛；保留检查，未把它算通过。
- 独立运行 `task-surface-smoke.mjs`：0，最终源码真实 Electron＋脚本模型复跑六项通过、零真实模型调用。
- `git diff --check`：0。

## 与计划不符的地方及理由

- 用户已明确允许本机 checkpoint，接下来从干净源码运行完整 smoke；此前的 dirty-source 拦截保留为历史失败记录。此次授权不包含推送、PR、部署或重启日用进程。
- 全套原有 12 项失败未顺手改业务／断言／golden：任务状态旧预期、continuity、permission soft reject、RSS 未结算、Skill schema／状态、macOS 故障注入、桌面读取批准与提醒旧 golden。失败已逐项在固定 baseline 复现。
- 日用五条授权只读核对有一条仅大小写不规范；新版本切换前须核对并规范这一条。此报告不声称已转换日用配置。
- 保留未知副作用、禁自动重放、后台绝对时限及原工具预算；没有实际扩大日用目录权限、真实模型／Telegram 验收或服务替换。
