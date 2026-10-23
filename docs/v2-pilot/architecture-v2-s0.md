# S0：macOS Seatbelt 探测与待批准规则

## 1. 改了什么

相对已审核的 `6f12544`，源码提交依次为 `6bed4ff`、`390c719`，最终验证绑定 `390c719`。只新增 `packages/assistant/scripts/seatbelt-probe.mjs`，没有修改产品装配、配置解析、审批、回执或快照。S0 已完成探测；S1 未实施，自主 Shell 未启用。当前候选 profile 存在已证实的跨进程环境读取、继承 socket 和脱组取消缺口，不能用于自主执行。

探测在真实 macOS 27.0.1 build 26A434，Darwin 27.0.0 / arm64、Node v26.4.0 上运行。`/usr/bin/sandbox-exec` 可执行，default-deny profile 能启动 Shell、Node、CLT Git，以及由 Node 执行的 npm/pnpm 版本命令。缺执行程序和缺 profile 均拒绝进入探测，没有 host fallback。此结论只覆盖当前机器和当前运行时版本。Apple 本机 man page 已把 sandbox-exec 标记为 deprecated，profile 接口亦可能变化，运行时仍须失败关闭。

留下可重跑的探测工具，不把 S1 runner 提前接入产品。所有数据夹具、进程心跳、网络端点和敏感哨兵均在新建私密临时目录。凭据检查仅枚举父进程变量名，子进程环境从固定字段重新构造；证据不含变量值或值的 hash。

## 2. 逐条对照验收项

### 固定比较基线

| 文件 | SHA-256 | 本轮结果 |
|---|---|---|
| `packages/assistant/src/permission-boundary.snapshot.json`，b0 | `b988e469ca6c830690358de82db65b67a316e9c0256bfa993b3199f8c2e68670` | 逐字节不变 |
| `packages/assistant/src/permission-decisions.snapshot.ts` | `08acd418d5d3831504b7393f72472c2910093a4b4b5d70394275f9847981bace` | 逐字节不变 |
| `apps/desktop/scripts/electron-smoke.mjs` | `03a3c7e6d174842edda61770f8f17b7480e6545ee52ffbda2f63a288d07a6c34` | 沿用 d1 获批输入迁移后的版本，8 项检查与判定未改 |
| `examples/eval/cm-step6-live.mjs` | `6a5572c3a0a37bb0979e2badcbc3cdbd16cda0849683c716f096a43815de1546` | 沿用 d1 获批单行配置迁移后的版本，判定未改 |

比较基准是上述原 b0 字节及当前 `6f12544` 的测试输入。e 已审核删除的四个配置模式及 policy 元数据仍按现有测试投影处理，不恢复、不扩大投影。以下清单全部是**待用户批准**，本轮实际权限变化为零。

### S1 与规则切换的完整拟议变化表

A 是本次 Run 已验证的单个授权目录，H 是显式配置的应用数据 home，T 是每次调用新建的私密临时目录。下表只改变有效自主 primary Run 的 Shell 路径；显式 host 和 Docker 沿用原规则。没有列出的规则一律不能变。

| 规则名 | 现在，相对固定 b0 | 批准后改成 | 原因 |
|---|---|---|---|
| S01 桌面自主 Shell | Shell 模块启用且有效 desktop grant 的 primary Run，仍使用 host、逐条确认；b0 `desktop/shell_exec` 被测试订阅者 deny | grant 与规范化 A 精确匹配、可信桌面入口且无显式 Docker 配置时，Shell 必须走 Seatbelt，不再逐条确认。Seatbelt 不可用则拒绝；不得执行 host | 用户批准的 S1 自主规则切换，免确认必须绑定 OS 限制 |
| S02 TG 自主 Shell | 独立 TG grant 经可信 gateway 验证且 bot/user/private chat/Thread/A 精确绑定后，Shell 仍使用 host、逐条确认；b0 `telegram/shell_exec` 被 deny | 仅同一既有绑定的 TG primary Run 使用 Seatbelt 免逐条确认；不继承 desktop grant，不扩大账号、会话、Thread 或工具范围。无效绑定仍逐条确认 host | 与桌面使用同一 Shell 隔离条件，保留 TG 信任边界 |
| S03 Seatbelt 失败关闭 | 尚无 Seatbelt 路径；host 和 Docker 是现有路径，Docker 失败不回退 | 不支持平台、缺程序、profile 不可编译、启动失败或能力核对失败都拒绝 Seatbelt 调用。模型参数不能选 host；host 只能走用户明确选择并逐次确认的路径 | 后端不可用不能变成更大的权限；缺程序与缺 profile 的拒绝已在探测器验证 |
| S04 Shell 可写路径 | 用户确认后 host Shell 具有宿主写权限，cwd 只限制工作上下文 | 拒绝以 `/`、`/Users`、用户主目录、`/opt/homebrew` 或只读运行时根本身为 A。Seatbelt 仅允许 A 与 T 写入，`/dev/null` 仅作丢弃设备；A/T 以外写入拒绝。没有共享可写系统 tmp、全盘可写挂载或主目录写权限。受保护路径优先于 A | 把单目录授权落实为 OS 写边界 |
| S05 Shell 可读路径与运行时 | host Shell 可读宿主用户可读内容 | Seatbelt 默认拒绝读取，仅开放 A、T、可信探测/执行入口与已确认的运行时只读路径；祖先只允许必要 metadata；系统 sysctl 读取须同时满足 S15 的跨进程保护。保护运行时和应用代码不可写，即使它们位于 A 下。禁止放开整个 `/`、`/Users`、`/opt/homebrew` 或完整应用数据目录 | Node/npm/git 需要运行时，但它们的存在不能授予全盘读写 |
| S06 敏感与可信文件保护 | host Shell 没有 OS 层敏感路径拒绝规则 | Seatbelt 显式拒绝 H、可信外部配置及其锁/临时替换文件、日用数据目录、用户 `.ssh`/`.aws`/`.gnupg`、`.netrc`/`.npmrc`/`.pypirc`/`.git-credentials`、`.docker/config.json` 及整个用户 `~/Library`，含 Keychains 与浏览器资料；A 内任意层 `.env`/`.env.*` 和同名凭据路径也拒绝读取或写入。解析后的真实路径仍受保护；授权父目录不能覆盖。只用假哨兵验收 | 阻止密钥、数据与权限配置被子进程读取或改写；不以读取真凭据证明保护 |
| S07 符号链接和 cwd | host Shell 进入已校验的 workspace-relative cwd 后，命令自身仍可沿链接访问外部 | 启动时校验 A/cwd 的规范路径与路径分量；执行期间由 Seatbelt 在解析目标上限制读写，A 内链接不能逃逸写范围或进入敏感/可信只读路径 | JS 侧字符串检查不能覆盖命令内部的链接访问 |
| S08 Seatbelt 环境 | host `commandEnvironment()` 复制大部分父环境，仅按 API_KEY/TOKEN/SECRET/PASSWORD/PASSWD/AUTH/CREDENTIAL/COOKIE/PRIVATE_KEY 名字黑名单过滤 | Seatbelt 完全新建环境，仅传 `HOME`、`TMPDIR`、固定 `PATH`、`LANG`、`LC_ALL`、`TZ`、`OPENSSL_CONF`、`GIT_CONFIG_NOSYSTEM`、`GIT_CONFIG_GLOBAL`、`GIT_TERMINAL_PROMPT`。HOME/TMPDIR 指向私密 T，OpenSSL/Git 全局配置指向空设备；语言与时区由宿主固定。未列名变量一律不继承，包括 API key、AWS_ACCESS_KEY_ID、SSH_AUTH_SOCK、GPG_AGENT_INFO、代理、NODE_OPTIONS/NODE_PATH、DYLD_*、BASH_ENV/ENV/ZDOTDIR/PYTHONPATH。host 现有过滤保持 | 黑名单漏掉未知凭据与运行时注入变量；新环境不复制凭据值 |
| S09 默认断网 | host Shell 没有网络隔离，Docker 已断网 | Seatbelt 不开放任何 network 权限，拒绝 IPv4/IPv6、TCP/UDP、DNS、loopback、裸 IP、监听和 Unix socket 新连接。不配置域名、代理或网络例外。联网命令须另走逐次确认 host | S2 之前默认断网；不能通过代理或本地服务绕过 |
| S10 继承描述符 | 现有 host 使用 ignore/pipe/pipe；没有 Seatbelt 下的 socket 防绕过验收 | Seatbelt launcher 仅提供新建的 0/1/2 标准流，不传应用 fd、IPC handle 或已连接 socket；验证任意额外 fd 不可用，不只检查 fd3。不把 network deny 当作关闭旧 socket | 本机故意传入已连接 fd3 后仍成功发出 12 字节，证明仅网络 profile 不够 |
| S11 外部进程控制 | host Shell 可调用宿主允许的进程控制或 IPC，原权限规则不声称其受沙箱保护 | Seatbelt 不开放 Apple Events、未申报 Mach/IPC、agent socket 或向外部进程发信号；禁止借 Herdr、浏览器既有进程等代做副作用。未来必要的系统服务例外必须另列规则、另获批准 | 已有进程的副作用不属于子进程文件隔离；Computer/浏览器控制仍独立逐次审批 |
| S12 后代约束 | host 后代没有 OS 文件/网络边界；Docker 按容器边界 | Seatbelt 内 fork/exec/脱组后代都继承同一只读、写范围、敏感路径、环境、fd 与断网限制，不能通过另起 shell/Node 脱离。S1 必须实测后代网络与注入，S0 当前只证明普通/脱组后代的文件限制 | 只约束直接子进程不足以授予自主 Shell |
| S13 取消与存活确认 | host 现有负 PID 进程组 TERM，再 250ms KILL；不能证明脱组后代停止 | Seatbelt 调用取消后，其全部后代不得继续。S1 必须实现并验证能覆盖脱组/再派生后代的终止或拒绝创建机制，不能沿用进程组即判通过。无法确认后代或执行结果时保留 unknown，停止且不自动重试，不伪装为已取消或无副作用 | 本机脱组后代在组 KILL 后仍有心跳；该缺口未解决前 S1 不通过 |
| S14 权限事实与说明文案 | host/Docker 分支；Shell `remember: never`；自主指令同时存在“Shell 需确认”与“local shell_exec 已授权”的矛盾 | 仅 Seatbelt 分支且有效 primary 自主 grant 才标记可免逐次；Shell 描述、自主系统指令、设置授权说明显示 Seatbelt、A/T、只读依赖、默认断网、敏感拒绝及失败关闭。显式 host 继续显示原逐次确认，Docker 原语义不变；remember 仍 never | 文案、模块权限事实和实际执行后端必须一致 |
| S15 跨进程信息与凭据旁路 | host 可读取当前用户有权读取的进程参数/环境；S0 候选 profile 即使直接环境已清洁，数字 `KERN_PROCARGS2` 仍读到另一个假进程的环境 | Seatbelt 必须拒绝读取其他宿主进程的参数、环境、内存以及调试/task port；只允许自身的已清洁状态。不把 `sysctl-read` 名称过滤当成足够证明。仅 Seatbelt 下的可行机制尚未确定，未证明前拒绝启用，不回退 host，不降低验收条件 | 本轮真进程 canary 已证实环境变量白名单不能封住这个旁路；按 kern.proc 名称拒绝也未拦住 |

本表 S01–S15 的表头至 S15、以 LF 分行并保留末尾 LF 的文本 SHA-256 为 `49c027d0c66bd99160ba6d215697eb73f0077c470e3f7b10d61073b34a325915`，仅用于固定待审核内容，不代表已批准。

S05 的运行时范围采用本次 [probe-result.json](evidence/architecture-v2-s0/probe-result.json) 的 `runtime` 清单：`/bin/sh`、精确 CLT Git 可执行文件、当前 Node 实际路径、其已加载 Homebrew dylib 目录和 opt 链接别名、npm/pnpm 实际 package 根，以及 `/System/Library`、`/usr/lib`、CLT `usr/lib`。不读取全局 OpenSSL/Git 配置。Seatbelt 的对象是 Electron 发起的 Shell 子进程，Electron 宿主仍在沙箱外；本轮清单不授予 Shell 读取 Electron 用户数据或任意 framework/asar 的新权限。S1 要证明 Electron 使用的实际 CLI 可执行文件和依赖仍在这份清单内；如需要新增只读路径，先补充清单获批，不能借运行时探测自行扩大范围。当前 npm/pnpm 证据只覆盖版本命令，不声称 install、项目构建或所有 git 子命令已可用。

S06 中的凭据相对路径在用户主目录与 A 两处都保护，整个用户 `~/Library` 被保护，Chrome、Edge、Firefox、Safari、Brave、Arc 的标准用户资料均落在拒绝范围。若 A 本身处于 H、用户 Library 或其他受保护根内，拒绝启用该 Seatbelt 授权，不能靠规则先后顺序开放它。S1 必须把实际展开路径和拒绝哨兵结果作为证据；不扫描这些真实路径的内容。运行时根不得覆盖受保护目录。探测器本轮只把 H、敏感哨兵和 `.env` 放进真实 profile，其余是待批准的 S1 规则，不能冒称已测。

### b0 允许变化的精确位置

若用户批准上表，当前旧 b0 行仅允许以下变化。S1 要交付全部实际差异与 S01–S15 的对照；任一多出来的差异均判失败。

| b0 key | 现在 | 允许的新值 |
|---|---|---|
| `desktop/shell_exec` | `approvals` 为一条 host 确认，测试 deny；`status=completed`；事件 `tool.call.failed / ok=null / code=TOOL_DENIED` | `approvals=[]`；`status=completed`；事件 `tool.call.completed / ok=true / code=null`。另以真进程回执验证 `pwd` 实际退出 0 且后端为 Seatbelt |
| `telegram/shell_exec` | 与上行相同，但来源为有效独立 TG grant 的 primary Run | 与上行相同，只允许现有可信 TG 身份与 Thread 绑定 |

新 Seatbelt 失败关闭、host 显式选择、断网、敏感路径、子孙/取消和 descriptor 场景另加，不覆盖原输入。旧 `permission-decisions.snapshot.ts` 的 autonomous 是 **host executor** 场景，仍必须 ask；不把它改成 Seatbelt 来获得绿灯。无须改其旧行，Seatbelt 权限事实另测。

保持不变：`plain`、`telegram-desktop-only`、`foreign-grant`、`other-thread`、`tui` 的全部旧行，desktop/telegram 的非 Shell 行，工具集合、命令集合、文件工具授权/记忆、Memory、Skill、Task、web、Computer、recipe、配置内外边界，worker 的空工具集及不继承前台自主。Docker 配置、挂载、断网、不回退和 `/authorize-shell` 仅 Docker next-Run 语义保留。grant 的原身份、A、Thread、idle/CAS、预算与新 Run 快照规则不扩大。回执、verifier、hash、unknown、不自动重试与不重放保持；S13 只增强 OS 子孙清理证据，不放宽结算条件。

### S0 实际观测

| 验收类别 | 真实结果 |
|---|---|
| 后端可用与失败关闭 | 可进入 default-deny；缺程序 ENOENT，缺 profile 非 0；均没有进入 fixture 或 host fallback |
| 写范围与敏感哨兵 | A/T 写成功；目录外写、runtime 写、H/敏感哨兵读取、A 内 `.env` 读取与 symlink 越界写全部 EPERM |
| 后代文件边界 | 普通与 detached Node 后代均保留上述所有文件限制，仍可写 A/T |
| 直接凭据环境继承 | 父进程候选名及额外探测名均 blocked。额外名不等于父进程真实存在凭据。固定构造环境，不复制应用环境；只记录名称/结果 |
| 跨进程环境读取 | 宿主 control 与候选 Seatbelt 均读到了另一个测试进程中的 `PROBE_CREDENTIAL_CANARY`，`blocked=false`；变量值随机生成且不记录。**凭据隔离尚未通过** |
| 默认断网 | 真实本地 IPv4/IPv6/Unix socket 新连接均 EPERM，无公网连接 |
| 已有 socket control | 故意传 fd3 可发出 12 字节，**未拦住**；标准三流启动时 fd3 不是 socket、对端 0 字节。S1 仍需覆盖任意额外 fd |
| 取消 control | 普通后代在组 TERM/KILL 后不再有心跳；detached 后代仍继续。探测器再对自己记录的 PID 精确 KILL，心跳停止；此清理不等于产品取消方案已完成 |
| 本轮统一验证 | 退出 0；UTC/上海各 1762 通过、0 失败、7 跳过；eval 101/101；真实 Electron + 假模型 8/8 |

## 3. 前后数字

相对 `6f12544`，只按代码行统计；文档、JSON 证据和截图不计代码。文件归类见 [line-changes.json](evidence/architecture-v2-s0/line-changes.json)。

| 类别 | 增 | 删 | 净 |
|---|---:|---:|---:|
| 产品 | 0 | 0 | 0 |
| 迁移工具 | 0 | 0 | 0 |
| 测试及验证工具 | 280 | 0 | +280 |

计划对 S0 估计产品 +30～60、验证 +60～100。本轮按用户“只探测”约束没有产品改动；验证工具超上界 180 行，原因是加入真实本地网络端点、继承 socket 正反 control、两类后代取消/清理、环境名称与运行时清单、编译原生 KERN_PROCARGS2 canary control、失败关闭和证据 hash。没有复制产品 runner、引入配置格式或实现 S1 的第二条执行路径。

## 4. 实际命令与退出码

所有探测子进程都携带显式临时 `--home`。原生 Shell/Git/npm 版本命令不支持产品 home 参数，通过带 `--home H` 的 probe 或 `/bin/sh -c ... --home H` wrapper 调用；Git/编译器/Node 测试 runner 为基础工具，进程内产品夹具显式指定临时数据路径。没有调用日用实例。

| 命令 | 退出码与结果 |
|---|---|
| `node --check packages/assistant/scripts/seatbelt-probe.mjs` | 0 |
| `node packages/assistant/scripts/seatbelt-probe.mjs --home /private/tmp/serika-s0-20261023-0D5Arf/probe-complete/H --output /private/tmp/serika-s0-20261023-0D5Arf/probe-result-final.json` | 0，绑定干净源码 `390c719`；S0 观测完成，`s1Accepted=false` |
| probe 内 Shell/Node/CLT Git/npm/pnpm 版本命令 | 全部 0；npm/pnpm 由 Node 直接执行实际入口 |
| probe 内缺程序 / 缺 profile | ENOENT / 65；这是预期拒绝，未进入 fixture |
| probe 内原生 canary 编译、宿主与 Seatbelt 环境读取 control | 全部 0；两个读取 control 均 `blocked=false`，是观测到的绕过，不能算安全验收通过 |
| probe 内普通/脱组取消 control | 两个 leader 都以 SIGKILL 结束；普通后代停，脱组后代继续，随后显式清理停止 |
| `SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-s0-20261023-0D5Arf/unified-final-output node packages/assistant/scripts/cm-step6-verify.mjs` | **0**，typecheck、两时区全套、eval、真实 Electron 冒烟和离线审计全部 0 |
| `git diff --check` | 0 |

统一验证绑定同一干净源码；[verification.json](evidence/architecture-v2-s0/unified/verification.json) 保存每条命令、退出码、输出 SHA 和源码 hash。`unified/live.json` 仍是离线审计读取已提交旧实模证据的投影，原日期/费用不属于本轮；本轮新真实模型调用 0、费用 $0。本次 [Electron 结果](evidence/architecture-v2-s0/electron-smoke/result.json) 与 8 张截图保存在本步专属 evidence 子目录；复制时剔除临时检出继承的旧 step4/step5 报告，原始结果中的输出路径字段保留不改。真实 Electron + 假模型的 8 项冒烟用于确认产品未回归，**并非 Electron 中的 Seatbelt 验收**。

| 证据 | SHA-256 |
|---|---|
| [probe-result.json](evidence/architecture-v2-s0/probe-result.json) | `3f74e090dcee6339abd19e337dd11f16a7921e91288ae57abbad476c77254585` |
| [proposed-b0-changes.json](evidence/architecture-v2-s0/proposed-b0-changes.json) | `763f6e02642080902f3891a8906dc4bc914b901ec661cba1b9e6e39f0070ee1c` |
| [unified/verification.json](evidence/architecture-v2-s0/unified/verification.json) | `6f4574837dc3ed2defb26a04bded3fcc29c930dd3d9588be611e2533a6413e9e` |
| [sysctl-attempts.json](evidence/architecture-v2-s0/sysctl-attempts.json) | `5659b859e53d6868791bb277e68a8c9d948ad53f4cb6194cef1ac72d9a0ec1d9` |
| [final-checks.json](evidence/architecture-v2-s0/final-checks.json) | `49daa7d037b58f4b5e0b3806f27ee7242303f25a5ebefcc530b759bc6983e3bf` |
| [manifest.json](evidence/architecture-v2-s0/manifest.json) | `8e179700f0ecec055832e43f78e003b0ccc71c9ac2829ff5141dd0990e82829e` |

## 5. 与计划不符的地方及理由

- 初始最小 profile 启动 Node 时 SIGABRT。按实际 dylib、opt 链接别名和祖先 metadata 收窄后仍发现 OpenSSL 全局配置读取；改为清洁环境 `OPENSSL_CONF=/dev/null` 后成功，不开放宿主配置。中间 allow-all-file-read 只用于 scratch 定位，没有进入最终 profile。
- 首次完整 CLI 因 parent 临时目录未创建而 ENOENT，未当作可用性结论；现在要求已有 canonical 临时 parent。第一版运行时 probe 中 `/usr/bin/git` 退出 1，而总体曾记 passed，原因是遗漏了运行时子项断言。已改成直接 CLT Git 并对每个运行时退出码断言；最终均 0。初版 `/dev/fd/3` lstat 被拒绝不能证明 descriptor 被关闭，已改用 fstat 和对端收字节数的 control。
- 尝试在 scratch profile 拒绝 `SYS_setsid`/`SYS_setpgid`，未能阻止 Node detached spawn。最终工具不含这个无效规则。S13 的脱组取消机制仍需 S1 解决，不能拿这次显式 PID 清理当产品答案。
- S0 原计划估计含产品配置/模块增量，本轮用户明确只探测，因此产品零改动；本轮验证工具行数超估，详见 §3。所有失败迭代的原因与最终修正列于本节和 [probe-iterations.json](evidence/architecture-v2-s0/probe-iterations.json)，未把负面 control 隐藏成通过。
- 补充 sysctl 试验把读取收窄至八个硬件/系统名称，Node 以 SIGABRT 退出，wrapper 退出 1；保留原 sysctl-read 并按 `^kern\.proc` 拒绝时，Shell/Node/Git 能启动，npm 退出 7、pnpm 退出 1，wrapper 仍为 1。原生数字 KERN_PROCARGS2 的假进程环境读取依旧未拦住。这两个尝试都没有写进最终 profile，不把不完整名字过滤当成解决方案。新增 S15，是否能仅用 Seatbelt 封住该旁路仍是 S1 的实质可行性问题。为把 canary 纳入可重跑源码，补提交 `390c719` 后从新干净提交重跑统一验证；初次 `6bed4ff` 的验证亦为 0，保留命令 hash。
- 尚未证明真实 Electron 中的 Seatbelt、任意 fd、UDP/DNS/监听、Mach/Apple Events、所有敏感路径哨兵、后代网络、脱组/再派生取消、跨进程凭据保护与 unknown 回执衔接。Mac Node/Shell 的结果不能替代 Electron 证据。S1 必须以真实 macOS Electron、显式临时 `--home`、真进程、退出码与截图验收；Linux 延后，Docker 保留。
- 依据已重读的旧约束，Shell never remember、Docker 不回退、独立 TG 身份绑定、worker 不继承、unknown 不重试继续有效。旧整工具集 host 自主条目已被现架构限制取代；只有上表列出的两条 primary Shell 规则拟切换，其他工具不随之放宽。

本轮运用 pstack 的“构建可重复工具”留下 probe，“验证实际路径”使用本机 OS、socket 与心跳，“分段交付”把规则切换留在用户明确设定的审核口；Karpathy 指南用于保持产品零改动。提交推送后停下，等用户批准 S01–S15 及两条 b0 差异；不进入 S1、日用切换、真实模型、服务注册或 TG 外发。
