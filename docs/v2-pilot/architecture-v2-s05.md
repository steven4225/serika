# S05 补正、运行时解析与切日用手册

## 1. 改了什么

相对已审核 `9ad2b9c`，源码提交为 `217ca43` 和 `e03b1b5`，最终验证绑定干净 `e03b1b5a7ee20994c254fbc3b01d030b167a4e37`。仅工作于 `experiment/architecture-v2`；本轮没有切日用。

- `seatbelt-policy.ts` 增加获批的 `/bin`、`/usr/bin`、`/usr/sbin` 只读执行范围。删固定 Cellar、opt 与 npm/pnpm 清单，不新增其他系统权限。
- `seatbelt-runtime.ts` 在 runner 启动时从 PATH 解析 Node/Git 真实路径；系统 Git launcher 用 xcrun 定位实际二进制。在独立临时目录，用重建的 10 项无凭据环境执行版本探测，采集 dyld 实际加载映像；otool 只为已加载库补充精确 install-name 目录。仅授权实际可执行文件、这些精确库目录和既定系统目录。解析失败、缺工具或命中 H/敏感/可信配置/源码保护路径均失败关闭，无 host fallback。Node 升级后重启即重建清单。
- `seatbelt-shell-runner.ts` 只消费一份解析结果；真正启动命令前复查取消，避免启动解析等待后再派发已取消命令。原文件、网络、环境、process-info、sysctl 与进程组策略保持。
- [切日用手册](cutover-runbook.md) 只写未执行；包括 main 全部写入者停机、一致快照、实际导入命令、无 transcript 的 Thread 和各类条数、首次只读检查与回滚。npm/pnpm、Node 子进程、其他 Homebrew 工具记入 [pending.md](pending.md)，Docker 保留。

本轮应用 pstack 的边界校验、迁完调用者即删除旧 API、实物验证原则：所有路径检查集中于解析器，固定路径导出全部删除，真实 Electron 经原 preload/IPC/Controller 执行；没有保留第二套路径、权限开关或新执行器。查阅旧约束中的 unknown 不重试、Shell never-remember、Docker 不回退、后台/worker 不继承、凭据与服务授权条目；本轮没有改动这些约定。

## 2. 逐条对照验收项

N 为 [原生结果](evidence/architecture-v2-s05/electron/native-result.json)，E 为 [真实 Electron 结果](evidence/architecture-v2-s05/electron/electron-result.json)，A 为 [权限审计](evidence/architecture-v2-s05/audit/audit.json)。均从干净最终源码生成。实测 macOS 27.0.1 / Darwin 27.0.0 arm64，Node v26.4.0，实际解析 Git 2.55.0，Electron 44.4.5。E 使用离线假模型发起真实工具，不调用真实模型。

| 验收项 | 实际结果 |
|---|---|
| S05 六个命令 | 已做。N `checks.runtime` 与 E `S05-ls/cat/grep/sed/find/git-status` 六项均退出 0，E 无逐条审批。`find ./readable -type f` 检查普通目录；`git status` 检查临时 Git 仓库。截图见 [S05-system-commands.png](evidence/architecture-v2-s05/electron/S05-system-commands.png) |
| 动态路径及升级 | 已做。`startup discovery follows a Node upgrade...` 同时模拟可执行路径及版本化 lib 目录更新，旧版本路径不再授权；`missing discovery and protected executable, library or config directories fail closed` 覆盖缺失、空结果、探测失败、受保护路径。N `runtimeUnavailable` 证明拒绝后无 host 标记文件 |
| S03/S04/S06/S07/S08 | 已做回归。N/E 的未授权写、H/config/data、Keychain/浏览器资料哨兵、凭据文件、任意层 .env、可信配置 lock/temp、保护父目录 rename、链接越界均阻断；环境只记变量名与 blocked，不含值或值的 hash。A 及完整权限测试保持其他授权判定 |
| S09/S10/S11/S12 | 已做回归。N/E IPv4/IPv6 TCP、UDP、bind/listen、Unix 新连接拒绝；对端包数/连接数为 0，额外 fd/socket 为 0；Mach、外部 signal、脱组和 posix_spawn 拒绝，fork/exec 后代仍受同一限制 |
| S13 与 S15 硬前提 | 已做且通过。E 的真实 Electron 主进程为跨进程读取目标，数字 MIB、proc-info/path、task ports 均拒绝，宿主假 canary 名称正对照可见；取消后两代后代 PID 消失、心跳停止。已执行工具的取消回执仍可为 unknown，不伪装零副作用。N `unknown` 故障注入仍 nonretryable，`cancelledDuringStartup` 无命令标记文件 |
| S01/S02/S14 与 worker | 已做。E 桌面自主不逐条确认；两次 host 含本地联网命令都需确认。TG 离线 Controller 产生两次独立 host 确认、无外发，见 [TG 结果](evidence/architecture-v2-s05/telegram/telegram-result.json)。b0 的 worker 工具表及既有权限判定保持；未新增 TG 自主 |
| 手册与日用数据 | 已做文档。6 个 shell 块及内嵌 JS 仅语法检查，未执行任何停机、快照、导入或首次日用启动命令；没有读取日用配置或数据 |
| 冻结文件和 Docker | 已做。A 固定原 b0、9ad2b9c b0、两份冻结脚本和权限表的 SHA；Docker 产品代码没有改动 |
| 统一验证 | 已做，只运行一次，退出 0。UTC 和 Asia/Shanghai 每档均 1764 通过、0 失败、7 既有跳过；eval 101/101，冻结真实 Electron 冒烟 8/8，离线审计通过。见 [verification.json](evidence/architecture-v2-s05/unified/verification.json) |

### 实际变化 vs 批准清单

| 对象 | 批准范围 | 实际差异与判定 |
|---|---|---|
| S05 Seatbelt | 新增三个 SIP 系统目录，只读可执行；运行时动态解析 | 与批准一致；未加网络、Mach、process-info、脱组或新环境例外 |
| `desktop/shell_exec` | 相对原 b0 唯一可变化的行 | 保持 S1 已批准替换；本轮相对 `9ad2b9c` 没有字节变化 |
| `telegram/shell_exec` | 必须与原 b0 逐字节一致 | 两边 538 字节，SHA `52f3b1dc3ba35898bef93898b912f53d9521ce23915532e14a69c9c6c73f54d3`，一致 |
| b0 其他内容及 S01–S15 其他规则 | 不允许新增差异 | A 验证完整 b0 恰等于原文件仅替换 desktop 一行；额外 changed keys 为空。b0 当前 SHA `d0b820f3eef8a8230d951e8e4da3d53cde0756b776b7645ffc00980dbbcc2e07`，与 `9ad2b9c` 全文件相等。未批准差异一律失败 |

## 3. 前后数字

相对 `9ad2b9c`，Git numstat；文档、证据和其中的示例代码不算产品/测试。完整逐文件统计见 A `lineChanges`。

| 类别 | 增 | 删 | 净 |
|---|---:|---:|---:|
| 产品 | 126 | 70 | +56 |
| 迁移工具 | 0 | 0 | 0 |
| 测试及验证 | 78 | 7 | +71 |

没有删除测试文件；原生诊断中移除固定 npm/pnpm 版本命令，因为它们已由用户明确延期，替换为本轮获批的六个命令。不修改 S13/S15 或冻结冒烟、检查器断言。真实模型调用 0、TG 外发 0、服务注册 0，费用 $0。

## 4. 实际命令和退出码

以下均在隔离实验 checkout；基础构建/测试命令由带临时 `--home` 的 shell wrapper 承载，产品进程传显式临时 H。统一验证内部沿用既有 fixtures 和独立 Electron checkout，原脚本未改。

| 命令 | 退出码 |
|---|---:|
| `/bin/sh -c 'pnpm typecheck && node --test packages/assistant/dist/modules/seatbelt-runtime.test.js packages/assistant/dist/modules/shell-module.test.js packages/assistant/dist/permission-boundary.test.js' --home /private/tmp/serika-s05-work/H` | 0，17 项通过 |
| `/bin/sh -c 'pnpm build:runtime && node --test packages/assistant/dist/modules/seatbelt-runtime.test.js' --home /private/tmp/serika-s05-work/H` | 0，2 项通过 |
| `/bin/sh -c 'pnpm typecheck && pnpm --filter @serika/desktop build' --home /private/tmp/serika-s05-work/H` | 0 |
| `node apps/desktop/scripts/seatbelt-s1-electron.mjs --home /private/tmp/serika-s1-s05-final-02/H --output /private/tmp/serika-s1-s05-final-02/evidence` | 0，内含原生 checker 0；Electron 真进程退出 0 |
| `node packages/assistant/scripts/seatbelt-s1-telegram.mjs --home /private/tmp/serika-s1-s05-tg-final-02/H --output /private/tmp/serika-s1-s05-tg-final-02/evidence` | 0，离线无 transport |
| `node packages/assistant/scripts/seatbelt-s1-audit.mjs --home /private/tmp/serika-s1-s05-final-02/H --output /private/tmp/serika-s05-work/audit-final` | 0 |
| `SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-s05-work/final-unified node packages/assistant/scripts/cm-step6-verify.mjs --home /private/tmp/serika-s05-work/verify-H` | 0，两时区全套、eval、冻结冒烟与离线审计均通过 |

证据 manifest：`6cf9e868519825e7ce71cf446b78a0503ad1b67f0b12dcb964dd70c082fd3ca7`。源码、脚本、截图、结果 SHA 及冻结文件核对见 [manifest.json](evidence/architecture-v2-s05/manifest.json)、[final-checks.json](evidence/architecture-v2-s05/final-checks.json)。

## 5. 偏差、出错与限制

- 开发探测曾因未先建 fixture 根目录退出 1，建好独立临时根后重跑；未接触日用目录。第一版只给 canonical 库目录，Node/Git 的 dyld 通过 opt install-name 读取 llhttp/pcre2 时 SIGABRT；增加的只是同一已加载库的精确别名目录，未开放 Homebrew 总目录。
- 初次 `find . -name allowed.txt` 递归进敏感哨兵，退出 1，证据保留于 [find-sensitive-walk.json](evidence/architecture-v2-s05/iterations/find-sensitive-walk.json)。成功用例改为普通目录，敏感负例不动。`git status` 虽退出 0，仍因敏感目录拒绝而有 EPERM 警告；允许看到目录项名称不代表可读正文。Shell 的 `/private/var/select/sh` 拒绝提示沿用 S1，没有为消除提示新增授权。
- `217ca43` 的首轮真 Electron/TG 均通过。复查异步启动后增加取消派发前检查并提交 `e03b1b5`；正式证据已全部重新生成。最终通过不能覆盖或删除上述开发失败记录。
- 手册不是切日用批准。当前导入器拒绝 `~/.serika`，所以写成固定显式新 H，要求 `~/.serika` 先为空；若要使用默认路径，需单独审核边界改动。新快照若不符合第 7 步固定 memory SHA/14 行裁决，也必须停下重新审核，不能改 expectedSha 凑过。
- npm/pnpm、Node 子进程及其他 Homebrew 工具暂未处理；不承诺所有 Git 子命令可用。平台限制仍为已审核的 Darwin 27.0.0/arm64，未扩平台；没有新 Linux 独立复现。本文不另附用户手动检查清单。

提交推送本轮报告和证据后停下等审核，不执行切日用、不迁日用数据、不进入其他阶段。
