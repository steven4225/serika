# 上下文与记忆：第 5 步（4c 摘要精简）

## 1. 改了什么

基线 `e16a36f`，最终产品源码 `2c834be`（前一提交 `379b133`）；仅在实验 worktree 实施。依据计划 §2.2、§2.3 和 §4 第 5 步：

- `compaction-records.ts`：保存前精简行动记录；模型输入中的旧工具内容、图片和文本附件换成带消息编号的占位；程序从用户请求／Steer、WorkTask、执行回执和权限状态直接生成不可模糊清单。
- `context-compactor.ts`／`context-compaction.ts`：摘要连同清单上限 12,000 估算 tokens，保存和复用都检查；清单随压缩冻结，复用保持前缀字节一致。旧记录从 hash 校验后的原文回执生成只读精简投影，不改原日志。失败／未知不能容纳时拒绝保存，保留来源。
- `app.ts` 只接入已有 WorkTask 和当前 Thread 的 primary 执行记录（沿用 50 Run 读取上限）；`tool-confirmation.ts` 只增加只读权限快照。使用 Karpathy 指南；查过 legacy 第 73–82、108–110、194–195 行的副作用、确认／remember、授权和原请求恢复规则。I1–I5、verifier、原回执格式和 hash 协议未变。
- 新验证包装脚本 `packages/assistant/scripts/cm-step5-verify.mjs` 为当次运行生成随机编号并关联测试、Electron 结果和截图 hash；原冒烟脚本保持原 SHA-256。

## 2. 逐条对照验收项

下表测试均在 `packages/assistant/src/context-compactor.test.ts`；两档窗口用例名称中的 `<window>` 分别为 `32768`、`1000000`。

| 项目 | 结果与测试名 |
|---|---|
| 失败、结果未知全部保留；完成／未执行各最近 8 条；更早合一行并指向原文 | 已做：`step5: <window> window saves bounded actions and a model-independent request/Steer/checklist`；`retains the last eight completed receipts plus rollup, unknown and denied effects without losing originals` |
| 旧工具结果和旧附件压缩时换占位，原文不丢 | 已做：上述两档用例检查模型输入不含工具正文／图片／文本附件；`step5: restart checklist reads an uncommitted unknown write from real receipts and masks retained old attachments` 检查保留区旧附件；来源消息和 prefix hash 不变 |
| 程序抽目标／约束、请求／同轮修正、未完成、未知、权限、最近真实回执 ≤6 | 已做：两档用例使用真实 WorkTask Store 和权限状态，模型故意忘掉请求，清单仍保留原请求／Steer／约束／未完成人工标准及 6 条回执；重启用例从实际执行 Store 读出未提交 transcript 的 unknown 写入 |
| 摘要 ≤12K；压缩后交办请求不丢 | 已做：两档摘要＋清单均 3,558 估算 tokens；请求已移出近期原文，原句和同轮修正仍在程序清单；旧超大摘要只读投影后也 ≤12K；`step5: an irreducible over-12K failure ledger is rejected without saving or losing failures` 覆盖不能无损满足上限的边界 |
| 固定前缀／授权边界 | 已做：两档用例重开复用时清单逐字相同，权限快照只读一次；Run 结束后真实自主权限清除，历史清单不恢复权限 |
| 全套测试、真实 Electron 冒烟 | 已做：1,806 pass／0 fail／11 既有 skip；macOS、构建后的真实 Electron 44.4.5、假模型、原 preload／IPC，8/8，无意外错误。8 张截图逐张核对，负例只出现预期错误；隔离临时目录已清理 |

## 3. 前后数字

相对基线，产品 TypeScript **+168／−54**；行为测试 **+125／−8**；验证包装脚本另计 **+68／−0**。含包装脚本的测试新增 193 行，超过产品新增 168 行：额外 68 行用于干净源码校验、随机运行编号和退出码／计数／hash 证据，同时保留已有独立复现绑定的原冒烟脚本。新增 4 个行为用例，无删除测试文件、无新增／改写快照。

| 隔离 fixture | 32,768 窗口 | 日用大窗口 1,000,000 |
|---|---:|---:|
| 有效输入上限 | 26,624 | 256,000 |
| 精简前工具大结果（估算 tokens） | 26,323 | 800,107 |
| 保存的摘要＋程序清单（估算 tokens） | 3,558 | 3,558 |
| 行动条目，精简前 → 后 | 45 → 22 | 45 → 22 |
| 清单最近回执 | 6 | 6 |

45 条来源为 21 完成、20 未执行、2 失败、2 未知；保存为 8＋8＋2＋2 原条目及两条归档提示。token 口径沿用 `char-half/v1`，不是供应商实测。旧只读盘点最大摘要 33,493 估算 tokens（pending F）不是本 fixture 的对照组，不据此宣称真实日用降幅。真实模型调用 0、本步费用 $0，既有账本累计 $0.36 未变。

## 4. 实际命令和退出码

最终源码 `2c834be` 的干净工作区运行 `node packages/assistant/scripts/cm-step5-verify.mjs`，退出 **0**。随机运行编号 `4d918125-930e-46a6-86f4-c309e1175663`；下列退出码、计数和指标来自 [verification.json](evidence/cm-step5/verification.json)，Electron 环境及重启证据见 [result.json](evidence/electron-smoke/result.json)，当次关联见 [cm-step5-run.json](evidence/electron-smoke/cm-step5-run.json)。`sourceHashes` 为运行前文件快照；当次冒烟产物以 `smoke.sha256`／`smoke.screenshots` 为准。

| 实际命令 | 退出码与结果 |
|---|---|
| `pnpm typecheck` | 0 |
| `pnpm test` | 0；运行时 1,163 pass／11 skip，桌面 631 pass，桌面脚本 12 pass；全部 0 fail |
| `pnpm --filter @serika/desktop smoke` | 0；8/8，逐项 `unexpectedErrors=0`；Electron 主进程重启前／后 PID 76509／76601 |

`gh issue list --state all --search 'experiment/architecture-v2 审核记录 in:title' --json number,title,url` 退出 0、返回 `[]`，未发现该审核 issue。提交前 `git diff --check` 及证据目录密钥前缀扫描均退出 0、无命中。

## 5. 与计划不符的地方及理由

第 5 步范围无扩展；分层摘要、后台屏蔽、排除记录和 CF／CE 留第 6 步。12K 为本步总体硬上限，现有容量绑定仍约束压缩调用和总输入。无法容纳全部失败／未知时明确失败；不以删记录凑上限。清单是压缩时的历史快照，后续用户原文和实时权限钩子继续生效。

按 AGENTS.md 单列两处历史断言变更：

- 原 `aggregates repeated completed file receipts without merging across uncertain effects or losing original receipts` 期待同文件归并为 4 组、每组最多 8 个调用 ID；改名为 `retains the last eight completed receipts plus rollup, unknown and denied effects without losing originals`，期待最近 8 个独立成功回执＋旧条目汇总，并保留未知／拒绝及最近成功 ID。
- `compacts interleaved successful reads and edits, without turning reads into saved file evidence` 原期待 2 组，现为 9 条（最近 8＋汇总）；读回执不能变写入证据的断言保留。

原因均为计划明确替换旧分组策略；未为无关失败改断言。只读复现另发现旧 `firstKeptMessageId=null` 边界在追加消息后失配（前缀 hash 未变），已记入 pending I，留第 6 步。

独立复现沿用**用户提供的 bot1 证据**：`1ebaffa`，Linux＋Xvfb＋真实 Electron 44.4.5＋假模型，8/8、截图逐张核对。原冒烟 SHA-256 仍为 `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f`，本机未重做云端复现。真实模型和第 9 条重放按已批准排期，待第 6 步完成后合批，预算 $2。未验证 macOS 日用常驻进程／日用数据，也未在 Linux 重跑本步新代码。当前停止，等待第 5 步审核；不开始第 6 步。
