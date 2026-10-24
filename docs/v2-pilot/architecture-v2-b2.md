# 4.5 b2 第三轮修订回报

本轮基线 c0f5fba，产品及测试提交 3f897b75a68d3dbff35c9926258d5661340272ca。本轮只修子模块控制路径，停在 b2 审核口；不发版，不进入 c1/c2/S2/S3。全部仓库、凭据哨兵及配置均为**测试数据**，不是日用验收。

## 1. 改了什么

- 唯一名单位于 packages/assistant/src/protected-paths.ts，文件工具与 Seatbelt 同用 modulesControl；不设 refs 例外，不枚举 Git 元数据，不增加扫描结果。
- 原实现实测在真实子模块中 git config --local 写入成功（exit 0）。最初排除 /refs/ 的候选又被真实合法模块名 group/refs/heads/outer 绕过；按用户后续裁决删除该例外。原生命令失败记录见证据 reproduction.json 的 repro、refs 原输出。
- 另实测模块 gitdir 可整体 mv（exit 0）。Seatbelt 增加仅针对目录的 file-write-unlink 禁令，防止 modules/worktrees 元数据目录置换；未禁止普通文件的 add/commit。复现见 reproduction.json 的 rename 原输出。

新规则原文：

```ts
modulesControl: "(^|/)[.]git/modules/(.*/)?(config($|[.]lock$|[.]worktree($|[.]lock$))|hooks($|/))",
gitMetadataDirectories: "(^|/)[.]git/(modules|worktrees)($|/)",
```

Seatbelt 目录置换保护从同一名单生成：

```scheme
(deny file-write-unlink
  (require-all (vnode-type DIRECTORY)
    (regex #"(^|/)[.]git/(modules|worktrees)($|/)")))
```

控制类继续只禁写；凭据类继续读写全禁。本轮未改变两类名单的其他条目、目录设置、Shell 后端或升级命令。

## 2. 逐条对照验收项

Darwin 27.0.0 arm64，Node v26.4.0。原生测试使用 SeatbeltShellRunner、真实 /usr/bin/git、本地真实子模块；外层模块名 group/refs/heads/outer，工作目录 deps/outer，再嵌套 libs/inner。没有模型或网络调用。

| 验收项 | 已做及结果 |
|---|---|
| 带 refs 的合法子模块名不能写配置 | 外层、内层 git config --local core.hooksPath /tmp/intruder 均 exit 255，Operation not permitted；配置原字节不变 |
| config 及锁、config.worktree 及锁、hooks | 外层、内层逐项 printf 写入均 exit 1；hooks/x 实际不存在；文件工具目标判定均 PROTECTED_PATH，控制文件读仍允许 |
| 不能整体替换子模块 gitdir | 外层、内层 mv 元数据目录均 exit 1 |
| 子模块 status/log/diff/add/commit | 外层、内层均 exit 0；普通 b2-change 分支提交成功，宿主核对提交主题 submodule-change |
| 主仓库 config 分支 | git switch -c config → 写 tracked → git add → git commit 均成功，exit 0；核对分支 config、主题 main-config-branch |
| 子模块 config/hooks 分支 | 外层 git switch -c config: exit 128；外层 git branch hooks: exit 128；内层 git switch -c config: exit 128；内层 git branch hooks: exit 128。按用户批准的已知限制拒绝；需要 host 逐次确认 |
| 原有 B2 验收 | 文件工具和原生 Seatbelt 原用例全部重跑；根仓库 git config/hooks 禁写、凭据禁读及正常提交仍满足 |
| 快照 B2-07 | 与 c0f5fba 比，现有 129 行零增删、零变化；无 B2-07 待批准项。原 111 行保持不变；现行可执行投影重放零差异 |
| 冻结文件与扫描 | 冻结 diff 为空；产品 scanProtectedPaths 零命中。仅 scripts/b2-scaling-probe.mjs 的旧基线可选导出保留，不参与产品或普通测试执行 |

完整原生命令、退出码及原输出：[native-submodules.json](evidence/architecture-v2-b2/f85e2fca-5d2a-494b-9aba-9ba2c6aa26e7/native-submodules.json)、[根仓库原验收](evidence/architecture-v2-b2/f85e2fca-5d2a-494b-9aba-9ba2c6aa26e7/native-git.json)。原有 /private/var/select/sh: Operation not permitted 诊断保留，未放宽系统路径。

## 3. 前后数字

| 提交 / 类别 | 增删行数 |
|---|---:|
| 3f897b7 产品及验证提交 | +69 / −4 |
| 其中产品，两处名单/策略文件 | +8 / −3，净 +5 |
| 其中测试/验证入口 | +61 / −1，净 +60 |
| 快照 | +0 / −0 |

新增测试多于产品代码，原因是一条真实两层子模块回归需要创建三个源仓库、克隆嵌套模块，记录正常 Git 操作、控制禁写、目录置换和分支名限制；未增加生产执行路径的扫描或测试依赖。上一轮已经批准的性能/发布升级证据保留于 [第二轮清单](evidence/architecture-v2-b2/62f1e8af-7632-47dc-ac26-c81f5b19196c/manifest.json)，本轮未重复性能及发布演练。

## 4. 实际命令和退出码

| 命令 | 结果 |
|---|---|
| 显式测试 home 内 pnpm typecheck | exit 0 |
| 显式测试 home 内 node --test packages/assistant/dist/directory-access.test.js | exit 0，6/6 |
| node scripts/b2-verify.mjs /tmp/serika-b2-round3-final | exit 0；typecheck/test 均 0，来源干净 3f897b7 |
| pnpm --filter @serika/desktop smoke | exit 0；冻结脚本、真实 Electron/假模型，8/8 passed，来源干净 3f897b7 |
| git diff --check；冻结 diff；快照 diff | 无空白错误；后两项均空 |

全套合计 **1841 项，1834 通过、7 项既有跳过、0 失败**。分段汇总（原日志原文）：

```text
ℹ tests 1171
ℹ pass 1164
ℹ fail 0
ℹ skipped 7
ℹ tests 658
ℹ pass 658
ℹ fail 0
ℹ skipped 0
ℹ tests 12
ℹ pass 12
ℹ fail 0
ℹ skipped 0
```

证据：[全套及快照](evidence/architecture-v2-b2/f85e2fca-5d2a-494b-9aba-9ba2c6aa26e7/verification.json)、[冻结/rg/行数](evidence/architecture-v2-b2/f85e2fca-5d2a-494b-9aba-9ba2c6aa26e7/audit.json)、[清单及 SHA](evidence/architecture-v2-b2/f85e2fca-5d2a-494b-9aba-9ba2c6aa26e7/manifest.json)、[冻结冒烟](evidence/electron-smoke/b2-round3-63d2c3a0-b34b-4798-aac3-f3d17bc2502d/result.json)。冒烟实际配置输入见 home-fixture.json：repository-test-fixture；冻结结果中的“日用配置副本”是沿用的旧标签，未读取真实日用配置。测试守卫的真实 home 写违规均为 0；日用 worker 的并发元数据变化仅记录，不宣称整棵真实 home 不变。

按用户本轮唯一授权，在旧目录只执行了 git status --short（exit 0），实际输出与最初 7 行一致：

```text
?? .env.before-flash-fast-20261015
?? docs/_codex-fix-restore-identity-cancel-wait.md
?? docs/channel-isolation.md
?? docs/grokbot-runloom-test.cloud-brief.md
?? docs/grokbot-runloom-test.local.sh
?? docs/handoff-serika-herdr-pi.md
?? var/
```

没有读取这些未跟踪文件，没有对旧目录作其他操作。

归档说明：Node 失败输出带有空白行缩进，最初以原始 .log 归档时触发 diff --check；现改用 JSON 字符串无损保存，并逐项保留原字节 SHA，未裁剪或改写运行输出。

## 5. 与计划不符的地方及理由

| 残余风险 / 限制 | 用户裁决 |
|---|---|
| 事先存在、指向受保护文件的硬链接 | **用户已接受**；沙箱内不能新建硬链接。文件工具仍拒绝多硬链接目标 |
| 凭据软链接的普通目标名可读 | **用户已接受**；按名字匹配的固有限制 |
| 控制类软链接、不叫 .git 的自定义外置 Git 元数据 | **仅这类自定义布局用户已接受**；标准 .git、worktree、子模块不在此豁免内 |
| 子模块内名为 config/hooks 的分支引用不能更新 | **用户已批准的已知限制**；需走 host 逐次确认。主仓库 .git/refs/** 不受本轮规则影响 |

本轮没有采用“枚举 Git 元数据生成 refs 例外”的候选方案。没有恢复全树扫描；没有修改冻结文件、真实 ~/.serika、日用发布目录或 legacy-main；没有调用真实模型、停止日用进程或发版。配置 v2 升级与 c2 的记忆 v7 升级留到 v2-release-2 一次完成。

已查旧约束的工具确认/记住、文件授权、Docker/Shell 沙箱、自主与执行回执条目。沿用 pstack 的“真实产物验证”和“迁完调用者即删旧 API”原则：在原生 Seatbelt 复现后验证，删除候选 refs 例外，仅保留一套共享名单。
