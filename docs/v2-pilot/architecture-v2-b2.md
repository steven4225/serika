# 4.5 b2 第二轮修订回报

两项必改已实现，停在 b2 审核口。既有硬链接风险已实测，另发现符号链接目标与外置 Git 元数据的保护缺口，均待用户裁决。本轮基线 `53f8033`；未进入 c1/c2/S2/S3。

## 1. 改了什么

- `protected-paths.ts` 删除全树扫描。文件工具只检查目标的 realpath、nlink、名单，并沿目标祖先识别 `.git`、gitfile、commondir 和有 HEAD/objects 的 Git 元数据目录；增加 `config.worktree`、锁文件和标准 worktree 路径。普通读请求不探查 Git 控制元数据。
- `search-files.ts` 仅在原有遍历中逐项过滤名单，仍跳过符号链接与多链接文件。Seatbelt runner 删除扫描输入，profile 只来自目录声明、固定保护路径和共享名单。
- 原生探针证明原 `SYS_link`/`SYS_linkat` 禁令不足：授权内 `ln target new-hardlink` 原退出 0，同 inode、nlink=2。保留这两条禁令，并增加有效的 `(deny file-link)`，新路径不存在、源 nlink=1。
- 构建写出 `dist/node-runtime.json`，并检查升级脚本与依赖 dist 存在。CLI 使用自身实际 Node，桌面使用发布构建记录的 Node；v1 提示含 Node、脚本、实际配置的绝对路径，并正确转义空格和单引号。
- 手册新增 [§7 升级到 v2-release-2](cutover-runbook.md#7-升级到-v2-release-2)。完整新增节 diff 见本轮证据 `cutover-runbook.diff`，包括停止写入者、dry-run、upgrade、启动核对、rollback 和 SHA 标准。

共享名单仍只定义于 `packages/assistant/src/protected-paths.ts`：

| 类别 | 名单及作用 |
|---|---|
| 控制，只禁写 | 实际 configPath 及 `.lock`；H/config.json 及锁；应用 dataDirectory；通知 helper；`~/.config/serika/`；`~/Applications/Serika-releases/`；`~/Applications/Serika.command` 及任意目录的 Serika.command；代码根；可信 computer executable；已配置 Skill 目录；`.git` 本身、config/config.lock、config.worktree/config.worktree.lock、hooks/，含标准 worktree config.worktree；文件目标祖先识别出的 gitdir/commondir 控制路径 |
| 凭据，读写全禁 | `.ssh/`、`.aws/`、`.gnupg/`、`.netrc`、`.npmrc`、`.pypirc`、`.git-credentials`、`.docker/config.json`、`.env`、`.env.*`；H/env、dataDirectory 同级 env；RUNLOOM_ENV_FILE、RUNLOOM_HOST_ENV_FILE、RUNLOOM_WORKER_ENV_FILE 明确指定的文件 |

此表描述名单路径，别名限制见第 5 节。桌面目录设置本轮未改；只更新 v1 启动提示的命令。

## 2. 逐条对照验收项

全部文件、凭据、仓库和配置均为**测试数据**。系统为 Darwin 27.0.0 arm64，Node 26.4.0，Electron 44.4.5。

| 验收项 | 实测结果与入口 |
|---|---|
| 不再每次遍历授权树 | 已做；产品 `rg scanProtectedPaths` 零命中。仅 `scripts/b2-scaling-probe.mjs:40` 保留可选旧导出，用于运行旧提交基线；没有产品或普通测试调用 |
| 约 10 万文件额外成本 | 已做；`b2-scaling-probe.mjs` 对同一目录先 1 文件、再 100001 文件测真实 read_file 和 shell_exec；数字见第 3 节 |
| 无权子目录不影响其他路径 | 已做；chmod 000 后实际 readdir 返回 EACCES；新版普通 read_file 成功、Shell exit 0。旧版 read_file 抛 EACCES，Shell 返回 SANDBOX_UNAVAILABLE |
| profile 不随文件数增长 | 已做；1 / 100001 文件均 13727 字节；加入既有硬链接后仍 13727 字节 |
| Git 正常操作、控制禁写、凭据禁读 | 已做；`directory-access.test.ts` 原生 Git 10 项，退出码见下表；文件 read_file 读 .git/config 成功、读 .ssh 哨兵返回 PROTECTED_PATH |
| 多目录、最深规则、撤销、越界及链接 | 已做；原 B2 文件工具和原生 Seatbelt 用例重跑；撤销下一次立即拒绝；文件工具既有硬链接仍返回 HARDLINK_NOT_ALLOWED；Shell 既有硬链接单列风险 |
| gitfile/commondir、config.worktree | 已做；目标祖先回归覆盖外置 metadata、common 控制及标准 worktree config.worktree；普通 Shell 的自定义外置 metadata 见第 5 节 |
| 发布构建和离线升级入口 | 已做；新临时独立 clone `4ac037d`，安装、build 均成功；脚本及依赖 dist 的 SHA 见 release-upgrade.json |
| 发布目录 dry-run / upgrade / rollback | 已做；从无关 cwd 复制实际 v1 提示执行，配置路径含空格、单引号。三项退出 0，SHA 原字节恢复 |
| 发布桌面拒 v1、升级后启动、回滚 | 已做；临时发布的真实 Electron 原 preload/IPC 三次启动：v1-rejected → v2-started → v1-rejected，无模型请求 |
| 快照与冻结文件 | 已做；当前 129 场景本轮零增删、零变化；B2-06 保持已批准值。原 111 行不变，现行 107 行重放零差异；冻结 diff 空 |

原生 Git 完整输出见 `native-git.json`：

| 测试命令 | 退出码 |
|---|---:|
| git status --short / git log -1 --oneline / git diff -- tracked | 各 0 |
| git add tracked / git commit -qm changed | 各 0；宿主核对提交为 changed |
| git config --local user.name Intruder | 255；could not lock config file .git/config: Operation not permitted |
| 写 .git/config.worktree / 写 .git/hooks/x / mv .git / cat .ssh/sentinel | 各 1；Operation not permitted |

保留原后端的 `Error opening /private/var/select/sh: Operation not permitted` 诊断，没有放开该系统路径。普通测试仓库关闭自动维护，未替换 hooks 或后端。

## 3. 前后数字

同一授权目录、相同命令、预热 runtime。旧版 `53f8033` 每档 3 次，新版 `4ac037d` 每档 7 次，表中为单调用中位数；两次来源工作区均干净。额外耗时 = 大目录中位数 − 小目录中位数，负数按测量噪声解释。profile 用固定路径参数调用生产编译器生成，排除每次命令随机临时路径长度的影响。

| 版本 / 指标 | 1 文件 | 100001 文件 | 额外耗时 |
|---|---:|---:|---:|
| 旧 read_file | 0.734750 ms | 1094.607125 ms | +1093.872375 ms |
| 新 read_file | 0.572542 ms | 0.516583 ms | −0.055959 ms |
| 旧 shell_exec | 22.349083 ms | 2425.617042 ms | +2403.267959 ms |
| 新 shell_exec | 21.179000 ms | 21.001125 ms | −0.177875 ms |
| 旧 profile | 13555 B | 13555 B | 加入 4 个被扫描的硬链路径后 14593 B |
| 新 profile | 13727 B | 13727 B | 加硬链后仍 13727 B |

本轮产品 **+71/−46，净 +25**；测试/验证入口 **+189/−27，净 +162**；手册 **+50/−0**；快照 **0/0**。测试净行超过最初估算 50%，原因是新增可复跑的 10 万文件性能/权限探针、独立别名风险探针和发布升级探针，未把这些脚手架放进产品执行路径。逐文件分类在 `audit.json`。

| 提交 | 增删行数 | 内容 |
|---|---:|---|
| `7684384` | +196/−63 | 目标检查、固定 profile、file-link 禁令、风险与性能探针 |
| `4ac037d` | +114/−10 | 发布升级绝对命令、构建 Node 记录、手册与发布探针 |
| `dd75aa3` | +3/−3 | 外置 Git 探针改由真实 git init --separate-git-dir 生成 |

配置演练 SHA：

- 临时发布 CLI 升级前 / 回滚后均 `c3f970c48bef88a2a6f9cffaa8d0372aefa2335126735c6aa9874f891247b359`。
- 临时发布 Electron 升级前 / 回滚后均 `796a283492d655a58e3010fcdefd9e57b3fe25cb4d6acc3eb86a959b6bb4c034`。
- 两者回滚回执均 `identical=true`。真实日用配置本轮未读取、未升级。

## 4. 实际命令和退出码

以下命令均在固定 v2 工作区或新临时发布 clone 运行；验证用显式测试 home 和已批准的 `SERIKA_B2_RECORD_CONCURRENT_HOME=1`，保留真实 home 写入拦截。

| 命令 | 退出码与结果 |
|---|---|
| `node scripts/b2-verify.mjs /tmp/serika-b2-round2-final` | 0；typecheck 0；pnpm test 0；1840 项中 1833 通过、7 项既有跳过、失败 0 |
| `pnpm --filter @serika/desktop smoke` | 0；干净 `4ac037d`，冻结脚本、真实 Electron / 假模型，8/8 |
| `pnpm install --offline --frozen-lockfile --store-dir /Users/a1-6/Library/pnpm/store/v11` 后 `pnpm build` | 各 0；临时发布 clone 的依赖和产物独立 |
| `node scripts/b2-release-probe.mjs /tmp/serika-b2-release-round2-4ac037d /tmp/serika-b2-round2-release-evidence` | 0；clean 发布目录，实际提示可复制，dry-run/upgrade/rollback 成功 |
| 临时发布 `node apps/desktop/scripts/b2-config-upgrade-smoke.mjs /tmp/serika-b2-round2-release-electron` | 0；真实 Electron 三次启动与 SHA 回滚核对 |
| `node scripts/b2-scaling-probe.mjs <assistant-dist绝对路径> <输出绝对路径> current` | 0；记录性能、profile、EACCES 与既有硬链观测，风险不是批准 |
| `node scripts/b2-alias-risk-probe.mjs <assistant-dist绝对路径> <输出JSON绝对路径>` | 0；clean `dd75aa3`，记录真实别名及外置 Git 风险 |
| `git diff --check`；冻结 diff；产品 scanner rg | 0；冻结空；rg 退出 1、零命中 |

证据：[清单](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/manifest.json)、[全套/快照](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/verification.json)、[性能](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/scaling-current.json)、[别名风险](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/alias-risk.json)、[发布升级](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/release-upgrade.json)、[发布 Electron](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/release-electron.json)、[原生 Git](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/native-git.json)、[冻结/rg/行数](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/audit.json)、[手册 diff](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/cutover-runbook.diff)、[冻结冒烟](evidence/electron-smoke/b2-round2-079692ba-56e5-4ecd-9fdd-5422de826655/result.json)。

原生/桌面/性能验证的真实 home 写违规均为 0；外部日用 worker 元数据变化仅记录，不宣称真实 home 整树未变。未调用真实模型，未停止日用进程，未修改日用发布目录或 legacy-main。全套/冒烟/发布证据绑定 `4ac037d`，后一个提交仅修风险夹具并单独重跑；不是日用模型质量验收。

## 5. 与计划不符的地方及理由

**以下风险均未预批接受或拒绝，等用户审核：**

| 风险，全部测试数据 | 实测 |
|---|---|
| 预先存在、指向受保护控制/凭据的硬链接 | Shell 读/写测试 H/config 与 H/env 别名均 exit 0；源实际变成 control-after / credential-after，同 inode、nlink=2。文件工具均 HARDLINK_NOT_ALLOWED。沙箱内新建硬链已拒绝 |
| 凭据符链指向普通目标名 | `.env → credential-target`；原 .env 路径被拒，普通目标名可被 read_file 和 Shell 读取。删除反向树索引后，仅凭目标名无法反查所有凭据别名 |
| 控制符链与自定义外置 Git metadata | `.git/config → git-target` 的普通目标名、gitfile 指向的 `metadata/config`，文件工具拒写；Shell 均可写。真实 separate-git-dir 仓库中，Shell `git -C worktree config --local user.name TestIntruder` exit 0，实际 config 出现该值。标准 `.git/config` 等路径仍拒写 |

这些观测不写入批准快照，也不解释为原 B2 安全目标全部成立。未为处理别名恢复全树扫描；未擅自更换 Shell 后端或放开权限。

测试断言调整逐项记录：

- 原生多目录用例删除“读/写事先存在的 hard 必须失败”两项旧断言，改由独立风险探针记录实际结果；增加授权内新建硬链被拒的断言及 inode 核验。依据是本轮明确移除硬链预扫描，并要求测量该残余风险。
- 原“credential 与 Git aliases 在文件和 Seatbelt 均保护”用例，改为目标祖先的 Git/gitfile/commondir 回归；原普通凭据目标禁读、Shell 普通目标禁写等断言已不成立，按上表单列，不隐藏为快照不变。测试文件未删除，未新增 skip。
- 首次外置 Git 探针的手工元数据不完整，`git config` 报 not-a-git-repository，不能当作保护成功；改用真实 `git init --separate-git-dir` 后复测并核对实际 config 变化。

验证调整：首次隔离 HOME 离线安装缺 tarball，退出 1、写违规 0；指定既有 pnpm store 后通过。临时发布初次启动触发 Electron 下载等待，已仅停止该测试进程组，独立复制本地已安装 Electron 44.4.5 的 dist/path.txt 后重跑；源和临时副本二进制 SHA 都是 `e06891704834df56f24489e1f971428161ae17312143624af13736255cc0ab34`，没有链接开发依赖或改日用安装。

约束偏离：一次补丁工具沿用环境默认 cwd，误在旧工作区创建本轮新文件 `scripts/b2-scaling-probe.mjs`。发现后只核对并删除这个刚创建的文件，撤销误写；未检查、修改或清理旧目录其他文件和用户数据。后续编辑均显式指定 v2 路径。这一失误不计为满足“不进入/不动旧目录”的约束。

已查旧约束的工具确认/记住、文件授权、Docker/Shell 沙箱、桌面/TG 自主与执行回执条目。按 pstack 的“删旧路径”“真实产物验证”“按可验证单元提交”执行，分别删除扫描、测量实际原生行为、分开提交权限与发布入口。代码根 URL 显式化、npm 的 .npmrc 影响继续留待后续，不在本轮实施。
