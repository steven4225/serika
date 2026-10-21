# 上下文与记忆：第 6 步

## 1. 改了什么

代码检查已完成；**第 4–6 步真实模型验收未通过，停在审核关口，不进入第 7 步。** 首个提交 `866ba7e` 修 Linux Xvfb 1440×900×24 与产品 +08:00 分钟时间，TG 测试未改。主体由 `context-blocks`、`context-source`、`thread-background`、`transcript-access`、`history-tools` 分担比例边界／分层、原文前缀、队列、排除投影和编号读取；删除同步压缩／即时重试旧路径。新增产品代码超过 400 行，按已批准本步拆分，app/Controller 只接线。日用 env 仅复制模型变量到 mode0600 临时文件，原文件未改，临时目录已删除。

## 2. 逐条对照验收项

| 项目 | 结果与证据 |
|---|---|
| UTC 时间与 Linux 启动 | 已做：`Telegram receive clock…` 在 `TZ=UTC` 先红后绿；后续 runner 同样带 Xvfb screen 参数 |
| 前台立即屏蔽、不等模型 | 已做：`foreground masks complete blocks…`、`context-compaction-runtime`；prepare 辅助模型派发为 0，完整工具单元不拆分 |
| 后台单队列、一次无工具调用、两轮间换摘要 | 已做：`thread-background`；取消／来源变化不保存；每项一次调用，失败保留原文，诊断保留后台错误 |
| 分层／远期索引及比例预算 | 已做：`background installs one bounded segment…`，32K 和日用；最近最多 4 段，第 5 段并入索引，段／索引／总预算按有效窗口缩放 |
| 不可模糊清单、未知效果 | 已做：宿主直接取请求、同 Run 修正、WorkTask、权限和回执；失败／unknown 全保留；`irreducible failure ledger…`、adapter 不重放工具用例 |
| 屏蔽后补抽、不能跳 cursor | 已做：`oversized leading assistant and user material…`、`memory-m1-acceptance`；按顺序分片，最后一片前不越过来源；旧 pending 重抽不覆盖新值 |
| 排除记录与所有内容读取 | 已做：`privacy exclusions survive restart…`、core `exclusion companions…`、backup `export filters excluded…`；原聊天不改，派生记忆与原话清理、撤销不能复活，旧摘要／索引／快照失效；诊断列出相关消息／文档 |
| 搜历史／编号读／工具区间读 | 已做：`history_search`、`history_read`；普通聊天及自主只读，排除消息仅占位；工具正文可按 Unicode 区间读 |
| 单条超窗与服务端超限 | 已做：head/tail+原文占位；`reported provider overflow…` 验证实报比例重算；adapter 最多重试一次、不重放工具 |
| pending I | 已做：`a null tip boundary remains valid after append…`；覆盖前缀 hash 不变时追加仍复用；cm-replay 同步 |
| 顶部等待整理提示 | 已做：quiet 模式隐藏例行 backlog/running，失败／实际回执仍展示；真实 Electron chat 截图已核对无常驻等待条，记忆页保留待整理段数 |
| 全套／真实 Electron | 已做：最终 `cad042e` 干净源码、macOS 构建 Electron、原 preload/IPC、隔离路径；全套 1775 pass / 0 fail / 11 skip；eval 79/79；smoke 8/8 |
| 合批真实模型／原对话重放／32K | **未通过**：首轮 M1 2/18（含固定哈希 replay-9，两档）；CF03 第 3 个后台项拒绝摘要。修抽取 schema 后续跑首调用失败且缺用量，批次冻结；CF05、CE03、CE05、独立冷进程实模验收未跑 |
| 14 行旧记忆表、停止关口 | 已交：附表 B；仅只读，无日用迁移；4 条对话级条目等用户裁决 |

## 3. 前后数字

相对 `a183ddf`，产品 +713/−632，测试 +560/−1481，脚本 +332/−6；新增测试行少于新增产品行。旧同步用例退休的依据见附表 A，历史快照／Oracle 未改分。实测 OS 是 macOS、构建后的 Electron；本机未跑 Linux，沿用用户批准的 bot1 Linux+Xvfb 独立复现，smoke SHA 始终 `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f`。

同一付费批次共 22 次派发：21 次返回用量计 **$0.02199946**，1 次费用未知（派发前预留 $0.0013248，非实际账单）；计划已知累计 $0.38199946。没有触达 $2 门槛；因未知用量先冻结。`live.json` 保留首轮失败与续跑，不把失败／未跑当成功，不把未知当零。

## 4. 实际命令和退出码

最终运行：`node packages/assistant/scripts/cm-step6-verify.mjs` → 0；脚本实际设置 TZ=UTC 并依次执行 `pnpm typecheck` → 0、`pnpm test` → 0、`pnpm eval:test` → 0、`pnpm --filter @serika/desktop smoke` → 0。运行时随机编号、PID、版本、源码／脚本／截图 hash 和实际退出码见 [verification.json](evidence/cm-step6/verification.json)、[smoke result](evidence/electron-smoke/result.json)。真实模型首轮与续跑命令为 `SERIKA_CM4_REPLAY=/tmp/cm-step4-replay9.json node examples/eval/cm-step6-live.mjs --approved-live [--continue-approved-batch]` → 均 1；调用与累计费用见 [live.json](evidence/cm-step6/live.json)、[cost-ledger.json](evidence/cost-ledger.json)。

## 5. 与计划不符的地方及理由

真实模型关口未过：本轮停止付费请求，须先核实未知调用与 CF03 拒绝原因，再继续当前验收；第 7 步不开工。抽取格式修复已做离线／Electron 重验，未获得真实模型重验。所有失败保留。

撤回早先 `first-fixes.json`：它曾事后包装真实日志并补编号，违反运行时证据规则，已删除；首个修复由后续统一 runner 重新实际验证。另复现并修复：合法大窗口原文被旧 32K 合并限额裁剪、完成文件递归进入后续段、单条消息无第二块时重算失败、无排除记录的损坏备份被提前读取；正文未靠改历史分数变绿。只做第 6 步及其验证修复。

已查 legacy 94（互斥／取消）、98/99（唯一行为循环／回执）、108/193（TG 信任）、113/123（来源／CAS）、139（完整工具交互／未知效果）、195（原请求／Steer）；本步按已批准计划变更上下文，权限、审批、回执格式、verifier 不变量保持。实验工作树单独操作，未改 main、未开 PR。

### 附表 A：旧断言调整依据

断言变更依据（第 6 步替换旧行为）：

| 用例／组 | 旧断言 → 新断言与理由 |
|---|---|
| `context-compactor.test.ts` 同步 prepare／force／重试／多块合并组 | 同步等待并多次调用 → prepare 零调用、每队列项一次、无效输出不推进；旧同步路径已删除，保留回执纯函数、未知副作用、重启、来源与预算断言 |
| `context-compaction-runtime` / `context-compaction-acceptance` | 同轮先摘要后主请求 → 主请求先屏蔽、后台完成后新轮复用；每日／长任务原始规模不变，32K 另测 |
| `model-context-budget` / `foreground-autonomy` | 单条过大直接失败／等待摘要 → 截断占位、原文不变、原请求继续保留；固定材料超限仍失败 |
| `memory-m1-acceptance` | 跳过过大旧来源再推进新来源 → 按 Unicode 连续分片、最后一片才推进；旧 pending 重抽不能覆盖新值 |
| `model-usage` | 人工强制同步 compact → 实际 prepare / runPending；短聊天零抽取和用量账本断言保留 |
| `baseline-assembly` | 固定工具集合 → 单独断言新增 `history_read/search` 后，与旧固定集合比较；未改历史快照 |
| `examples/eval/*` 块形状检查 | 旧多块合并器 → 产品同一完整工具边界；冻结 fixture、truth、旧 Oracle 的正负断言不变；新分层路径另记 |

未删除测试文件；旧同步实现对应用例被合并成新生命周期用例，不以历史测试数量充当本步质量指标。首个包装证据已撤回，最终结果待运行时 runner 生成。

### 附表 B：14 行旧记忆对照表（只读，待审核）

2026-10-21 通过 LegacyMemoryReader 读取日用 v4 当前投影：14 条均 active/applicable/enabled、均未置顶；源文件 SHA-256 `11b6fa95ce45a73a4d22187f35daa1aa91656825027bf60a2f3a929255078354`。没有迁移或修改源文件。ID 仅供此次审核定位。

| # / ID | 旧范围 | 当前内容概要 | 迁移建议（待用户裁决） |
|---|---|---|---|
| 1 / 978a1257 | 工作区 | 复盘先一行结论，再两条可执行步骤 | 保留为用户偏好 |
| 2 / 0113bb19 | 工作区 | Serika验收1013：咖啡不加糖，验收专用 | 建议丢弃测试项；若留必须保留场景条件 |
| 3 / ac6798c5 | 工作区 | Serika验收1013：回复中文，验收专用 | 建议丢弃测试项，不推定为日常偏好 |
| 4 / 7436ddc8 | 工作区 | Serika-Eval-1013-2208：当前验收对话咖啡不加糖 | 建议丢弃测试项 |
| 5 / 9f80adf7 | **对话 03e407b8** | 咖啡不加糖，仅当前对话 | **用户决定留／丢；不自动转摘要或全局偏好** |
| 6 / 04df6c43 | **对话 b6074d8b** | 最新咖啡不加糖；旧段曾加糖 | **用户决定留／丢；旧值只留历史，不提升为全局** |
| 7 / e8087dd4 | **对话 8bb44ece** | 最新辣度中辣；旧段微辣 | **用户决定留／丢；不提升为全局** |
| 8 / c3b19d9b | **对话 8bb44ece** | 通知渠道应用内，仅当前对话 | **用户决定留／丢；不提升为全局** |
| 9 / 41f1d455 | 工作区 | 只读代码时不要运行测试，限制不能去掉 | 保留为带条件的用户偏好，不覆盖显式实施授权 |
| 10 / 671b1ca0 | 工作区 | Serika 实验分支工作规则，含旧 HEAD／补丁号／提交前缀 | 项目笔记逐项审定；旧 HEAD、编号、一次性前缀不当当前事实或授权 |
| 11 / 0a0f2df1 | 工作区 | 旧底线／停问／双时态及验收规则 | 归项目历史，按现计划逐项裁决；不覆盖已批准重构 |
| 12 / f6e52e58 | 工作区 | 产品少操作、少配置、懒人化 | 保留为用户／产品偏好 |
| 13 / 8291bb0f | 工作区 | automationRefresh/reconnecting 不回退及文档先例任务 | 归项目决策记录，不作为长期个人偏好 |
| 14 / ba71d2c9 | 工作区 | 把连续相同错误只显示一次写入测试注释／pending | 一次性项目任务，建议不迁长期记忆 |
