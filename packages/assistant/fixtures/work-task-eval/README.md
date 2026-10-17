# WorkTask fixed fixtures

具体化既有 WT01–WT06，不新增案例 ID、通用 runner、生产 API 或模型重试。
全部案例都是隔离样例，不是 Runloom 生产代码或当前项目状态。

## WT01 — repo-regression-v1

复制 src/slug.mjs、test/slug.test.mjs、request.md 到隔离 workspace，
新增 unrelated.txt（正文为 `保留：与本次开发任务无关。\n`），提交一个干净
Git 基线，再记录 fixture commit、文件 hash 和基线命令输出。

固定命令是 `node --test test/slug.test.mjs`，cwd 为 `.`。原始测试应有一项
失败：实现只替换第一个空白，未把所有连续空白组规范化。模型必须自己复现，
做最小修复，再得到同一命令的成功回执。非字符串的既有错误和其它输入行为不变。
只允许 edit_file 修改实现及对应测试；旧测试必须逐字保留，可以末尾追加。
独立检查冻结输入/输出、成功命令在最后一次编辑之后、前后文件清单与非目标 hash。
范围/测试质量仍由用户审核，不能以自动 scope 检查代替 change_scope 人工项。

## WT02 — config-rule-v1

用相同方式安装 src/config.mjs、test/config.test.mjs、request.md 和
unrelated.txt。原始测试应全部通过。本次需求在 request.md 中固定：新增可选
maxItems（整数 1–50），省略/undefined 不改变旧返回形状，旧默认、错误消息、
校验顺序及忽略未知字段行为不变。模型需保留原测试并追加有效/无效/缺省覆盖。

固定命令是 `node --test test/config.test.mjs`，cwd 为 `.`。只允许修改实现和
对应测试，独立验证冻结的边界、无效值、旧默认和错误优先级。API/测试表达质量
仍需人工 api_review，不能只因 exitCode 0 就判整个案例 passed。

这些 .mjs 测试是供模型处理的 fixture，不在默认 pnpm test 的测试 glob 中；
WT01 故意保留失败的基线实现，不能把仓库里这份输入直接修好后冒充模型产物。

## WT03 — project-handoff-v1

把 notes.md 放到隔离 workspace 的 inputs/notes.md；schema 放到
inputs/manifest.schema.json。模型只可读取这两份材料及自己交付的文件，
只可新增根目录 handoff.md、manifest.json。

自动检查两文件存在、非空、Markdown 五个二级标题、JSON 顶层字段和全部
const 值，以及独立前后文件清单（排除程序自己的 .runloom/）和输入 hash。
人工 handoff_consistency 检查仍需审核正文，不能用字段检查冒充人工通过。

## WT04 — dirty-project-brief-v1

在隔离 Git 仓库提交一个干净基线，再安装 brief.md 的用户修改和
unrelated.txt 的用户新增行；记录执行前真实 Git diff 与完整文件 hash。
update.md 放到 inputs/update.md，仅模型读取，不允许修改。

固定安装顺序：基线 brief 用本目录 brief.md，但把
`这段由用户手工修改：保留两个空格  和原有措辞，不要润色。`
替换成 `初稿备注，等待用户修改。`；基线 unrelated.txt 为 `原有内容\n`。
提交这两个文件及 inputs/update.md 后，恢复本目录 brief.md 原文，并把
unrelated.txt 改为 `原有内容\n用户未提交内容：不能删。\n`。
这时再记录 before diff/hash，随后才运行任务。

只允许读取材料/brief，及 edit_file 操作 brief.md。自动检查进度与未决正文
包含冻结事实、先有成功 read_file 再有成功 edit_file，所有非目标区块与
其它文件逐字节不变。任务前的脏 diff 不是助手做的修改。
人工 brief_quality 检查仍需审核表达和未验证范围。

## WT05 — official-source-report-v1

把 request.md 复制到隔离 workspace，新增 unrelated.txt（正文为
`保留：研究任务不能改这条用户内容。\n`），记录输入 hash。只允许新增 report.md。
真实模型须先执行说明中的精确 Exa 查询，再各打开一次指定官方发布页和固定 tag
Markdown 文档。搜索摘要只能用于发现；事实、来源状态和 URL 以实际 fetch 回执为准。
HTML 若截断须写 partial，完整 Markdown 可用于核对 API 语义，但不是运行时实测。

独立检查成功写入回执、实际内容与写入参数一致、真实 finalUrl 被引用、截断被披露、
无额外修改，以及不超过两个来源的生产工具派发记录。request_counter 记录工具调用，
不冒充底层 HTTP/重定向/DNS 包计数；网络预检与案例实际执行必须分开。
opened_source_grounding 仍是人工项，不以关键词命中代替逐项事实核对。

## WT06 — conflicting-sources-report-v1

同样安装 request.md 和 unrelated.txt，只允许新增 comparison.md，不启用搜索。
仅打开 Node v18.16.0/v18.17.0 官方仓库两份固定文档；版本范围差异、旧文档缺失
API 章节，不等于直接实测旧运行时不支持，也不能人为编造成同范围事实矛盾。

独立检查成功保存与回执归属、两个实际来源 URL、输入 hash 及无额外文件。
source_fidelity 和 uncertainty_handling 是人工质量项；可核对的硬失败必须记录，
但程序不得代用户接受交付。本例覆盖版本差异和缺失
证据，不声称穷尽真正冲突来源或验证任何浏览器/本机 Node 兼容性。

## 报告边界

使用现有 AcceptanceCaseResult / writeAcceptanceReport。network=unused
指没有研究/工具网络，真实模型 API 仍联网且收费。独立程序可仅确认上述
隔离路径，必须在报告中披露；不代表 Electron 人工确认。仓库案例的 Shell
只放行精确测试命令，并在每次运行前核对当前实现/测试内容。Host Shell
不是系统沙箱，命令白名单也不能把测试/源码的副作用沙箱化。

产品创建包含必需的人工质量项；自动产物检查通过后仍 awaiting_acceptance。
不调用 recordHumanAcceptance 代用户接受。外部 Eval 的人工 check 保持
not_run，deriveCaseStatus 因而也不是 passed。失败尝试保留，不改 fixture
或验收预算重跑以覆盖首次结果。fixture 本身及脚本不进入模型完成证据。
