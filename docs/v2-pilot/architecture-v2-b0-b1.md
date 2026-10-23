# a2 补正与 b0+b1 联合交审

## 1. 改了什么

提交顺序：a2 补正 `75c6d9a` → b0 冻结 `cac308f` → b1 产品 `9680896`。a2 先完成独立统一验证，再开始 b0。

- `task-worker-entry.ts` 要求父进程显式传 `--home`；计划改成用户批准的新节奏。默认目录元数据见 [a2 补正报告](architecture-v2-a2-correction.md)。
- `tui-module-config.ts` 在配置边界把原 W 映射成唯一 `authorizedDirectory`。`app.ts`、确认器、权限扩展、文件工具、Skill、桌面设置及 TG grant 消费独立目录。`workspaceRoot` 保留项目上下文用途。
- `workspace-task-read-policy.ts` 改为 `directory-task-read-policy.ts`，调用者全部迁完，旧 API 删除。外部配置仍是现有格式，配置读写适配器转换一次，没有运行时双判定路径。

## 2. 逐条对照验收项

| 要求 | 结果及证据 |
|---|---|
| worker 缺 --home 退出；父进程显式传入 | 已做。`task-worker-entry.test.ts` 的 `requires explicit --home before accessing default or environment storage` 用真实 Node 子进程覆盖环境变量有/无两种，均退出 1 且不创建隐式目录。桌面 index/resident-entry → rss-worker-service → task-worker-service 均传 --home H |
| 列举默认目录；不读内容、不删除 | 已做。a2 报告列出 3 个文件名、大小、mtime；只 readdir/lstat，不跟随符号链接。切日用前须干净，处理方式由用户决定 |
| 更新实施顺序 | 已做。计划写明 d 三份文档暂在 user、导入器保留供切日用新快照重导；S1 前移自主切换，各规则变化待批准，Docker 保留；切后再 b2/c/Linux/S2/S3 |
| b0 先录制并冻结 | 已做。`permission-boundary.test.ts` 走真实 runtime/controller，补宿主免确认、真实 memory 读写、配置与路径。87 项两次录制逐字节一致；b1 捕获仍一致。旧有效 521 行权限表不变 |
| b1 单目录等价、规则不扩大 | 已做。同一 W 只映射一目录，实际确认卡、remember、命令、注册工具和 allow/deny/ask 保持。`permission-decisions`、`permission-extension`、`tool-confirmation-remember`、`tui-module-config`、`workspace-task-read` 及桌面权限测试覆盖 |
| 无目录不能获得文件权限 | 已做。`directory-authorization.test.ts` 验证无 read_file/write_file/shell_exec、无 authorize 命令，外来 grant 不启用、write_file 请求失败且无文件 |
| host/TG/worker 边界 | 已做。b0 桌面和 TG 的 host Shell 均仍审批；TG 不继承桌面授权；外来目录/其他 Thread grant 不放行；worker 工具集为空。真实 TG 外发、服务注册及系统沙箱实施均没做，超出本轮授权 |

查过旧约束：`docs/legacy/agents-constraints-2026-10-20.md` 的 Thin TUI 确认/remember、next-Run 与持久文件授权、Docker 无网且不回退 host、Computer 外置可信 executable/config、前台自主的频道与 Thread 绑定。旧“自主 host Shell 免确认”已被当前计划取代，本轮以 b0 的逐条审批为准。b0 中自主 memory_write 未注册、请求会 failed，是冻结现状；普通 primary 用真实工具实际写入夹具记忆。

## 3. 前后数字

以下相对 `613d33e`，按 git numstat（识别 rename）统计，文档/证据不算代码；迁移工具各阶段均 0。

| 单位 | 产品 增/删/净 | 测试及快照 增/删/净 |
|---|---:|---:|
| a2 补正 | +3/−2/+1 | +33/−11/+22 |
| b0 | 0/0/0 | +1137/0/+1137 |
| b1 | +132/−124/+8 | +82/−47/+35 |
| 本轮合计 | **+135/−126/+9** | **+1251/−57/+1194** |

其中生成的冻结 JSON 快照 +1021 行；测试代码本身 +230/−57，净 +173。测试超产品行数是本轮先冻结完整宿主权限的要求，另有真实 worker 子进程与无目录负例。无删除测试文件、无跳过新失败；测试输入仅等价迁字段，原断言保留。b0 实际净行数超过预计 +100～180，原因是保留完整确认卡文本；b1 产品净 +8，低于预计，使用既有结构完成。

实测 macOS（darwin），真实 Node 与真实 Electron + 假模型脚本。下表是自动检查结果，真实模型调用 0、费用 $0；不是实模行为验收，也未代替 Linux 独立复现。

| 阶段 | UTC 通过/失败/跳过（总数） | 上海 通过/失败/跳过（总数） | eval | Electron 脚本检查 |
|---|---:|---:|---:|---:|
| a2 @ 75c6d9a | 1761/0/7（1768） | 1761/0/7（1768） | 101/101 | 8/8 |
| b0-b1 @ 9680896 | 1763/0/7（1770） | 1763/0/7（1770） | 101/101 | 8/8 |

统一验证包含冻结的 32K 与日用窗口离线用例。本轮没有真实模型、常驻用户进程或系统沙箱下的窗口质量验收。

人工核对了本轮冒烟的保存回执和重启记忆两张截图：前者显示“已保存/撤销”，后者仍显示该条记忆；其余截图保留供审核。

## 4. 实际命令与退出码

- a2：`pnpm typecheck` → 0；worker 测试 12/0/0，连同 rss-digest 合跑 22/0/0。首次统一验证因 RSS 旧 parser 夹具未传 --home 而失败，补显式参数、保留原断言后重跑，退出 0。
- b0：`pnpm build:runtime` → 0；首次录制对空 bootstrap 比较 → 1（产品未改）；第二次录制及五个权限相关文件 → 0，46/0/0。录制命令与 hash 见 [freeze.json](evidence/architecture-v2-b0/freeze.json)。
- b1：`pnpm typecheck` → 0；七个受影响测试文件 → 0，144/0/0；无目录和 scheduled-skill 两文件 → 0，6/0/0。
- 两阶段分别执行 `SERIKA_CM6_VERIFY_OUTPUT=<独立输出目录> node packages/assistant/scripts/cm-step6-verify.mjs` → **0**。内部依次 typecheck、UTC pnpm test、上海 pnpm test、pnpm eval:test、临时干净检出 pnpm --filter @serika/desktop smoke、offline audit，命令逐项退出码均 0。原始输出及 hash 见各 unified/verification.json；最终源码 `9680896894e31c9722c7b6126b924335ebf575f6` 全程干净。

| 证据 | SHA-256 |
|---|---|
| a2 [verification.json](evidence/architecture-v2-a2-correction/unified/verification.json) | `72d1a5c4cde9c65304af4b52a2c88d5991d85e84f527936eec9dbe932f2eaedf` |
| b0+b1 [verification.json](evidence/architecture-v2-b0-b1/unified/verification.json) | `f348b07b9f1c061d8526cb3832a41ff00e26c2728215dd3bcd32b290aafef6ce` |
| [final-checks.json](evidence/architecture-v2-b0-b1/final-checks.json)，含逐文件/截图 hash 与行数 | `4707ffa4fd1531bd0a748bda9df55fd2eece6e028ded210c2cce18e0c1988e53` |
| 新权限快照（两次 b0 与一次 b1 相同） | `b988e469ca6c830690358de82db65b67a316e9c0256bfa993b3199f8c2e68670` |
| 原权限表（未改） | `08acd418d5d3831504b7393f72472c2910093a4b4b5d70394275f9847981bace` |
| 冻结冒烟脚本（未改） | `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f` |

## 5. 与计划不符的地方及理由

b1 保留外部 `workspace`、`desktopAutonomy.workspaceRoot`、`telegramAutonomy.workspaceRoot` 输入格式，仅配置解析/序列化适配器消费；新的外部格式与多目录留 d1/b2。运行时权限已只消费目录字段，项目不参与权限判定。确认卡仍保留原“工作区”文案，以保证本轮快照等价。已采用最小改动、迁完调用者删除旧 API、验证实际入口三条原则。

冻结冒烟仍使用已获批的测试夹具路径别名，产品不恢复旧存储路径。a2 报告的两文件测试数由笔误 16 更正为实际 22。未触碰 main、日用内容、真实模型、服务注册或 TG 外发。后续 d、b2、Seatbelt 和切日用均停在审核之后。
