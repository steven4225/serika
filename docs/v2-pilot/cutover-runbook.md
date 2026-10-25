# 切日用操作手册

本文只供审核，本轮没有执行。执行前另获用户批准；全程保留 main 原版本、原配置、原工作目录和备份。不要在 main checkout 构建实验版本，不调用模型来验证迁移，不自动注册服务或开启 TG。

## 1. 确认入口和停止条件

记录 main 的源码提交、应用路径、实际配置路径、工作目录、transcript 路径、Electron userData、resident 和 worker 的服务标签及启用状态。只记录路径、PID 和状态，不输出环境变量值、配置正文或 `launchctl print` 原文。

**开始前要求 `~/.serika` 不存在或是空目录，且不是符号链接。** 有任何内容就停止，由用户另行决定归档位置；不能覆盖、合并或直接删空。后面的快照步骤必须在这项检查通过后开始。

本次已批准目标为默认 `~/.serika`。导入时必须同时传 `--home "$NEXT_HOME" --cutover`；`--cutover` 只豁免这个精确目标，源、子目录及旧桌面数据根仍受禁止规则约束。目标非空时连成功导入的重跑也拒绝。不能导入后移动 H，因为 identity、草稿和回执绑定绝对路径。

在实验 checkout 中设置以下变量。先把示例路径换成刚才记录的实际路径。`MAIN_DATA` 必须是含 `runloom.json`、`desktop-identity.json`、`conversation-drafts.json` 和 `transcripts/` 的旧桌面数据根。旧配置指向的 workspace 也会一并快照。

```sh
EXPERIMENT='/absolute/path/to/experiment-checkout'
MAIN_DATA='/absolute/path/to/main-desktop-data'
CUTOVER_ROOT="$HOME/Serika-cutover-YYYYMMDD"
NEXT_HOME="$HOME/.serika"
REVIEWED_MEMORY='/absolute/private/step7/workspace/.runloom/memory.json.pre-v6'
REVIEW_DIR="$HOME/Serika-cutover-review-YYYYMMDD"
PLAN="$CUTOVER_ROOT/import-plan.json"
cd "$EXPERIMENT"
git branch --show-current
git rev-parse HEAD
```

确认分支是 `experiment/architecture-v2`，提交是本轮最终审核的源码。`CUTOVER_ROOT`、`REVIEW_DIR`、`NEXT_HOME.import`、`NEXT_HOME.staging` 必须是新路径，不能复用先前演练目录；`NEXT_HOME` 必须不存在或为空。`REVIEWED_MEMORY` 是第 7 步保留的原 v4/v5 文件，SHA 必须为 `0a3b46794629c9b2ca9437f2d79321321c3bad2548d57a35271da5f97df629a8`，不能用迁移后的 v6 文件或当前源代替。H 和源不可互为子目录；H 不能在授权目录里。

检查空目录时也要计入隐藏文件。运行以下只读检查，非 0 就停止：

```sh
node --input-type=module - --home "$NEXT_HOME" <<'JS'
import assert from 'node:assert/strict';
import { lstat, readdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
const path=join(userInfo().homedir,'.serika');
try { const stat=await lstat(path); assert.ok(stat.isDirectory()&&!stat.isSymbolicLink()); assert.deepEqual(await readdir(path),[]); }
catch(error) { if(error.code!=='ENOENT') throw error; }
JS
```

### 1.1 单独构建审核通过的固定版本

在停 main 之前准备程序。把用户批准的完整提交填入 `RELEASE_COMMIT`，目录名也用该提交。程序放在开发目录之外，独立 clone、独立安装依赖；不能链接开发 worktree 的 out、dist、node_modules，也不能从开发 worktree 启动日用。构建命令不启动应用、不读取日用数据、不注册服务。

```sh
RELEASE_COMMIT='<用户审核通过的完整40位提交>'
RELEASE="$HOME/Applications/Serika-releases/$RELEASE_COMMIT"
BUILD_HOME="$(mktemp -d /private/tmp/serika-release-build.XXXXXX)/H"
mkdir -p "$HOME/Applications/Serika-releases"
git clone --no-hardlinks --no-checkout "$EXPERIMENT" "$RELEASE"
git -C "$RELEASE" checkout --detach "$RELEASE_COMMIT"
test "$(git -C "$RELEASE" rev-parse HEAD)" = "$RELEASE_COMMIT" || exit 1
cd "$RELEASE"
/bin/sh -c 'pnpm install --frozen-lockfile && pnpm build' --home "$BUILD_HOME"
```

上面每条命令必须退出 0；安装依赖需要网络时由用户明确执行。`RELEASE` 不是开发 worktree，只供这一提交运行。保留 lockfile、源码提交、Node/Electron 版本、构建日志与产物 SHA 到私密发布记录。构建完成后生成固定启动脚本：

```sh
node --input-type=module - --home "$BUILD_HOME" "$RELEASE" <<'JS'
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const release=process.argv[4];
const launcher=`import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
const release=${JSON.stringify(release)};
const inspect=process.argv[2]==='--inspect';
// 获准联网使用后，由用户把这里换成受信任 env 文件的绝对路径。
const envFile='';
if(!inspect&&!envFile) throw new Error('先由用户配置日用环境文件；首次检查用 --inspect');
const env={HOME:homedir(),PATH:dirname(process.execPath)+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',LANG:'zh_CN.UTF-8'};
if(inspect) env.RUNLOOM_MODEL='mock';
else env.RUNLOOM_ENV_FILE=envFile;
const electron=createRequire(join(release,'apps/desktop/package.json'))('electron');
const child=spawn(electron,[join(release,'apps/desktop/out/main/index.js')],{cwd:release,env,stdio:'inherit'});
child.on('error',()=>{process.stderr.write('Serika 启动失败\\n');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
`;
await writeFile(join(release,'launch-serika.mjs'),launcher,{flag:'wx',mode:0o600});
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
await writeFile(join(release,'Serika.command'),'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(join(release,'launch-serika.mjs'))+' "$@"\n',{flag:'wx',mode:0o700});
JS
```

固定入口是 `$RELEASE/Serika.command`，可在 Finder 双击。它只启动已构建产物，不重建、不拉取，也不注册 LaunchServices 或后台服务。首次检查用 `"$RELEASE/Serika.command" --inspect`，清空继承凭据并使用 mock；不要发送消息或启动整理。实际日用前，用户另行批准模型使用并把脚本的 `envFile` 指向既有受信任私密文件；只写路径，不把密钥放进启动脚本。文件内必须明确模型选择，且不能包含旧数据路径覆盖项。启动脚本不继承开发终端的 `SERIKA_HOME`、RUNLOOM 路径、模型密钥或测试开关，因此日用默认使用 `~/.serika`，无需每次传 `--home`。

以后升级由用户选定并审核新提交。停止旧入口的写入者、备份 H，在新的提交目录重复独立构建并测试；用户确认数据格式兼容、备份回滚方案后才改用新入口。保留旧版本和旧入口及其 Node 运行时；Node 被移除或升级导致固定入口不可启动时，重新构建并审核新入口，不改用开发目录；不在旧发布目录运行 `git pull`、重建或自动升级。源码回退若涉及格式变化，必须同时恢复该版本可读的数据快照。

## 2. 停止 main 的所有写入者

1. 在 main 桌面取消当前 Run，等待 idle 和工具子进程真正结束。遇到 unknown 保留原回执，先人工核对，不重试命令。
2. 在 main 原有入口关闭独立后台宿主和任务 worker 服务。记录原启用状态，确认对应 launchd job 已不存在，不能只关闭窗口。不要卸载其他服务，不新增实验服务。
3. 退出 main Electron 主进程及其 Helper、resident-entry、RSS worker、task-worker-entry、正在执行的 scheduled Skill 子进程。关闭指向同一数据的 CLI/TUI。只停止已核实属于这些入口的 PID，不用宽泛 `pkill node` 或 `pkill Electron`。
4. 确认这些 PID 和 job 均已消失、不会被 KeepAlive 拉起。无法确认就停。操作期间不启动 main，也不切换工作目录授权。

服务的实际标签以 main 原入口为准，不能拿实验版本的 H 标签计算规则去停旧服务。独立宿主、worker、CLI 和桌面任何一个仍在写，都不能开始快照。

## 3. 取得一致快照并生成 v6 静态源

先在停止的状态下，把 main 的整个桌面数据根、外部配置、实际 workspace、外部 transcript、服务定义及外部 env 文件分别做私密原样备份。保留权限和符号链接值，不跟随链接；不把凭据放进仓库。记录每个原路径到备份路径的映射、文件集合、SHA 和权限模式。这份完整 main 备份用于回滚，不能只用产品导出的六个 store 代替。

下面调用现有第 7 步工具，由工具再取得导入所需的配置、identity、草稿、workspace 和 transcript 一致快照，并执行备份、迁移演练与回滚核对。`CUTOVER_ROOT` 由工具创建，执行前不能存在。

```sh
cd "$RELEASE"
node packages/assistant/scripts/cm-step7-migrate.mjs \
  --home "$NEXT_HOME" --source "$MAIN_DATA" --output "$CUTOVER_ROOT" \
  --reviewed-memory "$REVIEWED_MEMORY" --review-directory "$REVIEW_DIR"
```

退出 0 且 `status=passed` 才能进入第 4 节。退出 2、`awaiting-memory-decisions` 表示需要裁决；此时只生成私密差异模板，尚未创建 `CUTOVER_ROOT`。模板名为 `memory-delta-<当前memory SHA>.json`，位于权限 0700 的 `REVIEW_DIR`，文件权限 0600；禁止放进任何 Git 仓库，不要把正文复制到公开报告。

逐条比较 `changes` 的 `before` 和 `after`，包括正文、来源、scope、revision、状态和历史。新增、修改、删除均按完整 ID 比较，不按顺序或文字猜合并。保留模板，另存一份 `decisions.json`，只填写每行 `decision` 和顶层 `metadataDecision`：

| decision | 用法 |
|---|---|
| `{"action":"keep-reviewed"}` | 修改或删除条目保留已审核版本；新增条目不能选。原 14 行里的丢弃项仍丢弃 |
| `{"action":"discard"}` | 丢弃这条增量的当前内容；若原来有保留内容，也明确删除该内容 |
| `{"action":"accept-current","category":"preference"}` | 接受当前完整有效 assertion，可选 `preference`、`note`、`document`。原 14 行的类别不能更改，原丢弃项不能借增量恢复；新增行须由用户明确分类 |

原 14 行的审核记录和既定转换始终保留在 `result.json` 的 `rows`；增量裁决另记 `delta`。修改行选 `accept-current` 时由本次逐条裁决授权替换为当前正文，不再次套用旧正文转换。删除行选 `discard` 才删除其迁移结果，选 `keep-reviewed` 则仍需在快照 transcript 中验证旧来源。document 会保留文档属性并进入文档库。所有保留内容暂时映射 user，c2 再归项目。

保留 `decisions.json` 的文件权限 0600。审核顶层 `metadata.before/after`，确认游标、候选、旧回执和文档库变化；把 `metadataDecision` 填为 `accept-current`，否则工具拒绝。旧候选和历史只归档，当前游标仍验证 transcript 前缀，文档库关联丢弃项时拒绝；不认识的来源或格式先停下来处理。不能编辑 ID、before/after、SHA 或漏掉条目，也不能覆盖 `expectedSha`。原始审核 memory 缺失或 SHA 不符时停止，不能用当前 memory 冒充。

用户完成逐条裁决后重跑，仍用同一源和原定的未创建输出路径：

```sh
DECISIONS="$REVIEW_DIR/decisions.json"
node packages/assistant/scripts/cm-step7-migrate.mjs \
  --home "$NEXT_HOME" --source "$MAIN_DATA" --output "$CUTOVER_ROOT" \
  --reviewed-memory "$REVIEWED_MEMORY" --review-directory "$REVIEW_DIR" --decisions "$DECISIONS"
```

裁决绑定基线及当前 memory 的完整 SHA，源再次变化就重新生成差异表、重新逐条裁决。待裁决重跑不会覆盖模板，不创建业务目标；备份或演练开始后若失败，保留全部输出，查清后另选新 `CUTOVER_ROOT`，不自动续跑或删掉旧证据。

成功时工具保留 `backup.tar`、manifest、`rehearsal/`、`rollback-control/`、`v6-review/` 和 `result.json`。核对 `sourceChangesDuringRehearsal` 必须为空；工具原来允许的健康文件变化在本次停机切换中也不接受。版本不是 v4/v5、更多 profile 或外部 Thread 路径仍会拒绝。全过程保持 main 停止；如果裁决期间恢复了 main，重新停机并取得新快照和差量审核，不沿用旧成功结果。

## 4. 生成计划，预览后导入新 H

以下操作只读 `v6-review`。原审核三条偏好、三份项目文档及本次明确保留的增量均暂时映射 user，c2 再归项目。原 v6 存储 scope 字段保持原字节，user 映射在导入回执中记录。旧权限、服务与自主配置不继承。

```sh
V6_SOURCE="$CUTOVER_ROOT/v6-review"
node --input-type=module - --home "$NEXT_HOME" "$V6_SOURCE" "$PLAN" <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { manifest } from './packages/assistant/scripts/cm-step7-migrate.mjs';
import { importHome } from './packages/assistant/scripts/home-import.mjs';
const home=process.argv[3], source=process.argv[4], planPath=process.argv[5];
const encoded=x=>JSON.stringify(x,null,2)+'\n';
const memory=JSON.parse(await readFile(join(source,'workspace/.runloom/memory.json'),'utf8'));
assert.equal(memory.version,6);
const migration=JSON.parse(await readFile(join(source,'../result.json'),'utf8'));
assert.equal(migration.status,'passed'); assert.deepEqual(migration.sourceChangesDuringRehearsal,[]);
assert.equal(memory.entries.length,migration.realData.entries);
assert.equal(memory.entries.filter(x=>x.category==='preference').length,migration.realData.preferences);
assert.equal(memory.entries.filter(x=>x.category==='document').length,migration.realData.projectDocuments);
const files=await manifest(source);
const specification={version:1,importedAt:new Date().toISOString(),manifest:files,
  manifestSha256:createHash('sha256').update(encoded(files)).digest('hex'),authorizedDirectory:null,
  userEntryIds:memory.entries.map(x=>x.id),userDocumentIds:memory.library.documents.map(x=>x.id)};
await writeFile(planPath,encoded(specification),{flag:'wx',mode:0o600});
const preview=await importHome({source,home,specification,cutover:true});
await writeFile(planPath+'.preview.json',encoded(preview),{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:preview.status,counts:preview.counts,
  registeredThreads:preview.registeredThreads,withoutTranscript:preview.registeredWithoutTranscript.length}));
JS
node packages/assistant/scripts/home-import.mjs --source "$V6_SOURCE" --home "$NEXT_HOME" --manifest "$PLAN" --cutover
```

检查私密 preview 的完整映射、条数、ID、正文 SHA、来源 SHA、每个 Thread 的 transcript SHA。授权目录默认空；如果源有非空 WorkTask，工具会要求显式目录映射，此时先审核 `authorizedDirectory`，重建新计划，不能跳过 WorkTask。确认预览后才执行：

```sh
node packages/assistant/scripts/home-import.mjs --source "$V6_SOURCE" --home "$NEXT_HOME" --manifest "$PLAN" --cutover --execute
```

每条命令必须退出 0。成功回执在 `H/imports/receipt.json`；`H.import/backup`、`rehearsal` 和 `rollback-report.json` 必须保留。若发布后没有成功回执，停止启动，检查 intent/prepared/staging 和备份；隔离 H 的恢复须确认同一源与计划，再显式 `--execute --recover`。默认 `~/.serika` 一旦非空仍拒绝，不能借 `--recover` 绕过；保留已发布数据并交用户决定下一步，不自动重跑、移动或清空。

## 5. 对照回执和首次启动

启动前逐项对照源 manifest、preview、成功回执和实际目标文件。任一项不符即停止：

| 核对项 | 通过条件 |
|---|---|
| 完整快照和回滚 | 备份、演练、回滚的文件集合、SHA、权限模式、逻辑条数全部相等；没有额外文件；v6 静态源 manifest 前后相同 |
| 记忆和文档库 | preference/document/note、library document 和各自 ID 集合等于本次逐条裁决后的 preview；未发生增量时才是 3/3/0 和 3；folder 数、importReceipts、progress、excludedSources、undoReceipts 等数组数与源一致；memory 全文件 SHA 相等，正文、ID、revision、来源保留 |
| Thread | 注册数等于 `registeredThreads`；`registeredWithoutTranscript.length` 和完整 ID 集合与源逐一相等；transcript 文件数、提交消息数、各文件 SHA、Thread 关联及来源 quote 一致；不能给无 transcript 的 Thread 补造消息 |
| 执行与界面数据 | execution-records 文件数及 Run 数、每个文件 SHA 一致；当前 Thread 和草稿数一致，路径只映射到固定 H；unknown 留待人工核对 |
| 任务与权限 | tasks 恢复后取消/暂停/中断的变化逐条见映射；RSS 关闭；运行锁、token、服务与 checkpoint 仅归档；旧自主 grant 不生效；没有旧配置字段 |

历史 d2 是 41 注册 Thread、22 无 transcript、19 transcript 文件、1436 提交消息、41 execution-records 文件、138 Run、13 草稿。**这不是新快照的期望值**，每次必须重新统计并解释变化。

首次启动前保存成功回执和目标 manifest。在独立发布目录做 CLI 静态检查，再用固定入口启动真实 Electron；不从开发 worktree 运行：

```sh
cd "$RELEASE"
env -i HOME="$HOME" PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
  "$(command -v node)" apps/cli/dist/index.js --home "$NEXT_HOME" --check
"$RELEASE/Serika.command" --inspect
```

先检查当前 Thread、历史、无 transcript 的 Thread、草稿、本次裁决后全部记忆和文档可读。此阶段不发送聊天、不启动模型整理、不打开 TG、不注册 resident/worker 服务。确认应用诊断中的 H 和各数据路径全部正确，没有连上旧 main 宿主。导入器移除了自主配置并禁用 Shell；后续启用目录授权、桌面自主或后台服务必须由用户明确操作。桌面 Seatbelt 默认断网，需要联网的 Shell 由用户关闭自主、选 host Run 后逐条确认；TG Shell 保持逐条确认。

`--check` 只证明静态配置可读。模型连通、联网、服务、TG 和真实使用验收另行授权，不能用静态检查宣布它们通过。npm/pnpm、Node 子进程和其他 Homebrew 工具仍未支持；Docker 保留。

## 6. 出问题时回滚 main

1. 停止独立发布版本的 Electron 及本 H 的全部写入者。若后来获准开过服务，先停其独立标签并确认 job 与 PID 消失。unknown 先人工核对，不重放。
2. 原样保留新 H、`.import`、`.staging`、回执和出错证据。不要再导入，不把 v6 内容反向写回 main，不移动 H 来修路径。
3. main 原数据未变时，直接选回记录的 main 应用、原配置、原工作目录和原 userData。若原目录曾被人工移动或损坏，从完整 main 备份按原路径恢复，并核对全部 manifest、SHA、权限；不要用只含迁移数据的 H 代替 main 备份。
4. 用记录的 main 源码或原二进制启动 main，先确认历史、草稿和原记忆。只恢复切换前已启用的 resident/worker 服务及原标签，避免双写。新旧实例不能同时使用同一数据。
5. 保留切换前后全部私密证据，报告差异；实验产生的新内容以后再单独迁移。不能宣布自动无损合并或再次自动切换。

## 7. 升级到 v2-release-2

本节将配置 v1→v2、记忆 v6→v7 合并为一次离线升级，由用户在发版时执行。本轮审核只演练副本，不升级日用数据。先按 §1.1 独立构建审核通过的 `v2-release-2`，保留旧发布目录、固定入口和 Node。构建生成 `packages/assistant/dist/node-runtime.json`；桌面的升级提示使用其中的 Node 绝对路径，CLI 使用当前 Node。

### 7.1 停止 Serika、完整备份、两项 dry-run

先取消 Run 并等待 idle，停用当前 H 的 resident/worker 服务，退出桌面和使用同一 H 的 CLI/TUI。按 §2 核对实际 job、PID 和子进程均已退出。不能确认全部写入者已停止就不升级。运行时遇到旧配置或旧记忆会拒绝启动，并给出绝对路径升级命令，不静默转换。

以下变量填新发布目录的实际绝对路径。记录目录须为新目录，权限 0700，完整 H 备份、记录和回执不进入仓库。

```sh
RELEASE="$HOME/Applications/Serika-releases/<审核通过的完整40位提交>"
NODE="$(/usr/bin/plutil -extract nodeExecutable raw -o - "$RELEASE/packages/assistant/dist/node-runtime.json")"
CONFIG_UPGRADE="$RELEASE/packages/assistant/scripts/config-upgrade.mjs"
MEMORY_UPGRADE="$RELEASE/packages/assistant/scripts/memory-upgrade.mjs"
CONFIG="$HOME/.serika/config.json"
MEMORY="$HOME/.serika/data/memory.json"
PROJECT='/Users/a1-6/Code/agents/serika-v2'
UPGRADE_RECORD="$HOME/Serika-v2-release-2-upgrade-YYYYMMDD"
umask 077
mkdir -m 700 "$UPGRADE_RECORD"
test -x "$NODE" && test -f "$CONFIG_UPGRADE" && test -f "$MEMORY_UPGRADE" || exit 1
/usr/bin/ditto "$HOME/.serika" "$UPGRADE_RECORD/home-backup"
/usr/bin/diff -qr "$HOME/.serika" "$UPGRADE_RECORD/home-backup" || exit 1
/usr/bin/shasum -a 256 "$CONFIG" "$MEMORY" > "$UPGRADE_RECORD/before.sha256"
"$NODE" "$CONFIG_UPGRADE" --config "$CONFIG" --dry-run > "$UPGRADE_RECORD/config-dry-run.diff"
"$NODE" "$MEMORY_UPGRADE" --memory "$MEMORY" --project "$PROJECT" --dry-run > "$UPGRADE_RECORD/memory-dry-run.json"
cat "$UPGRADE_RECORD/config-dry-run.diff" "$UPGRADE_RECORD/memory-dry-run.json"
/usr/bin/shasum -a 256 -c "$UPGRADE_RECORD/before.sha256"
```

每条命令必须退出 0。配置预览只将 `version: 1` 改为 `2`，将旧授权目录转为同路径 `readwrite` 目录项和 `projectDirectory`；其他配置保持。日用 personal 授权目录不改为 serika-v2。**如需在 Serika 中访问 serika-v2 项目文件，由用户在设置里手动添加授权目录；选择项目不会授予文件权限。**

记忆预览须逐条核对：三条已确认偏好→`user`；三份文档及已确认的 main 分支 note→上述 Serika 项目。当前基准为总计 7 条、偏好 3、文档条目 3、文档库 3。其余 ID 列入 `unknown`，工具退出非零并停止；先由用户逐项决定，再以 `--mapping <绝对路径JSON>` 传入 `{id,scope}` 数组，不能默认归 user。归属表不输出正文，来源 Thread/消息与原字节备份保留。两项 dry-run 后核对 SHA 未变，有意外差异就停止。

### 7.2 配置 upgrade → 记忆 upgrade → 启动核对

```sh
"$NODE" "$CONFIG_UPGRADE" --config "$CONFIG" --upgrade > "$UPGRADE_RECORD/config-upgrade.json"
"$NODE" "$MEMORY_UPGRADE" --memory "$MEMORY" --project "$PROJECT" --upgrade > "$UPGRADE_RECORD/memory-upgrade.json"
cat "$UPGRADE_RECORD/config-upgrade.json" "$UPGRADE_RECORD/memory-upgrade.json"
"$RELEASE/Serika.command" --inspect
```

若 dry-run 使用 mapping，记忆 upgrade 必须带同一 `--mapping`。两项工具均先持久化完整原文件备份和含 SHA 的回执，再原子替换文件。保留各自 `backupPath`、`receiptPath`；核对备份 SHA 为 `originalSha256`，当前文件 SHA 为 `upgradedSha256`。

启动后先不发送新消息或启动整理。核对 H、历史、草稿、配置 v2、记忆 v7，以及 7 条总量／3 偏好／3 文档／文档库 3。选 personal 时三份文档不在主上下文、`memory_read` 或文档索引；选 serika-v2 时可见；三条 user 偏好两边均生效。目录授权列表和原授权相符，无升级提示或启动错误。通过后由用户恢复原先启用的服务和日用入口。

### 7.3 出问题时按相反顺序回滚

再次停止新版本全部写入者并保留错误证据。填两次升级输出中的实际 `receiptPath`，不能用重定向保存的输出文件代替工具回执。先记忆，后配置：

```sh
MEMORY_RECEIPT='<memory upgrade 输出的 receiptPath 绝对路径>'
CONFIG_RECEIPT='<config upgrade 输出的 receiptPath 绝对路径>'
"$NODE" "$MEMORY_UPGRADE" --memory "$MEMORY" --rollback "$MEMORY_RECEIPT" > "$UPGRADE_RECORD/memory-rollback.json"
"$NODE" "$CONFIG_UPGRADE" --config "$CONFIG" --rollback "$CONFIG_RECEIPT" > "$UPGRADE_RECORD/config-rollback.json"
cat "$UPGRADE_RECORD/memory-rollback.json" "$UPGRADE_RECORD/config-rollback.json"
/usr/bin/shasum -a 256 -c "$UPGRADE_RECORD/before.sha256"
```

两项退出 0、`identical: true`，各自 `originalSha256`、`restoredSha256`、升级前记录完全相等才算回滚通过；保留两个 `rollbackReceiptPath`。随后用旧发布入口核对，再恢复原服务。新版本仍应拒绝旧格式。文件已被修改、备份损坏或 SHA 不符时工具拒绝覆盖：保留现场，由用户根据完整 H 备份判断恢复范围，不自动重试或覆盖。启动核对若产生业务数据写入，也需先裁决差量，不能直接抹去。

### 7.4 项目移动后的离线重绑

启动或选择时若提示项目在旧路径找不到，先停止使用同一 H 的全部 Serika 写入者。项目不会自动猜测新目录或转移记忆。使用提示中的绝对 Node 和脚本路径，将 `--to` 替换为实际新目录，先预览再执行：

```sh
"$NODE" "$RELEASE/packages/assistant/scripts/project-rebind.mjs" --data "$HOME/.serika/data" --from '<旧项目绝对路径或项目ID>' --to '<新项目绝对路径>' --dry-run
"$NODE" "$RELEASE/packages/assistant/scripts/project-rebind.mjs" --data "$HOME/.serika/data" --from '<旧项目绝对路径或项目ID>' --to '<新项目绝对路径>' --upgrade
```

预览逐类显示条目、文档、进度、导入回执、屏蔽记录和注册的受影响条数，不输出正文。目标已有任一种记忆关联记录就停止，不合并。工具完整备份 memory.json 和 projects.json 的原字节与权限模式，先写含两个文件 SHA 的回执再替换。来源 Thread/消息、revision、原请求 hash 和进度 prefixHash 保持；目录授权、配置和 transcript 不改。保留两个备份和 `receiptPath`。

重启核对项目笔记、文档、user 偏好后再恢复使用。若需回滚，先停止全部写入者，再执行：

```sh
"$NODE" "$RELEASE/packages/assistant/scripts/project-rebind.mjs" --data "$HOME/.serika/data" --rollback '<重绑输出的receiptPath绝对路径>'
```

两个文件的 `originalSha256` 与 `restoredSha256` 相同，且 `identical: true` 才算回滚成功。两次文件替换中断时，回滚允许各文件处于原 SHA 或重绑后 SHA，并核对后恢复。文件漂移、权限变化或备份损坏时拒绝覆盖；结果未确认时保留现场和回执，不自动重绑重试。回滚会恢复旧项目注册，旧路径仍失联时继续显示提示，需要恢复原目录或重新明确重绑。

## 8. release-2 项目选择修复与 release-3

`v2-release-2`（983e8d394ad2e7367532e550b2df9681b39ca70d）记为“项目选择缺陷，未完成验收”；原标签不移动。release-1、release-2、全部备份和 `Serika-support/917ee15…` 保留。release-3 使用 §1.1 的独立 clone、固定 Node、私密 env 路径和 `Serika.command`；正常桌面启动不注册或启用 resident/worker，验收通过及明确恢复前两个服务保持 disabled。

当前离线定点工具为 `packages/assistant/scripts/daily-project-repair.mjs`，只接受 memory SHA `0f4aa629f06fc2327912dbef47bcdbced1514cac1028660c4fd6796f322fb9bc` 与已批准的 projects 原始字节；任何漂移都停。它不改升级工具、正式记忆正文、文档库或 transcript。“你好”原消息的发布目录 memoryProjectId 保留，纠错说明见 release-3 记录。

发布前仅在当前 H 的完整副本运行 `apps/desktop/scripts/release3-rehearsal.mjs --source-home <H> --output <新私密临时目录>`。脚本先修复副本，再以发布目录为 cwd 启动真实 Electron 和假模型，核对 personal、老 Thread 游标及整理调用数、失败日志和重启读取。复制数据只重定位配置/桌面身份中的 home 路径，transcript 字节及其 prefix hash 原样保留。输出含日用副本，禁止提交到 Git。

真实数据严格分段，每段结束等用户确认：

1. 用户确认 Serika 已退出；只读确认无桌面/CLI/host/worker/lockf，两个 job disabled、未加载。有残留或状态异常就列出并停，不自行 kill。
2. 新做完整 `cp -a` 备份，核对文件集合和 SHA；执行下面 dry-run，原样给出 diff 后停。
3. 用户批准后 apply，回报 prepared/applied 回执路径与 SHA 后停，不启动桌面。
4. 用户双击 release-3 的 `Serika.command`，核对正常打开、personal 或无项目、personal 读写授权、3 偏好、personal 不见 Serika 文档、用户自己发送“你好”有回复。
5. 全部通过后才按保存的原有效启用状态恢复两个服务。将 plist 的入口与 WorkingDirectory 指向新发布目录，核对 Node/env/home 和通知 helper，再执行 enable/bootstrap 并核对 job/ps/readiness。若宿主会恢复 TG，须先取得明确授权。本次用户已在 release-3 验收后明确允许按保存状态启动 TG，只查询连接状态，不发测试消息。

```sh
NODE='/opt/homebrew/Cellar/node/26.4.0/bin/node'
RELEASE3='/Users/a1-6/Applications/Serika-releases/<release-3完整SHA>'
"$NODE" "$RELEASE3/packages/assistant/scripts/daily-project-repair.mjs" --home "$HOME/.serika" --dry-run
# 独立确认后才执行：
"$NODE" "$RELEASE3/packages/assistant/scripts/daily-project-repair.mjs" --home "$HOME/.serika" --apply
# 仅用户决定回滚时，使用 apply 输出的 prepared 回执及其 SHA：
"$NODE" "$RELEASE3/packages/assistant/scripts/daily-project-repair.mjs" --home "$HOME/.serika" --rollback '<repair.receipt.json>' --receipt-sha '<receiptSha256>'
```

工具在 H 外另做完整备份。两个目标不能一起原子 rename，因此 prepared 回执先落盘；中途失败不得重跑 apply，需核对各目标是否为原始/修复后 SHA，再由用户决定显式逆序 rollback。原始回执或备份 SHA 不符、目标出现第三种 SHA 均拒绝。

worker 通知 helper 仍依赖 `Serika-support/917ee15…`，旧发布和 support 不可删除。Node 路径带 Cellar 版本，`brew upgrade node` 后必须重建固定入口和 plist。正常桌面启动不清除 launchd 的 disabled override；用户核对通过前不安装、enable 或 bootstrap 服务。

release-3 已完成验收与服务恢复，固定入口为 `~/Applications/Serika.command`，指向 be13d5d 完整发布目录的 Serika.command。以后发版按 [release-3 发布记录](release-3.md#以后发版时更新固定入口) 的步骤，在新版本验收和服务恢复完成后原子更新链接，旧发布目录不动。
