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
