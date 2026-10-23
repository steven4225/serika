# architecture-v2 S1：桌面 Seatbelt 与规则切换

## 1. 改了什么

S13、S15 和限定的 b0 差异核对通过；当前沙箱不支持 npm/pnpm，未切日用。

源码提交 `1ad23a6f847d1723331a431628188fcf92550c46`，从审核通过的 `bb5c6e6` 开始，仅在 `experiment/architecture-v2`。正式 native、Electron、TG 和 b0 审计都绑定该提交，`sourceWorktreeDirty=false`。本机 macOS 27.0.1、Darwin 27.0.0、arm64；Electron 版本与 PID 见 [Electron 结果](evidence/architecture-v2-s1/electron/electron-result.json)。真实模型调用 0，费用 $0，TG 外发 0。

| 文件 | 改动与原因 |
|---|---|
| `modules/seatbelt-policy.ts`、`seatbelt-shell-runner.ts` | 默认拒绝的 Seatbelt profile；A/T 写、固定运行时只读、凭据/可信文件保护、sysctl 白名单及 process-info 拒绝；拒绝 setsid/setpgid/posix_spawn；runner 负责私密环境、全新三流、进程组清理和结算等待 |
| `shell-module.ts`、`app.ts`、`module-host.ts`、`assistant-controller.ts` | 只有可信桌面自主 primary Shell 走 Seatbelt。说明按 Run 的真实入口生成；前台回到 idle 前等待 runner 结算。迁完调用者删除旧 `allowDesktopAutonomy` API，收尾 API 同步改为 async |
| `desktop-runtime.ts`、`foreground-autonomy.ts`、`capabilities.tsx` | 显式传 H；说明桌面沙箱、默认断网、失败关闭，以及关闭自主后逐条确认的 host 路径。TG 设置不变，Docker 保留 |
| `seatbelt-s1-*` 验证脚本、smoke provider 与受影响测试 | 真 Mac 原生系统调用、真 Electron + 原 preload/IPC/Controller、离线受信 TG 入口、b0 字节核对。假模型只提出真实 Shell 调用，不注入工具结果 |
| step4.5 计划 | S02 记为切日用后再评估，固定本次批准范围与 S13/S15 前提 |

## 2. 逐条对照验收项

N = [native-result.json](evidence/architecture-v2-s1/electron/native-result.json)，E = [electron-result.json](evidence/architecture-v2-s1/electron/electron-result.json)，T = [telegram-result.json](evidence/architecture-v2-s1/telegram/telegram-result.json)，C = [补充边界探测](evidence/architecture-v2-s1/supplement/result.json)。N/E 在同一真实 Mac、不同进程形态运行；补充脚本与 hash 一并保留。表内失败的负例退出码是预期拒绝，不代表命令执行成功。

| 规则 | 实际实现与真实 Mac 证据 |
|---|---|
| S01 已做 | E `S01-S10-S11-S15`：桌面自主 Shell 真执行，退出 0，没有 `approvalRequestedAt`；原 b0 `pwd` 行由确认/拒绝变为无确认/完成；另有 [真 Electron pwd 回执](evidence/architecture-v2-s1/pwd/pwd-result.json) 与截图证明 cwd=A、退出 0、无审批 |
| S02 保持原规则 | **未切换**。T 有有效独立测试 TG grant，连续两次 Shell 各要求一次 host 确认，批准后才能写临时 B，证明没有套用桌面 Seatbelt。没有连接 Telegram 服务或发送消息 |
| S03 已做 | N `S03` 的不合法授权返回 `SANDBOX_UNAVAILABLE`；缺程序 ENOENT、坏 profile 非 0 且没有执行 fixture；C 的根授权/链接/cwd 越界均拒绝，fallback 哨兵始终不存在。模型参数不能选择 host |
| S04 已做 | N/E `filesystem`：A 与私密 T 写成功，B 写 EPERM；C 根目录授权拒绝；保护目录及其祖先重命名也拒绝 |
| S05 已做，有兼容限制 | N `runtime`：Shell/Node/CLT Git 退出 0，运行时写 EPERM。路径固定于 S0 清单，无全盘读例外。**npm/pnpm 版本命令均 SIGTRAP、exitCode=null，当前不支持**；没有称为可用。仅保留路径读取清单不等于这些程序所有行为可执行 |
| S06 已做 | N `expandedSensitiveRoots` / `policy-reference.sb` 固定实际展开路径；假 H/Library/Keychains/浏览器资料、A 中凭据文件和 `.env` 等读写拒绝；带 `[]` 的可信配置、lock、替换临时文件均拒绝。参考 profile 的 T 是占位路径，实际 runner 另加入应用源码根保护。E 的真实临时 H/config/data 同样拒绝。没有读取真实凭据或日用数据 |
| S07 已做 | N/E 的链接越界写、敏感链接读拒绝；C 实测 A 链接分量、cwd 链接、`../B` 拒绝，规范子目录 cwd 的正对照退出 0 |
| S08 已做 | runner 完全新建批准的 10 项环境；N/E `environment` 仅列变量名与 blocked。Electron 启动环境中随机假 canary 的宿主正对照可见名称，沙箱直接环境不可见。没有保存、打印或 hash 变量值 |
| S09 已做 | E `network` 原生 IPv4/IPv6 TCP connect、UDP sendto、bind/listen 全 EPERM；`filesystem` 的 loopback/Unix 新连接拒绝；测试端 TCP 连接 0、UDP 包 0。DNS 传输被 UDP 拒绝；Node DNS 初始化另以 SIGTRAP 终止，不能把它算作可用 DNS。无公网访问 |
| S10 已做 | N/E 原生 helper 从 fd3 扫描到实际 RLIMIT_NOFILE，额外 fd=0、socket=0。N 的宿主故意传已连接 fd 正对照检测到 1 个 socket；launcher 没有继承它 |
| S11 已做 | E `externalSignal` EPERM；cfprefsd 与 Apple Events 的 Mach service lookup 均返回 1100。未开放代理 socket、Mach 服务或外部进程代做副作用的权限 |
| S12 已做 | N/E `fork-exec` 后代继承相同文件、环境、TCP/IPv6/Unix 限制；Node detached `posix_spawn` 返回 EPERM。没有放开脱组 API |
| S13 已做，硬前提通过 | E `cancellation`：双重 fork、父进程先退出、setsid/setpgid 拒绝，TERM 后再 fork 的后代也消失；到 idle 后两次心跳相同、两个 PID 均 ESRCH。取消回执仍为 **unknown**，未伪装成已知零副作用。N 的真实命令后注入组观测 EPERM，得到 `TOOL_OUTCOME_UNKNOWN/retryable=false`，只调用一次；注入部分明确属于故障测试，不冒充自然 OS 故障 |
| S14 已做 | 桌面描述与授权说明显示 Seatbelt/A/T/断网/失败关闭；TG/host 原逐次确认文案保留，`remember=never`。baseline 历史文件不改，按批准内容比较说明差异；E 两次 host 确认截图与原权限文案一致。worker 不继承由 b0 及原受影响测试继续验证 |
| S15 已做，硬前提通过 | N/E 原生数字 `KERN_PROCARGS2`、`KERN_PROCARGS`、`KERN_PROC_PID`、proc_pidinfo/path、task/read/inspect/name port 全拒绝；E 以自己的真实 Electron 主进程为目标。宿主正对照确实看到假变量名称，沙箱 sysctl 返回 EPERM、名称不可见。task port 有些正对照本来已被 OS 拒绝，不把这些结果单独归因于 Seatbelt。未采用“启动环境去密钥”的备选 |

### 实际变化 vs 批准清单

基线 b0 SHA `b988e469ca6c830690358de82db65b67a316e9c0256bfa993b3199f8c2e68670`；新 SHA `d0b820f3eef8a8230d951e8e4da3d53cde0756b776b7645ffc00980dbbcc2e07`。完整 [b0.diff](evidence/architecture-v2-s1/audit/b0.diff) 与 [audit.json](evidence/architecture-v2-s1/audit/audit.json) 均由核对脚本生成。

| 比较对象 | 批准范围 | 实际变化 | 判定 |
|---|---|---|---|
| `desktop/shell_exec` | 只允许这行变化 | `approvals=[]`、`status=completed`、`tool.call.completed/ok=true/code=null` | 一致 |
| `telegram/shell_exec` | 不允许变化，S02 延后 | **与 b0 逐字节一致**，两边 538 字节，SHA 都为 `52f3b1dc3ba35898bef93898b912f53d9521ce23915532e14a69c9c6c73f54d3` | 一致 |
| b0 所有其他行、字段及格式 | 不允许变化 | 将基线仅替换 desktop 行后，完整文件字节与实际文件相等；没有新增投影或删除其他旧行 | 一致 |
| 未列入批准清单的规则 | 一律不允许变化 | b0 实际 changed keys 恰为 `["desktop/shell_exec"]`，额外差异为空 | 一致；任何额外差异均判失败 |
| `permission-decisions.snapshot.ts` | 不变 | SHA `08acd418d5d3831504b7393f72472c2910093a4b4b5d70394275f9847981bace` | 逐字节不变 |
| 冻结 8 项 Electron 冒烟 | 输入和判定沿用审核版本 | SHA `03a3c7e6d174842edda61770f8f17b7480e6545ee52ffbda2f63a288d07a6c34` | 逐字节不变 |
| 冻结检查器 `cm-step6-live.mjs` | 不变 | SHA `6a5572c3a0a37bb0979e2badcbc3cdbd16cda0849683c716f096a43815de1546` | 逐字节不变 |

### Mac 手动检查，4 步

1. 在实验检出目录构建，然后启动交互检查。使用全新根，不使用日用配置。下面的 Electron 是真进程，模型为离线脚本，测试网络只连它自己创建的 loopback 端点。

   ```sh
   cd /Users/a1-6/.codex/worktrees/cm-step0/aisdk-agent-framework
   S1_MANUAL_ROOT=$(mktemp -d /private/tmp/serika-s1-manual-XXXXXX)
   mkdir "$S1_MANUAL_ROOT/gui" "$S1_MANUAL_ROOT/tg"
   /bin/sh -c 'pnpm build:runtime && pnpm --filter @serika/desktop build' --home "$S1_MANUAL_ROOT/gui/H"
   node apps/desktop/scripts/seatbelt-s1-electron.mjs --home "$S1_MANUAL_ROOT/gui/H" --output "$S1_MANUAL_ROOT/gui/evidence" --interactive
   ```

2. 观察自主检查没有确认框。脚本提示停止时，在 Electron 点 **停止本轮**。脚本检查双重派生和 TERM 后再派生的后代全部停止；失败会退出 1，不能继续当作通过。
3. 随后两条 host 命令必须各出现一次确认。在界面分别核对并点 **允许本次调用**。第二条含 `node:net`，需联网并连接临时本地测试端点，必须仍先确认；最终 `hostNetworkConnections=1`、Electron 退出 0、`status=passed`，截图保存在指定 evidence 目录。
4. 运行下面的离线受信 TG 入口检查。分别输入 `y`、`n`，必须看见两次独立 host 确认，第二条拒绝后不生成第二个 B 哨兵，最终 `approvals=2/status=passed`。它运行生产 App/Controller 的 TG 授权分支，使用测试身份回调，**不连接 Telegram 网络或声称 TG 外发验收**。

   ```sh
   node packages/assistant/scripts/seatbelt-s1-telegram.mjs --home "$S1_MANUAL_ROOT/tg/H" --output "$S1_MANUAL_ROOT/tg/evidence" --interactive
   ```

## 3. 前后数字

相对 `bb5c6e6`，以源码提交的 numstat 加附带的 23 行边界探测和 26 行真实 Electron pwd 脚本计算，见 [line-changes.json](evidence/architecture-v2-s1/line-changes.json)。文档、JSON 回执、b0 快照和图片不计代码。无测试文件删除。

| 类别 | 增 | 删 | 净 |
|---|---:|---:|---:|
| 产品 | 239 | 24 | +215 |
| 迁移工具 | 0 | 0 | 0 |
| 测试与验证工具 | 620 | 22 | +598 |

产品低于 400 行。验证新增多于产品：原生 syscall/fd/网络 helper、再派生取消夹具、真 Electron 驱动、离线 TG 两次确认、b0 字节审计和可交互手查分别覆盖不同安全边界，没有复制产品 runner。S1 估计需按这些实际安全验收面修正，未因此增加产品授权范围。

## 4. 实际命令和退出码

所有新产品探测都显式传临时 `--home`；Shell/clang/Git/npm 等不接受产品参数的命令由携带 `--home H` 的 runner 或 `/bin/sh` wrapper 承载。统一验证中的基础构建/测试 runner 沿用既有实现，产品夹具仍使用独立临时目录。正式命令根为 `/private/tmp/serika-s1-final-pM8GN5`，没有加载日用配置或测试密钥。

| 命令 | 退出码 / 结果 |
|---|---|
| `pnpm typecheck`，临时 home wrapper | 0 |
| `node --test packages/assistant/dist/permission-boundary.test.js packages/assistant/dist/baseline-assembly.test.js packages/assistant/dist/modules/shell-module.test.js`，临时 home wrapper | 0，20 通过，0 失败 |
| `pnpm --filter @serika/desktop exec tsx --test src/main/foreground-autonomy.test.ts`，临时 home wrapper | 0，7 通过，0 失败 |
| `node apps/desktop/scripts/seatbelt-s1-electron.mjs --home ROOT/electron/H --output ROOT/electron/evidence` | 0；内部原生验证工具 0；真实 Electron 主进程退出 0，6 张聊天/审批截图 |
| `node packages/assistant/scripts/seatbelt-s1-telegram.mjs --home ROOT/telegram/H --output ROOT/telegram/evidence` | 0，2 次独立 host 确认，无 TG 外发 |
| `node packages/assistant/scripts/seatbelt-s1-audit.mjs --home ROOT/audit/H --output ROOT/audit/evidence` | 0；唯一 desktop b0 差异；冻结 hash 全相等 |
| 补充 `probe.mjs --home ROOT/supplement/H --repo EXPERIMENT_CHECKOUT` | 0；4 个拒绝分支、1 个规范 cwd 正对照 |
| 补充 `pwd.mjs --home ROOT/pwd/H --repo EXPERIMENT_CHECKOUT` | 0；真实 Electron `pwd` 退出 0，无审批，cwd=A，主进程退出 0 |
| `SERIKA_CM6_VERIFY_OUTPUT=ROOT/unified node packages/assistant/scripts/cm-step6-verify.mjs --home ROOT/unified-H` | **0**；UTC/上海各 1762 通过、0 失败、7 跳过；eval 101/101；冻结真实 Electron + 假模型 8/8 |
| `git diff --check` / 提交前 evidence 扫描 | 0，见 final-checks.json |

| 证据 | SHA-256 |
|---|---|
| [Electron](evidence/architecture-v2-s1/electron/electron-result.json) | `c631729ea9067ac8b7ac0613e407d0d60dd9f68d1aad687724d16e66990fea3f` |
| [native](evidence/architecture-v2-s1/electron/native-result.json) | `046f6c0d5fef46559e73a24ef9a3d28726d8b3ab421fdbccfbe8f833d7ae3e26` |
| [TG](evidence/architecture-v2-s1/telegram/telegram-result.json) | `a501fb74c05831c8f301b537c89280ae27cb426504db5b6b11a88594055cf88d` |
| [b0 audit](evidence/architecture-v2-s1/audit/audit.json) | `b0ade20a192ba693cdafe5095290e6e048910a0a62e8fac92759d6305a68a366` |
| [unified verification](evidence/architecture-v2-s1/unified/verification.json) | `d15241ac6fe5327b246fb2bc99e8c85faf92dcd19fef640b1d39218869e86597` |
| [supplement](evidence/architecture-v2-s1/supplement/result.json) | `93c31df5fe390745691a8713c72ad71500793ecb41a67e6e5859c0dbc6b7bc42` |
| [Electron pwd](evidence/architecture-v2-s1/pwd/pwd-result.json) | `38e1691c20f3dc576d2ab37d2f5318169269cc9ce596ccd06e83a3f9867c2878` |
| [line changes](evidence/architecture-v2-s1/line-changes.json) | `e5267edc3f8d7e813c6291573b67b346126465cc1026931c53b40093be523c9c` |

正式材料使用各自运行时 UUID；[manifest.json](evidence/architecture-v2-s1/manifest.json) 覆盖本轮所有证据文件的 SHA-256。统一验证的旧实模审计投影仍属于历史批次，不属于本轮真实模型调用。

## 5. 与计划不符的地方及理由

- 探测迭代并非全为 0。宽泛 sysctl 或给 process-info 加 self 例外的早期 scratch 未能保护跨进程信息，已弃用；原始 scratch 曾覆盖，不补造这些迭代的运行字段。开发失败 JSON 中的图片 hash 保留原样，但这些开发截图未提交，也不作为正式图片证据。完整脚本中先遇到 Node 缺 uname 必需 sysctl 而 SIGABRT，加入 `kern.hostname/kern.version` 后文件探测可用。开发失败报告保留原字节，见 [iterations](evidence/architecture-v2-s1/iterations)。
- 扩展原生检查发现可信路径手写正则的转义错误，含 `[]` 的假配置仍可读；改用系统 profile 中已有的 `regex-quote`，并加读写及祖先重命名负例。没有把配置临时文件留成旁路。
- 真 Electron 中发现取消后 Run 先回 idle、后代心跳仍短暂变化。修改为等待 Seatbelt runner 结算，再结束前台上下文。取消调用的执行结果保留 unknown，正式证据同时证明 OS 后代已停止，没有把 unknown 改成成功或无副作用。
- S15 为拒绝全部 process-info，而不是开放 self 例外；setsid/setpgid/posix_spawn 全拒绝。依赖这些 API、未列入 S0 的独立可执行文件，或需要 Mach/DNS 初始化的程序可能不能运行。**已实测 npm/pnpm 和 Node DNS 为 SIGTRAP**，不声称可用于所有构建、install 或 Git 子命令。没有加入任何 S11 系统服务例外；需要这些操作时由用户关闭自主，再逐条确认 host。这是当前沙箱的兼容限制，切日用仍未批准。
- 测试期的几个错误也保留说明：根目录 `--import tsx` 因依赖解析失败退出 1，改用已构建 dist；一次 Node `--version --home` 的参数组合退出 9，改由 Shell wrapper 承载 home；早期 b0 与 host 文案断言暴露批准中的桌面差异；说明缓存一度按初始化入口生成了 host 文本，已改用真实 Run entry。首次 Electron 宿主正对照错误发送 SIGUSR2，终止的仅为本次临时 Electron，现正对照明确 read-control；清理代码也改为保存真实 child handle。TG 检查最初把预览就绪前后的同一审批事件算了两次，现只处理非空 preview。首次开发截图带有默认高级侧栏，未提交这些图片，正式截图收起侧栏后重跑；有两次错误文档锚点 patch 被原子拒绝、若干路径诊断命令退出非 0、首次 staged diff-check 发现 EOF 空行后已修正。证据打包首次 Python heredoc 遇到编码解析错误，未执行复制，改为 ASCII 打包脚本后成功。前缀扫描初版把五个测试文件路径中的 task 后缀误报成 sk- 前缀；核对命中仅为 lineChanges.path，改为带词界的前缀扫描后为 0，未输出匹配值。
- 一次早期 targeted 命令未套显式 `--home` wrapper，夹具仍全用临时目录，未访问日用数据；后续正式命令采用显式临时 home。命令层偏差不隐瞒。

| 变动的测试预期 | 旧预期 | 新预期与依据 |
|---|---|---|
| desktop foreground autonomy | 多步 Shell 9 次确认、WorkTask Shell 1 次确认 | 均为 0，依据批准 S01；TG/host 确认用例保留。用 Shell builtin/Node 替换不在只读清单中的 cat/sleep/touch，文件结果与取消要求保留 |
| shell-module / assembly | host 自主可写成已授权；旧 Shell 说明 | host 始终确认；桌面使用准确 Seatbelt 说明，依据 S14；历史 assembly 文件不改，原 b0 除 desktop 一行不改 |
| 新增 S05 诊断工具的开发断言 | 所有版本命令均应退出 0 | Shell/Node/Git 要求 0；npm/pnpm 原始非 0 留为 unsupported，不计为可用运行时。这个诊断预期不覆盖 S15 的阻断条件，也未通过开放新权限让程序跑通 |
| 新增 Electron 取消检查 | 必有 `shell.cancelled=true` 回执 | 保留实际 unknown 回执，同时严格要求 idle 后 PID 全消失、心跳不再变；执行是否已产生副作用仍未知，依据 S13 与原 unknown 不重放规则 |

未在 Linux 实测。没有新增 32K 或日用大窗口的真实模型测量；本轮禁止真实模型，原上下文离线断言由统一验证回归。

已查旧约束中 Docker 不回退、Shell never remember、独立 TG 绑定、worker 不继承、unknown 不自动重试及取消条目。pstack 用“构建可重跑工具”留下四类验证入口，“验证实际路径”要求真进程/真实 IPC/OS 结果，“分段交付”把切日用留在审核后；Karpathy 指南限制改动于本轮权限与结算边界。决策记录 [decisions.tsv](evidence/architecture-v2-s1/decisions.tsv) 已 inline 审阅；注意项是运行时固定版本与 npm/pnpm/posix_spawn 的兼容限制。没有启用未批准的 S02，没有实施启动环境无密钥的备选；提交推送后停下，等待审核。
