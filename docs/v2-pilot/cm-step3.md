# 上下文与记忆：第 3 步（4b，代码与本批实测通过）

## 1. 改了什么

依据计划 §2.1、§2.4、CM30–40、CM48、CM53–56、CM67 和 C05/C07/C12，在实验 worktree 实现三段：固定快照与读工具 → 五层实际装配及可选消息附注 → 删除旧检索、配置和界面入口。代码检查点提交：`a92fab7`；用户批准附表 D 后完成本批真实模型验收，结果见附表 E。

- `memory-snapshot.ts`：偏好 / 项目笔记各 4 KiB，整条选入、置顶优先；显式文档正文不进入快照。
- `context-assembler.ts`、`app.ts`：②固定记忆及文档 / 方法索引；⑤时间、任务、checkpoint、resume、WorkTask 和记忆更新随新消息保存。只新增可选 `contextReferences/contextSnapshot` metadata，旧消息不回写；压缩失败回滚快照。更新附注记录引入 ID，重开后也能作废后加条目；快照刷新后只在模型视图折叠已并入快照的旧记忆附注，不删除原消息或修改已存 metadata。
- `memory-read-tools.ts`：实际注册对象免确认的 `memory_read`，普通聊天 / 前台自主可用，worker 不注册。文档 / 方法按 ID 读取，超额记忆只做 NFKC、小写、空白分词后的正文包含匹配；读时复核当前启用、时态、作用域及方法来源 / 依赖。写工具留第 4 步。
- 六个旧检索模块及其接线、配置、索引维护、旧 recall 入口全部删除；旧的回合 / 字节滑动裁剪、手动压缩、长任务模式及 70% 预警删除；已有方法只读，停止新方法提炼。磁盘已有语义缓存不主动删除。

## 2. 逐条对照验收项

| 项目 | 结果与证据 |
|---|---|
| 五层真实请求与稳定② | 已做：`app-five-layer.test.ts` 的 production runtime 用例；`context-assembler.test.ts` 稳定 / 刷新 / 重开 / 回滚；`baseline-assembly.test.ts` 保留历史快照，逐项比对批准变化 |
| ⑤随新消息保存、旧消息兼容 | 已做：真实 JSONL 写入 / 重开用例验证旧消息和已提交前缀字节不变，模型视图才展开附注；未迁移日用原文 |
| 删除 rewrite / relevance / contextView / vector / index / 旧检索，不留开关 | 已做：附表逐文件；生产源无六模块 import 和退役配置读取。读工具内只有最小关键词匹配 |
| 每类 4 KiB，超额不删不拒写 | 已做：snapshot budgets 用例；真实 store 仍保留三个超额条目，工具可读到全部 |
| C05 文档 / 已有方法免确认；后台不给 | 已做：真实 Runtime 工具轮、自主工具表、`dreaming.test.ts` 索引与读来源重检；停用文档 / 撤回条目回归。搜历史 / 按编号读工具及排除记录仍按 CM51/52 排第 6 步 |
| 写入、权限、回执、verifier | 记忆写改造没做，按第 4 步；来源/CAS/unknown 测试保留；Shell 和 TG 未扩大授权。查过 legacy 原行 94、108、110、113、115–123、131–133、136、139、155、187–195；18 个局部取代条目标注产品提交号，保留未取代部分 |
| 缓存命中率 ≥70% | 已做，本批通过：真实主请求 ΣcacheRead/Σinput，旧 7.85%、新 88.97%；含每组首轮，未以 hash 复用率代替 |
| 接收消息至首段可见正文中位数下降 | 已做，本批通过：18 对双方有正文的样本，旧 5.924 秒、新 2.918 秒；配对差值中位数 −3.048 秒；各臂 2 个 tool-only 单列 |
| 32K / 日用大窗口 | 离线容量绑定与 fail-closed 测试保留；CE03/CE05 和大窗口 CF fixture 通过。真实 32K 超限可用性依用户裁决留第 5/6 步，本步未截断原文或摘要 |
| 桌面快照 / 像素 | 已做：历史文本快照未重录。隔离旧提交与新 UI，同一 1440×900 布局、同一 fixture 做方法 / 上下文两处有效比较，左聊天区域差异均 0；设置页用语义快照验证模式入口删除；不是 Electron/常驻进程验收 |

## 3. 前后数字

相对 `e7e51af`，产品 **+420 / −3284，净 −2864 行**（包含 eval/配置/launcher；排除测试和文档）；测试 **+378 / −6298，净 −5920 行**。新增产品低于批准的 650 行，测试新增少于产品新增。删除测试文件 **27** 个，名单见附表。本批实际 **98 次计费 HTTP 请求**（40 主模型 + 20 旧相关性 + 38 embedding），按返回 usage 核算 **$0.35782636 + ¥0.000697875**，低于批准的 120 次 / $2 + ¥0.05；没有重试或加样。

最终全量 **2163 pass / 0 fail / 11 skipped**（运行时 1520、桌面 631、scripts 12）；离线 eval **84/84**，五组 guards 通过。有效像素差异：方法 3088（说明文字）、上下文 3180（移除手动压缩入口）；差异包围盒分别为 (756,584)–(1060,598)、(738,279)–(1410,349)。设置页截图滚动位置未对齐，不报告其差异数。比较时固定 DOM 布局和 h-dvh 为 1440×900、禁用过渡后用 CDP 同尺寸截图；先前尺寸不同的截图不计入。已人工看新上下文和方法页面；fixture 未实现的 IPC 显式显示失败，不算真实功能成功。

## 4. 实际命令和退出码

工作目录：`/Users/a1-6/.codex/worktrees/cm-step0/aisdk-agent-framework`。以下为最终离线结果：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 0（`/tmp/serika-cm-step3-typecheck-delivery.log`） |
| `node --test packages/assistant/dist/context-assembler.test.js packages/assistant/dist/app-five-layer.test.js packages/assistant/dist/baseline-assembly.test.js` | 0，10/10（`/tmp/serika-cm-step3-refresh-fixed.log`） |
| `pnpm eval:test` | 最终 0，84/84（`/tmp/serika-cm-step3-eval-delivery.log`） |
| `pnpm eval:guards` | 0，5/5 组（`/tmp/serika-cm-step3-guards-delivery.log`） |
| `pnpm test` | 0，2163 pass / 0 fail / 11 skipped（`/tmp/serika-cm-step3-final-checkpoint.log`） |
| `node /tmp/serika-cm-step3-live.9OTL94/run.mjs` | 0，40 次真实 Runtime 装配 completed，0 网络请求、0 工具执行（`dry-results.json` / `dry-summary.json`） |
| `node /tmp/serika-cm-step3-live.9OTL94/run.mjs --approved-live` | 0，40 次装配 completed、98 次 HTTP 全部 200，usage 全部结算，本批两项指标通过（`live.log` / `live-summary.json`） |
| `git diff --check` / `git diff --cached --check` | 最终 0；清理已删函数留下的末尾空行后通过 |

失败与修复保留在附表；仅运行了批准的附表 D 真实模型对比，未重启日用进程或改 main。本次实测收尾只改报告与 pending，按文档改动检查，不重复运行全套代码测试。

## 5. 与计划不符的地方及理由

代码和离线检查后先停，取得用户明确费用批准后才执行附表 D；本批真实模型验收通过，未扩展到第 4 步。旧 v5 存储、review/automatic 写语义及沉淀生命周期未提前迁移，留第 4/7 步；旧配置含已退役字段会严格报错，未添加兼容开关或改日用配置，切换提醒已写入 `pending.md`。后台冲突准备仅去掉关键词排名，保留已有来源、历史和 Thread 写作用域；不是继续保留主聊天旧检索。

实测输入估算范围 112,156–173,854 tokens，部分高于附表 D 初估的 11–13 万，但均在报价采用的 256K 上界内；没有截断输入。配置副本的必要正规化、旧相关性一次降级、输出上限与测量边界见附表 E，不据此宣称 32K、工具任务质量或日用切换通过。

CM40 删除 70% 预警后，现行压缩目标需扣除已有 predictedGrowth，否则 CE 重开会立即重复压缩；使用同一增长预留修复，无新常量、无裁剪。完整新摘要 / 异步屏蔽仍不在本步。Karpathy 指南用于限定删除范围与先复现后修复；ego-browser 用于隔离像素检查及官方价格核对；其中浏览器预览验收标为“未在 Electron 验证”，不作为原生桌面验证。浏览器 TaskSpace 已关闭，两个隔离预览服务已停止。

<details>
<summary>附表 A：逐文件产品代码增删（新增 / 删除行）</summary>

统计范围 `.ts/.tsx/.mjs/.json/.command`，排除 `.test.` 和历史 baseline 资料。该口径把离线 eval 脚本也算入产品上限，未用“移到脚本”减小分母。

| 文件 | 新增 | 删除 |
|---|---:|---:|
| `apps/cli/src/index.ts` | 0 | 1 |
| `apps/cli/src/tui.ts` | 0 | 68 |
| `apps/desktop/config/desktop.example.json` | 1 | 1 |
| `apps/desktop/src/main/context-settings.ts` | 0 | 29 |
| `apps/desktop/src/main/desktop-config.ts` | 4 | 4 |
| `apps/desktop/src/main/desktop-runtime.ts` | 3 | 17 |
| `apps/desktop/src/main/module-settings.ts` | 0 | 11 |
| `apps/desktop/src/main/resident-protocol.ts` | 1 | 1 |
| `apps/desktop/src/main/runtime-bridge.ts` | 1 | 3 |
| `apps/desktop/src/main/runtime-ownership.ts` | 2 | 2 |
| `apps/desktop/src/renderer/src/App.tsx` | 2 | 2 |
| `apps/desktop/src/renderer/src/context.tsx` | 5 | 59 |
| `apps/desktop/src/renderer/src/daily-setup.ts` | 1 | 3 |
| `apps/desktop/src/renderer/src/dreaming-panel.tsx` | 3 | 15 |
| `apps/desktop/src/renderer/src/formal-memories.tsx` | 1 | 1 |
| `apps/desktop/src/renderer/src/interaction-preview.tsx` | 4 | 6 |
| `apps/desktop/src/renderer/src/memory-preview.tsx` | 1 | 1 |
| `apps/desktop/src/renderer/src/memory-references.tsx` | 3 | 53 |
| `apps/desktop/src/renderer/src/memory.tsx` | 2 | 2 |
| `apps/desktop/src/renderer/src/personal/settings-model.ts` | 0 | 12 |
| `apps/desktop/src/renderer/src/personal/settings.tsx` | 1 | 83 |
| `apps/desktop/src/renderer/src/shell-preview.tsx` | 2 | 2 |
| `apps/desktop/src/shared/context-panel.ts` | 2 | 6 |
| `apps/desktop/src/shared/ipc-forwards.ts` | 0 | 2 |
| `apps/desktop/src/shared/ui-contract.ts` | 0 | 6 |
| `examples/eval/Start-Memory-Acceptance.command` | 0 | 71 |
| `examples/eval/daily-compaction.mjs` | 7 | 2 |
| `examples/eval/e2e.mjs` | 2 | 3 |
| `examples/eval/guards.mjs` | 1 | 1 |
| `examples/eval/memory-everyday-acceptance.mjs` | 5 | 5 |
| `examples/eval/memory-recall-completeness.mjs` | 0 | 223 |
| `examples/eval/memory-recall-scale.mjs` | 0 | 275 |
| `examples/eval/memory-recall.mjs` | 0 | 267 |
| `examples/eval/memory-sequence-acceptance.mjs` | 1 | 1 |
| `examples/eval/memory-transition-acceptance.mjs` | 1 | 1 |
| `examples/eval/package.json` | 0 | 1 |
| `package.json` | 0 | 1 |
| `packages/assistant/src/api.ts` | 3 | 3 |
| `packages/assistant/src/app.ts` | 35 | 79 |
| `packages/assistant/src/assistant-controller.ts` | 6 | 126 |
| `packages/assistant/src/browser.ts` | 1 | 1 |
| `packages/assistant/src/context-assembler.ts` | 89 | 22 |
| `packages/assistant/src/context-budget.ts` | 13 | 33 |
| `packages/assistant/src/context-compaction.ts` | 1 | 0 |
| `packages/assistant/src/context-compactor.ts` | 12 | 54 |
| `packages/assistant/src/context-sources.ts` | 6 | 11 |
| `packages/assistant/src/context-window.ts` | 3 | 248 |
| `packages/assistant/src/controller-dreaming.ts` | 4 | 9 |
| `packages/assistant/src/controller-memory.ts` | 1 | 1 |
| `packages/assistant/src/controller-work-tasks.ts` | 0 | 2 |
| `packages/assistant/src/dreaming.ts` | 13 | 7 |
| `packages/assistant/src/host-commands.ts` | 1 | 13 |
| `packages/assistant/src/memory-consolidation.ts` | 7 | 36 |
| `packages/assistant/src/memory-context-view.ts` | 0 | 107 |
| `packages/assistant/src/memory-embedding-client.ts` | 0 | 271 |
| `packages/assistant/src/memory-health.ts` | 20 | 17 |
| `packages/assistant/src/memory-instructions.ts` | 5 | 4 |
| `packages/assistant/src/memory-native-acceptance.ts` | 11 | 8 |
| `packages/assistant/src/memory-query-rewrite.ts` | 0 | 101 |
| `packages/assistant/src/memory-reference-source.ts` | 16 | 120 |
| `packages/assistant/src/memory-relevance.ts` | 0 | 122 |
| `packages/assistant/src/memory-retrieval.ts` | 0 | 298 |
| `packages/assistant/src/memory-semantic-index.ts` | 0 | 270 |
| `packages/assistant/src/memory-store.ts` | 7 | 0 |
| `packages/assistant/src/memory-temporal-acceptance.ts` | 4 | 4 |
| `packages/assistant/src/modules/checkpoint-module.ts` | 2 | 3 |
| `packages/assistant/src/modules/memory-module.ts` | 3 | 4 |
| `packages/assistant/src/task-instructions.ts` | 3 | 29 |
| `packages/assistant/src/task-worker-context.ts` | 3 | 8 |
| `packages/assistant/src/tui-module-config.ts` | 3 | 32 |
| `packages/assistant/src/memory-read-tools.ts` | 32 | 0 |
| `packages/assistant/src/memory-snapshot.ts` | 60 | 0 |

</details>

<details>
<summary>附表 B：同步删除的测试文件</summary>

- `apps/desktop/src/main/context-settings.test.ts`
- `apps/desktop/src/renderer/src/desktop-memory-semantic.test.ts`
- `apps/desktop/src/renderer/src/memory-references.test.ts`
- `examples/eval/memory-recall-completeness.test.mjs`
- `examples/eval/memory-recall-scale.test.mjs`
- `examples/eval/memory-recall.test.mjs`
- `packages/assistant/src/app-memory-chain-acceptance.test.ts`
- `packages/assistant/src/app-memory-index-maintenance.test.ts`
- `packages/assistant/src/app-memory-relevance.test.ts`
- `packages/assistant/src/app-memory-retrieval.test.ts`
- `packages/assistant/src/app-memory-upgrade.test.ts`
- `packages/assistant/src/assistant-controller-memory-index.test.ts`
- `packages/assistant/src/context-window-runtime.test.ts`
- `packages/assistant/src/context-window.test.ts`
- `packages/assistant/src/dreaming-acceptance.test.ts`
- `packages/assistant/src/memory-context-view.test.ts`
- `packages/assistant/src/memory-embedding-client.test.ts`
- `packages/assistant/src/memory-query-rewrite.test.ts`
- `packages/assistant/src/memory-recall-live.test.ts`
- `packages/assistant/src/memory-recall-persistence.test.ts`
- `packages/assistant/src/memory-relevance-selection.test.ts`
- `packages/assistant/src/memory-relevance.test.ts`
- `packages/assistant/src/memory-retrieval-scope-consistency.test.ts`
- `packages/assistant/src/memory-retrieval-temporal.test.ts`
- `packages/assistant/src/memory-retrieval.test.ts`
- `packages/assistant/src/memory-semantic-index.test.ts`
- `packages/assistant/src/memory-upgrade-config.test.ts`

这些文件测试的是退役检索 / 索引 / 模式 / 工作摘要 / 方法提炼入口；底层 MemoryStore 时态、来源、候选 CAS、写入不确定性与 I1–I5 测试未删。已有方法的来源失效、归档和依赖测试留在 `dreaming.test.ts`。

</details>

<details>
<summary>附表 C：修改旧断言的依据与失败记录</summary>

| 文件 / 测试 | 旧断言 → 新断言及理由 |
|---|---|
| `baseline-assembly.test.ts` 四组组装 | 旧所有工具/提示词完全同字节 → 精确比较非记忆工具 schema / 非记忆系统文本；只允许新 read 指令与自主去旧 Memory 工具。模块诊断的 pinned preview 文案精确替为 snapshot 文案；历史快照文件原封不动 |
| `context-assembler.test.ts` | 动态 reference 在历史前 → ②固定、⑤随消息，重开 / 刷新 / rollback；140000 字节工具结果完整，并验证旧 Run 引用不能复活 |
| `app.test.ts` / `steering-controller.test.ts` / TG 测试 | metadata 只等于 source/exclude → 原字段保留并允许验证新增可选 contextReferences；parts 未改 |
| `foreground-autonomy.test.ts` / 主聊天引用断言 | 参考不得持久化 → ⑤以 metadata 持久化，普通用户消息仍一条；工具执行与授权不变 |
| `memory-consolidation.test.ts` / `memory-correctness.test.ts` | 无关键词重合的事实 / 较旧 a2 不在材料 → 固定有界冲突材料保留它们；foreign scope、来源、CAS 仍检查 |
| `context-compactor.test.ts`、CLI、desktop-runtime 等 | 手动 compact 命令文案 / UI 入口 → 删除入口专属断言，核心 summary / retry / abort / unknown / 预算测试改调用 prepare(force)，未删其安全断言 |
| `memory-health.test.ts` | 同 Thread 不列排除、pinned-only 预览 → 全部 Thread 记忆不进固定 workspace 快照；snapshot 诊断 |
| `modules/memory-module.test.ts` | 指令以旧写说明开头 → 新 read 说明在前，旧写规则的内容断言仍在 |
| `workspace-task-read.test.ts` symlink | 等 task_read 返回 TASK_FILE_INVALID → 固定方法索引读取同一目录时先 fail-closed；主模型未执行，诊断为 DREAMING_SYMLINK_NOT_ALLOWED，其余权限断言保留 |
| `examples/eval/e2e.test.mjs` | 从产品模式函数生成两档预算 → 冻结历史 RD/RL 的原数字 fixture，传纯预算，不传退役 mode/warning；case、Oracle、历史分数未改 |

失败记录：

- 首轮运行时 44 fail / 3 cancelled；首轮桌面 exit 1：退役配置 / 旧断言未清完，逐项修复。
- `full2.log` 2 fail：memory 指令开头 anchor 和 symlink 提前失败路径；按上表修正。
- `full3.log` TS 编译失败：测试中的 Tool.execute 联合类型转换；仅修测试类型。
- 停用文档回归先红：按 ID 读到空成功；修读工具检查 active/missing 后绿。
- `full-final.log` 0：运行时 1520 pass / 11 skip，桌面 631 pass，scripts 12 pass。
- `eval-test.log` exit 1：daily-compaction 导入已删的模式函数；冻结数值 fixture 后 `eval-test2.log` 剩 CE03/CE05 两个重开重复压缩失败。定位到 compactor 目标从旧 warning 改 trigger 时漏扣增长预留，修后 `eval-test3.log` 84/84。
- `complete.log` 3 fail：新 snapshot 诊断文字仍与旧 baseline 比较；只在比对器中列明精确批准差异，未重录 snapshot。最终重跑结果见正文。
- 收尾在 assembler:194 复现旧 foreground metadata 跨 Run 复活：原请求被压缩后，后续普通 Run 又得到旧任务引用；新增同一核心测试中的边界断言先红，只按 currentUserId 选择引用后 10/10 定向绿（foreground-repro / foreground-fixed.log）。
- `delivery-final.log` 全量 exit 1：Computer Controller deny 场景原有 5 秒 waitFor 超时（1519 pass / 1 fail / 11 skip），回执断言未执行到；不改该测试 / 超时，独立复测 4/4，随后 `verified-final.log` 全量 exit 0。
- `updates-repro.log` 先红：固定②之外新增 extra 后撤回，重开未作废 extra；⑤附注可选 metadata 保存本次引入 ID，后续与当前投影比较。文档索引回到初态也发送覆盖附注。`updates-fixed.log` 10/10。
- `refresh-repro.log` 先红：快照刷新后旧⑤附注仍重复已失效 extra；模型展开时折叠最新快照边界之前的旧记忆附注，原消息/metadata 不改。首次修复编译 exit 2（ES2022 无 findLastIndex），改用 reduce；`refresh-fixed.log` 10/10。
- 最初截图大小不同，后一次 HMR 重置页面，均丢弃这两批像素数字；设置页还有滚动位置不齐，报告只列同状态、同布局的方法 / 上下文两组结果。
- 付费前两次配置预演报 `Invalid TUI config schema`，均为 0 网络请求：日用配置含归档实现不支持的 main 专有 `herdrBinding` / `telegramAutonomy.toolApproval`。只在两臂 ordinary 测量配置副本移除非活动 Herdr/TG 配置；新臂另外移除本步退役字段。最终 40 次零网络装配通过后才开始计费，日用原配置未改。

</details>

<details>
<summary>附表 D：计费对比原方案（用户已批准并执行，结果见附表 E）</summary>

采用 `e7e51af` 的独立归档实现旧臂，当前提交为新臂；旧实现只存在评测临时目录，不进入产品、不加开关。日用日志与记忆只读，重放在隔离副本。先选两组各十条连续普通消息、每请求约 11–13 万输入 token 的样本，两臂逐对交错，第二组反转先后顺序，保留每组首个冷请求。同一主模型、冻结的同一历史/问题、同一运行模式和输出上限；各臂使用自身真实工具表和装配，限首个主请求，不执行真实工具，不开启后台沉淀/压缩，失败不重试，不自动增样或重跑。

计划调用上限：

- **40 次主模型请求** = 2 组 × 10 轮 × 新旧两臂；主输出上限 256 tokens。
- 旧臂最多 **20 次相关性辅助请求**，沿用实际 relevance 开启的配置；它替代 rewrite，不叠加第二次 rewrite，原输出上限 768。
- 旧臂最多 **60 次 embedding HTTP 请求** = 两组 × 每组最多 20 条初始事实 + 两组合计 20 条问题；用两组独立冷索引，其余同组复用。数据量/调用数超出上限先停，不截断原文来凑预算。
- 合计最多 **120 次计费 API 请求**；新臂没有检索辅助 / embedding 请求。

价格依据（2026-10-21 官方页只读核对）：

| 模型 / 路由 | 单价 |
|---|---|
| [Command Code DeepSeek V4.1 Flash Fast](https://commandcode.ai/models/deepseek-v4-1-flash-fast) | 输入 $0.16/M、cache read $0.02/M、输出 $0.58/M |
| [Command Code Provider](https://commandcode.ai/docs/provider) | 按 underlying API rates 计费；不把 coding-plan credits 当免费 |
| [北京 DashScope qwen3.7-text-embedding-flash](https://help.aliyun.com/zh/model-studio/model-pricing) | 输入 ¥0.125/M，输出不收费；不按免费额度抵扣、不按 Batch 半价 |

按主请求平均 120K 输入、旧辅助每次保守 24K 输入计，全部不命中约 **$0.86**；有缓存时预计 **$0.60–0.90**。把每主请求按 256K 输入、20 次辅助按 24K、全额输出上限计，全部冷输入约 **$1.73**，是 token 假设下的保守估算，不是服务商封顶承诺；建议本批美元预算 **$2**。embedding 按总输入不超过 256K tokens 估算 **¥0.032**，建议单列 **¥0.05**。开始前冻结样本和调用清单；usage 使剩余预算预测超出就停止，后续重跑另批批准。

指标：每臂 ΣcacheRead/Σinput（含冷首轮，usage 缺失保持未知）；从接收消息开始，包含旧辅助等待，到首段非空可见正文的配对中位数；推理不算正文。工具首输出但没有正文、无输出、请求失败分别列数，不塞进正文等待中位数。只报告实测结果，未达到 70% 或中位数未下降就明确未通过，20 对只作为本轮试验，不声称稳定统计保证。提供组内 prefix hash 证明装配未偏离，真实缓存以 provider usage 为准；Command Code 缓存 TTL 未获保证。

</details>

<details>
<summary>附表 E：2026-10-21 真实模型结果、口径与证据</summary>

本批结论：**通过**。主模型和单价沿用附表 D，用户批准上限为 120 次请求、$2 + ¥0.05；完成后停止，没有补足请求数。

| 实测指标 | 旧组装 `e7e51af` | 新组装 `a92fab7` |
|---|---:|---:|
| 主请求数 | 20 | 20 |
| 主请求 input tokens | 1,859,414 | 1,991,624 |
| 其中 cache-read tokens | 145,920 | 1,771,904 |
| 主请求 token 加权缓存率 | 7.8476% | 88.9678% |
| 同 18 对首正文等待中位数 | 5.924242 秒 | 2.918203 秒 |
| 仅工具输出 / 无输出 | 2 / 0 | 2 / 0 |
| 主请求 output tokens | 4,253 | 4,234 |
| 主请求费用（美元） | $0.27954418 | $0.07304900 |
| 辅助请求及费用 | 20 相关性：$0.00523318；38 embedding：¥0.000697875 | 0 |

逐对 new−old 的等待差值中位数 **−3.047863 秒**，不是两臂中位数相减。主请求缓存率含每组首轮；若把旧相关性辅助也纳入 chat 总输入，旧为 **8.2908%**，新仍为 **88.9678%**。两组分开主请求缓存率：第一组旧 7.70% / 新 87.98%，第二组旧 7.99% / 新 89.89%。

费用复核：旧相关性 input/cache/output 为 36,477 / 11,264 / 1,679 tokens；embedding 输入 5,583 tokens。美元按 `(input−cache)×0.16/M + cache×0.02/M + output×0.58/M`，人民币按 embedding input×0.125/M；合计 **$0.35782636 + ¥0.000697875**。这是供应商返回 usage × 已核对官方单价的实际用量核算，未核对供应商账单扣款，不按免费额度抵扣。98 条 dispatch 对应 98 个唯一调用编号，全部 HTTP 200、usage 完整，未结预留为 0，0 传输失败 / 重试 / 加样。旧相关性 19 次 succeeded、1 次 degraded（第一组第 10 对，HTTP 200）；按旧实现保留该样本及其等待，没有重跑。

测量方法与边界：

- 两臂使用真实 `createRuntimeApp`、自身实际 instructions / 工具 schema / 上下文准备，旧实现仅在临时归档。冻结同一份 1,140 条主对话、16 条有效压缩记录和当前正式记忆；每组十条连续普通消息，不跨有效摘要周期，两组互不重叠。第一组逐对 old→new，第二组 new→old。同组共享相同记忆副本，旧向量冷索引组内复用。checkpoint / dreaming 文件原本不存在，未虚构文档。
- 两臂都是 ordinary primary、非 TG / 非自主；测量副本共同移除未活动的 Herdr/TG 配置，新臂另移除 `modules.memory.queryRewrite/semantic/contextView`、`contextCompaction.mode/warningRatio`。保留其余共同声明，不改日用配置、权限或数据。
- 从 `runtime.run()` 调用前计时，包含真实准备与旧辅助等待，到 provider 首个非空 `text-delta`；reasoning 不算正文。已有历史预置 / 初始化不计时，没有把历史 receivedAt 与今日时间相减。完整消费首个主请求以收 usage，主输出上限 256、旧辅助沿用 768；给本地 Runtime 固定停止结果，不执行生成的工具调用，不用新生成文本推进下一轮历史。没有后台沉淀或额外压缩请求。
- 两臂各两条相同配对只有工具输出，未按零秒塞入中位数；其余 18 对均保留。40 个主响应 finishReason 为 stop 5、tool-calls 9、length 26；输出 cap 会限制答复，不据此评定答案 / 工具任务质量。没有裁剪输入；provider 实际主输入为 77,346–116,553 tokens，与本地估算不是同一口径。
- 组内 tools、system 和既有 summary hash 各稳定为 1 种；位于其间的旧动态参考每组为 10 种，新固定②为 1 种（新②为 `jcs-sha256:v1:533b8268ffb731dfaeb5d435aaf4d7a263e42d0f3a07dcb6c5145148e4b03d26`）。这些仅证明装配稳定性，缓存验收仍取真实 provider usage。没有本地付费 warmup，也没有能力保证清空云端缓存或其 TTL。
- 每个 HTTP 前检查数量与保守费用预留，禁止 redirect / 自动重试，缺失 usage 或意外请求会停止。20 对是本轮受控首请求性能 pilot，不是稳定统计保证、32K 可用性、真实工具全链路或原生 Electron / 常驻进程验收。

本地证据目录 `/tmp/serika-cm-step3-live.9OTL94/`：`live-results.json`（逐请求用量与装配分段 hash）、`live-summary.json`、`live-dispatch.jsonl`、`live.log`；零网络装配见 `dry-results.json` / `dry-summary.json`。运行脚本 SHA-256 为 `0d9b63f260d5bd3a1c5a5702dc72544d39d40b57d6fa23cb4157ec0708c5c569`，运行后复核一致。冻结原日志 SHA-256 为 `e3486c5ea37f11dda5111f22a91d0b4416252f935e5e20641225f803a4872e3f`，记忆为 `17ba4edba47851d46c3a7a503719bb2e5cd9550938aeb019a0d7f31bb156607d`。含私人原文的冻结文件仅在本地 0600 副本，未提交；临时归档、评测脚本和生成物也未进入产品仓库。

</details>
