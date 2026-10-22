# 架构 4.5 a2：桌面、resident、worker 的 H 归属

## 1. 改了什么

基线 `b555a01`，最终验证源码 `6b82c9f`。只做获批 a2。

- `packages/assistant/src/application-home.ts` 统一 H 解析；CLI、Electron 共用 `--home > SERIKA_HOME > ~/.serika`，Electron 缓存默认 `H/cache/electron`，`RUNLOOM_USER_DATA` 仅覆盖缓存。
- `apps/desktop/src/main/{desktop-runtime,desktop-config,desktop-identity,runtime-ownership,resident-entry,resident-service,rss-worker-service}.ts`：配置 `H/config.json`、存储 `H/data`、会话 `H/transcripts`、界面状态 `H/desktop`、频道及宿主状态 `H/resident`。socket、服务 label 和 worker 锁归 H。Thread 注册键不再包含项目目录。
- `packages/assistant/src/task-worker-{entry,service,context,health}.ts`：worker 显式接 H；无项目可读取自己的任务及配置；项目快照/Skill 仍需显式项目。通知路由和前台提示同属 H。频道持久化归 H，TG grant 仍绑定当前明确项目及原 bot/user/chat/Thread。
- `backup.ts`、`recovery-profile.ts`：备份从 H 读取，恢复写入新 H；v1 归档成员名保持原格式，写盘前映射到 `data/`。恢复选择保存在原 H，草稿随当前 H 切换。
- 删除只剩定义/测试引用的 Memory、Checkpoint、Task、WorkTask 文件名及锁名常量，同步调用者及两份路径基线。仍在生产使用的 `TASK_WORKER_LOCK_FILE_NAME` 保留。按用户批准，仅冒烟夹具创建 `W/.runloom → H/data` 别名；冻结脚本字节未改。

查过旧约束 `docs/legacy/agents-constraints-2026-10-20.md` 的 Thin TUI 授权、Docker Shell、Trusted desktop foreground autonomy 和 TG 独立授权条目。本步保持其项目授权、逐次 host Shell 确认、未知效果不重试规则。

## 2. 逐条对照验收项

| 验收项 | 结果与证据 |
|---|---|
| 桌面/resident/worker 仅使用 H 存储 | 已做。`application-home.test.ts` 无别名验证实际 H 文件和空项目目录；`task lifecycle acceptance (mock)` 用 `--home --config`、不传项目，实际 worker 子进程完成任务并重启读取；`resident-process.test.ts` 运行真实 headless entry。 |
| 两个 H 的 socket、身份、任务、频道状态隔离 | 已做。`isolates two homes sharing a project without aliases; changing project preserves Thread and disables the old grant` 检查两个 socket/identity 路径、实际 TaskStore/MemoryStore/TG store；`resident-transport.test.ts` 拒绝外来 H 握手。 |
| 切项目不换 Thread，旧 grant 不静默扩大 | 已做。上述无别名用例实际重建 DesktopRuntime，保留用户历史/Thread/transcripts，旧自主 grant 未启用；TG 三项原授权测试保持断言。 |
| 新实例不误连日用 resident，不自动注册/替换/启服务 | 已做。H 派生 socket/label；`runtime-ownership.test.ts`、`resident-service.test.ts`、`rss-worker-service.test.ts` 验证无隐式启用、可信参数精确匹配及拒绝替换；服务命令使用注入 runner，未注册真实 OS 服务。 |
| 产品没有 W/.runloom 存储读写路径 | 已做。[source-search.json](evidence/architecture-v2-a2/source-search.json) 记录 290 个产品源码文件的检索。剩余命中分为 v1 归档虚拟成员 8 行、临时文件后缀/服务 label 5 行、renderer IPC 名 132 行；没有向 W/.runloom 读写存储的路径。测试/验收夹具另列排除规则。 |
| 死常量和过时基线清理 | 已做。上述检索中的目标旧常量引用为 0；`baseline-paths.test.ts` 两份基线更新为获批 H 布局。哈希基线、冻结检查器和冻结冒烟未改。 |

Electron 冒烟为真实 Electron、原 preload/IPC、假模型，完成 8/8。它通过获批别名读取同一物理 H/data 文件；独立 H 隔离用例没有别名。32K 与大窗口离线回归包含在统一验证；未进行真实模型质量或系统级沙箱验收。Linux 留审核方独立复现。

## 3. 前后数字

`git diff --numstat b555a01 6b82c9f` 可复算。[line-changes.json](evidence/architecture-v2-a2/line-changes.json) 含逐文件分类；文档和运行证据不计代码。

| 类别 | 新增 | 删除 | 净值 | 文件数 |
|---|---:|---:|---:|---:|
| 产品 | 228 | 214 | +14 | 30 |
| 迁移工具 | 0 | 0 | 0 | 0 |
| 测试、验收脚本及路径基线 | 441 | 336 | +105 | 43 |

净值在计划区间内。测试新增行数超过产品，主要为跨进程 home 参数、既有 store 夹具迁移、无别名隔离用例及冻结冒烟适配器。未删除测试文件、未加跳过条件。

按获批行为修改的断言单列如下；其余权限断言保持：

| 测试 | 旧断言 → 新断言及原因 |
|---|---|
| `desktop-identity.test.ts` 的 workspace/config 隔离及 legacy preference 两例 | 换 W 新建 Thread/不可选择旧 Thread → 同 H/config 沿用 Thread；a2 明确要求项目切换不换 Thread。 |
| `desktop-runtime.test.ts` generated identity 例 | 自动创建个人 workspace → `workspaceRoot=null`；H 可无项目工作。WorkTask/Dreaming 夹具显式给项目，仍检查原功能。 |
| `git-reality.test.ts` 旧项目 bookkeeping 例 | 忽略未跟踪 `.runloom/checkpoint*` → 计为项目改动；应用记账已移到 H，不再忽略项目遗留文件。 |
| worker 参数与服务参数例、两份路径基线、frontmost 入口定位 | 必须 W/旧存储位置 → 显式 H、可无 W、新位置；项目快照仍必须 W，旧服务参数仍判不兼容。 |
| 其余 store/backup/TG/draft 测试 | 按相同测试意图把文件定位到 H；备份 v1 虚拟成员断言不变。 |

## 4. 实际命令、退出码与证据

实测 macOS。最终源码干净提交上运行，统一验证退出 **0**，源码在验证结束前保持干净。

```sh
SERIKA_CM6_VERIFY_OUTPUT=/tmp/serika-a2-unified-6b82c9f \
  node packages/assistant/scripts/cm-step6-verify.mjs
```

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `pnpm typecheck` | 0 | 类型检查 |
| `env TZ=UTC pnpm test` | 0 | 1760 通过 / 0 失败 / 7 跳过，总计 1767 |
| `env TZ=Asia/Shanghai pnpm test` | 0 | 1760 通过 / 0 失败 / 7 跳过，总计 1767 |
| `pnpm eval:test` | 0 | 101/101，离线 |
| `pnpm --filter @serika/desktop smoke` | 0 | 临时干净检出，8/8 |
| `node examples/eval/cm-step6-offline-audit.mjs` | 0 | 离线审计 |

- [统一报告](evidence/architecture-v2-a2/unified/docs/v2-pilot/evidence/cm-step6/verification.json) SHA-256：`12471fd854ec027a045db4c52975ac53598401c63cb74ef12929956937412d0b`。
- [证据 hash 清单](evidence/architecture-v2-a2/final-checks.json) SHA-256：`ee3867bbb3670507fc5211a29071a3bc4e361c4c39cc67ed06db44a18447e553`。包含运行时随机编号、源码提交、命令及逐文件 hash。
- [运行记录](evidence/architecture-v2-a2/runner.log)、[Electron 结果及截图](evidence/architecture-v2-a2/unified/docs/v2-pilot/evidence/electron-smoke/result.json)、[实际夹具别名](evidence/architecture-v2-a2/unified/docs/v2-pilot/evidence/electron-smoke/home-fixture.json)。
- 冒烟 SHA-256：`9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f`；冻结检查器：`f45f10aa5f644fdc450d9e8ffef81d45d48f53f38d7455cca00c611b4e43c46a`。

## 5. 偏差与后续关口

首轮统一验证 `8287c77` 退出 1：UTC runtime 为 1124/0/7，桌面为 621/3/0。三项失败来自 TG 存储 scope 与权限目录耦合。改 `autonomyBinding()` 从宿主当前项目取得权限目录，原断言复测 3/3 后重新跑完整统一验证。[失败原报告](evidence/architecture-v2-a2/prior-unified-failure.json) 保留，不作为通过证据。

中间两次 worker 锁测试漏传 `--home`，误写默认 `~/.serika/data`，不符合全路径临时夹具约定。事后仅核对已知路径元数据和进程参数：[元数据记录](evidence/architecture-v2-a2/fixture-incident-metadata.json)。未读取其中内容，也未删除既存 `~/.serika` 或其新目录；没有本轮遗留 worker。原日用 worker 位于旧日用目录，未重启、停止或改动。此处不能写成“全轮测试都只触及临时目录”。所有 worker 子进程测试已显式传临时 H，最终统一验证使用该修复。

未改 main，未读取日用配置或数据，未调用真实模型，费用 $0；未注册服务或 TG 外发。实现遵循“迁完调用者即删旧 API”和“验证实际产物”：只保留 H 写入路径，使用实际 store、worker/headless 子进程和 Electron 检查。8 处目录层级推算保持待办。

已知审批约定保持：TG 私聊不会自动得到 main #177 的全工具免确认，host Shell 仍逐次确认。自主 Shell 默认断网及 S2 域名放行属于后续 S；未提前切换系统沙箱，Seatbelt 先验收、bubblewrap 随后，两者通过前保留 Docker。d2 仍仅演练，真正切日用时另获授权，用保留的同一导入器导入新的一致快照。D13 用户未告知的 main 功能不列切日用必做项。

本轮交付后停在 a2，等待审核，不开始 b0。
