# 切日用前第 2 轮：本地终端与已有 Pi

## 1. 改了什么

在 `experiment/architecture-v2` 从已审核的 `68dcda6` 实施第 2 轮，源码提交 `5168b70e63eed98bfe865bc506f67d4ba0625c4d`。

| 文件 | 原因 |
|---|---|
| `terminal-module.ts`、配置、`app.ts` | 新增默认关闭的本地终端能力 `terminal_exec`，复用现有 Shell 执行器，明确为 Seatbelt 外 host 操作。仅桌面宿主 primary 装配，TG primary 共用；每次确认且不可记住，无自主放行声明 |
| `herdr-target.ts`、runtime/ownership、resident/IPC、capabilities/target picker | 用户主动查找已运行会话、选择 pane 与 terminal identity；现有配置锁/CAS、idle/reload/rollback 保存目标。固定 argv 的设置操作只取元数据，不读取终端输出或启动 Herdr |
| `execution-record-store.ts`、`compaction-records.ts`、conversation 展示 | 将新工具接入既有退出码、unknown、命令预览、输出与进度路径；不引入第二个执行器或行为循环，不扩大 WorkTask 自动验收权限 |
| `telegram-gateway.ts` | 停止词忽略边缘空白/中英文标点和英文大小写；绑定提示读实际授权状态，改用“授权目录” |

目标选择是模型的明确上下文，**不是 host Shell 的强制目标隔离**。每条完整命令仍需人工批准。配置必须在授权目录外，target 精确绑定目录，terminal 与 Docker Shell 不共存；关闭终端模块不影响 Seatbelt Shell。没有移植 main 旧压缩器、`toolApproval:skip`、浏览器功能或旧 API。

## 2. 逐条对照验收项

| 实际变化 vs 批准清单 | 证据与判定 |
|---|---|
| #171 本机 CLI 能力 | 已做，`confirmed Telegram terminal calls...` 经真实 RuntimeApp/Controller、逐次审批、真实 Shell 子进程执行离线 CLI；指引使用有界 version/help，成功后停止重复探测 |
| #171 显式 Herdr 目标 | 已做，`lists fixed-argv metadata...` 验证 env/argv 与 target CAS，拒绝替换终端、过期目录、禁用能力、不安全 binary 和伪造参数；`changes the target through the resident socket...` 走真实本地 socket，保存→reload→AppInfo→解除，无模型 Run |
| #177 已运行 Pi | 已做，离线 fake Herdr/Pi 经 get→prompt 一次→get/read，状态序列持久变化并独立核对产物及未改文件。指引覆盖显式 session/pane/terminal、Pi 类型/空闲检查、blocked/stalled/timeout 不重发、生命周期/输出/产物证据；不启动新 Pi 替代旧进程 |
| 方案 A：桌面/TG 每次确认 | 已做，新增 b0 `terminal/desktop/terminal_exec`、`terminal/telegram/terminal_exec`，各连续两卡，remember=null，两次 TOOL_DENIED，host 写哨兵不存在；真实执行夹具每条审批。Herdr 调用同一 `terminal_exec` 权限，没有额外放行路径 |
| 既有 b0 与 Seatbelt | 已做，原 `87` 行值与原始格式保留，仅末尾追加上述两行；Seatbelt 三个产品文件与冻结检查器/冒烟 SHA 完全不变 |
| TG 停止词 | 已做，`whole-message stop variants...` 接受“停”“停下”“停止”“stop”“STOP”和 `/stop` 的边缘空白和标点变体，拒绝句内提及；实际取消并持久暂停原路径不变 |
| TG 绑定提示 | 已做，`binding success describes the current host grant...` 两种实际授权状态分别给出文件/Seatbelt 免确认和其他确认，或工具逐次确认；无“工作区”旧词 |
| 回执与重连/压缩 | 已做，`terminal_exec records request/start/completion...` 保存非零退出码；同名 `projects exact Shell input...` 与 progress snapshot 用例覆盖展示；`terminal_exec restart checklist...` 从真实重开存储保留 unknown 和原命令 |
| 统一验证 | 已做，退出 0；源码干净，UTC/Asia Shanghai 全套、离线 eval、真实 Electron 冻结冒烟 8/8、offline audit 通过 |

停止可说 **“停”／“停下”／“停止”／`stop`／`/stop`**，忽略边缘空白、标点和英文大小写；句子中包含这些词不触发。恢复仍说 **“恢复自主执行”** 或 **`/autonomy_resume`**，也可在桌面重新明确授权；不因停止/恢复扩大原 grant。

## 3. 前后数字

相对 `68dcda6` 的 Git numstat，文档/运行证据不计代码；明细见 audit `lineChanges`。没有删除测试文件。

| 类别 | 新增 | 删除 | 净行数 |
|---|---:|---:|---:|
| 产品 | +265 | -15 | +250 |
| 测试/验证 | +389 | -17 | +372 |
| b0 快照，单列 | +39 | -1 | +38 |

测试/验证新增多于产品，主要用于真实子进程与本地 socket、拒绝副作用、重启 unknown 和现有回执展示的覆盖，以及可重跑的冻结/b0 审计；没有为简单配置字段另加排列组合。

## 4. 实际命令和退出码

所有测试入口显式传临时 `--home`，wrapper/审计向子进程传临时 HOME、SERIKA_HOME、RUNLOOM_HOME；产品实例使用临时目录。完整 argv 与日志 SHA 在 [audit.json](evidence/v2-round2/audit/audit.json) 和 [verification.json](evidence/v2-round2/unified/docs/v2-pilot/evidence/cm-step6/verification.json)。

| 实际命令 | 退出码与结果 |
|---|---|
| `node packages/assistant/scripts/v2-round2-verify.mjs --home /private/tmp/serika-v2-round2-audit2-H --output /private/tmp/serika-v2-round2/audit-final` | 0，类型检查/构建、核心定向 81/81、桌面/TG 定向 148/148 |
| `node /private/tmp/serika-v2-round2-tg-evidence/run.mjs --home <temporary> ...`，TG 回归红→绿→完整 gateway | 1 → 0 → 0；红 3 pass/12 fail，绿 15/15，完整 80/80 |
| `node /private/tmp/serika-v2-round2/run.mjs --home <temporary> /bin/sh -c ...`，root 核心开发测试 | core-tests、core-tests2 退出 1；core-tests3 退出 0，25/25+30/30；core-tests4 退出 0，26/26。完整命令见 [开发记录](evidence/v2-round2/development-commands.md) |
| 首次统一验证，源码 `e4aa769` | 1，UTC runtime 1136 pass/2 fail/7 skip；最终修正前的失败，整体未通过 |
| `SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-v2-round2/unified-final node /private/tmp/serika-v2-round2/run.mjs --home /private/tmp/serika-v2-round2/unified2-H node packages/assistant/scripts/cm-step6-verify.mjs --home /private/tmp/serika-v2-round2/unified2-H` | 0，统一验证通过 |
| 统一内部 `pnpm typecheck` | 0 |
| 统一内部 `env TZ=UTC pnpm test` | 0，tests=1806, pass=1799, fail=0, skipped=7 |
| 统一内部 `env TZ=Asia/Shanghai pnpm test` | 0，tests=1806, pass=1799, fail=0, skipped=7 |
| 统一内部 `pnpm eval:test` | 0，tests=101, pass=101, fail=0, skipped=0 |
| 统一内部 `git clone --shared --no-checkout . <temporary>/smoke-source` | 0 |
| 统一内部 `git checkout --detach 5168b70e63eed98bfe865bc506f67d4ba0625c4d` | 0 |
| 统一内部 `pnpm --filter @serika/desktop smoke` | 0 |
| 统一内部 `node examples/eval/cm-step6-offline-audit.mjs` | 0 |

关键证据 SHA：audit `1144c3e5c63152c00bcf1f187fb50282d48a164563aecbe8124829b37612c88b`；统一验证 JSON `f1db625ea1f75bbbc7251ccc4781ecea89f2cb2ba242db392aefa35077725e8b`；b0 `2011a3a03fdd0d2c9e757526d16866d0c40c52e616c0f5d9ea0efb0fcbbbdc2d`。完整文件/字节/hash 见 [manifest.json](evidence/v2-round2/manifest.json)。

## 5. 偏差、出错与限制

- TG 回归先在旧产品跑红，再修复转绿。桌面初测误用 ListRunsResponse.length、SSR 缺 React import；一次前置修改的相对路径错误未修到 import，随后修正，31/31。schema 命令 cwd 错找不到 tsx，改为 desktop cwd 后 4/4。首个 SSR 失败日志保留；早期 typecheck、扩大 targeted、错误 cwd 的同名日志被成功输出覆盖，失败退出码来自当时工具返回，未补造原日志。
- root 初次 b0 capture 因新增行未写快照退出 1；原快照含旧 Memory 字段，曾直接比较未投影行报错，保留原文件后沿用已有投影。核心初测发现 Docker 负例用绝对路径先触发旧 path guard，改为合法相对路径后验证 terminal/Docker 拒绝；装配比较原断言没有新增默认模块，现明确断言 terminal disabled/无工具，再比较所有旧内容，历史 baseline 文件不改。第二次装配预期漏写 `state:disabled`，补全后通过。
- 首次统一验证在 UTC runtime 全套退出 1，1136 pass/2 fail/7 skip。两处 `tui-module-config` 的旧默认模块表未列入新增的 `terminal:false`；补齐预期后定向配置测试 30/30，再提交干净源码重跑。首次失败 verification JSON 和日志保留。
- 核心开发命令误传不存在的 `compaction-records.test.js`，Node 没收集该路径；最终 audit 明确使用真实 `context-compactor.test.js`，全套统一测试也覆盖它。没有靠删除断言或改旧快照凑绿。
- 源码 `git diff 68dcda6 5168b70 --check` 退出 0；证据加入后 `git diff --cached --check` 退出 2，仅原始失败日志的 40 行框架行尾空白，保留字节与 SHA。具体位置见 package-checks.json，不清洗错误记录。
- 采用最小 main 对等方案 A；host 完整命令可操作本机，Herdr target 依赖明确指引和每次命令审批，没有声称强制限制任意 host 命令。设置页主动元数据发现是用户直接操作，模型读取/输入/停止仍每次审批。无 terminal_exec 的 worker/TUI 装配，无浏览器、整工具免确认、服务注册或自动安装。
- macOS 原生 Node、真实 Shell 子进程与 resident socket 已测；renderer target picker 为 SSR，冻结统一冒烟是真 Electron、原 preload/IPC、离线假模型，未实测新 picker 的真人点击或真实 Herdr/Pi。未运行真实模型、真实 TG 外发、真实服务、日用数据；费用 $0。上下文沿用 32K/大窗口离线回归，未做新真实模型窗口验收，Linux 未实测。
- 查过旧约束的 Shell/Docker never-remember、host/worker 分界、独立 TG 授权、Computer 逐次确认、unknown 不自动重试和取消条目。pstack 领域建模将目标归配置，边界校验在宿主；复用现有执行器和回执；分离共享状态让 root 独占集成、配置锁维持单写。Karpathy 将范围限于本轮；未引入兼容旧路径或死接线。

提交推送后停等审核，不进入第 3 轮、不切日用。
