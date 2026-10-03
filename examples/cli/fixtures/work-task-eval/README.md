# WorkTask artifact fixtures

只具体化既有 WT03/WT04，不新增案例 ID、通用 runner、生产 API 或模型重试。
全部项目状态为虚构材料，不是 Runloom 项目状态。

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

## 报告边界

使用现有 AcceptanceCaseResult / writeAcceptanceReport。network=unused
指没有研究/工具网络，真实模型 API 仍联网且收费。独立程序可仅确认上述
隔离路径，必须在报告中披露；不代表 Electron 人工确认。

产品创建包含必需的人工质量项；自动产物检查通过后仍 awaiting_acceptance。
不调用 recordHumanAcceptance 代用户接受。外部 Eval 的人工 check 保持
not_run，deriveCaseStatus 因而也不是 passed。失败尝试保留，不改 fixture
或验收预算重跑以覆盖首次结果。fixture 本身及脚本不进入模型完成证据。
