# 切日用前补正：记忆增量裁决、默认 H 和固定版本入口

## 1. 改了什么

基线 `bb409fc`，源码提交 `367550f5f2feed0af64f51a0001e7efa923013fe`。仅修改两个离线导入工具、相应测试和切日用手册；没有执行切日用。

- `cm-step7-migrate.mjs` 以私密原审核 memory 的固定 SHA 为基线，按完整 ID 生成新增、修改、删除列表，包含前后完整条目和 metadata。清单在仓库外 0700 目录、0600 文件内；待裁决返回 2，不创建迁移输出。裁决文件只允许填写逐项 decision 和 metadataDecision，绑定原审核及当前源 SHA。保留原 14 行裁决及既定转换记录，增量结果另留摘要回执；错误、漏项、重分类、源变化均拒绝。CLI 改为命名参数并要求显式 `--home`，删除旧 positional 入口。
- `home-import.mjs` 只有显式 `--cutover` 才允许精确默认 home；源仍受原禁止规则约束。目标不存在或为空且非 symlink 才允许，发布前复查原空目录身份再删除空目录并发布 staging。非空默认 home 一律拒绝，包括 replay/recover；隔离 H 原有显式恢复语义保持。
- [手册](cutover-runbook.md) 改为导入 `~/.serika`，增加私密增量裁决及重跑步骤、动态核对条数，以及开发目录之外固定提交的独立 clone/构建/启动脚本和用户决定升级流程。独立入口日常无需 `--home`；不注册服务。完整 diff 见 [cutover-runbook.diff](evidence/architecture-v2-cutover-tools/cutover-runbook.diff)。

本轮使用 pstack 的领域建模、边界校验、幂等操作与实物验证原则：选择“不可变原裁决＋SHA 绑定增量”，避免整份重裁决覆盖旧结果；待裁决不创建业务输出；目标准入集中在 importer；用实际 CLI、临时 HOME、tar 和生产 JSONL/v6 reader 核对。没有新增产品执行路径。

## 2. 逐条对照验收项

| 要求 | 结果与证据 |
|---|---|
| 新增 2、修改 1 | 已做。`real JSONL source validation, complete tar rollback...` 模拟 2 新增＋1 修改，生成逐行 before/after；未填裁决和错误 SHA 拒绝，完整裁决后备份/演练/回滚成功。保留 8 entries，其中 preference 4、document 4；源字节不变 |
| 删除、保留旧版及原 14 行 | 已做。同测试识别 deleted，覆盖 keep-reviewed/discard；每次 `realData.rows` 与原审核迁移结果 deepEqual。尝试改原类别拒绝。接受修改保留 ID、revision、来源；新增文档进入 library。原裁决函数及原 14 行测试断言不变 |
| 私密清单及重跑 | 已做。断言 0700/0600，拒绝仓库内 review 目录；待裁决后原 output 不存在，重跑不覆盖模板。模板不直接编辑，另存 decisions；SHA 或任何非裁决字段不符则拒绝。只用虚构夹具，未访问真实原审核副本或日用记忆 |
| `--cutover` 默认 home 准入 | 已做。`cutover CLI admits only absent or empty default home...` 在 6 个临时 HOME 中运行真实 CLI：absent/empty 成功，hidden/nonempty/file/symlink/dangling 拒绝；缺 flag、子目录和默认 home 作为源均拒绝；成功后再次导入也拒绝。源 manifest 不变 |
| 恢复与迁移不变量 | 已做。原 8 个持久化中断边界及退出 73 的真实子进程仍通过；隔离 H 的显式 recover 和无写 replay、来源/Thread/quote 校验、transcript SHA、完整回滚保持 |
| 手册三处 | 已做文档。默认 H 和逐项裁决命令更新；记忆及文档条数取本次结果，不再硬断言 6/3/3；无 transcript Thread 数和 ID 集合仍必查；固定提交独立发布及升级/回退步骤齐全。shell/内嵌 JS/生成脚本/带单引号路径共 16 项检查通过，生成器只在临时目录写脚本，未安装或启动发布程序 |
| b0、冻结文件和 Docker | 已做。[audit.json](evidence/architecture-v2-cutover-tools/audit.json) 核对 b0、permission-decisions、冒烟及检查器与 bb409fc 字节相同；相对原 b0 仍只有 desktop/shell_exec，TG 行 538 bytes，SHA `52f3b1dc3ba35898bef93898b912f53d9521ce23915532e14a69c9c6c73f54d3`。Docker 未改 |
| 统一验证一次 | 已做且退出 0，只运行一次。UTC 与 Asia/Shanghai 每档均 1765 通过、0 失败、7 既有跳过；eval 101/101，冻结真实 Electron 冒烟 8/8，离线审计通过。见 [verification.json](evidence/architecture-v2-cutover-tools/unified/cm-step6/verification.json) |

证据类型为 macOS 上真实离线 CLI、单元测试，以及统一验证中的真实 Electron＋假模型脚本。未调真实模型、未开 TG 外发、未注册服务，费用 $0。本轮未对 Seatbelt 重新声称独立验收，其源码和权限快照保持 S05 已审核版本。

## 3. 前后数字

相对 `bb409fc` 到源码提交，Git numstat；文档和生成证据不计产品或测试。详见 audit `lineChanges`。

| 类别 | 增 | 删 | 净 |
|---|---:|---:|---:|
| 产品 | 0 | 0 | 0 |
| 迁移工具 | 162 | 21 | +141 |
| 测试 | 97 | 2 | +95 |
| 手册 | 104 | 27 | +77 |

未删除测试文件，2 行测试删除均为扩展 import 的替换，不删除或放宽旧断言。工具内固定三偏好检查改为完整迁移文档比对，以支持审核通过的增量；原 `migrateDocument` 14 行规则未改。

## 4. 实际命令和退出码

以下在隔离实验 checkout；测试 wrapper 带显式临时 `--home`。新默认 home 用例的每个 CLI 子进程也带临时 `--home`，并设置独立临时 HOME。

| 命令 | 退出码 |
|---|---:|
| `git fetch origin experiment/architecture-v2` | 0 |
| `/bin/sh -c 'node --test packages/assistant/scripts/cm-step7-migrate.test.mjs packages/assistant/scripts/home-import.test.mjs' --home /private/tmp/serika-cutover-tools-work/H` | 0，两轮各 7/7 |
| `/bin/sh -c 'python3 /private/tmp/serika-cutover-tools-work/check-runbook.py' --home /private/tmp/serika-cutover-tools-work/H` | 0，16 项，未启动产品 |
| `/bin/sh -c 'python3 /private/tmp/serika-cutover-tools-work/audit.py' --home /private/tmp/serika-cutover-tools-work/H` | 0，行数、冻结 SHA、权限行、完整 diff |
| `git diff --check bb409fc HEAD`，完整原始 diff 附件 | 2，标准 patch 的上下文空行保留单空格；排除此附件检查所有其余变更为 0 |
| 证据凭据前缀扫描 | 初版 Python 断言 1；核实 10 个文件路径误报、加词边界后 0，无凭据命中 |
| `SERIKA_CM6_VERIFY_OUTPUT=/private/tmp/serika-cutover-tools-work/unified node packages/assistant/scripts/cm-step6-verify.mjs --home /private/tmp/serika-cutover-tools-work/verify-H` | 0，两时区全套、eval、冻结冒烟和离线审计通过 |

手册旧 SHA `88d6ef1d9a3f0d4bac22b7c99750b4372a36012accb4bce01008b2eb04141e32`；新 SHA `a0f0a3e3c836622ba47a8dc0a28438faaa2cb87daa2fd14ee80acb2a981f1156`。完整 diff、所有源码/日志/截图/结果 hash 见 [manifest.json](evidence/architecture-v2-cutover-tools/manifest.json)，manifest SHA 为 `6ead0def51329b61ef1778d2aaaf990fa27c869256935e67e71d275d0ea9fb55`。

## 5. 偏差、出错与限制

- 提交证据前 `git diff --cached --check` 把完整 `.diff` 附件中 26 个标准上下文空行的单空格标为 trailing whitespace；提交命令序列未在该非 0 结果处停止，随后仍提交并推送。对已提交附件单独复核退出 2；排除此原始附件检查所有其余变更退出 0。完整 diff 已与 Git 原输出逐字节核对，因此保留附件原样，并补本条记录；未改源码或重跑统一验证。
- 本轮定向测试及文档检查未出现失败。证据扫描初版把 `task-...` 的 `sk-` 子串误报为密钥，Python 断言退出 1；核实 10 处全部是源码或 work-task 锁文件路径后，给模式加词边界，扫描退出 0，未改证据内容。第二轮针对删除/keep-reviewed/discard、原类别保护和私密权限补了断言；最终统一验证还覆盖提交后的全部代码。没有为通过检查修改冻结脚本、b0 或旧测试断言。
- 审核依据须由用户提供第 7 步保留的原 v4/v5 文件；工具验证其固定 SHA。本轮为遵守不读日用数据，未读取本机真实 `~/.serika`、main 数据或旧私密副本，未执行任何真实裁决、导入、停机或切换。
- 当前 default home 非空时没有自动恢复例外。发布后回执未知，保留数据及证据，交用户决定，不清空、不移动、不自动再写。
- 手册启动脚本仅生成和语法检查，尚未构建/安装真实日用发布物；未来由用户选择审核提交、私密 env 路径和模型使用时机。npm/pnpm、Node 子进程、其他 Homebrew 工具仍按既有待办，不在本轮扩大。
- 统一验证无失败或重跑。该统一工具内部沿用已审核 fixture 和独立临时 Electron checkout；未改统一工具或其冻结依赖。

提交推送实验分支后停下等审核，不执行切日用。
