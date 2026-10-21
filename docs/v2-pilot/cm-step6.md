# 上下文与记忆：第 6 步（56fe5cf 复核修复）

## 1. 改了什么

**已按批准的附表 D／E 完成离线修复；唯一一次整批真实模型重跑仍未通过，现停下等审核。不开第 7 步、不迁日用。** `88a70a0` 修摘要类型／预算提示及检查回归，`7a80a2a` 实施规范正文与关键值校验、清单硬额度及超额引用；实模绑定干净提交 `3ec3f6a`，没有分批补跑。

来源引用仍精确绑定用户消息；identity.value 在引用和正文逐字出现，数字／单位一致，否定／条件无法对应就拒写。清单及③层恢复日用基准≤2K／≤12K，其他窗口按计划比例缩放；溢出保留数量、消息范围和分页入口，原回执及未知状态不变。摘要提示词明确精确字段类型与各段预算，校验没有放宽。首个时间修复为既定产品行为变更：给模型固定 +08:00 分钟，不再随宿主 TZ；时区常量合并仍在待办。

本轮本机验证：**macOS／UTC 全套1781通过／0失败／11跳过、eval82/82、真实Electron8/8**（源码7a80a2a）。8张截图已逐张核对，冒烟脚本SHA未变。本轮未在Linux重跑，不把用户对56fe5cf的独立Linux复现当成本轮新代码结果。

## 2. 逐条对照验收项

| 56fe5cf 后下一关要求 | 本轮处理 |
|---|---|
| 1 M1 原话规则 | 已按批准的附表 D 实施：来源精确，identity.value 在引用／正文逐字出现；数字及单位一致；否定／条件原分句保留，不能对应则拒绝。`M5 normalizes the body…` 覆盖规范主语和偷换关键值反例；同句矛盾仍完整原话 |
| 2 CF03／CE03／CE05 失败形状与预算 | 已加 `recorded CF03/CE03/CE05 array and items-wrapper…`、`recorded CE03/CE05 proportional overflows…`；覆盖 goal 数组、数组被 items 对象包装、非 JSON、32K／日用段及索引超限拒绝、四段旧记录不变、后续合规结果可发布。提示词列精确类型、每段总预算、索引扣除范围元数据后的额度；校验未放宽 |
| 3 CF05 pastRead | 已先红后绿：长文件名回执正例，以及失败／未知／未来／疑问／无关写入反例。旧成绩 2/5 保留；旧回答重新检查只写独立 reference，不算本轮实模通过 |
| M1 passed 布尔值 | `evaluateM1` 从已有 checks 汇总明确布尔值；历史原始 attempt 不改，live 最新视图只补派生 false 并标来源 SHA／变换说明 |
| 恢复计划清单额度 | 已按批准的附表 E 实施：清单及③层共同硬计数；超额引用包含失败／unknown 数量、消息范围和读取入口。`overflow checklist reads page…` 在两档验证分页读取未提交 unknown 回执、排除不泄漏；`legacy history plus checklist…` 验证旧摘要超预算只改变请求投影 |
| 一次整批重跑 | 已做且仅一次：M1 18项两档（含固定哈希replay-9）、CF03/05、CE03/05全部16轮及4个独立冷进程；145次调用，全部HTTP200且有用量，无 response_format。整批未过，已停；费用见下 |

### 本轮真实模型结果（唯一重跑，原 Oracle 不变）

| 项目 | 结果 | 可核失败／冷进程 |
|---|---|---|
| M1（32K＋日用，18项） | **11/18，passed=false** | 确认式2项缺助手提议来源附记；同句矛盾2项未完整保留或关键值不匹配；replay-9两档关键值拒绝；日用同槽冲突1项分组检查未过。18项来源哈希与上批一致 |
| CF03 | **0/3** | 前两轮constraints从数组错成单对象；三轮goal既定字面检查未命中；独立冷进程无摘要重建，但回答检查未过 |
| CF05 | **2/5** | 前两轮constraints错形／后台失败；generation=3的unknown表述检查未过；generation=2、4通过。冷进程答案过，但发生摘要重建，整项未过 |
| CE03（32K） | **0/3** | constraints/pending结构错误、一次根结构拒绝（路径$）；goal等检查未过；冷进程发生重建且答案未过 |
| CE05（32K） | **0/5** | generation=0、3、4段或索引比例预算拒绝；goal等检查未过；冷进程发生重建且答案未过 |

CE05后3轮的实际③层投影为305／1248 estimated tokens（清单193≤208），历史层被替换为原文编号入口，所有16轮主请求的inputFits均true。generation=4的既定`layerChecks.total`检查存档完整层，仍为false；保留原检查和该轮失败，不用投影合规替它加分。CF05原fixture有效输入400K，其等比例③层预算18,750；CF03日用基准256K为12,000，CE两档26,624为1,248，未改fixture容量或Oracle。

新一轮不是服务商HTTP错误：145/145 HTTP200且用量完整，请求均没有response_format；失败发生在模型输出格式、比例额度及既定行为检查。主后台逐项callIds、输出形状、路径和失败原因均在独立attempt中，未保留原始摘要内容。

### 56fe5cf 已审核历史批次（保留原分）

下表为历史结果；清单借用额度已由该历史批次附表 E 的获批实现替换：

| 审核项 | 结果与证据 |
|---|---|
| 1 无原文失败诊断 | 已做：保留 HTTP 状态、错误名／码、结束原因、schema 路径；`failure diagnostics retain status…` 用敏感哨兵验证不保留正文／上游消息；每个后台项在返回时写 live，CF03 有实际 callIds、路径和拒绝原因 |
| 1 参数支持先核查 | 已做：真实适配器边界测试及该历史批次 122 个 HTTP 请求均无 `response_format`，Schema 仅是提示词正文；服务商目录确认该模型支持 chat/completions，但没公布严格 Schema 参数支持，未把兼容接口说成严格支持 |
| 2 轮次分开、整批重跑、同一预算 | 已做：新轮独立 runId／时间／源码／脚本哈希／文件；旧混合文件逐字归档，缺失的旧诊断不追补；旧未知调用以 $0.0013248 计入预算，每次派发先记预留。该历史批次 M1 18 项、CF/CE 共 16 轮及 4 个独立冷进程均实际运行 |
| 3 过滤必须提供 | 已做：`RuntimeApp.projectExecutionRuns` 为必需，Controller list/get 均无未过滤回退，测试嵌入器显式提供投影；strict typecheck 通过 |
| 4 删除后重抽 | 已做：来源 Thread／消息 + subject／attribute；没有身份时退正文哈希。`v6 replacement/undo…source-specific deletion survive reopen` 先复现换措辞被抽回，再修复；同消息其他属性仍能写 |
| 4 清单超预算不中断 | 已做：超比例清单借用近期原文额度，屏蔽最旧完整块，保留全部失败／unknown，诊断记 `checklist_overflow`、预算和边界；`an oversized checklist masks old blocks…` 先红后绿 |
| 4 旧摘要权限 | 已做：`reusing an old summary rebuilds…current permission snapshot` 验证旧摘要复用时仍有权限字段，当前快照 true→false，不继承旧授权 |
| 全套与真实 Electron | 已做：干净 6f2193e，**macOS** UTC 全套 1776 通过／0 失败／11 跳过，eval81/81，构建 Electron 原 preload/IPC、隔离目录，smoke8/8，脚本 SHA 未变；统一 runner 退出0 |
| 合批真实模型关口 | **未通过**：该历史批次 a1189c9、run `1834686a-b68d-49fb-9f39-d04f1f99bac9`，122 次调用均 HTTP200、均返回用量，完整结果见下表；runner 退出1 |
| 旧记忆裁决／第7步条件 | 已记录附表B/C和唯一计划第7步；未执行迁移；记忆页段数无截图，撤回该已验证声明 |

| 实模项目 | 既定检查结果 | 可核原因／冷进程 |
|---|---|---|
| M1（32K＋日用，含固定哈希原对话 replay-9） | 8/18 | 10 项均被“正文必须逐字来自绑定证据”的宿主校验拒绝；不是服务商参数错误，两档原对话重放均未过 |
| CF03 | 2/3 轮；整项未过 | 第0轮 goal 是数组，schema 路径 `goal`、finish `stop`；冷进程回答和无重建通过 |
| CF05 | 2/5 轮；整项按原检查未过 | 3 个负项均为 `pastRead` 正则漏判：实际回答明确读取成功，但文件名等使“读取→成功”间隔超过12字符；原分和 Oracle 不改。冷进程回答和无重建通过 |
| CE03（32K） | 0/3 轮 | constraints/pending 等字段结构错误，另有摘要／索引比例预算拒绝；冷进程有重建且回答检查未过 |
| CE05（32K） | 0/5 轮 | 同类 schema 与比例预算拒绝，部分目标／待办检查未满足；冷进程有重建且回答检查未过 |

## 3. 前后数字

本轮相对56fe5cf：产品 +54/−28、测试 +165/−15、脚本 +33/−4，另 Electron fake provider +1/−1。测试新增多于产品，是用户指定的失败形状重现、M5偷换关键值反例，以及硬额度／排除分页两个核心边界所需；未新增测试快照或删除文件。

上一轮对 56ad8d7：产品 +63/−17、测试 +66/−4、脚本 +134/−54；测试新增多3行，是三项指定行为回归及脱敏／真实适配器边界证据所需，无删除测试文件、跳过新增测试或改历史 Oracle／快照。原 UTC 1775/11 仅为 **macOS**；用户独立复现的 **Linux＋Xvfb 1440x900x24、Electron44.4.5、干净56ad8d7** 在 UTC／+08:00 各 1767/19，eval79/79、smoke8/8，8个额外跳过为既有 macOS 专属测试；该独立结果未冒称为本机新代码实测。后续用户在干净56fe5cf复核：Linux＋Xvfb1440x900x24、UTC／+08:00 全套1768通过／19跳过、eval81/81、真实Electron8/8，8张图与不变脚本SHA均已核对。

按批准报价，本轮 **$0.59343940**；前两批已知 $0.70418294＋旧未知预留 $0.0013248，**合批预算占用 $1.29894714 / $2**，余 $0.70105286。计划累计已知 $1.65762234，含预留 $1.65894714 / $5。145次用量逐项重算与账本一致；旧未知调用仍按预留计费，不按0；本轮无新增未知用量。剩余额度不构成再次重跑授权。

## 4. 实际命令和退出码

`node packages/assistant/scripts/cm-step6-verify.mjs` → 0（本轮88a70a0与7a80a2a各跑完整套和真实Electron；7a80a2a为最新，macOS／UTC 1781／0／11，eval82，smoke8）；最终运行证据：[docs/v2-pilot/evidence/cm-step6/verification.json](evidence/cm-step6/verification.json)、[docs/v2-pilot/evidence/electron-smoke/result.json](evidence/electron-smoke/result.json)。

`SERIKA_CM4_REPLAY=/tmp/cm-step4-replay9.json node examples/eval/cm-step6-live.mjs --approved-live --rerun-approved-batch` → **1（验收未过）**；本轮唯一attempt：[docs/v2-pilot/evidence/cm-step6/live-7c5b4116-0378-4286-afc2-ac9b00eafe0b.json](evidence/cm-step6/live-7c5b4116-0378-4286-afc2-ac9b00eafe0b.json)，runId `7c5b4116-0378-4286-afc2-ac9b00eafe0b`、源码3ec3f6a；[docs/v2-pilot/evidence/cm-step6/live.json](evidence/cm-step6/live.json) 是本轮逐字副本。上轮独立原始证据：[docs/v2-pilot/evidence/cm-step6/live-1834686a-b68d-49fb-9f39-d04f1f99bac9.json](evidence/cm-step6/live-1834686a-b68d-49fb-9f39-d04f1f99bac9.json)；上轮参考重算时曾生成M1.passed=false的派生视图，现latest已由新轮替换；上轮原始attempt字节及账本SHA不动；旧证据 [docs/v2-pilot/evidence/cm-step6/live-legacy-mixed.json](evidence/cm-step6/live-legacy-mixed.json) 原字节归档；[docs/v2-pilot/evidence/cost-ledger.json](evidence/cost-ledger.json) 可复算预留和累计。模型仅使用授权本地 env 的必要变量，mode0600 临时文件与工作目录已清理，日用文件未改。参数核查依据：[服务商官方文档](https://commandcode.ai/docs/provider)及本轮请求字段／公开目录记录。

`node examples/eval/cm-step6-live.mjs --recheck-recorded` → 0：独立[docs/v2-pilot/evidence/cm-step6/cf05-reference.json](evidence/cm-step6/cf05-reference.json)，原2/5、新检查参考5/5，新增模型调用0；参考结果不算通过。

## 5. 与计划不符的地方及理由

**唯一整批实模仍未通过，按本次要求交材料并停下等审核；不再付费补跑、不继续改产品。** 附表D/E已获准并实施；剩余关口是本轮M1的确认来源／矛盾保留／关键值拒绝／冲突分组，以及摘要错形、比例预算和目标／unknown检查。这里只列失败，不擅自指定下一轮改法或放宽校验。旧“第三个后台项拒绝摘要”的历史细节已丢失，不能追补为证据；新失败逐项有可核记录。此前事后包装的 first-fixes.json 仍撤回，以运行时统一 runner 为准。读过旧约束94、98/99、139、193、195：前后台互斥、唯一行为循环、完整工具交互、未知效果及权限边界保持。第7步和日用迁移均未开始。

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

**依据与偏差**：本次审核给出的 M5 口径是“来源原话引用＋关键值在原话中”，对应唯一计划 §2.5 的“每条带来源消息编号和原话摘录／isExactUserQuote”。计划没有要求整个 `text` 都是 `sourceQuote` 的连续子串。现行 `memory-write.ts` 的 add/replace 分支额外执行 `isExactUserQuote(sourceQuote, text)`；这是第4步用整段原话保守保留否定／条件的实现选择，未单独获准成为比计划更严的语义规则。当前提示词又未说明该整段限制，所以规范化输出被拒绝。不能把这10个拒绝直接解释成模型编造。

**用户批准并实施的方案**：复用 `sourceQuote`、`text`、`identity`，不加存储字段或额外模型调用。

1. 来源仍绑定唯一当前普通用户消息；`sourceQuote` 仍是精确连续摘录。确认式来源仍要求相邻、助手自己的提议及用户明确说出同一具体值。排除、顺序、CAS、unknown 不变。
2. 正文可规范主语和叙述框架，不要求整段照抄；add/replace 必须给出 `identity`，`identity.value` 在同一精确引用及规范正文中都必须逐字出现，不能用地点别称、数字改写或同义替换通过。
3. 宿主对数字／单位、否定及条件保留做通用词法核对；引用中的否定、例外、适用条件不能在正文丢失或翻转。不能验证的写法保留完整原句，否则拒写；不以模型声明“已验证”替代检查。不会新增按咖啡／地址等话题分支，也不移除现有来源检查。
4. 回归覆盖规范主语成功，以及偷换地点、数字、删除否定、删除条件均拒绝；同句矛盾仍完整保留双方并 uncertain。词法对应只证明字面对应，不能证明规范正文与原话在任意自然语言中语义等价。

例：`我家地址是上海市甲路18号` → 正文 `用户家庭地址：上海市甲路18号`，引用仍保留原句，value 为 `上海市甲路18号`；改为乙路／19号拒绝。`我喝咖啡不加糖，低血糖时除外` 不得存成“咖啡加糖”或“咖啡不加糖”而丢掉例外；无法可靠拆分条件时保留整句。用户明确批准“附表 D，保留关键值校验”，本轮已按以上边界实施。数字与否定／条件采用保守字面核对；它可能拒绝语义等价的复杂改写，提示词要求此时保留完整原句。

### 附表 E：清单预算偏差说明（已批准恢复计划额度）

**为什么出现**：上轮审核要求超大必留清单不能抛错卡住前台；实现保留所有失败／unknown 和当前结构化信息，先移走旧原文以满足总输入窗口。但 `createCompactionChecklist(maxTokens)` 只减最近回执和请求摘录，未给失败／unknown 设硬上限；`prepare` 的 `totalSummary` 检查又仅算 `layerMessage`，没有把清单相加。它解决了部分前台抛错，同时违反 §2.1 的清单和③层分配，不能以报告描述追认。

| 额度（char-half/v1估算） | 32K有效配置 | 日用默认配置 |
|---|---:|---:|
| 请求总输入 A | 26,624 | 256,000 |
| 计划单段／清单上限 | 208（按比例） | 2,000 |
| 计划③层总上限 | 1,248 | 12,000 |

修复前的检查只有 `F + H + C + R + U ≤ A`：固定层 F、历史摘要 H、清单 C、保留原文 R、当前消息及封装 U 都计入实际请求；H 单独受③层总上限约束，C 没有单独硬上限。所以最坏③层 H+C 可逼近 `A−F−U`，近期原文可被挤到接近0；不能宣称③层≤12K。失败／unknown 再增长，连最小当前消息都放不下时，当时的代码仍可能抛错；总窗口检查只约束估算，不是服务商真实 token 的数学保证。

**用户已批准恢复额度与超额引用，现已实施**：清单及③层总预算都硬计数；超出的失败／unknown 全量留在既有原文／执行回执，清单用明确数量、消息范围和按编号读取入口表示“有未展开的失败／未知效果”，仍保留未知语义，不改成成功、不自动重试。当前目标／条件／权限同样不能被无提示删除，过大时给编号引用。用户明确批准“恢复计划额度，批准超额引用方案”。按此将“所有必留项逐项注入”改为“有限清单＋可读原件”；不再借用近期原文额度，不修改 §2.1 追认历史偏差。清单读取复用原工具的 start/end 分页，未提交到原文的执行回执也有可用入口，仍不执行或重试任何效果。

删除抑制无身份时的正文哈希分支保持现状；第7步迁移补身份后删除，当前不执行。

本轮测试调整依据：200条失败清单从“全量注入”改为“原件全部保留＋有数量和编号的有限引用”，依据本轮附表 E 明确批准；C04／后台抽取／自动写入及 Electron 的离线 fake proposal 仅补必填 identity（`smoke-model.ts`，冒烟脚本和8项检查未变），矛盾正文与来源／truth 不变；错误断言从“正文必须原话”改“关键值不匹配”，对应附表 D。没有删除测试文件或改历史 Oracle。

提交前核对：145条调用费用重算、4条账本证据SHA、最新副本字节一致、18项M1来源哈希、8张截图与SHA均通过；证据目录按授权env中5个长度≥12的密钥值及sk-前缀扫描，0命中。按AGENTS检索“experiment/architecture-v2 审核记录”未找到对应issue，本轮审核授权依据用户本聊天明确回复。
