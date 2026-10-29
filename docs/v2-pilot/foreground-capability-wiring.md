# 普通前台能力接线验收

状态：2026-10-30 本地全测及干净源码 Electron smoke 通过。分支 `codex/foreground-capability-wiring`，基线 `c88682c`。三案已取得真实功能结果，剩余验收缺口见下表；日用未切换，合并由用户操作。

## 1. 改了什么

- `app.ts`、`capability-status.ts`：按实际注册表、当前配置及授权生成能力摘要；普通前台捕获原请求，随当前 Run 结束清除。
- `shell-module.ts`、`terminal-module.ts`：Shell 装配通用 CLI 发现指引，独立于 terminal 开关；保留 Herdr/Pi 固定目标及确认约束。
- `foreground-autonomy.ts`、`context-sources.ts`、`compaction-records.ts`：普通前台任务推进、当前 Run 任务锚及 Shell 回执摘录，批准后沿原 AgentLoop 继续。
- 本轮仅适配 `baseline-assembly.test.ts` 的已批准装配合同，历史快照不变；另归档证据并更新报告。外部 V8 调试器被动观察原 IPC 转发函数，未替换 preload、处理器或授权逻辑。产品 diff SHA-256 仍为 `2a0d623738969dc9b0920ad0fc3f461ccf265c79ec7eefa521db167f4afee84e`；新测试源 SHA-256 仍为 `bebbb9b7ef1672950b2e896347f0cb580aa54ffef337cfbd82b2d92c82d86b94`。

## 2. 逐条对照验收项

| 验收项 | 证据与状态 |
| --- | --- |
| 配置、注册、授权、尚未实查分开 | 已做接线，包含 Shell host/Seatbelt/Docker、terminal、Pi target 和授权状态；health 为 `not_checked`。禁用及未绑定由注册状态和 target 表达。全部配置、授权变化边界测试没做。 |
| 能力块字节稳定、不重复 schema | 已观察首案 4 个 primary 请求均为 1716 字节且同 SHA；最新文件案 6 个样本均为 1715 字节、SHA `4a279456365b4e41b7c6d533d353a3f1186ca9f448ddb18acd8069cbda58ca46`。摘要不含每轮时间戳，后台压缩单列。全部指纹变化边界未验证，不以整个 system 相同作为条件。 |
| terminal 关闭、Shell 仍可 CLI 发现；案 1 查 Pi 版本及帮助 | 真实 Electron、真实模型经 Shell 获得 Pi 1.4.0 与帮助并交付。首案第二张卡审批来源缺记录，不能补造归因。[首案证据](evidence/foreground-capability-wiring/9bcb62ff-e50c-438d-bee2-e28e146f116e.json)。 |
| 缺专用工具后检查其他已授权路径，unknown 停卡 | 指令已接线，权限及 unknown 相关单测通过。缺失软件、替代路径及环境变化复查的真实负例没做；未重放历史 unknown。 |
| 普通 desktop/TG 原任务及修正，结束清除 | 已做，`foreground-wiring.test.ts` 3/3。普通模式没有注入自主免确认或宽文件授权。Steer 及 TG 授权边界相关测试通过。 |
| 压缩保留完成、失败、unknown 及摘录，同 Run 续做 | 单测及脚本化模型的真实工具链已做。32,768 窗口生产遮罩后保留原目标、Host checklist、真实 Shell marker，并继续读产物；1,000,000 同负载未前台遮罩，后台摘要落盘。各工具仅一次，下一 Run 重新确认且不继承锚。真实模型本案未触发压缩。[脚本化验证原始摘要](evidence/foreground-capability-wiring/87548cea-eeda-4540-8551-d169f69e0e29/summary.json)。 |
| 案 2 一句话读、修文件、跑检查、核对产物 | 真实 Electron、真实模型已完成：`sum.mjs` 从 `a-b` 改为 `a+b`，检查成功，修改后回读源码，外部独立执行及回读通过。成功检查执行了两次，严格“不重复”未通过；`maskedRequests=[]`。[文件案证据](evidence/foreground-capability-wiring/9e1163d6-4f79-40e4-ab95-8ba57131e4da.json)。 |
| 案 3 固定 Herdr/Pi 小任务，Serika 独立检查 | 真实 Electron、真实模型已完成。结构化 `herdr_pi_control` 一次 prompt，Pi session 用户消息恰好一条；Pi 创建 `answer.json` 为 `{"sum":15}`。Serika 自己回读、运行 `node verify.mjs`，exit 0、`PI_ARTIFACT_PASS`，外部复核通过。仅新建目标已停止并删除。[Herdr/Pi 证据](evidence/foreground-capability-wiring/b6656086-4a3c-4e69-9d4a-899ef0d860c5.json)。 |
| 权限及确认无放宽，批准后原 AgentLoop 继续 | 28 项相关单测通过，含既有权限快照、TG 不继承 remembered grants、Shell 不可记住及 Steer。最新文件案捕获 `remember:true`；Herdr/Pi 案 5 张卡的展示、点击、原 confirm、清卡闭环。原 IPC handler 未变。旧缺失归因保留。 |
| 全测、干净源码 Electron smoke、PR | 已做：`pnpm test` exit 0，共 1865 通过、7 跳过、0 失败、0 取消。[最新全测原始结果](evidence/foreground-capability-wiring/a922abeb-7854-430e-be48-8a03f93a7b81/result.json)。真实 Electron、假模型 smoke 8/8，sourceWorktreeDirty=false，[smoke 原始结果](evidence/electron-smoke/result.json)。[旧 4 项失败](evidence/foreground-capability-wiring/79d45376-185f-4574-848b-bed89c4e02e4/result.json)原样保留。 |

真实环境为 macOS、Electron 44.4.5 独立进程、原 preload/IPC、新建 HOME/profile/workspace，模型为 `deepseek/deepseek-v4.1-flash-fast`。真实模型使用 32,768 窗口，有效输入 26,624。1,000,000 窗口只有脚本化模型证据；日用常驻进程未验收。

## 3. 前后数字

- 产品代码 7 文件 `+63/-15`，新接线测试 `+116` 行，装配测试 `+48/-5`。测试较多是因为 desktop、TG 的真实 Controller/审批链、实际回执存储夹具及新增能力块的明确断言。产品三处接线未再改动。
- `build:runtime`、typecheck、新测试 3/3、相关测试 28/28、装配定向 5/5 已通过；全测 1865 通过、7 跳过、0 失败。两档脚本化压缩通过，不计作真实模型通过率。
- 累计 30 次真实请求，五批分别为 5、4、2、6、13 次，原定请求上限已满。用户批准借用日用 env 的模型连接信息，取消因费用不明暂停的条件；旧 usage 缺失不再阻塞本批。历史失败及缺失记录原样保留于[账本](evidence/cost-ledger.json)，unknown 未计为零费用。
- 日用 env 仅在进程内读取模型连接字段，没有创建包含真密钥的临时文件，没有加载日用 TG、数据或服务配置。

## 4. 实际命令和退出码

- `pnpm build:runtime` → 0；`pnpm typecheck` → 0。
- `SERIKA_B2_RECORD_CONCURRENT_HOME=1 node scripts/test-home.mjs --home /private/tmp/serika-tg-diagnose-home4 -- node --test --test-timeout=20000 packages/assistant/dist/foreground-wiring.test.js` → 0，3/3。
- 相关测试经隔离 guard，以 `node --test --test-concurrency=4` 运行 `context-assembler.test.js`、`context-compaction-runtime.test.js`、`steering-controller.test.js`、`permission-boundary.test.js`、`permission-decisions.test.js`、`permission-extension.test.js`、`tool-confirmation-remember.test.js` → 0，28/28。旧命令还包含不存在的 `capability-status.test.js`，Node 未运行该项，不计作能力边界覆盖。
- `node /private/tmp/serika-sum-project.phaszmy8/live.mjs --preflight` → 0，零模型请求、观测错误 0、失效确认被拒绝、原 handler 不变。该目录历史真实运行 → 1，第 2 次请求 transport-unknown，未重试。
- `node /private/tmp/serika-project.py6nfqfw/live.mjs` 文件案已完成；随后 Herdr 夹具因 macOS Unix socket 路径过长退出 1，尚未创建目标。新临时夹具采用短路径 `/private/tmp/w-vr2g51uh` 后完成 Herdr/Pi 案，证据状态 `pi-completed`、清理状态 `cleaned`。
- `SERIKA_B2_RECORD_CONCURRENT_HOME=1 node scripts/test-home.mjs --home /private/tmp/serika-wiring-compaction-probe/home -- node /private/tmp/serika-wiring-compaction-probe/probe.mjs /private/tmp/serika-wiring-compaction-probe/evidence` → 0。guard violations 0，并发元数据变化 3。原脚本、stdout、result 和 summary 已归档，三个 SHA-256 均与 summary 一致。
- `/private/tmp/serika-wiring-full-test.mjs` 旧全测 → 1，四项装配比较失败。适配后同命令新全测 → 0，原始 result、stdout 及 runner 已归档。Runtime 1197 通过/7 跳过，desktop 656 通过，脚本 12 通过。外层 guard passed、violations 0，记录并发变化 214、metadataUnchanged=false，不能声称日用目录元数据不变。两轮均未传模型凭据。
- `pnpm build:runtime` 及 `pnpm typecheck` 本轮均 → 0。装配测试修前 1 通过/4 失败，修后 5/5、exit 0；guard passed、violations 0、并发变化 3，历史快照未改。远端 CI 为 `disabled_manually`，未把远端无检查结果当作通过。
- `pnpm --filter @serika/desktop smoke` → 0，8/8。源码提交 `4f8fb2416bb33a2c565cb912ea394ad086af1743`，sourceWorktreeDirty=false，Electron 44.4.5，原 preload/IPC，realModelCalls=0。原 smoke 脚本 SHA-256 `dc93b146f85165710071944d59108a36898c7a60aac37605950aa2264dcbb994` 与基线一致；8 张截图均按证据 SHA-256 回算匹配。外层 guard passed、violations 0、并发变化 9，临时目录已清理。[隔离运行记录](evidence/foreground-capability-wiring/12f9b771-cf2b-4366-9b0e-477b45788807/result.json)。

## 5. 与计划不符的地方及理由

- 首版脚本混比 primary 与后台压缩的完整 system，已改为比较能力块字节；旧失败不回填。
- 旧确认观测漏“允许并记住”，且旧卡被处理后仍等待 decision 文件。新脚本记录全部按钮、按 approvalId 点击，外部被动观察 `method === "confirm"` 的原 IPC。最新运行闭环，旧记录不补造。
- 文件案成功检查重复一次，真实模型主动截短输出而未触发压缩。这两项仍是验收缺口；脚本化证据只证明生产压缩接线及真实工具回执链。
- 四个失败测试为 `minimal assembly matches __baseline__/assembly-minimal.txt`、`full assembly matches __baseline__/assembly-full.txt`、`full-without-todoist assembly matches __baseline__/assembly-full-without-todoist.txt`、`full assembly in the autonomous desktop foreground matches __baseline__/assembly-full-desktop-autonomous.txt`。均在 `assertStep3Assembly` 的 `newSystem === oldSystem` 失败。旧比较器尚未处理已批准新增的前台推进、能力块、Shell CLI 指引，后续 capability_status 比较也尚未适配新增 execution。本轮适配比较器，先明确断言新增能力块、前台与 CLI 指引的内容、次数及适用条件，再精确归一化。夹具补齐与 Controller 相同的 beginRun/endRun，分别核对 Run 内外授权状态。历史快照、无关 schema 和权限规则比较均保留；定向由 1 通过/4 失败变为 5/5 通过。
- 已查旧约束的 Shell/Docker 沙箱、确认、前台自主与 TG 授权、回执及 unknown 不重放条目。未改 AGENTS、授权面、日用部署或产品三处接线。沿用 Karpathy 最小改动及 pstack Prove It Works，分开报告真实模型、脚本化模型及实际产物证据。
