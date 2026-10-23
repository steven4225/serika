# 切日用前第 1 轮：TG 续聊与 S02

## 1. 改了什么

在 `experiment/architecture-v2` 从 `86b518a` 实施，仅第 1 轮。用户本轮批准取代旧 S02 延期决定。

| 文件 | 原因 |
|---|---|
| `telegram-gateway.ts`、`telegram-store.ts` | 普通补充先绑定原 Run/稳定 Steer ID 再派发；成功静默；恢复只查精确回执。停止立即取消本私聊 Run，并持久暂停免确认；明确恢复只解除暂停，不创建授权 |
| `app.ts`、Shell 模块、前台指令 | TG 独立身份授权复用桌面同一 Seatbelt runner；删除显式调整的临时 ID 路径。策略、运行时解析器和执行器不变 |
| resident 协议/传输、ownership、snapshot IPC、renderer runtime-store | revision 拦截旧帧；聚焦/可见时同步；generation 防止异步旧快照覆盖当前流，快照补回漏掉的工具状态 |
| TG 设置/共享状态、module-settings | 展示暂停状态、说明沙箱范围，桌面明确授权可恢复；旧设置函数的所有调用者已迁到参数对象 |

频道记录首次写入暂停/Steer 关联时升 v3，旧程序拒绝读取；原 v1/v2 保持可读，读取本身不迁移。resident 传输版本升 2，拒绝无 revision 的旧宿主。没有新权限开关、第二个 runner、服务或执行循环。

## 2. 逐条对照验收项

| 实际变化 vs 批准清单 | 证据与判定 |
|---|---|
| #184 普通消息补充进入同 Run Steer | 已做，`successful ordinary TG Steer...`；原 Run/消息/Steer ID 一致，旧审批不再有效，补充不启动新 Run |
| #184 TG/桌面续聊同步 | 已做，真实本地 socket 测试及 renderer focus/visibility、旧快照竞态测试；同 Thread 历史/终态同步 |
| #185 成功补充和已接受恢复静默 | 已做，`ordinary TG supplements...` 注入已接收后丢确认；恢复无新调用、无额外结果投递。拒绝/未知/未应用保留通知 |
| S02 文件与 Shell | 已做，`independent TG authorization...` 聊天/WorkTask 真工具路径，文件和 Seatbelt 内命令无逐条审批；桌面授权不授予 TG 权限 |
| S02 精确绑定与停止 | 已做，bot/user/private chat/Thread/目录逐项不匹配拒绝；`TG grant survives...` 实际取消未知工具不重放，重启仍暂停；`stop pauses...` 普通“继续”不恢复，陌生人恢复无效 |
| b0 `telegram/shell_exec` | 唯一本轮批准变化：ask/deny → 真实 Seatbelt 执行；`approvals=[]`、completed/ok=true。其余字节与 `86b518a` 完全相同，含既有 desktop 行 |
| S01–S15 其他规则与工具 | Seatbelt 三个产品文件 SHA 不变；原生 checker 对未授权写、敏感读、网络、进程/环境、取消、后端不可用、unknown 等通过；Computer/浏览器/终端/Herdr 没有新增放行 |
| 冻结与范围 | 审计核对原冒烟、检查器、统一验证与权限表 SHA 不变；真实模型 0、真实 TG 外发 0、服务注册 0，费用 $0 |
| 统一验证 | 退出 0；源码 `165b4d823477c2ae43e37c8f60881181c5cdbda2` 干净。UTC 与 Asia/Shanghai 全套、离线 eval、真实 Electron 冻结冒烟 8/8、offline audit 均通过 |

停止说 **“停止”** 或 **`/stop`**；恢复说 **“恢复自主执行”** 或 **`/autonomy_resume`**，也可在桌面 Telegram 设置重新明确授权。暂停期间沿用逐次确认；原 grant 失效时，恢复指令不会创造新授权。

## 3. 前后数字

相对 `86b518a`，产品与测试/验证代码分别按 Git numstat 计算；快照单列，文档/运行证据不算代码。详见 audit `lineChanges`。

| 类别 | 新增 | 删除 | 净行数 |
|---|---:|---:|---:|
| 产品 | +190 | -49 | +141 |
| 测试/验证 | +288 | -19 | +269 |
| b0 快照，单列 | +4 | -10 | -6 |

没有删除测试文件。测试/验证新增超过产品，是实际 socket/浏览器生命周期 fixtures、暂停持久化与不重放故障检查及可重跑审计工具所需。

## 4. 实际命令和退出码

所有测试以显式临时 `--home` 的 wrapper 或脚本执行；子产品实例均使用独立临时 home，未读写 `~/.serika`。

| 实际命令 | 退出码与结果 |
|---|---|
| `node packages/assistant/scripts/v2-round1-verify.mjs --home /private/tmp/serika-s1-round1-final2/H --output /private/tmp/serika-v2-round1/audit-final` | 0，类型检查、TG 真工具路径 6/6、原生 Seatbelt 全过 |
| `/bin/sh -c "pnpm typecheck && pnpm --filter @serika/desktop exec tsx --test src/main/resident-transport.test.ts src/main/ipc.test.ts src/renderer/src/runtime-store.test.ts" --home /private/tmp/serika-v2-round1/final-sync-H` | 0，52/52。`ipc.test.ts` 不存在，tsx 未收集该文件；真正 `ipc-forwards.test.ts` 由统一测试覆盖 |
| renderer 两条回归，修复前产品 | 1，0/2，见 `sync-regressions-red.log` |
| renderer runtime-store 全套，修复后 | 0，42/42，见 `sync-regressions-green.log`；web TypeScript 0 |
| 首轮统一验证，源码 `080d703` | 143，UTC 全套 1771 pass/0 fail/7 skip 后主动终止，整体未通过 |
| `SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-v2-round1/unified-final node packages/assistant/scripts/cm-step6-verify.mjs --home /private/tmp/serika-v2-round1/verify-final-H` | 0，最终统一验证通过 |
| 统一内部 `pnpm typecheck` | 0 |
| 统一内部 `env TZ=UTC pnpm test` | 0，tests=1780, pass=1773, fail=0, skipped=7 |
| 统一内部 `env TZ=Asia/Shanghai pnpm test` | 0，tests=1780, pass=1773, fail=0, skipped=7 |
| 统一内部 `pnpm eval:test` | 0，tests=101, pass=101, fail=0, skipped=0 |
| 统一内部 `git clone --shared --no-checkout . <temporary>/smoke-source` | 0 |
| 统一内部 `git checkout --detach 165b4d823477c2ae43e37c8f60881181c5cdbda2` | 0 |
| 统一内部 `pnpm --filter @serika/desktop smoke` | 0 |
| 统一内部 `node examples/eval/cm-step6-offline-audit.mjs` | 0 |

本轮 [audit.json](evidence/v2-round1/audit/audit.json)、[统一验证](evidence/v2-round1/unified/docs/v2-pilot/evidence/cm-step6/verification.json)、[manifest.json](evidence/v2-round1/manifest.json) 包含运行随机 ID、源码/脚本/输出 SHA。b0 SHA `a5f3059a18ea43c1ff14efb48f09933ef110da00c0e070d31f3870333911852f`；冻结 Electron 冒烟 SHA `03a3c7e6d174842edda61770f8f17b7480e6545ee52ffbda2f63a288d07a6c34`；冻结 live checker SHA `6a5572c3a0a37bb0979e2badcbc3cdbd16cda0849683c716f096a43815de1546`。

## 5. 偏差、出错与限制

- `git diff 86b518a HEAD --check` 对源码退出 0；证据加入后 `git diff --cached --check` 退出 2，仅红测试原始日志第 17/19/36/38 行含 Node 测试框架输出的空白。保留原始字节与 SHA，不清洗日志。统一输出中继承的旧 `live.json` 和 step4/5 记录未重复打包，避免被误认成本轮结果。
- 开发首次类型检查发现新增 mock 参数隐式 any，改用原方法参数类型；同步测试首次假 socket teardown EPIPE，补齐假 peer 的错误处理。修后定向测试通过，未删断言凑绿。
- 最终定向命令误写一个不存在的 IPC 测试路径，已如实列出；统一全套覆盖实际 IPC 测试。最终复核发现同 Run 快照漏补工具状态、普通流事件误取消 Steer 可用状态读取，新增回归复现并修复；初版统一验证结果保留，旧验证在 UTC 全套退出 0 后主动终止，整体退出 143，不能算通过；最终统一验证绑定修正后的干净源码。
- 原 TG 自主测试的 Shell 审批次数 7/1 改为 0/0；停止重启后 enabled=true 改为 paused=true/enabled=false；均属于本轮 S02/停止批准。装配比较仅更新获批的前台 Shell 说明；IPC 两条旧断言从 `current.snapshot` 迁为刷新后的 `host.snapshot`。冻结历史文件不改。
- 实测 macOS/原生 Node 与本地 socket；统一冒烟是真 Electron、原 preload/IPC、离线假模型。没有用户手机实测、真实 TG 网络或真实模型效果结论；Linux 未实测。上下文窗口沿用统一离线回归，没有新真实模型 32K/大窗口测量。
- 查阅旧约束：独立 TG 绑定、桌面记住项不继承、Shell never-remember、Docker 不回退、worker 不继承、unknown 不自动重试与取消。pstack 的领域建模让关联和暂停归现有频道记录；迁完调用者删除旧 API；实物验证要求真实工具/OS/socket 路径；共享状态仅由 resident/TelegramStore 各自串行持有。Karpathy 限制改动于本轮。

推送后停下等审核，不开始第 2 轮、不切日用。
