# 第二批文档清理审查

审查基线：`db59edfcbe38e5c285b145477d6c07e54ffb26d1`。结论：四份候选全部保留，本批无删除。

## 改了什么

新增本审查记录。四份候选中，两份报告仍有独立的边界说明和定向验证命令；按本批成组删除要求，两份对应任务书一并保留。

## 逐条对照验收项

| 候选 | 结论与保留段落 |
| --- | --- |
| [optimization-route-impl-brief.md](../legacy/batches/optimization-route-impl-brief.md) | 保留。第 36–60 行是 A＋B 任务依据，仍由报告第 3 行引用；对应报告需保留，本批不拆组删除任务书。 |
| [history-durability-batch-a-b.md](../legacy/batches/history-durability-batch-a-b.md) | 保留。第 14–18 行说明缓存失效、等待租约不占写入队列、未知伴随记录保留和写入失败停止派发；第 25–39 行给出存储与回执故障的定向命令和观察条件；第 41–51 行区分日用操作与存储夹具证据。 |
| [optimization-route-batch2-plus.md](../legacy/batches/optimization-route-batch2-plus.md) | 保留。第 8–16 行是 C＋D 任务依据，仍由报告第 3 行引用；对应报告需保留，本批不拆组删除任务书。 |
| [telegram-lifecycle-confirmation-batch-c-d.md](../legacy/batches/telegram-lifecycle-confirmation-batch-c-d.md) | 保留。第 19–29 行说明归档同步顺序、未知归档再次核对、重启状态及发送前确认复核；第 35–45 行给出两项定向本地验证及观察结果；第 47–57 行保留真实手机操作与脚本替身的证据边界。 |

已对照非 evidence 的受 Git 管理 Markdown，包括现行架构、记忆计划、旧约束和桌面 README。README 第 108、114、130、205、215 行已有确认续办、归档、历史保存及部分测试说明，但未覆盖上述全部细节和命令组合。

除四份候选外，其他 Markdown 只在两份 v2-pilot 记录中提及 `transcript-maintenance.test.ts` 文件名，未找到 A＋B 的完整定向命令组合。`receipt.*sync failure`、`full legacy journal resumes` 和 `expired confirmation can be renewed` 的定向选择器未在其他非 evidence Markdown 中找到。

静态核对确认这些选择器仍对应 `packages/assistant/src/app.test.ts` 和 `apps/desktop/src/main/telegram-gateway.test.ts` 的测试名，两个 transcript 测试文件也仍存在。本批没有执行这些历史验证命令。

## 前后数字

四份候选合计 314 行，全部原样保留。删除文档 0 份，产品代码与测试代码变化均为 0 行；新增文件仅本审查记录。

## 实际检查与结果

- `python3` 调用 `git ls-files -z` 和 `rg` 扫描基线 1,998 个现存 tracked 文件：检查退出码 0。两个报告无入链；两个任务书各有一处组内引用，均在报告第 3 行。无组外入链或脚本引用。
- 新增报告后再次扫描引用并校验相对链接、候选内容与基线相同：检查退出码 0。新增引用均指向保留的候选，未产生悬空引用。
- `git diff --check`：退出码 0。

## 与计划不符的地方及理由

314 行是候选审查范围，本批未达到成组删除条件，因此未删。审查结果通过独立分支提 PR 到 main。验证限于文档引用、内容和测试名静态核对；按本轮范围不运行模型、Electron、日用操作或生成 evidence。
