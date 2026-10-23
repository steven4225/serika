# Computer 只读权限与默认目录写入补正

基线 `63cc724`；验证源码 `7587054bd204ae55d5fd9c4330dd1de040da632a`。只提交实验分支，提交推送后停等审核。

## 1. 改了什么

- `computer-module.ts` 复用已有权限声明：check 与已授权应用 observe 自动执行，action 继续每次确认且不可记住。删除 check 专用确认回调；白名单、窗口/PID/token 校验及未知效果规则保持。桌面设置、TG 和能力提示按新规则更新。
- CLI 四个测试启动调用补齐临时 `--home`，首个用例另设不同环境 home，断言只有显式 home 被创建。没有改变产品默认路径。
- `scripts/test-home.mjs` 要求显式临时 home，给子进程设置 HOME/SERIKA_HOME/RUNLOOM_HOME；用真实用户目录定位保护目标，不随临时 HOME 改变。Node 文件写入在调用前拦截并记录违规；即使子进程吞错并退出 0，整体仍失败。元数据 watcher 与前后 lstat 清单覆盖非 Node 子进程写入，发现变化即终止并失败。此检查不读取默认目录文件内容，也不把它当 OS 沙箱。
- runtime、desktop、eval 测试与 smoke 的 package 入口均经过检查；新增 `verify:cm6` 包装冻结统一检查器。直接测试入口缺少临时 home 时先失败；标准入口为 `node scripts/test-home.mjs --home TEMP -- COMMAND`。

查过旧约束 §Testing and quality 的 Local Computer Use 精确 Bundle ID、只注册 primary、fresh observation、unknown effect 不重试，以及证据密钥禁入条目；逐条确认部分以本次用户批准为准。pstack 的 Laziness Protocol 让权限改动留在现有声明；Prove It Works 用假驱动、实际 Controller、离线 TG 和临时保护目录验证。没有新增执行通道。

## 2. 实际变化与批准清单

| 批准项 | 实际结果及证据 |
|---|---|
| 桌面/TG check 免确认 | b0 各连续两次无审批；模块测试只调用 list_apps 并过滤允许应用；TG 集成实际回执无 approvalRequestedAt |
| 已授权 observe 免确认 | Controller 桌面/TG 均先读后进入 action；离线 TG 收到假驱动的授权应用 AX 结果，无确认卡 |
| 未授权应用直接拒绝 | 新快照每入口两次明确 COMPUTER_PRECHECK_FAILED；模块测试断言驱动调用数不增加 |
| action 每次确认、不可记住 | 原两条快照连续拒绝两次且 remember=null；两入口 Controller 的拒绝、取消、断线、派发后取消回执保持，不重放 |
| 快照范围 | 原 89 + 第三轮其余 16 = 105 行逐值不变；用户已确认允许改 4 行；新增 2 行，共 111 行 |
| 冻结 SHA | 13 个受保护脚本、权限决策快照及 Seatbelt 文件与 63cc724 一致；见 evidence/computer-read/audit-source-final/audit.json |
| 默认目录只查元数据 | 下表为全部条目；未读内容、未删除、未移动；是否存档由用户决定 |
| 全局写入检查 | 临时保护目录测试证明：Node 吞错后整体仍失败；Shell 写入被元数据检查识别并失败；正常隔离命令通过 |
| 统一验证 | 最终退出 0；两时区各 1821 pass / 7 skip / 0 fail，离线 eval 101/101，冻结 Electron 冒烟 8/8 |

逐条快照如下，其余 105 行不变：

| 行 | 改前 | 改后 |
|---|---|---|
| round3/desktop/computer_check/check | 每次确认 | 免逐条确认 |
| round3/desktop/computer_observe/observe | 每次确认 | 免逐条确认，仍核对白名单 |
| round3/telegram/computer_check/check | 每次确认 | 免逐条确认 |
| round3/telegram/computer_observe/observe | 每次确认 | 免逐条确认，仍核对白名单 |
| round3/desktop/computer_observe/unauthorized | 新增 | 无审批，直接拒绝，两次结果均入快照 |
| round3/telegram/computer_observe/unauthorized | 新增 | 无审批，直接拒绝，两次结果均入快照 |

### ~/.serika 全量元数据与来源

以下时间为 UTC，目录大小为 lstat 返回的目录条目字节数，不是内容合计。精确纳秒值保存在最终 audit.json 和 guard 记录中。

| 路径 | 大小 bytes | 修改时间 UTC |
|---|---:|---|
| ~/.serika/ | 128 | 2026-10-22 17:32:47.918 |
| ~/.serika/transcripts/ | 64 | 2026-10-22 16:21:12.239 |
| ~/.serika/data/ | 160 | 2026-10-22 17:33:49.361 |
| ~/.serika/data/task-worker-health.json | 206 | 2026-10-22 17:33:49.354 |
| ~/.serika/data/task-worker.lock | 0 | 2026-10-22 17:32:47.922 |
| ~/.serika/data/tasks.json.lock | 0 | 2026-10-22 17:32:47.976 |

- `transcripts/` 是空目录。命令记录显示 a1 在 2026-10-22T16:21:11.097Z 直接执行 `pnpm test:runtime`；四个 `cli-entry.test.ts` 启动 `[ENTRY,"--tui","--config",configPath]`，未传 home，解析器回到用户默认 home，实际 Runtime 创建 transcripts。目录时间在下一秒，与该入口吻合。这是命令时间与代码路径的归因，没有历史文件系统系统调用审计，不能声称观察到了当时的具体 mkdir 调用。
- `data/` 三文件与 a2 补正的既存清单字节数一致，修改时间在历史毫秒精度内一致。a2 的 17:32:40 与 17:33:39 两次 `task-worker-entry.test.js` 定向命令漏传 home，原因和修复已在 a2 报告记录；本轮确认强制 home 入口仍在，没有改回去。
- 第 1–3 轮统一验证分别在 2026-10-23T12:26、13:22、14:57 UTC 开始，全部晚于现存元数据；前三轮记录也使用临时 home 包装器。当前证据不支持“a2 补正后又写入”，上次清单只列 data，遗漏了更早存在的空 transcripts。元数据不能证明历史上绝无任何写入；这里如实区分直接比对与时间归因。
- 本轮最终统一验证的 10 份保护记录全部通过：真实目录元数据逐值不变，watcher 变化事件 0，Node 写入违规 0。初次递归清单与最终记录的全部路径、大小、纳秒修改时间一致。原目录原样保留。

## 3. 前后行数

相对 63cc724，截止验证源码 7587054：

| 类别 | 新增 | 删除 | 净增 |
|---|---:|---:|---:|
| 产品 | 18 | 20 | -2 |
| 测试、验证入口、检查脚本 | 364 | 37 | +327 |
| 权限快照 | 50 | 56 | -6 |

逐文件在 evidence/computer-read/audit-source-final/audit.json 的 lineChanges。测试/验证多于产品，因为产品只改已有权限声明，本轮另要求可复跑的目录写入检查、违规验证及快照/冻结/元数据审计。未删测试文件；原 check 确认卡断言改为只读自动审批声明，旧批准文案按本次授权精确替换比较，历史 assembly 文件和权限决策快照保持。

## 4. 实际命令、退出码与证据 hash

全部测试命令通过显式临时 `--home` 包装器；包入口将 SERIKA_TEST_HOME 展开为该参数。旧开发包装器也将 HOME/SERIKA_HOME/RUNLOOM_HOME 定向临时目录。以下表格列出实际运行与退出码，原始日志见 development/。

| 命令/入口 | 退出码及结果 |
|---|---|
| 旧临时包装器下 `pnpm typecheck && node --test permission-boundary … computer-module … baseline-assembly` | 1，19/24，5 项旧行为差异，initial.log |
| `node scripts/test-home.mjs --home /private/tmp/serika-computer-read/guard-H -- …` | 1，临时根路径校验失败，guard-initial.log |
| 同入口 guard2-H 的三项检查 | 1，2/3，路径别名和 watcher 过滤后修复，guard-fixed.log |
| 同入口 guard3-H 的三项检查及 pnpm typecheck | 0，3/3，guard-third.log |
| 两次 b0 采集 `SERIKA_B0_CAPTURE=… node --test …/permission-boundary.test.js` | 各 1，获批新增行未同步或采集数组引用错误；target2.log、b0-copy.log |
| 最终定向 typecheck + Computer/Controller/b0/assembly + renderer + CLI/guard | 0，32/32、7/7、7/7，final-target.log |
| 离线 TG `tsx --test --test-name-pattern='Computer reads' src/main/telegram-gateway.test.ts` | 0，1/1，tg.log |
| CLI 首个用例新增环境 home 隔离断言后重跑四项 | 0，4/4，cli.log |
| 修正旧 app/permission 断言后 `pnpm typecheck && node --test --test-timeout=10000 …/app.test.js …/permission-decisions.test.js …/tool-confirmation-remember.test.js` | 0，28/28，app-fix.log |
| 新审计 `node packages/assistant/scripts/computer-read-verify.mjs --home /private/tmp/serika-computer-read/audit-source-H --output /private/tmp/serika-computer-read/audit-source-final` | 0；首次审计因空数组退出 1，原始 audit/audit.json 保留 |
| 首次 `SERIKA_TEST_HOME=/private/tmp/serika-computer-read/unified-H SERIKA_CM6_VERIFY_OUTPUT=…/unified pnpm verify:cm6` | 1，UTC runtime 1151 pass / 2 fail / 7 skip；unified-first-failure/ 保留 |
| 最终 `SERIKA_TEST_HOME=/private/tmp/serika-computer-read/unified-final-H SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-computer-read/unified pnpm verify:cm6` | 0；内部原样运行冻结 cm-step6-verify.mjs |

最终冻结统一验证内部命令如下，退出码直接来自 verification.json：

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `pnpm typecheck` | 0 | 完成 |
| `env TZ=UTC pnpm test` | 0 | tests=1828, pass=1821, fail=0, skipped=7 |
| `env TZ=Asia/Shanghai pnpm test` | 0 | tests=1828, pass=1821, fail=0, skipped=7 |
| `pnpm eval:test` | 0 | tests=101, pass=101, fail=0, skipped=0 |
| `git clone --shared --no-checkout . <temporary>/smoke-source` | 0 | 完成 |
| `git checkout --detach 7587054bd204ae55d5fd9c4330dd1de040da632a` | 0 | 完成 |
| `pnpm --filter @serika/desktop smoke` | 0 | 冻结 Electron 8/8 |
| `node examples/eval/cm-step6-offline-audit.mjs` | 0 | 完成 |

| 证据 | SHA-256 |
|---|---|
| manifest.json | `8d0baccc9801d5bb3b6a8fd2d8db29658cd065d98d299c17779183bf246c02cf` |
| audit-source-final/audit.json | `df3cc421b0608ea659dd41f78df20694652ace151716902189cb3aaf537bbb5f` |
| unified verification.json | `9d392f7dc7280abade06810f502b9b7ff50f15321800cd2bcc694b7db9ec23b9` |
| b0 快照 | `10aa321059feff1c0e8a383c0b169d8d886d98b721e3ad0db80ec1537f12cafc` |

冻结检查器 SHA `7fc93222da184d9f27cd9fc2601dde208e9a9690cc277b0c879d280d41840ffb`；冻结冒烟 SHA `03a3c7e6d174842edda61770f8f17b7480e6545ee52ffbda2f63a288d07a6c34`。其余 11 项在审计 frozen 字段中。manifest 列出全部证据文件的字节数和 SHA，凭据模式扫描 0 命中；不包含真实 ~/.serika 文件内容。源码 diff --check 退出 0。


## 5. 偏差和限制

- 开发首次定向测试 19/24，通过之前先出现 5 项预期旧规则差异；按用户批准更新 4 行、追加负例，并精确对比新的能力文案，没有放宽其余保护。一次试图直接比较历史 config 行与当前投影的准备脚本退出 1，未写快照；随后只改获批键。
- 写入检查的首轮错误只接受系统 tmpdir，拒绝 /private/tmp；第二轮发现 /var 与 /private/var 路径别名导致测试断言失败，同时将 watcher 的通知改为核对元数据差异，避免访问事件误报。修正后的三项临时夹具检查通过。
- 新拒绝快照曾保留可变数组引用，后续用例清空后变为空数组；独立审计退出 1 抓到该问题。改成复制数组，重新采集两项真实拒绝结果；采集前后的预期快照失败和原始日志均保留，最终审计通过。
- 第一次统一验证在 UTC 阶段退出 1。`app.test.ts` 仍等待 observe 确认，断言失败后 Run 未取消，定向终止该测试子进程才完成失败报告；旧 `permission-decisions.test.ts` 也仍期待 check/observe 逐次确认。前者改为实际执行假只读驱动、仅拒绝 action，并在 finally 取消/等待 Run；后者在不改冻结快照文件的前提下，明确投影本次两工具的新预期，其余规则继续逐值比对。三文件定向 28/28 后提交新源码，重新完整验证。
修改原断言的具体依据如下，均由本次权限批准触发：

| 测试 | 原断言 | 本轮断言 |
|---|---|---|
| computer-module.test.ts 的声明测试 | check 有确认卡 | check/observe approval=auto；action 不自动；全部不可记住 |
| baseline-assembly.test.ts | 能力提示要求批准 check/observe | 只替换这段获批文案，其余 schema、system 和能力仍逐值比较 |
| app.test.ts 的 Computer 路径 | 两工具均待 ID 审批，驱动不启动 | 只读实际调用 list_apps/list_windows；仅 action 待审批，拒绝后不派发 |
| permission-decisions.test.ts | 冻结快照的 check/observe 为 ask | 冻结文件不改；只对两工具建立显式 allow 预期，remembered same 仍 not offered，其余逐值比较 |

- 无真实模型、真实 Computer 应用/驱动、TG 外发或服务注册。Computer 当前仍是 AX 观察，不产生截图；本轮没有新增截图能力。截图/界面证据仅来自冻结冒烟的隔离假数据，未读取真实 UI 密钥。提交前做凭据模式扫描，不归档真实默认目录文件内容。
- 写入检查会使非 Node 写入导致的目录变化失败，不能撤销已经发生的外部写入；本轮实际真实目录无变化。它是测试检查，不替换产品 Seatbelt。只在 macOS Node/离线 TG/冻结 Electron 形态验证，没有实际 Pi/网站/Computer 业务验收。
- 归档原始失败断言日志含 16 处行尾空白，证据 git diff --check 退出 2；保留原字节，位置与输出在 package-checks.json。源码 diff --check 退出 0，报告没有将证据格式检查写成通过。
- 不切日用，不移动 ~/.serika，推送后停等审核。
