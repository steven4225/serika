# 4.5 b2：多目录与可信控制文件保护

本轮修正基于 `dc64781`，只处理 b2 审核提出的配置升级与保护分类。B2-01～B2-04 已批准；B2-05 的禁写与 B2-06 的读取规则按用户批准落实。仍停在 b2 审核口，未进入 c1/c2/S2/S3。以下自动化均使用测试数据，真实模型调用 0，未部署或重启日用实例。

## 1. 改了什么

- strict 配置版本升为 **2**，所有正常配置生成器及测试输入同步迁移；运行时不支持 v1，也不转换。v1 明确报错：`配置为 v1，请运行 node packages/assistant/scripts/config-upgrade.mjs --config <配置文件> --upgrade 升级`。真实 Electron 已验证显示此句；IPC 连接失败时页面外层会带远程方法错误前缀。
- `packages/assistant/scripts/config-upgrade.mjs` 是显式离线命令。先验证转换后的完整 v2 schema，再完整字节备份，以既有配置 flock、SHA 检查、临时文件/rename/fsync 写入。`authorizedDirectory` 转为 `authorizedDirectories: [{path, access:"readwrite"}]` 与 `projectDirectory`，保留 autonomy 等其他设置；null/缺省授权保持为空，已是 b2 数组的 v1 只改版本。混用非空旧字段与新字段时拒绝覆盖。
- `--dry-run` 只打印变化字段的 diff，不写文件、不输出未变设置。升级回执先于配置替换落盘，保留完整备份与原/新 SHA；回滚验证当前配置与备份，恢复原字节后再读文件生成 SHA 相同的回滚回执。升级后配置若已被其他操作修改，命令拒绝覆盖，完整备份仍保留。
- **唯一名单为 `packages/assistant/src/protected-paths.ts`**：名字规则、宿主配置路径与 Git 元数据目标都在此定义。`directory-access`、递归 `search_files` 与 Seatbelt profile 共用它。删除了文件边界、Seatbelt policy 和 runtime 中重复的凭据正则。共享扫描还保护符链目标、Git gitfile/commondir 指向的实际配置；每个文件请求与 Shell 请求扫描授权树，成本随树大小增加，不可读路径失败关闭；不把整个 `.git` 树设为只读，index/objects 等仍可写。
- 桌面沿用原目录表及 preload/IPC，增删与读/读写切换无新入口；默认配置、恢复配置与错误显示迁 v2。持久目录授权仍与一次批准/本对话记住分开存储、分开显示，撤销在下一请求生效。

### 两类保护清单

两类都受授权目录范围约束；“可读”不增加目录授权。符链/硬链边界继续独立拒绝。

| 类别 | 统一名单范围 | 文件工具 / Seatbelt |
|---|---|---|
| 控制 | 当前配置及 `.lock`；H 的 `config.json`、`config.json.lock`；应用数据目录；`~/.config/serika/`；注册 computer driver、Skill 目录；通知 helper；当前代码根；`~/Applications/Serika-releases/`；`~/Applications/Serika.command` 及授权树内任意 `Serika.command` | 允许读，禁止写及替换受保护祖先 |
| Git 控制 | `.git/config`、`.git/config.lock`、`.git/hooks/`；`.git` 本身替换；控制符链真实目标、gitfile/commondir 指向的同类元数据 | 允许读，禁止写；status/log/diff/add/commit 可用 |
| 凭据 | 任意层级 `.ssh/`、`.aws/`、`.gnupg/`、`.netrc`、`.npmrc`、`.pypirc`、`.git-credentials`、`.docker/config.json`、`.env`、`.env.*`；H/env、数据目录同级 env；显式 `RUNLOOM_ENV_FILE`、`RUNLOOM_HOST_ENV_FILE`、`RUNLOOM_WORKER_ENV_FILE` 及其真实目标 | 读写全禁；文件工具返回 `PROTECTED_PATH`，递归搜索跳过 |

Seatbelt 的断网、只读运行时依赖、进程结算、真实 home/Library 中运行程序的准入限制继续沿用；没有换后端或扩展 S3。

## 2. 逐条对照验收项

| 验收项 | 结果与测试名 / 证据 |
|---|---|
| 真实配置只查键存在性 | 已做；仅解析并输出顶层键是否存在。`authorizedDirectory` **存在**；`desktopAutonomy` **存在**；`telegramAutonomy` **存在**。未输出值，未升级真实配置 |
| v2 升级、备份、dry-run、保留设置、回滚回执 | 已做；`config-upgrade.test.mjs` 4 项实际 CLI 子进程测试，含配置/备份变化拒绝与既有锁占用拒绝 |
| 升级 → 启动 → 回滚 → SHA | 已做；真实 Electron、原 preload/IPC、测试 H/config.json，三次完整启动均结束进程；详情见下表 |
| 控制可读、凭据不可读 | 已做；真实注册 `read_file` 读 `.git/config` 成功，读测试 `.ssh` 哨兵返回 `PROTECTED_PATH`；原生 Shell 读取凭据失败；递归搜索无 env/凭据别名内容 |
| 原生 Git 五个正常操作、四个拒绝操作 | 已做；Darwin 原生 `sandbox-exec`，真实临时 Git 仓库；命令/输出见下表及 `native-git.json` |
| 多目录与最深权限；绝对路径/../符链/硬链越界拒绝 | 已做；`directory-access.test` 与原生 Seatbelt，包括 rw→ro→rw；外部哨兵保持原文 |
| 授权父目录也不能改控制文件或自行授权 | 已做；H/config、driver、Git、env、launcher 写入负例；新增 Git 控制符链与 gitfile 真实目标回归用例 |
| 删除授权后下一请求拒绝；审批不扩大目录权限 | 已做；实际配置重载与旧审批后边界检查；目录设置 Electron 7/7，含最后目录删除、CAS 拒绝、完整重启不恢复授权 |
| 旧快照与冻结文件 | 已做；原 111 行、上轮已审 127 行均零变化；新增 B2-06 两行；冻结 diff 空 |

### 测试 home 升级与回滚演练

测试配置为人工构造，包含旧授权和两个 autonomy 身份绑定，已有桌面超时设置；没有复制真实配置内容。

| 阶段 | 实测结果 |
|---|---|
| v1 启动 | 页面明确显示升级命令；配置 SHA 不变 |
| dry-run → upgrade | diff 只有版本和目录字段；完整备份 SHA 等于原配置；两个 autonomy 对象原样保留 |
| v2 启动 | 输入框可用，原 IPC 返回唯一读写目录与项目基点；未发送聊天/模型请求，无可见错误 |
| rollback → 再启动 | 原始字节恢复，回滚回执 `identical=true`；再次启动明确拒绝 v1 |
| 原 SHA / 回滚后 SHA | 两者均为 `e2d82410df8c0cc3b849548d9d31fe41050cd18e7cfebd1225d2eecec16576ea` |

命令入口，先在本工作区构建 `pnpm build:runtime`，再显式传绝对配置路径：

```sh
node packages/assistant/scripts/config-upgrade.mjs --config <绝对配置路径> --dry-run
node packages/assistant/scripts/config-upgrade.mjs --config <绝对配置路径> --upgrade
node packages/assistant/scripts/config-upgrade.mjs --config <绝对配置路径> --rollback <升级回执绝对路径>
```

真实日用配置等发版后由用户执行。

### 原生 Seatbelt Git 输出摘要，测试仓库

| 命令 | 退出码与输出 |
|---|---|
| `git status --short` | 0；` M tracked` |
| `git log -1 --oneline` | 0；测试 initial 提交 |
| `git diff -- tracked` | 0；`first` → `changed` |
| `git add tracked` | 0 |
| `git commit -qm changed` | 0；宿主再读 HEAD 主题为 `changed` |
| `git config --local user.name Intruder` | 255；`could not lock config file .git/config: Operation not permitted`；user.name 仍为 Test |
| `printf bad > .git/hooks/x` | 1；`Operation not permitted` |
| `mv .git moved-git` | 1；`Operation not permitted` |
| `cat .ssh/sentinel` | 1；`Operation not permitted` |

各命令仍有原 Shell 后端的 `Error opening /private/var/select/sh: Operation not permitted` 诊断；未放开该系统路径。正常 Git 操作的退出码与实际提交均已核对；不把该诊断省略成“无警告”。测试仓库关闭 Git 自动维护以避免把进程策略受限的维护子任务混入 commit 结果，未替换 hooks 入口或改后端。

### 快照差异

| 编号 | 旧值 → 新值 | 工具 / agent / 来源 | 审批 |
|---|---|---|---|
| B2-06 | 无此行 → `b2/read/control: ok` | read_file / primary / 测试授权树 `.git/config` | 用户已批准控制类可读 |
| B2-06 | 无此行 → `b2/read/credential: PROTECTED_PATH` | read_file / primary / 测试 `.ssh` 哨兵 | 用户已批准凭据类不可读 |

除此之外无快照变化，**无新增待批准快照项**。原 111 行中现行 107 行重放零差异；4 个早已退休的 automatic/review 配置场景继续保留历史值，退休 policy 元数据沿用原投影，不重写原行。

## 3. 前后数字

相对本轮基线 `dc64781`，产品 **+294/−69，净 +225**；测试及验证入口 **+425/−178，净 +247**；快照 **+3/−1**，场景 **127→129**。产品与测试净行均超最初 b2 估算 50%。本轮新增显式离线迁移、完整备份/回滚及共享保护扫描；测试增加实际 CLI、原生 Git/别名回归和三次 Electron 启动。大量文件的版本替换是等量增删，新增净行主要来自上述验证。

职责按离线命令、`protected-paths.ts` 单一规则、既有执行边界分开；没有保留 v1 运行分支或旧单目录文件授权路径。提交 SHA 及逐提交增删见本轮 `audit.json` 与交付回报；快照独立提交 `ac587a2`。

## 4. 实际命令和退出码

| 命令 | 退出码与结果 |
|---|---|
| `node scripts/b2-verify.mjs /tmp/serika-b2-review-final-source` | 0；内部 typecheck 0、pnpm test 0；1840 项中 1833 通过、7 项既有跳过，失败 0 |
| `SERIKA_TEST_HOME=... SERIKA_B2_RECORD_CONCURRENT_HOME=1 pnpm --filter @serika/desktop smoke` | 0；冻结脚本，真实 Electron，8/8 |
| 同一 test-home 守卫下运行 `b2-config-upgrade-smoke.mjs` | 0；v1 拒绝 → v2 启动 → 回滚 → v1 拒绝，SHA 一致 |
| 同一守卫下运行 `b2-directory-smoke.mjs` | 0；目录 UI 7/7 |
| `git diff --check`；冻结 diff；旧正则/旧单目录 API `rg` | 0；冻结 diff 空；删除模式 `rg` 退出 1、零命中 |

证据：[清单](evidence/architecture-v2-b2/d5253dc3-d330-4b7d-bc7e-583c5d6d7951/manifest.json)、[最终全套/快照](evidence/architecture-v2-b2/d5253dc3-d330-4b7d-bc7e-583c5d6d7951/verification.json)、[原生 Git 完整输出](evidence/architecture-v2-b2/d5253dc3-d330-4b7d-bc7e-583c5d6d7951/native-git.json)、[升级/回滚](evidence/architecture-v2-b2/d5253dc3-d330-4b7d-bc7e-583c5d6d7951/config-upgrade/result.json)、[目录设置](evidence/architecture-v2-b2/d5253dc3-d330-4b7d-bc7e-583c5d6d7951/directory-settings/result.json)、[冻结/rg/逐提交行数](evidence/architecture-v2-b2/d5253dc3-d330-4b7d-bc7e-583c5d6d7951/audit.json)、[冻结冒烟](evidence/electron-smoke/b2-review-493db20f-4224-4d84-8c33-95f9101ed246/result.json)。

实测 Darwin 27.0.0 arm64、Node 26.4.0、Electron 44.4.5。单元/控制器集成使用假模型；原冒烟使用假模型及真实工具/存储；升级与目录演练不发模型请求。这些不是日用模型质量验收。真实 home 写入拦截违规均为 0；测试守卫自己的临时保护夹具故意违规另计。外部日用 worker 元数据并发变化按本窗口批准记录，未停日用进程，未宣称整树不变。

## 5. 与计划不符的地方及理由

- 复现与修法：旧文件边界允许读取测试 `.ssh` 路径；旧 Seatbelt 把控制和凭据混成拒读集。统一分类后，文件/Shell 同规。复核再发现 `.git/config` 符链真实目标可写，现统一扫描真实目标；标准 `.git` gitfile 的 ENOTDIR 会让整根失效，现按 gitfile/commondir 识别控制元数据并补回归。未扩大后续步骤范围。
- 测试输入迁 v2以继续触发原场景；“不支持版本”负例从 2 改为 3。旧字段负例也用 v2，继续单测旧字段拒绝；home-import 的旧源仍为 v1并断言输出 v2。原行为断言未放宽，未删除测试或新增跳过。首次全套查出的桌面内部包导入改为公开错误类型后，包边界检查通过。
- 冻结 smoke 仍生成 v1，且会在已转 v2 的临时配置重新加旧字段；仅已批准的非冻结夹具转换这些临时输入，仓库退休样例固定不变。冻结脚本及所有冻结基线字节未改。上一版报告的 smoke SHA 记录错误，现按文件与 `8e0222f` 双方实测校正为 `03a3c7e6d174842edda61770f8f17b7480e6545ee52ffbda2f63a288d07a6c34`。
- 已查旧约束的工具确认/记住、下一 Run 文件授权、持久文件批准、Docker 沙箱、桌面/TG 可信自主及执行回执条目。按 pstack 的领域建模、边界校验、真实产物验证执行，分别落实为单一分类规则、显式配置解析和原生/Electron 演练。
- 待办已记录到 `pending.md`：代码根的 `new URL("../../..", import.meta.url)` 与 `dirname(dirname())` 显式化一并后续处理；`.npmrc` 禁读对 npm 的影响留到 S2。本轮均未实施。

五分钟复验入口：构建后在干净源码、原 test-home 守卫下运行 `node apps/desktop/scripts/b2-config-upgrade-smoke.mjs /tmp/serika-b2-upgrade-demo`。它只创建测试 home，自动演练升级/启动/回滚，结果 JSON 应为 passed 且原/回滚 SHA 相同；测试目录清理。停在 b2 审核口。
