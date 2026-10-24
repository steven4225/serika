# 4.5 b2：多目录与可信控制文件保护

仅交付 b2，基线 `8e0222f`，停在审核口。c1/c2/S2/S3 未实施。全部验证使用测试数据；真实模型调用 0，未部署或重启日用实例。

## 1. 改了什么

- `directory-access.ts` 统一目录声明、最深匹配、明确基点、链接拒绝与请求时重读；五个文件工具只走 `directory-file-tool.ts` 这一条执行边界。原单目录工厂签名已删除。
- Seatbelt 从同一声明生成读/写策略，保留原后端、断网及进程结算语义。每次运行扫描授权树，拒绝已有硬链接；禁止沙箱创建硬链接。扫描成本随授权树大小增加，授权树含不可读路径时失败关闭。
- 设置 → 文件与网页增加目录表，支持添加、删除、读/读写、保存；使用整表 CAS 与原配置锁/原子写入。保存后留在当前页；AppInfo、磁盘和界面同步。持久目录授权只存可信配置；一次批准与本对话记住仍存原审批状态，分别显示，均不能扩大目录范围。原自主/TG/Herdr 身份绑定保持独立。
- 目录移除在下一工具请求重新加载并拒绝，包括旧审批已经放行的调用。多根未选基点返回 `DIRECTORY_SELECTION_REQUIRED` 与候选路径；支持授权父目录内的明确项目基点；没有新增项目发现或切换机制。

### 控制文件保护清单，待批准

以下路径及其受保护祖先禁止普通文件工具写入。Seatbelt 的同一拒绝集还会拒读控制/凭据路径，包括 `.git/config`、hooks 与 launcher；这是比仅保护写入更严格的行为，列入待批准项，可能影响需要读取 Git 配置的命令。用户手动入口为桌面目录设置与可信宿主编辑配置，模型工具不能改目录表。

| 保护项 | 实际范围 |
|---|---|
| H 配置和 env | 当前 `configPath`、其 `.lock`；显式 H 的 `config.json`、`config.json.lock`、`env`；数据目录及其同级 `env`；任何层级 `.env`、`.env.*` |
| 外部可信环境文件/程序 | 宿主声明的 `RUNLOOM_ENV_FILE`、`RUNLOOM_HOST_ENV_FILE`、`RUNLOOM_WORKER_ENV_FILE`、`RUNLOOM_NOTIFICATION_HELPER`；computer executable；每个注册 Skill 目录整树 |
| Serika 可信代码与发布 | 当前运行代码根整树；`~/.config/serika/`；`~/Applications/Serika-releases/`；`~/Applications/Serika.command`；授权目录内任何 `Serika.command` |
| Git 控制 | 授权目录任意层级 `.git/config`、`.git/hooks/`，以及 `.git` 本身的替换 |
| 凭据 | 任意层级 `.ssh/`、`.aws/`、`.gnupg/`、`.netrc`、`.npmrc`、`.pypirc`、`.git-credentials`、`.docker/config.json` |
| Seatbelt 原有额外保护 | H、应用数据、transcript 根、真实用户的 `.serika/`、`Library/`、运行时 Node/git 与库目录；这些维持原 OS 沙箱限制 |

## 2. 逐条对照验收项

| 验收项 | 结果与证据 |
|---|---|
| 多目录读/读写，最深声明优先 | 已做；`directory-access.test`，真实临时文件系统及原生 Seatbelt 的 rw→ro→rw 写入检查 |
| 列表外绝对路径、`..`、符号链接、硬链接 | 已做；五种真实注册工具边界与原生 Seatbelt 负例，外部哨兵原文不变 |
| 父目录获写权限仍不能篡改控制文件、自行授权 | 已做；配置/driver/Git/env/launcher 负例；真实配置撤销测试；保护项清单如上，待审核 |
| 删除后下一次请求拒绝 | 已做；同一 DirectoryAccess 重载实际临时配置；Seatbelt 下一命令拒绝；Electron 删除最后一项和重启均不恢复 |
| 目录授权与一次/对话批准分开 | 已做；`permission-extension`、`permission-decisions` 保持原规则；目录范围在审批后的工具执行边界再检查；确认卡显示显式目录 |
| 桌面增删、切换与权限同步 | 已做；真实 Electron、原 preload/IPC，经页面控件完成 7 项检查；CAS 过期拒绝、Thread/自主状态不变 |
| 原 111 行快照 | 存储值 111/111 不变；重放现行 107 行零差异。原测试在 b2 之前已排除 4 个 automatic/review 退休配置场景，并投影删除退休 policy 元数据，本轮沿用 |
| 冻结文件 | diff 为空；六个冻结脚本、两处装配/路径历史基线与 `permission-decisions.snapshot.ts` 均未改 |

### 快照差异表

原有行没有变化，因此没有“旧值→新值”的待批准项。下面是单独快照提交新增的 16 行，旧值均为“无此场景”，影响 primary 文件工具/桌面或显式配置输入；原场景判定不变。

| 编号 | 新场景与结果 | 影响工具 / agent / 来源 | 状态 |
|---|---|---|---|
| B2-01 | read-only → `READ_ONLY_DIRECTORY`；deep-write → `ok` | write_file、shell_exec / primary / 临时声明 | 待批准 |
| B2-02 | absolute、traversal → `PATH_OUTSIDE_WORKSPACE`；symlink → `SYMLINK_NOT_ALLOWED`；hardlink → `HARDLINK_NOT_ALLOWED` | read_file、shell_exec / primary / 临时越界路径 | 待批准 |
| B2-03 | ambiguous → `DIRECTORY_SELECTION_REQUIRED`；selected、project-base → `ok` | 文件工具、shell_exec / primary / 明确基点 | 待批准 |
| B2-04 | revoked → `PATH_OUTSIDE_WORKSPACE` | 文件工具、shell_exec / primary / 配置移除 | 待批准 |
| B2-05 | control/home-config、driver、.git/config、.git/hooks/pre-commit、.env、Serika.command → `PROTECTED_PATH` | write_file、edit_file、shell_exec / primary / 可信控制路径 | 待批准 |

## 3. 前后数字

产品 **+472/−184，净 +288**；测试与验证入口 **+471/−181，净 +290**；权限快照 **+17/−1，净 +16 行**，场景 111→127。测试统计包括测试夹具、测试入口和预览，不含报告及运行证据。

两项净行数均超估算 50%。产品增加集中于共享目录判定、五种工具执行边界、Seatbelt 硬链接/嵌套保护和完整桌面保存链；新产品代码超过 400 行，按职责放在目录判定、文件工具边界及既有桌面/Shell模块，没有增加包或后端。测试额外包含原生 OS 负例、真实 Electron 目录探针和可复跑证据入口；旧配置夹具跨 CLI/desktop/assistant 迁移，删除旧签名后未留兼容执行路径。

提交：`a81aa41` +929/−356，实现与测试；`4335716` +17/−1，仅快照；`69f5990` +10/−9，补齐旧桌面夹具；`bf79ee9` +5/−1，证据比较沿用退休 policy 投影。报告与证据另提交，完整 SHA 和行数见最终回报。

## 4. 实际命令与退出码

| 命令 | 退出码与结果 |
|---|---|
| `node scripts/b2-verify.mjs /tmp/serika-b2-verified` | 0；内部 `pnpm typecheck` 0、`pnpm test` 0；runtime 1156/1163、既有跳过 7；desktop 657/657；脚本测试 12/12 |
| `SERIKA_TEST_HOME=/tmp/serika-b2-smoke-guard SERIKA_B2_RECORD_CONCURRENT_HOME=1 pnpm --filter @serika/desktop smoke` | 0；真实 Electron 原冒烟 8/8，冻结脚本 SHA `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f` |
| 原 `test-home` 包装下运行 `node apps/desktop/scripts/b2-directory-smoke.mjs ...` | 0；真实 Electron 原 IPC 7/7；该 Electron 临时目录已清理 |
| `git diff --check`；冻结路径 diff；旧字段/工厂 `rg` | 0；冻结 diff 空；已删除模式 `rg` 退出 1、零命中 |

证据：[总清单](evidence/architecture-v2-b2/3217bafe-f387-49b0-8967-996c684e2722/manifest.json)、[测试/快照](evidence/architecture-v2-b2/3217bafe-f387-49b0-8967-996c684e2722/verification.json)、[目录 Electron](evidence/architecture-v2-b2/3217bafe-f387-49b0-8967-996c684e2722/directory-settings/result.json)、[原冒烟](evidence/electron-smoke/b2-a32d3d3c-f33d-4355-b5ad-a176587886af/result.json)、[冻结/行数/rg](evidence/architecture-v2-b2/3217bafe-f387-49b0-8967-996c684e2722/audit.json)。实测 Darwin 27.0.0 arm64、Node 26.4.0、真实 Electron 44.4.5；单元/控制器测试使用假模型，Seatbelt 使用本机 sandbox-exec。目录 UI 探针没有模型请求；原冒烟使用原假模型及真实记忆工具/宿主校验/存储。未把这些结果视为真实模型日用验收。

## 5. 与计划不符的地方及理由

- 两项验证协议调整均获本窗口明确批准：仅非冻结 `electron-smoke-fixture.mjs` 将临时旧字段转换成数组并固定仓库样例；本轮入口启用 `SERIKA_B2_RECORD_CONCURRENT_HOME=1`，保留原 Node 写入拦截，记录日用 worker 并发元数据变化，不因此终止测试。默认测试守卫仍严格比较元数据，临时保护夹具的 Node/Shell 写入负例仍严格失败。原冻结 smoke 报告的“日用副本”标签由旁证 `home-fixture.json` 明确纠正为仓库测试样例。
- 所有真实 home 保护守卫记录 `violations=0`，守卫测试在临时保护夹具上故意触发的违规另计；并发变化计数保留在命令证据中，不能把它解释为“真实 home 整树未变”。未读取凭据正文、操作日用进程或修改日用发布目录。
- 现有装配基线测试显式期待新增 `directory` 参数和多目录说明；历史基线文件不改。`/workspace` 测试夹具使用规范化路径；缺失目录错误断言仍保留，旧字段错误名改为 `projectDirectory`。原测试未删除、未新增跳过。`desktop-config` 的缺目录错误匹配由 `/authorizedDirectory/i` 改为 `/projectDirectory/i`，因为旧字段已删除；桌面 application-home、foreground-autonomy、runtime 竞态夹具由写旧字段改为写数组/基点，恢复原有断言的触发条件。未新增测试开关绕过产品判定。
- 旧单目录代码检查：`config.authorizedDirectory`/`moduleConfig.authorizedDirectory` 顶层读取与旧字符串文件工厂签名 **0 命中**。生产源码单词 `authorizedDirectory` 尚有 **22 行**，仅用于 desktop/TG/Herdr 精确身份绑定和 Skill 外置基点；外部 importer 的显式单目录输入在边界转数组，冻结 smoke/非冻结适配夹具保留历史测试输入。无第二条文件授权执行路径。
- 已查旧约束中工具确认/记住、下一 Run 文件授权、持久文件批准、Docker 沙箱和桌面/TG 可信自主条目。采用 pstack 的领域建模、迁调用方后删除旧 API、真实产物验证，分别落实为统一声明、统一工厂入口和原生/Electron 测试。

审核口：控制文件清单及 B2-01～B2-05 待用户审核，未继续后续步骤。五分钟演示入口为构建后的 `node apps/desktop/scripts/b2-directory-smoke.mjs "$PWD" /tmp/serika-b2-demo-evidence`：它在全新临时 H 启动真实 Electron，通过设置页添加两个临时目录、切读/读写、删除并完整重启；输出 7 项通过，目录表同步且授权不恢复。源码须干净；不加载日用配置。文件/沙箱用例可单独在原测试守卫下运行 `node --test packages/assistant/dist/directory-access.test.js`。
