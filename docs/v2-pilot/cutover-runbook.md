# 切日用操作手册

本文只供审核，本轮没有执行。执行前另获用户批准；全程保留 main 原版本、原配置、原工作目录和备份。不要在 main checkout 构建实验版本，不调用模型来验证迁移，不自动注册服务或开启 TG。

## 1. 确认入口和停止条件

记录 main 的源码提交、应用路径、实际配置路径、工作目录、transcript 路径、Electron userData、resident 和 worker 的服务标签及启用状态。只记录路径、PID 和状态，不输出环境变量值、配置正文或 `launchctl print` 原文。

**开始前要求 `~/.serika` 不存在或是空目录，且不是符号链接。** 有任何内容就停止，由用户另行决定归档位置；不能覆盖、合并或直接删空。后面的快照步骤必须在这项检查通过后开始。

当前 `home-import.mjs` 的 `guardPath()` 明确拒绝源或目标位于 `~/.serika`。本手册使用另一个固定新 H，日用入口始终显式传 `--home`，`~/.serika` 保持空。若用户要求默认目录就是 `~/.serika`，停止执行，先单独审核导入器边界变更。不能导入后移动 H，因为 identity、草稿和回执绑定绝对路径。

在实验 checkout 中设置以下变量。先把示例路径换成刚才记录的实际路径。`MAIN_DATA` 必须是含 `runloom.json`、`desktop-identity.json`、`conversation-drafts.json` 和 `transcripts/` 的旧桌面数据根。旧配置指向的 workspace 也会一并快照。

```sh
EXPERIMENT='/absolute/path/to/experiment-checkout'
MAIN_DATA='/absolute/path/to/main-desktop-data'
CUTOVER_ROOT="$HOME/Serika-cutover-YYYYMMDD"
NEXT_HOME="$HOME/Serika-v2-home-YYYYMMDD"
PLAN="$CUTOVER_ROOT/import-plan.json"
cd "$EXPERIMENT"
git branch --show-current
git rev-parse HEAD
```

确认分支是 `experiment/architecture-v2`，提交是本轮最终审核的源码。`CUTOVER_ROOT`、`NEXT_HOME`、`NEXT_HOME.import`、`NEXT_HOME.staging` 必须都是新路径，不能复用先前演练目录。H 和源不可互为子目录；H 不能在授权目录里。

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
node --input-type=module - --home "$NEXT_HOME" "$MAIN_DATA" "$CUTOVER_ROOT" <<'JS'
import { runMigration } from './packages/assistant/scripts/cm-step7-migrate.mjs';
const report = await runMigration({ source: process.argv[4], output: process.argv[5] });
if (report.status !== 'passed' || report.sourceChangesDuringRehearsal.length !== 0)
  throw new Error('Snapshot is not consistent; stop and inspect private artifacts');
console.log(JSON.stringify({status: report.status, backup: report.backup.sha256}));
JS
```

工具保留 `backup.tar`、manifest、`rehearsal/`、`rollback-control/`、`v6-review/` 和 `result.json`。它只接受第 7 步已审核的旧 memory SHA 与 14 行裁决。若当前 main 记忆已变、版本不是受支持的 v4/v5、存在更多 profile 或外部 Thread 路径，停止并重新审核映射。**不要覆盖 `expectedSha`、改断言或拿旧静态副本冒充最新快照。** 工具允许的健康文件变化在本次停机切换中也不接受。

## 4. 生成计划，预览后导入新 H

以下操作只读 `v6-review`。三条偏好和三份项目文档暂时映射 user，c2 再归项目。原 v6 存储 scope 字段保持原字节，user 映射在导入回执中记录。旧权限、服务与自主配置不继承。

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
assert.equal(memory.version,6); assert.equal(memory.entries.length,6);
assert.equal(memory.entries.filter(x=>x.category==='preference').length,3);
assert.equal(memory.entries.filter(x=>x.category==='document').length,3);
assert.equal(memory.library.documents.length,3);
const files=await manifest(source);
const specification={version:1,importedAt:new Date().toISOString(),manifest:files,
  manifestSha256:createHash('sha256').update(encoded(files)).digest('hex'),authorizedDirectory:null,
  userEntryIds:memory.entries.map(x=>x.id),userDocumentIds:memory.library.documents.map(x=>x.id)};
await writeFile(planPath,encoded(specification),{flag:'wx',mode:0o600});
const preview=await importHome({source,home,specification});
await writeFile(planPath+'.preview.json',encoded(preview),{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:preview.status,counts:preview.counts,
  registeredThreads:preview.registeredThreads,withoutTranscript:preview.registeredWithoutTranscript.length}));
JS
node packages/assistant/scripts/home-import.mjs --source "$V6_SOURCE" --home "$NEXT_HOME" --manifest "$PLAN"
```

检查私密 preview 的完整映射、条数、ID、正文 SHA、来源 SHA、每个 Thread 的 transcript SHA。授权目录默认空；如果源有非空 WorkTask，工具会要求显式目录映射，此时先审核 `authorizedDirectory`，重建新计划，不能跳过 WorkTask。确认预览后才执行：

```sh
node packages/assistant/scripts/home-import.mjs --source "$V6_SOURCE" --home "$NEXT_HOME" --manifest "$PLAN" --execute
```

每条命令必须退出 0。成功回执在 `H/imports/receipt.json`；`H.import/backup`、`rehearsal` 和 `rollback-report.json` 必须保留。若发布后没有成功回执，停止启动，检查 intent/prepared/staging 和备份；只在确认属于同一源与同一计划后显式 `--execute --recover`，不自动重跑。

## 5. 对照回执和首次启动

启动前逐项对照源 manifest、preview、成功回执和实际目标文件。任一项不符即停止：

| 核对项 | 通过条件 |
|---|---|
| 完整快照和回滚 | 备份、演练、回滚的文件集合、SHA、权限模式、逻辑条数全部相等；没有额外文件；v6 静态源 manifest 前后相同 |
| 记忆和文档库 | preference 3、document 3、note 0、library document 3；folder 数、importReceipts、progress、excludedSources、undoReceipts 等数组数与源一致；memory 全文件 SHA 相等，正文、ID、revision、来源保留 |
| Thread | 注册数等于 `registeredThreads`；`registeredWithoutTranscript.length` 和完整 ID 集合与源逐一相等；transcript 文件数、提交消息数、各文件 SHA、Thread 关联及来源 quote 一致；不能给无 transcript 的 Thread 补造消息 |
| 执行与界面数据 | execution-records 文件数及 Run 数、每个文件 SHA 一致；当前 Thread 和草稿数一致，路径只映射到固定 H；unknown 留待人工核对 |
| 任务与权限 | tasks 恢复后取消/暂停/中断的变化逐条见映射；RSS 关闭；运行锁、token、服务与 checkpoint 仅归档；旧自主 grant 不生效；没有旧配置字段 |

历史 d2 是 41 注册 Thread、22 无 transcript、19 transcript 文件、1436 提交消息、41 execution-records 文件、138 Run、13 草稿。**这不是新快照的期望值**，每次必须重新统计并解释变化。

首次启动前保存成功回执和目标 manifest。用实验 CLI 静态检查，再启动构建的真实 Electron，所有入口固定同一个 H：

```sh
node apps/cli/dist/index.js --home "$NEXT_HOME" --check
env -u RUNLOOM_CONFIG -u RUNLOOM_USER_DATA -u RUNLOOM_WORKSPACE -u RUNLOOM_TRANSCRIPTS -u RUNLOOM_THREAD -u RUNLOOM_ENV_FILE \
  ./node_modules/.bin/electron apps/desktop/out/main/index.js --home "$NEXT_HOME"
```

先检查当前 Thread、历史、无 transcript 的 Thread、草稿、六条记忆和三份文档可读。此阶段不发送聊天、不启动模型整理、不打开 TG、不注册 resident/worker 服务。确认应用诊断中的 H 和各数据路径全部正确，没有连上旧 main 宿主。导入器移除了自主配置并禁用 Shell；后续启用目录授权、桌面自主或后台服务必须由用户明确操作。桌面 Seatbelt 默认断网，需要联网的 Shell 由用户关闭自主、选 host Run 后逐条确认；TG Shell 保持逐条确认。

`--check` 只证明静态配置可读。模型连通、联网、服务、TG 和真实使用验收另行授权，不能用静态检查宣布它们通过。npm/pnpm、Node 子进程和其他 Homebrew 工具仍未支持；Docker 保留。

## 6. 出问题时回滚 main

1. 停止实验 Electron 及本 H 的全部写入者。若后来获准开过服务，先停其独立标签并确认 job 与 PID 消失。unknown 先人工核对，不重放。
2. 原样保留新 H、`.import`、`.staging`、回执和出错证据。不要再导入，不把 v6 内容反向写回 main，不移动 H 来修路径。
3. main 原数据未变时，直接选回记录的 main 应用、原配置、原工作目录和原 userData。若原目录曾被人工移动或损坏，从完整 main 备份按原路径恢复，并核对全部 manifest、SHA、权限；不要用只含迁移数据的 H 代替 main 备份。
4. 用记录的 main 源码或原二进制启动 main，先确认历史、草稿和原记忆。只恢复切换前已启用的 resident/worker 服务及原标签，避免双写。新旧实例不能同时使用同一数据。
5. 保留切换前后全部私密证据，报告差异；实验产生的新内容以后再单独迁移。不能宣布自动无损合并或再次自动切换。
