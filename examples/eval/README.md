# Serika promptfoo eval

不需要 PostgreSQL，不启动桌面、常驻服务或 worker。每条案例独立创建临时 workspace/config/transcript，结束后清理；不读取日用配置、历史或记忆。结果留在此目录的 `results/`，不提交 Git。

## 第 3 步后的记忆验收

查询改写、相关性与向量召回 eval 已随对应产品实现删除；旧报告与分数保留。固定快照与读工具离线结果见 `docs/v2-pilot/cm-step3.md`；真实模型缓存与首正文 A/B 需另行批准次数和费用。

## 连续压缩保真回归（独立新套件）

`CF03` 用日常档连续压缩 3 轮，`CF05` 用长任务档连续压缩 5 轮；每轮追加越过该档位 85% 触发线的独立合成历史。目标、已确认决策、未完成事项、未获批准的部署、成功读取及结果未知的非幂等写入工具对只在第一轮提供，后续素材不补答案。每轮保存实际摘要与预算快照，检查完整增量链、unknown 写结果未被改写为成功／失败及无工具重放；最后另起新进程，检查复用摘要不新增压缩调用。使用现有 Controller／AgentLoop，不新增执行框架。

五分钟离线 Demo：`pnpm eval:test` 可验证 Oracle 的正例和丢失目标／权限等负例，不收费。下面是真实模型命令，需用户在自己的终端配置 Key 并明确承担调用费用；本次新增套件的真实模型结果仍为 **not_run**，不能用离线绿测代替：

先核实供应商对当前精确模型的窗口声明，再在终端设置 `COMMAND_CODE_CONTEXT_WINDOW_TOKENS` 为已核实的正整数，或配置同一 `provider + modelId` 的 `modelContextWindows`。不要为了通过测试猜填 1M。日常／长任务的完整输入目标分别要求窗口至少容纳 256K／400K 加 4,096 输出预留和 32,768 安全余量。容量未知的保守上限或较小模型不能被记为“大体量档位通过”。新 CF Oracle 分开核对冻结的请求档位和真实有效预算，允许已核实的非 1M 窗口，但不放松输入目标、近期保留、摘要或分块要求；旧 RD／RL 判分和历史报告保持不变。

```sh
SERIKA_EVAL_LIVE=1 RUNLOOM_MODEL=command-code \
COMMAND_CODE_MODEL_ID=deepseek/deepseek-v4.1-flash-fast \
pnpm eval:e2e --suite compaction-fidelity --cases CF03,CF05 --repeat 1
```

另有独立的 **32K 有效预算**套件 `CE03/CE05`：在隔离配置中为精确 provider/model 设置 32,768 上限，仍保留日常／长任务档位意图，按 Runtime 的真实投影生成历史（输入 26,624、近期原文 20,480、摘要输出 2,048、输入分块 22,528）。它只证明配置小窗口下的连续压缩链路，不能并入 CF 满档或旧 RD/RL 的分母，也不证明供应商容量；真实模型仍为 **not_run**。

```sh
SERIKA_EVAL_LIVE=1 RUNLOOM_MODEL=command-code \
COMMAND_CODE_MODEL_ID=deepseek/deepseek-v4.1-flash-fast \
pnpm eval:e2e --suite compaction-fidelity-effective --cases CE03,CE05 --repeat 1
```

分母是两项任务，不是 8 项独立测试：任一轮失败会使整项任务失败。事实验收采用固定字面短语及来源 ID，是可复核的保守回归 Oracle，不是通用语义质量评分；同义改写可能被判失败，应保留原始证据人工复核而不是回写分数。报告冻结新 suite/spec/Oracle 指纹，不改旧 RC／RD／RL 题目或历史报告；不宣称模型物理 1M、Electron／TG 或日用重载已验收。

## 五分钟开始

在仓库根目录，Node >=22.22（eval 工具的要求；运行时原有 >=22.12 要求不变）：

```sh
pnpm install
pnpm eval:test
pnpm eval
pnpm eval:view
```

`pnpm eval` 是免费、无模型网络调用的离线套件，报告为 `examples/eval/results/offline.json` / `offline.html`。view 只监听 `127.0.0.1`；不会主动分享报告。promptfoo 遥测和更新检查关闭，缓存关闭，串行执行。

`pnpm eval:view` 打开本地 HTML 报告服务，访问 `http://127.0.0.1:15500/`；真实模型报告用 `/live.html`。这是导出报告查看入口，不是 promptfoo 的全功能管理面板（其当前 `view` 命令不能限制监听地址，所以不作为默认入口）。Ctrl+C 关闭。

## 当前主入口：三层验收

```sh
pnpm eval:guards
# 在你自己的终端隐藏输入 Key，不要写进命令历史或聊天：
read -r -s 'COMMAND_CODE_API_KEY?Command Code API Key: '
export COMMAND_CODE_API_KEY
export SERIKA_EVAL_LIVE=1 RUNLOOM_MODEL=command-code
pnpm eval:e2e --cases T01,T02,M01,M02,S01,C01,M06,R01 --repeat 1
pnpm eval:e2e --repeat 3
SERIKA_EVAL_VIEW_PORT=15501 pnpm eval:view
unset COMMAND_CODE_API_KEY
```

隐藏输入示例适用于 macOS zsh。`pnpm eval:e2e` 只使用当前进程环境里的凭据，不读取日用凭据文件。真实模型调用会计费；缺 Key 或配置为 mock 就失败，不降级成离线结果。你可以先跑 8 条试跑检查接线，再跑完整的 16 条 × 3；试跑不计入正式 48 次。

| 层 | 命令或入口 | 判定依据 |
| --- | --- | --- |
| 1 程序保护 | `pnpm eval:guards` | Eval Oracle、取消/截止、记忆正确性、预算、存储回执五组确定性测试；不计入模型成功率 |
| 2 真实模型后端 | `pnpm eval:e2e --repeat 3` | 真实 Controller/AgentLoop/模型/工具；独立 Oracle 查磁盘、记忆来源、待审、排期、摘要和执行回执 |
| 3 实际产品 | 日用 Electron / worker / Telegram | 单独操作与证据；后端通过不自动把产品标成通过 |

查看 `http://127.0.0.1:15501/latest`。旧 `/live.html` 是早期 6 条 smoke 报告，不是这份完整验收结果。viewer 只监听本机地址。

### 固定场景与边界

| Case | 验收目标 |
| --- | --- |
| T01–T04 | 无工具聊天、真实文件创建/读回、精确编辑、拒绝后无副作用 |
| M01–M06 | 正式偏好/真实来源、同义新增来源、冲突不堵同批事实、场景区分、纯提醒排除、新进程新 Thread 召回 |
| S01–S02 | 三分钟 typed 提醒保存与时间、后台不可用警告留在主回复 |
| C01–C02 | 真实摘要保留关键事实、重启复用旧摘要不重账 |
| R01–R02 | 新进程历史回放、旧批准不继承/不重放写入 |

每次 Case 都重建独立临时 workspace/config/transcript；重启场景确实另起子进程。只允许规定的 `notes/report.md` 文件操作及合成喝水提醒；无 Shell/联网研究授权，不读取日用数据。提醒 fixture 不启动 worker，不声称到期通知。摘要 fixture 使用 12K 测试预算、1.5K 近期原文、2K 摘要输出和独立 24K 摘要输入分块，**不等于生产 256K/400K 连续链验证**。

Oracle 不相信回复里的“完成”：检查实际产物、来源、待审、游标及回执。所有主回复另查整理 JSON 泄漏。失败时仍保存可读取的部分产物；读失败明确记录，不伪造空数据。真实供应商报告的缓存/Token/用量进入报告，未报告或未配价格为 `null`/未知，不当作零费用。重试按现有调用记录计算，跨进程按调用 ID 去重。

每次报告独立保存在 `results/<时间>-<SHA>/`，包含 `manifest.json`、`summary.json`、逐条 `evidence/*.json`、Promptfoo JSON/CSV/HTML、程序门禁与 `product.json`。分母包括全部计划运行，环境错误和未运行不会被剔除；Whole-case retry 与缓存关闭。实际使用的模型、Git SHA、dirty 状态、diff hash 和评测器指纹均记录。修改题目/Oracle 后必须视为新评测版本，不回写旧分数；人工复核可另附记录，不冒充原始自动分。

第三层通过 `report.mjs` 的 `recordProduct()` 单独记录，状态为 `passed / failed / blocked / not_run`，必须附真实证据与原因。系统提交通知不等于用户收到或阅读；Run 完成也不等于 WorkTask 人工验收。产品数据需要显式授权，不自动用后台结果充当桌面/TG 结果。

## 可靠性扩展：19 个场景 × 3 个变体

在你自己的本机终端运行（不要在聊天里发送 Key）：

```sh
zsh examples/eval/Start-Reliability-Eval.command
```

脚本隐藏输入 Key，只导出到本次进程环境，退出后清除；固定请求 Command Code `deepseek/deepseek-v4.1-flash-fast`。它不读取旧终端、凭据文件、剪贴板或日用数据。缺 Key、错误模型配置会明确失败，不回退 mock。已有环境变量时也可直接运行：

```sh
SERIKA_EVAL_LIVE=1 RUNLOOM_MODEL=command-code \
COMMAND_CODE_MODEL_ID=deepseek/deepseek-v4.1-flash-fast \
pnpm eval:e2e --suite reliability --repeat 3
```

| 组 | 场景 | 实际计划 |
| --- | --- | --- |
| RM01–RM05 | 明确保存、同义增加来源、冲突不堵同批及后续事实、Thread 隔离、场景保守边界 | 15 次 |
| RM06–RM10 | 同句矛盾整组待审、提醒混合偏好、含糊范围不扩大、撤回恢复冲突、新进程召回 | 15 次 |
| RM11 | 明确变更带新事实身份，后续普通相反陈述仍待审 | 3 次 |
| RC01–RC04 | 事实位于开头／中段／接近切点、多事实与未批准状态 | 12 次 |
| RC05–RC08 | 完整长工具结果、连续增量压缩、新进程复用、跨 24K 摘要块累积 | 12 次 |

每场景三个明确的表达／数据变体，每变体在新 workspace 独立运行一次。当前完整计划 57 次；早期 18 场景的 54 次报告保留原分，不回写。不是 57 个不同任务，也不是同一输入随机重复三次。Promptfoo `--repeat` 在此套件内部为 1，三行变体已经显式生成；原种子套件仍用相同输入重复。变体编号和真值、不同场景数、计划／执行／未执行、每场景是否三次全过均留在报告中。

Oracle 还检查：当前回执所称的待审有同一来源的真实候选；未知案例不得只凭 Run 完成过关；关键事实必须真的进入压缩前缀；工具历史不重放；实际 runtime modelId 必须为 fast。RM03 仅测试普通相反陈述，不再把“改成”题意混进去。RM09 的两轮语义提取用真实模型；第二轮若待审，fixture 只批准恰好一条本轮来源匹配的 workspace/general/sweetened 候选，再测冲突恢复和明确撤回后恢复。审核／撤回／恢复是隔离宿主的显式操作，不冒充自动行为或日用点击。

本套件的 RC 组仍用 **12K 输入窗口估算**，不是 256K／400K 压力测试；RC08 通过更长的合成历史覆盖多块摘要。现有运行时每块携带前一摘要顺序累积，没有虚构额外“合并调用”。日用体量测试另走下述 RD／RL 套件；Electron／真实 TG／到期通知仍须另验。

`pnpm eval:guards` 单列免费程序边界：取消／截止、固定上下文超预算、容量与写入失败／游标、存储和回执。这些测试通过数不加入真实模型成功率。小样本用于找失败样本，不能证明“可靠性 100%”；安全越界、错覆盖、假回执、工具重放必须单独列出，不能被平均成功率盖住。

运行期间不要修改测试集、Oracle 或被测运行时；失败保留，不自动整案重试。费用无价格配置时显示未知，不算零。后续版本比较必须保持相同套件／变体、模型和配置；不能拿新增测试与旧 24 次混算百分点提升。

### 本轮：12 次记忆回归＋16 次日用体量压缩

```sh
zsh examples/eval/Start-Daily-Level-Eval.command
```

固定 fast 模型、隐藏输入 Key。顺序执行 RM03／RM05／RM09／RM11 各 3 变体，再执行 RD01–RD08（日常）与 RL01–RL08（长任务）各一次，分别保留两个报告；即使记忆批失败，也继续执行原计划内的压缩批，不重试或删失败。

| 配置 | 日常 RD | 长任务 RL |
| --- | --- | --- |
| 应用输入预算 | 256,000 | 400,000 |
| 近期原文 | 48,000 | 64,000 |
| 摘要输出上限 | 6,000 | 8,000 |
| 摘要输入分块 | 32,000 | 32,000 |
| 正常触发／预警 | 85%／70% | 85%／70% |

配置直接取生产 `contextBudgetForMode()`，冻结为 `frozen-eval/resolved-specs.json`，不修改生产数字和算法。多主题完整合成历史估算约为预算的 88%，事实在开头／中段／压缩切点前；跨块场景的三个关键来源进入不同的 32K 块。工具 call/result 完整配对；增量场景再追加日用体量历史；重启场景另起子进程，旧摘要复用不得新记调用。

`fixtures/<证据ID>/history.json`、`metadata.json` 保留实际历史、估算量、UTF-8 体量和关键消息位置；增量另留 `incremental-history.json`。Oracle 检查实际档位、历史越过触发线、事实确实进入压缩前缀以及最终估算不超过应用输入预算；不得按更大的物理窗口放行。保留原 120 秒 Run 截止，不延长期限让分数变绿。模型调用级重试若发生仍记录；整案不重试。

这是“生产预算＋大体量合成历史＋真实后端模型”的验收，不是日用 Electron 重载／真实 TG／模型物理 1M 上限认证，也不是把主聊天原文塞满 256K／400K 后禁用压缩的压力测试。新旧题目和体量不同，不与旧 12K 分数直接算百分点提升。

### 旧证据离线重评（零新模型调用）

```sh
node examples/eval/regrade.mjs examples/eval/results/<原报告目录>
```

读取原报告冻结的题目和已经保存的原始证据，以当前 Oracle 重新验收；写入新的 `*-regrade-*` 目录，保留原分、重评分和新 Oracle 指纹。**不改旧 summary／evidence／HTML，不生成新的模型数据，不覆盖 latest。** 标题允许合法编号，目录查看仍只认可原 fixture 的精确工具／路径白名单，越界写入和 Shell 不能因此放行。

## 早期 smoke 模式（保留用于快速排查）

| 模式 | 真正测什么 | 不能证明什么 |
| --- | --- | --- |
| offline | 真实 Controller / AgentLoop / MemoryStore / ContextCompactor，注入脚本化模型响应后检查保存、冲突、游标、工具拒绝和超预算边界 | 真实模型的提取、语义识别、回复质量；Electron/Telegram/通知 |
| live | 相同运行时，替换为项目已有模型配置；按真实保存状态与回复断言 | 原生桌面、真实提醒到期、32K/256K/400K 连续长任务、全部恢复保证 |

离线分数不是模型效果分。案例里的 `extractions` 只驱动离线假模型，live 不向模型提供这些答案。固定预算案例不调用模型；故障注入案例仅 offline 运行。

## 真实模型（会产生费用，需要你显式启动）

先在当前终端安全加载现有模型凭据；不要把 key 写入案例/命令历史/仓库。本套件不自动读取日用凭据文件。

```sh
SERIKA_EVAL_LIVE=1 RUNLOOM_MODEL=command-code pnpm eval:live
```

沿用 `COMMAND_CODE_API_KEY` / `COMMAND_CODE_MODEL_ID` / `COMMAND_CODE_BASE_URL`；也支持现有 `deepseek`、`minimax-m3` 配置。缺凭据/未显式开启/配置成 mock 时立即失败，不降级为离线绿测。只对合成案例发请求。

live 报告在 `results/live.json` / `live.html`。第一轮不加 LLM judge，只有代码断言，因此没有额外裁判模型费用。当前没有将所有内部调用的 usage/cost 汇总给 promptfoo，不能拿面板的空费用当零费用；重试/沉淀仍可能多次调用模型。

promptfoo 对整条案例的外层重试已禁用；运行时原有模型请求重试策略不变。评测只允许合成输入，报告可能保存输入和回复；勿直接导入私人聊天或密钥。

## 加案例与排查失败

- 在 `cases.json` 增加 description、vars、expected；输入 `turns` 可以做同一 workspace 多轮场景，各案例之间隔离。
- 配置的 `disableVarExpansion: true` 必须保留，否则 promptfoo 会把消息数组拆成组合案例，而不是连续对话。
- `provider.mjs` 接现有运行时，结果同时给出回复、有效记忆数、待审数、来源校验、游标、工具开始次数。不要仅断言“记住了/完成了”字样。
- `assertions.mjs` 是明确的业务验收，不是通用质量评分；修改模型/提示词后可重跑 live。框架失败也算失败，不能当作无记忆/无工具。
- 纯提醒案例只评测不进入长期记忆，不评测保存提醒或 worker 到期投递。
- 精确时序、崩溃、取消、并发、权限与存储安全继续由现有 `pnpm test` 负责，promptfoo 不替代它们。
- `pnpm test` 保持原门禁；本评测包另用 `pnpm eval:test` 检查，离线报告用 `pnpm eval` 生成。

初始案例：普通聊天、拒绝工具、偏好自动保存、相反偏好待审、纯提醒 no_memory、片段丢失 deferred、固定上下文超预算明确失败。

接入依据：[自定义 JS provider](https://www.promptfoo.dev/docs/providers/custom-api/) 与 [JS assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)。框架使用本地 promptfoo SQLite 结果目录，这不要求部署数据库服务，也与 Serika 核心持久化无关。
