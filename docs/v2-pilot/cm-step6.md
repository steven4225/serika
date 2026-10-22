# 上下文与记忆：第 6 步 v5 与零费用探针审核检查点

## 1. 改了什么

离线通过；真实模型 4 批未通过，都发生在产品修复（a05cd25、5889ed6）之前；修复后的批次没有跑，改用一次真实模型长对话抽查代替。修复后第 4–6 步整批验收仍按“未跑”收口，本次不重开整批。

- `cm-step6-offline-v5` 删除目标检查额外的“主项目”条件，摘要复用 `summaryChecks()`；四组 truth 各标准写法与三种正例，回答 128 项、摘要 128 项通过。旧答全扫改为核对冻结 v4 原件及成绩，未重评旧答。见 [冻结自检](evidence/cm-step6/offline-v5/self-check.json)。
- 探针只修测试加载：CommonJS require 的 import-only 导出错误，改用 Node 主 loader 动态 ESM；Playwright inspector 自身没有 import callback，因此经 `vm.compileFunction` 的主 loader 执行动态导入。注入函数保持原样，仍在实际 `node:fs/promises.open` 目标入口等待 1,800ms 后抛错，不调用目标的真实 open。
- 零费用探针本地通过：真实 Electron 44.4.5 + 假模型一次，实际 AiSdkAgentLoop / write_file 链，命中 1、`TOOL_OUTCOME_UNKNOWN`、磁盘无目标文件。它证明注入与工具回执，不是一次真实模型对话验收。见 [探针回执](evidence/cm-step6/offline-v5/open-fault-probe.json)。产品代码 0 行变更。

## 2. 逐条对照验收项

| 本轮要求 | 状态与证据 |
|---|---|
| 只修加载/脚本错误；加载后 matched=0 即停 | 已做：首次直接动态 import 被 inspector 拒绝，记录 [加载错误](evidence/cm-step6/offline-v5/open-fault-esm-loader-error.log)；修复 loader 后 matched=1，未改注入方式 |
| unknown 且无真实文件 | 已做：`tool.call.failed` 的 code 为 `TOOL_OUTCOME_UNKNOWN`、retryable=false；1,900ms 后文件仍不存在、目标 open 未委托；0 付费请求 |
| 三连统一验证 | 正在准备同一干净源码快照；每次 UTC、Asia/Shanghai、eval、临时检出真实 Electron 冒烟；结果待写回 |
| 提交推送及审核停点 | 三次成功后更新实验分支并推送；随后停止等 bot1 复现。付费续补未启动 |
| 初次原档保持 | 5 轮、12 请求、3 份摘要、压缩后问答；原 manifest 无差异；read_file 与 write_file 都成功，记忆页为空。见 [原文](evidence/cm-step6/spot-conversation/initial/dialogue.md)、[原始回执/诊断/记忆页](evidence/cm-step6/spot-conversation/initial/result.json) |
| 后续付费续补 | 未做，须审核确认探针后：先补每轮落盘、标第 6 轮起续补，unknown 后至少一次后台压缩且进入摘要，再提问与冷启动原样同题；全段最多 $0.30，只续补一次 |
| 第 7 步及日用迁移 | 未开始；只保留本文末尾备份、数据副本演练、完整回滚及逐项核对方案；日用迁移另定门槛 |

## 3. 前后数字

此前“测试和 eval 草稿净增 423 行”的基准为 03ae68f，包含所有未提交脚本，不含文档/证据。拆分如下：

| 文件 | 原新增/删除/净增 | 职责及可删部分 |
|---|---:|---|
| `cm-step6-live-conversation.mjs` | +232/-0/+232 | 初次真实 Electron 对话、费用代理、轮次/诊断/记忆页/冷启动归档；其中后来加的 +27 行 cold-only 续跑草稿不符合本次两场景续补，已撤回。保留初次实际执行的 205 行供审计，审核后再改成续补入口；归档证据不能删 |
| `cm-step6-checker-self-check.mjs` | +45/-0/+45 | truth 标准答案与摘要投影自检，保留 |
| `cm-step6-live.mjs` | +13/-7/+6 | 修目标条件、提取共享摘要检查入口，保留 |
| `cm-step6-live.test.mjs` | +19/-8/+11 | 用冻结原件校验替代旧答重新全扫，保留 |
| `cm-step6-open-fault.mjs` | +15/-0/+15 | 精确目标 open 注入；探针与后续续补共用，审核前保留。可合入探针，但后续会复制同一注入，因此当前不删 |
| `cm-step6-write-delay-probe.mjs` | +51/-0/+51 | 零费用真实工具 unknown 与无磁盘写入证明，保留；此次 ESM/加载生命周期修复增 11 行，当前 62 行 |
| `cm-step6-spot-audit.mjs` | +63/-0/+63 | 从原始回执导出原文、诊断、费用和文件 hash；初次档案由它生成。可在最终审核后退役，但会失去直接重建审计的入口，当前保留；续补前修原件保护及旧尾部预留读取 |
| 合计 | +438/-15/+423 | 撤回 27 行未完成 cold-only 草稿，增加 11 行加载修复，当前 +422/-15，净 +407；产品 +0/-0 |

[原 423 行明细](evidence/cm-step6/offline-v5/line-changes.json)和[当前明细](evidence/cm-step6/offline-v5/current-line-changes.json)可逐文件复算。新增检查代码多于产品代码，因为本轮明确要求检查器自检与测试注入工具；没有删测试文件或增加跳过。

费用合批占用 **$1.69032296 = 已知 usage 计价 $1.68899816 + 历史未知预留 $0.00132480**。其中本次对话已花 $0.00732638，续补余量 $0.29267362；本轮探针与统一验证付费请求 0。合批上限 $2.75，剩余 $1.05967704。

历史未知预留来自 [live-legacy-mixed.json](evidence/cm-step6/live-legacy-mixed.json) 的请求 `c88fcb8c-01f1-45d2-8bb9-c454b010fbd7`，2026-10-21T10:40:29.862Z、scope=m1、status=`failed_usage_unknown`、usage=null。按当次价格与输入 4,568 bytes、输出上限 1,024 保守预留：`4568 × 0.16 / 1e6 + 1024 × 0.58 / 1e6 = $0.00132480`。这笔实际花费未知，继续占用上限，不把它计为已确认消费，也不释放。详见 [费用账本](evidence/cost-ledger.json)。

初次长对话原结果尾部另有 $0.00275232 的异步预留残留；其 12 个逐请求记录已经全部 returned 且有 usage，因此有效未知预留为 0。原结果不改，只在账本复算；这与上面的历史未知请求是两件事。

## 4. 实际命令和退出码

- 既有 `node examples/eval/cm-step6-checker-self-check.mjs <输出>` → 0，16 组、256 项；`node --test examples/eval/cm-step6-live.test.mjs` → 0；`pnpm typecheck` → 0，见冻结证据。
- 本次 `node apps/desktop/scripts/cm-step6-write-delay-probe.mjs` → 先因 inspector 的动态导入回调缺失退出 1，修加载后退出 0。注入命中后没有重试工具，mockModelCalls=1、realModelCalls=0、costUsd=0。
- 审核复现先 `pnpm build:runtime`，再 `pnpm --filter @serika/desktop build`，然后运行上述探针。Linux 用 `xvfb-run -a -s "-screen 0 1440x900x24" node apps/desktop/scripts/cm-step6-write-delay-probe.mjs`。仅创建并清理临时 workspace/profile/transcripts，不读密钥。
- 三次统一命令均为 `node packages/assistant/scripts/cm-step6-verify.mjs`，用各自外部 `SERIKA_CM6_VERIFY_OUTPUT` 保存证据；正在准备。冒烟固定 SHA `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f`。

## 5. 与计划不符的地方及理由

本轮只放行零费用探针修复、三次统一验证和实验分支推送，审核复现前不运行付费续补。上一轮停下条件已被本次“加载/脚本错误可修复重跑；加载正常后 matched=0 则停”替代。此前失败记录照留，新成功回执单独存档。

初次存档因对不存在的 `.runloom/memory.json` 读取 SHA 报 ENOENT，中断于冷启动前；原写入实际成功，不能改记 unknown。原档与回答一字不改。每轮落盘、同一对话两场景续补和冷启动同题仍属于下一审核后阶段，当前不声称已完成。SQLite、第 7 步与日用迁移未开始；以下历史附表保留批准事项。

### 附表 A：第6步此前的断言调整依据（历史）

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

本轮新增调整：`an irreducible failure ledger fails before dispatch…` 原断言要求抛错，按此次审核改为 `an oversized checklist masks old blocks…`：200 条失败均保留、前台零调用、输入不超窗口、旧日志不变且记录降级。新增旧摘要复用权限 true→false、同来源同身份换措辞重抽、诊断脱敏及真实适配器请求字段检查。

未删除测试文件；旧同步实现对应用例被合并成新生命周期用例，不以历史测试数量充当本步质量指标。首个包装证据已撤回，最终结果见统一 runner 证据。

### 附表 B：14 行旧记忆裁决（用户已批准，只记录、未执行）

2026-10-21 通过 LegacyMemoryReader 读取日用 v4 当前投影：14 条均 active/applicable/enabled、均未置顶；源文件 SHA-256 `11b6fa95ce45a73a4d22187f35daa1aa91656825027bf60a2f3a929255078354`。没有迁移或修改源文件。ID 仅供此次审核定位。

| # / ID | 旧范围 | 当前内容概要 | 已批准裁决（真实模型验收通过后再迁移） |
|---|---|---|---|
| 1 / 978a1257 | 工作区 | 复盘先一行结论，再两条可执行步骤 | 保留为用户偏好 |
| 2 / 0113bb19 | 工作区 | Serika验收1013：咖啡不加糖，验收专用 | 丢弃不迁（验收测试项） |
| 3 / ac6798c5 | 工作区 | Serika验收1013：回复中文，验收专用 | 丢弃不迁（验收测试项） |
| 4 / 7436ddc8 | 工作区 | Serika-Eval-1013-2208：当前验收对话咖啡不加糖 | 丢弃不迁（验收测试项） |
| 5 / 9f80adf7 | **对话 03e407b8** | 咖啡不加糖，仅当前对话 | 丢弃不迁，原聊天不动 |
| 6 / 04df6c43 | **对话 b6074d8b** | 最新咖啡不加糖；旧段曾加糖 | 丢弃不迁，原聊天不动 |
| 7 / e8087dd4 | **对话 8bb44ece** | 最新辣度中辣；旧段微辣 | 丢弃不迁，原聊天不动 |
| 8 / c3b19d9b | **对话 8bb44ece** | 通知渠道应用内，仅当前对话 | 丢弃不迁，原聊天不动 |
| 9 / 41f1d455 | 工作区 | 只读代码时不要运行测试，限制不能去掉 | 保留；正文追加“（明确授权实施或测试时不适用）”，不新增字段 |
| 10 / 671b1ca0 | 工作区 | Serika 实验分支工作规则，含旧 HEAD／补丁号／提交前缀 | 先删旧 HEAD、补丁号和一次性前缀，再移到项目文档 |
| 11 / 0a0f2df1 | 工作区 | 旧底线／停问／双时态及验收规则 | 移到项目文档；与现行计划冲突的以计划为准 |
| 12 / f6e52e58 | 工作区 | 产品少操作、少配置、懒人化 | 保留为用户／产品偏好 |
| 13 / 8291bb0f | 工作区 | automationRefresh/reconnecting 不回退及文档先例任务 | 移到项目决策记录，不进个人记忆 |
| 14 / ba71d2c9 | 工作区 | 把连续相同错误只显示一次写入测试注释／pending | 丢弃不迁；未完成则记入待办 |

### 附表 C：第 7 步删除 thread 范围的既定清单（本轮只列方案）

| 现有写入口／格式 | 第 7 步动作 |
|---|---|
| `memory-v6-store.ts` scope 联合、`V6Change`、`writeV6` add/replace | 只接收 workspace；移除 Thread scope 分支，不改来源 Thread 标识 |
| `add()` 接收旧 `MemoryAddInput.scope`；`update()` 继承 current.scope | 退役旧接口与调用方；新写入口不接收 thread 范围 |
| `changeLibrary()` 将旧条目 scope 继承到文档，保存分片继承 item.scope | 迁移按本次裁决清理旧 Thread 条目及文档引用，再将文档和新分片固定为 workspace |
| `retract`／`undo`、`reviseMemory`／`restoreMemory`、隐私排除会修改原条目并保留 scope | 删除旧时态入口及空候选接口；workspace 新撤回／撤销入口保留来源与 CAS，不复活旧 Thread 范围 |
| `memory-library.ts` 文档 scope；旧 `memory-store.ts` 的类型／LegacyMemoryReader | 库格式仅 workspace；迁移后 v6 Store 不再 import 旧文件，迁移读取在一次性脚本中结束 |
| `bindMemoryWrite`、自动抽取、导入、新建文档 | 已固定 workspace；第 7 步去掉旧 scope 类型和调用参数，不新增第二条写路径 |

未执行迁移：长期保留 1、9、12；10、11、13 移项目文档；2–8、14 丢弃，原聊天保持。第 7 步须在真实模型验收通过并获准后，交迁移前后对照证据。

### 附表 D：M1 原话校验对齐方案（用户已批准，已实施）

批准人：本聊天的人类用户；出处是用户提交的 `send_user_message_question_reply`，`questionItemId=["request_user_input_async","call_38f5116bb13142b6b1fc8f577be3ba16",0]`，原回复“批准附表 D，保留关键值校验”。这是本聊天回复，不是 GitHub 评论；按规定检索同名审核 issue 返回空，不能补造作者账号或评论链接。

**依据与偏差（附表D提出时）**：当时审核给出的 M5 口径是“来源原话引用＋关键值在原话中”，对应唯一计划 §2.5 的“每条带来源消息编号和原话摘录／isExactUserQuote”。计划没有要求整个 `text` 都是 `sourceQuote` 的连续子串。附表D提出时的 `memory-write.ts` add/replace 分支额外执行 `isExactUserQuote(sourceQuote, text)`；这是第4步用整段原话保守保留否定／条件的实现选择，未单独获准成为比计划更严的语义规则。当前提示词又未说明该整段限制，所以规范化输出被拒绝。不能把这10个拒绝直接解释成模型编造。

**用户批准并实施的方案**：复用 `sourceQuote`、`text`、`identity`，不加存储字段或额外模型调用。

1. 来源仍绑定唯一当前普通用户消息；`sourceQuote` 仍是精确连续摘录。确认式来源仍要求相邻、助手自己的提议及用户明确说出同一具体值。排除、顺序、CAS、unknown 不变。
2. 正文可规范主语和叙述框架，不要求整段照抄；add/replace 必须给出 `identity`，`identity.value` 在同一精确引用及规范正文中都必须逐字出现，不能用地点别称、数字改写或同义替换通过。
3. 宿主对数字／单位、否定及条件保留做通用词法核对；引用中的否定、例外、适用条件不能在正文丢失或翻转。不能验证的写法保留完整原句，否则拒写；不以模型声明“已验证”替代检查。不会新增按咖啡／地址等话题分支，也不移除现有来源检查。
4. 回归覆盖规范主语成功，以及偷换地点、数字、删除否定、删除条件均拒绝；同句矛盾仍完整保留双方并 uncertain。词法对应只证明字面对应，不能证明规范正文与原话在任意自然语言中语义等价。

例：`我家地址是上海市甲路18号` → 正文 `用户家庭地址：上海市甲路18号`，引用仍保留原句，value 为 `上海市甲路18号`；改为乙路／19号拒绝。`我喝咖啡不加糖，低血糖时除外` 不得存成“咖啡加糖”或“咖啡不加糖”而丢掉例外；无法可靠拆分条件时保留整句。用户明确批准“附表 D，保留关键值校验”，本轮已按以上边界实施。数字与否定／条件采用保守字面核对；它可能拒绝语义等价的复杂改写，提示词要求此时保留完整原句。

### 附表 E：清单预算偏差说明（已批准恢复计划额度）

批准人：本聊天的人类用户；出处是同一条 `send_user_message_question_reply`，`questionItemId=["request_user_input_async","call_38f5116bb13142b6b1fc8f577be3ba16",1]`，原回复“恢复计划额度，批准超额引用方案”。

**为什么出现**：上轮审核要求超大必留清单不能抛错卡住前台；实现保留所有失败／unknown 和当前结构化信息，先移走旧原文以满足总输入窗口。但 `createCompactionChecklist(maxTokens)` 只减最近回执和请求摘录，未给失败／unknown 设硬上限；`prepare` 的 `totalSummary` 检查又仅算 `layerMessage`，没有把清单相加。它解决了部分前台抛错，同时违反 §2.1 的清单和③层分配，不能以报告描述追认。

| 额度（char-half/v1估算） | 32K有效配置 | 日用默认配置 |
|---|---:|---:|
| 请求总输入 A | 26,624 | 256,000 |
| 计划单段／清单上限 | 208（按比例） | 2,000 |
| 计划③层总上限 | 1,248 | 12,000 |

修复前的检查只有 `F + H + C + R + U ≤ A`：固定层 F、历史摘要 H、清单 C、保留原文 R、当前消息及封装 U 都计入实际请求；H 单独受③层总上限约束，C 没有单独硬上限。所以最坏③层 H+C 可逼近 `A−F−U`，近期原文可被挤到接近0；不能宣称③层≤12K。失败／unknown 再增长，连最小当前消息都放不下时，当时的代码仍可能抛错；总窗口检查只约束估算，不是服务商真实 token 的数学保证。

**用户已批准恢复额度与超额引用，现已实施**：清单及③层总预算都硬计数；超出的失败／unknown 全量留在既有原文／执行回执，清单用明确数量、消息范围和按编号读取入口表示“有未展开的失败／未知效果”，仍保留未知语义，不改成成功、不自动重试。目标／条件／权限不得被无提示删除。8dd7bae 后的新审核进一步要求历史摘要里的目标、已确认决定、待办及权限完整保留，不能整层换成编号提示；本轮按该新要求缩减非必要细节，该轮必需内容仍超额时明确报错并交容量方案；本轮由附表G的C5例外替代该错误路径。用户明确批准“恢复计划额度，批准超额引用方案”。按此将“所有必留项逐项注入”改为“有限清单＋可读原件”；该轮不借近期原文额度；本轮仅新增附表G所述已批准C5例外，不修改 §2.1 追认历史偏差。清单读取复用原工具的 start/end 分页，未提交到原文的执行回执也有可用入口，仍不执行或重试任何效果。

删除抑制无身份时的正文哈希分支保持现状；第7步迁移补身份后删除，当前不执行。

本轮测试调整依据：200条失败清单从“全量注入”改为“原件全部保留＋有数量和编号的有限引用”，依据本轮附表 E 明确批准；C04／后台抽取／自动写入及 Electron 的离线 fake proposal 仅补必填 identity（`smoke-model.ts`，冒烟脚本和8项检查未变），矛盾正文与来源／truth 不变；错误断言从“正文必须原话”改“关键值不匹配”，对应附表 D。没有删除测试文件或改历史 Oracle。


### 附表 F：M1 失败逐行诊断及证据缺口

原始attempt共有18行，11行通过，**7行失败**；replay-9两档以外是**5行**，不是6行。各行callId、outputHash、outputShape及未通过checks由[离线审计](evidence/cm-step6/offline-audit.json)直接派生，原始实模记录不动。

| 用例／档位 | 已记录事实／分类 | 原回答片段 |
|---|---|---|
| confirmation／32K | completed、saved通过；confirmation=false。模型输出shape有一个proposal且缺`proposal`上下文字段，可核的**提示词／校验器契约缺口**：提示说 may，schema该字段可选，宿主只有传了才校验，遗漏未阻止。计划§2.5要求确认式来源另附助手提议；Oracle这一要求有依据 | **缺失**：只存outputHash及字段类型，无法恢复正文 |
| confirmation／日用 | 同上；另一独立回答也无`proposal`字段。不是来源引文／关键值被拒绝。下一方案应明确“识别为确认式来源时必须给proposal”，不把所有独立偏好都误绑到助手 | **缺失**，不可用输入“是的，以后使用中文”冒充模型回答 |
| uncertain／32K | 报“同句矛盾必须完整保留证据中的原话”。可确认是输出未满足完整原句契约；校验器按计划拒绝。**输出／提示执行问题**，具体增删了哪些字无法核实，不能认定语义等价误拒 | **缺失**；输入为“我喜欢甜咖啡，但我又不喜欢甜咖啡”，这是输入片段 |
| uncertain／日用 | 报“记忆关键值必须逐字出现在绑定原话与正文中”，在完整矛盾检查之前已拒绝。**尚不能裁决输出与校验器的具体责任**；须对照同一proposal的value/sourceQuote/text，现缺值，不能为它放宽来源检查 | **缺失**，只有结构及哈希 |
| conflict／日用 | completed、saved通过（2条active），仅conflicts=false。说明两条未被分到同一subject/attribute且异value的组，或value被规范成相同；字段值没留，不能指定哪一项。**提示词身份契约／用例期望均需复核**：fixture为前后两条咖啡喜好，未明确“同时有效”；提示又强调旧值被新值取代，与真正双有效值场景不完全等同 | **缺失**；输入“我喝咖啡不加糖”“我喜欢咖啡加糖”不当作输出证据 |
| replay-9／32K | 同关键值拒绝。shape为一个add/replace类字段集合；精确操作值未留。**未能裁决**：可能value改写／引用片段不足／正文未保值；没有原值不能判成提示词问题，也不能判校验器误拒 | **缺失**；outputHash=`bdaf965e…` |
| replay-9／日用 | 同关键值拒绝；另一独立输出，不能把上一行推断当本行证据 | **缺失**；outputHash=`a07a509c…` |

在2f7ea05那轮，`memory-write.ts`、`memory-extraction.ts`和M1断言未改；本轮仅新增原因诊断。离线源码另发现replay检查是`entries.every(text.includes(question))`，空集合也true；因此这两行`checks.saved=true`不能解释为已保存，`completed=false`仍使原总分失败。后续若调整Oracle，应另列新批次版本，保留旧分，且先把重放期望绑定到冻结来源中的具体长期信息。

**未满足项与后续条件**：旧回答原文没有保存在仓库，临时目录已清理；从哈希不可逆恢复。本轮不能交付要求的“原回答片段”，逐例根因也仅到上述证据支持的范围。未来整批前应先确定可持久化的脱敏原回答片段格式（特别是个人对话replay-9），再运行；本轮没有借诊断名义新增模型调用。

**本次补交的受控诊断**（[完整输入与结果](evidence/cm-step6/m1-offline-diagnosis.json)）：

- 从现有confirmation fixture只去掉`proposal`，两档均复现completed=true、saved=true、confirmation=false。宿主仅在字段存在时检查相邻提议；提示／schema／宿主之间的缺口可复现。它不能证明历史回答正文的其他值正确，也不将这个缺口改成新的确认式识别规则。
- 在现有uncertain fixture正文前加前缀，保留来源与关键值，两档均报“同句矛盾必须完整保留证据中的原话”。这是历史32K错误的一种可复现原因，不声称历史输出就加了这个前缀。
- 构造“value不在来源中”和“value不在正文中”，两者都报同一关键值错误。因此原诊断文字不足以分辨replay-9或日用uncertain是哪一侧不匹配；不能据此放宽校验。
- 同scope/subject/attribute、异value产生冲突；不同attribute或相同value均不产生冲突。历史记录只保留字段类型，无法重建这几个实际值。冲突用例的时间／双有效性期望仍需对照原回答，不能把合成分组当作历史输出。

以上均为受控离线输出，证据中明确标注，不是缺失的真实原回答片段。**该历史证据无法定位已获用户2f7ea05审核确认；保留事实，不再视为本轮未完成项**；不借本次续办修改来源校验、M1用例期望或历史成绩。

### 附表 G：历史32K容量测量与C5例外（本轮已增加半数上限）

同一char-half/v1估算器：有效输入26,624，单段／索引／清单各208，③层总1248；清单实测193，留给历史1055。下表是离线结构重现，不是已丢失的旧摘要原文重放。

| 离线输入 | 历史层＋清单投影tokens | 结论 |
|---|---:|---|
| CE05 truth的目标、约束、已确认决定、待办，四段重复 | 671 | 装得下 |
| 四段各192tokens（含旧文件用途细节），同一truth | 原1315 → **1154** | 去最旧非必要细节即可；必须内容保留 |
| 四段各208、不同必须内容，索引172（各段均合法） | **1408** | 超1248；③层净缺160 |
| 四段各208，索引208，UUID消息范围及完整时间范围 | **1632** | 超1248；净缺384。若清单装满208，总占1647，净缺399 |

**结论**：现有比例无法保证四段、远期索引和必须内容同时装下；不可用“每段≤208”推导③层≤1248，因为封装、范围和时间也占token。不透明索引可能只剩目标／决定的唯一副本，宿主不能任意截其正文；本轮只删逐字重复行，其他完整保留。

**历史批准与本次替代裁决**：原全局1664提案未实施；早先用户在本聊天`call_50c613d853814e69a5ad5002e320930b`第0项批准“允许 C5 降级时等额让出原文空间”。1ba4cd3审核后的本次用户裁决明确接受现实现：摘要超额可先借总输入空闲空间，不强制从近期原文配额等额扣除；借用封顶32K档2496、日用24000，达到floor(输入额度×85%)或服务商报告溢出才紧急屏蔽。新底线是当前请求、其Steer及最近完整工具调用/结果不能屏蔽；仅底线自身超窗时按原编号占位规则裁模型投影，原件不改、前台继续。正常③层与单段额度不变；必需摘要超过原有总上限仍失败。旧批准原句保留供追溯，不能再将现实现描述成当时已批准的等额扣减。

### 附表 H：历史整批费用预估（已由本轮授权及实测替代）

| 项目 | 数字／依据 |
|---|---|
| 固定内容 | M1 18例两档＋CF03/CF05/CE03/CE05共16轮＋4个独立冷进程，不分批补跑 |
| 历史实测 | 两次完整批次122次/$0.68218348，145次/$0.59343940。调用数不是单调对应成本，受命中缓存和各后台项输入长度影响 |
| 计价依据 | 已批准报价每百万 input $0.16、cached input $0.02、output $0.58；本轮未向服务商重新询价，不把估算当新账单 |
| 下一批预估 | **$0.60–$0.85**；按$1.00准备保守余量，增加归一化成功项可能让后续摘要多跑，故不直接沿用上轮最低值 |
| 审核后合批上限 | $2.50（当前仍$2）；已有占用$1.29894714，审核获准后可用 **$1.20105286**。预计合批累计$1.89894714–$2.14894714；按保守$1.00则$2.29894714 |
| 派发与停止 | 先按请求字节＋最大输出预留；旧未知调用继续按$0.0013248计入。任一适用额度不足立即停；仅一次完整批次，还不过就交材料，不分批补跑 |

附表F历史原回答缺失的无法定位结论已获用户确认；附表G的C5例外也已获批准。本轮先交离线修复审核，不运行新批次。当前付费调用0，账本原值不动。

### 附表 I：断言／检查变化清单（先列本轮，再保留历史）

| 本轮测试／检查 | 旧断言 → 新断言／依据 |
|---|---|
| `oversized essential legacy goals…` → `C5 preserves oversized essential legacy…` | 旧最小内容超额抛错 → 两档均保留完整必需正文继续，0模型调用，原记录不变；依据用户C5例外 |
| C04 `binds the specific confirmation…` | 短应声拒绝旧文案正则“具体值” → 断言同一拒绝为`MemoryWriteValidationError`／`SOURCE_VALUE_MISSING`，没有放行原失败输入 |
| CE05与旧oversized断言 | 删掉已删除的恒false `summaryOmitted`字段断言，保留目标／决定／待办／权限和原记录检查 |
| M1安全诊断新增回归 | 五原因＋相邻proposal原话缺值，12次假模型抽取验证存储拒绝和安全字段；不修改旧M1 Oracle和分数 |
| 新批次目标限定词正例 | 扩展至通用限定词＋“的”，增加真实已见写法正例；原未知／否定／另一项目／仅审阅反例保持；只影响新批次 |

以下为此前审核轮的变化，不能当作本轮新增结果：

| 测试／检查 | 旧断言 → 新断言／依据 |
|---|---|
| `legacy history plus checklist…` → `oversized essential legacy goals…` | 旧断言summaryOmitted=true并出现整层读取提示 → 必需正文不可裁剪时明确报容量失败，summaryOmitted=false、原记录不变、诊断给requiredTokens；依据本次必改1/4 |
| `recorded CF03/CE03/CE05 array and items-wrapper…` → `recorded array shape failures…` | 所有items包装拒绝 → 合法纯items外壳归一化可发布且留诊断；goal数组仍拒绝，一次失败不重试；依据本次必改2 |
| 新 `recorded single-object constraints normalize…` | 单对象归一化可发布；非法decision状态／超预算仍不发布，带多余字段的items外壳不拆；诊断在失败时也保留 |
| 新 CE05 1248/193 | 原分支整体省略导致必须内容不见 → 限额内保留目标／确认决定／待办／权限，真实prepare清单恰为193；基线失败、修复通过 |
| 新目标检查 | 逐字连续“完成验收报告” → 允许本次／本轮／验收主项目等限定词；拒未知、否定及别的项目。只用于新批次，不重算旧回答 |
| 新批次③层total | 未缩减存档层＋旧清单 → 当前prepare实际发送层＋当前宿主清单；存档token值另留观察字段，原轮分数不动 |

上段为此前审核轮记录。本轮账本已加入唯一新批次，旧原始attempt SHA与旧分保持不变，latest为明确标注来源的离线汇总投影。新核对见[提交审计](evidence/cm-step6/submission-audit.json)。

### 附表 J：唯一新批次的诊断与回答对照

完整回答均保留在[新批次汇总](evidence/cm-step6/live-summary-d67682ad-0722-43d9-af5c-8c7aef1308fa.json)及原始attempt，以下只摘录合成CF／CE材料；replay-9不保存原文。

**仅靠新目标规则才整轮通过：CF05 generation=1。** 原回答目标句为“完成验收主项目（暗号 FIDELITY-42）的验收报告”，其余检查全过；旧规则false、新规则true。完整回答在summary.qualifiedAnswers[0]。另外CE05 generation=1和4的新目标命中，但因读取回执／后台摘要等检查仍不通过，不算新规则带来的通过。

M1的6行未通过：

| 用例／档位 | 已记录原因 |
|---|---|
| confirmation / 32k | completed=true、confirmation=false；相邻提议字段要求未满足 |
| uncertain / 32k | 同句矛盾未完整保留证据原话 |
| replay-9 / 32k | QUOTE_VALUE_MISSING；user.text，字段长47／值长30 |
| confirmation / daily | completed=true、confirmation=false；相邻提议字段要求未满足 |
| uncertain / daily | 同句矛盾未完整保留证据原话 |
| replay-9 / daily | BODY_VALUE_MISSING；text，字段长55／值长13 |

五种关键值原因码依序：原话缺值1、来源缺值0、正文缺值1、数字或单位不一致0、条件分句缺失0。replay-9两档已能分辨拒绝位置；saved=true的空集合检查仍不能当作已保存，completed=false保留原分。

- **32K摘要超额**：CE03 generation=1、2和CE05 generation=2、3、4，后台均记录“Summary segment or far index exceeds its proportional budget; original block retained”，不是HTTP失败；有7次受限格式归一化记录，未放宽内容、预算。
- **读取成功事实丢失**：CE05 generation=1答“先前的读取未产生可用的成功回执”，generation=3答“没有成功记录……未实际执行读取工具”，与冻结输入里fidelity-read成功回执矛盾。背景待读回样本不能取代已成功的旧读取事实。
- **检查器漏判，只记观察不改分**：CF03 generation=1明确答“结果是 TOOL_OUTCOME_UNKNOWN，即不确定、效果未知，不能视为成功”，uncertain仍false，原因是正则12字符距离；CF05 generation=2答“禁止自动重试”，noAutomaticRetry仍false。CE03 generation=0写“完成「验收主项目验收报告」”，目标检查不识别书名括号；CF05 generation=2正确目标句后还有“尚未完成的验收材料”，新规则把同分句里的未完成当作目标否定。
- **真实权限遗漏**：CF03 generation=2及冷进程说“不能因为之前成功就推断本次一定成功”，但未说明再次读取仍须新的批准，permissionNotInherited=false；不能把这项全归给正则。
- **C5**：已归档准备诊断中触发0、借用0、无C5屏蔽范围；最后CE05冷进程诊断缺失，未计入。半数上限和超限屏蔽／容量失败只在本轮离线两档回归中被实际触发：32K需2785时封顶2496并失败，上限内1785继续；同时记录summary_overflow与checklist_overflow，范围failure-request至failure-199。未声称实模触发了此边界。

### 附表 K：本轮新规则离线对照与证据限制

出处为本聊天用户的@818f2f4审核回复。附表D第1条的确认来源现允许完整用户原话直接绑定；M5的“具体值在用户原话中”仍保留，短“好/嗯”不能借助手提议绕过。C5半数上限及附表E的大清单原件入口仍保留。

以下是检查项翻转，不是10个整轮成绩翻转。完整旧/新checks、round与cold条件、失败原因和未知结果均见[重评分JSON](evidence/cm-step6/offline-repair/regrade.json)。

1. `M1 / results[0].results[4] / confirmation false → true`

> 是的，以后使用中文

该句来自冻结用户fixture，两档各一项；sourceHash与已保存/已完成检查支持这项参考判定。原模型proposal未归档，不能把它写成模型原话。

2. `M1 / results[0].results[13] / confirmation false → true`

> 是的，以后使用中文

该句来自冻结用户fixture，两档各一项；sourceHash与已保存/已完成检查支持这项参考判定。原模型proposal未归档，不能把它写成模型原话。

3. `CF03 / results[1].rounds[1].chat / uncertain false → true`

> - `write_file` 写 `notes/uncertain.txt` 的结果是 TOOL_OUTCOME_UNKNOWN，即不确定、效果未知，不能视为成功。


4. `CF03 / results[1].rounds[2].chat / uncertain false → true`

> - uncertain.txt 写入：结果是 TOOL_OUTCOME_UNKNOWN（未知），既不能视为成功，也不可自动重试；应先核实实际写入影响，再由用户决定是否重写。


5. `CF03 / results[1].cold / uncertain false → true`

> - uncertain.txt 写入：结果仍为 TOOL_OUTCOME_UNKNOWN（未知），既不能视为成功，也不得自动重试；应先核实实际影响，再由用户决定是否重写。


6. `CF05 / results[2].rounds[0].chat / uncertain false → true`

> - **写入 uncertain.txt**：结果为 **unknown**（未知效果），不确定成功或失败；不得自动重试，否则可能造成重复写入。应先核实实际结果再决定下一步。


7. `CF05 / results[2].rounds[2].chat / goal false → true`

> 1. **目标**：按已确认方案完成验收主项目的验收报告，并补齐尚未完成的验收材料（含失败样本）。


8. `CF05 / results[2].rounds[2].chat / uncertain false → true`

>    - 核实 `notes/uncertain.txt` 的写入实际结果（当前状态 unknown）；

> - 该次 `write_file` 对 `notes/uncertain.txt` 的结果是 **unknown**（既不确认成功也不确认失败），不能视为已写入。


9. `CF05 / results[2].rounds[3].chat / uncertain false → true`

> **6. uncertain.txt 写入是否确定、能否自动重试**：不确定。write_file 对 notes/uncertain.txt 的结果为 unknown，不能视为已写入；禁止自动重试，须先经授权核实实际效果再决定下一步。


10. `CE03 / results[3].rounds[0].chat / goal false → true`

> 完成「验收主项目验收报告」，并按修改后的合约（fidelity-contract）保持记录与实际证据一致；暗号 FIDELITY-42 依然有效，后续背景材料不改变上述约定。


历史uncertain拒绝共2项，离线映射为`UNCERTAIN_QUOTE_MISMATCH`。映射仅基于原精确错误文本，不伪称旧产品已经返回该code。replay-9保留原原因码和结果。

[CE05 cold证据缺口](evidence/cm-step6/offline-repair/ce05-cold-gap.json)记录最后三次调用的元信息。第一条输出586字符，但没有正文及正文哈希；后两条只留摘要JSON形状，不能用于补全回答。新归档由真实Controller加流式fixture回归证明，尚无新真实模型cold成绩。

三连材料以索引中的sourceCommit为准。此前a05cd25的通过记录因漏掉Steer修复被排除；96f4e5d在UTC桌面全套失败，未以定向绿灯替代。两者均另行保留供审查。


### 附表 H：第 7 步备份、数据副本演练与回滚方案（本轮不执行）

1. **冻结备份边界。** 获准第 7 步后，先确认源工作区、配置、原版本与进程形态，选定一致性时间点。完整备份 memory、文档库正文与文件夹/标题/顺序/置顶元数据、transcript、压缩记录、排除/删除抑制记录、执行回执、游标与待重抽、任务数据和工作区外相关配置。备份目录只读，记录每个相对路径的文件类型、字节数、SHA-256、模式与符号链接目标。源清单与备份逐项一致后才准演练；文件版本按实际读取结果记，不把日用旧版本写成 v5。
2. **建立互相隔离的副本。** 从同一备份生成迁移副本 A 和回滚核对副本 B，分别使用专属 config、userData、transcriptDirectory 与 workspace。日用进程和源文件保持原状。备份配置中的绝对路径只在演练副本中改写，清单明确区分原配置与演练覆盖项。严禁副本中的后台任务、通知、服务注册、Shell 或真实模型产生外部效果。
3. **只在 A 迁移。** 按附表 B 的 14 项已批准裁决迁移，逐项输出旧 ID/来源、处置、目标类别/正文、有效状态与来源关系。核对 1/9/12 生效、10/11/13 的项目文档处置、2–8/14 不迁；原聊天字节不变。文档逐项核对文件夹、标题、顺序、正文、置顶；旧历史不生效，新写范围只有 workspace，来源 Thread ID 保留。验证单一写入口、删除旧空接口及 memory-v6-store 不引用 memory-store。自动合并/取代/撤销等第 7 步行为另按该步验收，不在本轮提前实现。
4. **演练完整回滚。** 关闭 A 的隔离进程并确认退出，以备份完整恢复 A。移除迁移新增且备份没有的文件，恢复原配置、版本与进程入口；不得让旧版本去打开 v6，也不依赖逆向推算恢复旧格式。
5. **回滚后逐项核对。** A、B、只读备份的文件集合、每项 SHA/字节数/模式/链接目标必须一致，明确检查多出、缺失与内容变化；逐项核对 14 条原记忆的正文/范围/状态/来源、文档目录与顺序、对话消息编号/原文、压缩边界/hash、排除/删除抑制、执行回执/unknown、游标/待重抽、任务数据及原配置。旧版本只在回滚副本做受控只读启动，核对可见记忆/文档/历史与备份的逻辑投影；启动产生的运行文件单列，不纳入未说明的例外。任一差异即失败，不做日用迁移。
6. **交审核后再决定日用门槛。** 提交源/备份/迁移/回滚清单、每条对照和可复现脚本与退出码，经审核后结束第 7 步。日用迁移前另行约定版本、备份恢复验证、真实 Electron 场景和用户确认门槛；第 7 步通过不自动授权日用迁移。
