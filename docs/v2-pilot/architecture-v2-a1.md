# 架构 v2 第 4.5 步 a1 交付

## 1. 改了什么

依据 [已批准计划 a1](../architecture-v2-step4.5-plan.md#a1-home-入口与-cli-数据位置)。基线 `ae5cf67344e277058a8da3864b566a11f089efeb`，最终验证源码 `052a530091407348b0572c2d33b3f30096a5db4d`。

- `apps/cli/src/application-home.ts` 在 CLI 边界解析 `--home > SERIKA_HOME > ~/.serika`。正常启动首次创建 H 和默认配置，配置、数据、transcripts 分别位于 `H/config.json`、`H/data`、`H/transcripts`；不创建默认 workspace。
- `packages/assistant/src/{assembly,app,data-paths}.ts` 接收显式数据目录；各 store 改收文件路径，调用者同步迁完。assistant/core 不读取全局 home，也不修改进程环境。WorkTask 的产物验证和 Recipe 的 cwd 仍使用 workspace。
- `apps/cli/src/{index,startup-check,cli-options}.ts` 接入 home；`--check` 只解析和检查，不初始化目录。CLI 不再隐式读取旧 `RUNLOOM_CONFIG`、`RUNLOOM_TRANSCRIPTS` 入口或 workspace 记忆。
- 桌面和 worker 调用者本步显式传入其原数据位置；home 身份切换留在 a2。`cm-step7-migrate.mjs` 仅适配 store 参数，未执行迁移。

已核对 [旧约束](../legacy/agents-constraints-2026-10-20.md) 的 Thin TUI `fileAuthorizations`、只读 `--check`、Docker 显式启用且不得回退 host、Computer 外部可信配置，以及 WorkTask unknown 回执规则。文件/Shell 权限、外部配置防自我授权、unknown 核对和内容 hash 协议沿用原规则；记忆 v6 格式、scope 与预算未变。

## 2. 逐条对照验收项

新增用例均在 `apps/cli/src/application-home.test.ts`。以下是离线工具链与实际存储证据，模型使用 `MockLanguageModelV3`。

| a1 验收项 | 结果与证据 |
|---|---|
| 全新 H 首启、重启一致 | 已做。`fresh CLI homes keep real memory writes, tasks and transcripts apart across restart without a workspace` 经过真实 `memory_write`、来源校验、`task_create` 和 JSONL 持久化；重开后请求准备含用户原话，配置字节一致。`CLI entry creates only its selected home and --check stays read-only` 覆盖真实 CLI 子进程入口。 |
| 无 workspace 创建用户数据 | 已做。同一用例创建记忆和提醒，断言 workspace 缺省且文件/Shell 模块未启用。此步仍写 v6，user scope 的格式变更属于 c2。 |
| H1/H2 同进程隔离 | 已做。同一用例复用 Thread 名称，两个 Controller 同进程，记忆、任务、transcripts 互不可见。 |
| 不设置全局环境变量 | 已做。`home precedence and read-only preflight neither create files nor alter the environment` 核对解析优先级和传入 env 未改变；assistant 通过显式路径装配。 |
| preflight 不创建目录 | 已做。上述 preflight 用例和真实 CLI 子进程用例均核对目录未创建。 |
| 旧路径保护、无隐式导入 | 已做。`a storage home does not grant workspace file access or load old workspace memory` 在临时 workspace 放入损坏旧记忆，home 仍能读取空的新 store，旧文件字节未变。真实 Electron 冒烟 `daily-path-refuses-writes` 核对实验保护拒绝旧路径，未读取日用内容。 |
| 已批准配置权限不变 | 已做。上述权限用例核对自动记忆配置在 workspace 内仍拒绝；原配置、授权、符号链接与权限判定测试保留。b0 的完整宿主权限快照尚未开始。 |

冻结的真实 Electron 冒烟 8 项完成，经过原 preload/IPC 和假模型；它是桌面回归证据。新增 CLI home 尚未在 Electron 中实施，不能把冒烟结果作为 a2 的验收。32K 与大窗口的离线回归随统一验证执行，本轮没有新增真实模型窗口实验。

## 3. 前后数字

统计范围为基线到最终验证源码，逐文件数据见 [line-changes.json](evidence/architecture-v2-a1/line-changes.json)。可用 `git diff --numstat ae5cf67344e277058a8da3864b566a11f089efeb 052a530091407348b0572c2d33b3f30096a5db4d` 复算；文档和运行证据另列，不计产品代码。

| 类别 | 新增 | 删除 | 净值 | 文件数 |
|---|---:|---:|---:|---:|
| 产品代码 | 196 | 106 | +90 | 24 |
| 迁移工具 | 1 | 1 | 0 | 1 |
| 测试及验收脚本 | 512 | 360 | +152 | 86 |
| 计划文档 | 23 | 18 | +5 | 1 |

产品净值落在计划 +40～+120 内；测试净值超过预计 +80～+140。测试新增行数也超过产品，主要因为所有 store 的测试、验收脚本与测试装配调用者须同步替换参数，并新增 4 个 home 优先级、隔离持久化和权限边界用例。没有删除测试文件或通过跳过测试消除失败；冻结检查器、冒烟脚本和权限快照未改。

## 4. 实际命令、退出码与证据

实测 macOS，最终源码 `052a530`。在干净源码上执行以下统一命令，退出 **0**；冒烟在临时干净检出中运行，`sourceStayedCleanDuringVerification=true`。

```sh
SERIKA_CM6_VERIFY_OUTPUT=/tmp/serika-a1-unified-052a530 \
  node packages/assistant/scripts/cm-step6-verify.mjs
```

| 统一验证内的命令 | 退出码 | 实测结果 |
|---|---:|---|
| `pnpm typecheck` | 0 | 类型检查完成 |
| `env TZ=UTC pnpm test` | 0 | 1759 通过 / 0 失败 / 7 跳过，总计 1766 |
| `env TZ=Asia/Shanghai pnpm test` | 0 | 1759 通过 / 0 失败 / 7 跳过，总计 1766 |
| `pnpm eval:test` | 0 | 101/101，离线 |
| `pnpm --filter @serika/desktop smoke` | 0 | 8/8，真实 Electron、假模型 |
| `node examples/eval/cm-step6-offline-audit.mjs` | 0 | 冻结证据审计完成 |

每个时区的三个测试进程分别为 runtime 1124 通过、7 跳过，desktop 623 通过，migration 12 通过。这里报告的是 macOS 实测，Linux 由审核方独立复现。

- [统一原始报告](evidence/architecture-v2-a1/unified/docs/v2-pilot/evidence/cm-step6/verification.json) SHA-256：`de1ffac6e66356318b23d8c2e934fe04b5e6328b807f91a5fbbb7d551ca0d3f3`。
- [汇总及证据 hash 清单](evidence/architecture-v2-a1/final-checks.json) SHA-256：`cee50721b2f4bd9480cf9d24d7b93e9588c9b7bcca13831d9ba6af7258ce298f`。其中保留当次随机 runId、源码提交、命令、逐文件统计和证据 SHA。
- [运行命令记录](evidence/architecture-v2-a1/runner.log) 与 [Electron 运行证据及截图](evidence/architecture-v2-a1/unified/docs/v2-pilot/evidence/electron-smoke/result.json)。
- 冒烟脚本 SHA-256 保持 `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f`；冻结检查器保持 `f45f10aa5f644fdc450d9e8ffef81d45d48f53f38d7455cca00c611b4e43c46a`。

复现 CLI home 使用新建临时目录，构建后运行 `node apps/cli/dist/index.js --check --home "$probe_dir/home"`，目录应仍不存在；再运行 `node apps/cli/dist/index.js --tui --home "$probe_dir/home" --thread sample`，应创建选定 home，退出并重开后沿用同一配置和 transcripts。`probe_dir` 由 `mktemp -d` 取得。未配置真实模型时仅使用默认假模型；记忆工具持久化由上述离线用例验证。

## 5. 偏差与后续关口

最初针对性测试发现 Recipe 路径迁移漏查存储目录符号链接、TaskStore 子进程夹带旧构造参数，以及 macOS `/var` 规范化路径断言差异。分别恢复目录符号链接拒绝、迁完脚本内参数、按 realpath 断言，随后针对性测试 95/95；最终统一验证结果如上。未改原权限断言和快照。

本轮未读取或写入日用数据，未操作 main，未调用真实模型，模型调用费用为 $0。未注册服务、未发 TG、未运行 native Computer 或系统级沙箱验收。a2 及之后均等待审核。

已批准的后续行为变化已记入计划，验收需逐项核对：TG 私聊不继承 main #177 的全工具免确认，需按工具规则审批；自主 Shell 默认断网，S2 域名放行完成前 `git push`、`pnpm install` 等需用户确认后逐次 host 执行。a1 尚未切换 Shell 沙箱。Seatbelt 先验收，bubblewrap 随后，两者通过前保留 Docker。

d2 仅在副本上演练；真正切日用须另行授权，使用同一导入器导入新的一致日用快照。导入器保留至切日用，d1 交付时再次写明。D9 的具体项目路径在 d2 前由用户补齐；D13 的日用必需 main 功能由用户另行告知，当前不列为切日用必做项。
