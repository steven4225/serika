# 上下文与记忆：第 1 步调用日志（2026-10-21）

## 1. 改了什么（文件和原因）

已把第 0 步裁决写入计划 §6，并同步 §2–4（文档先提交 `aa173c7`）。`model-call-log.ts` 负责独立日文件；`model-usage-observer.ts` 在既有 SDK 边界接入，`app.ts` 只做装配；`scripts/cm-baseline.mjs` 只读统计日用数据。依据：计划 §2.9、步骤 1；Karpathy 指南用于限定改动为调用观测。

审后修正（前态 `955365d`）：新日志改为按条 fail-open，诊断暴露进程内累计失败次数；新增 `round-output-timing.ts` 观测前端正文事件，Controller 只接线并在消息入口保存接收时间。调用级首输出另在 SDK 流边界记录。

## 2. 逐条对照验收项

| 验收项 | 状态与证据 |
|---|---|
| 内容无关的分段 hash/token/字节，及用途、Run、缓存、输出、耗时 | 已做：T1/T5/T6；实际用量缺失保持未知，分段 token 标为估算 |
| 独立日文件、30 天、不裁剪日内调用、不记向量 | 已做：T2/T7/T8；覆盖四类现有用途，向量链路没有日志接线 |
| 旧回执格式、128 次摘要及 8 MiB 上限不动 | 已做：T2、既有 model-usage / 回执 / I1–I5 套件；核心文件 diff 为 0 |
| 改动前基线、消息间隔分布 | 已做：只读脚本退出 0；附表 A/B，原始内容不进报告 |
| 32K 与日用大窗口 | 已做：T6 在 SDK 边界完整验证 26,624 / 256,000-token 输入；真实模型容量验收未做，本步无计费调用 |
| 新日志失败跳过、下次重试；旧账本不动 | 已做：更新 T4，失败 2 条后下一次调用正常写入；既有 usage file sync failure 测试仍阻止派发 |
| 调用首输出 / 轮次首正文分开计时 | 已做：stream first output、round timing、Controller Demo；区分 text/tool_call，工具无正文 / 无输出单列，正文计时含接收后的前置等待 |

## 3. 前后数字

以 `f260ba1` 为前态：产品/工具代码 **+147/−4**（TS +89/−4、只读脚本 +58），测试 **+157/−1**；测试多出的 10 行用于隔离持久化、轮转、取消和两档输入。新日志单文件保留 **129 次开始 + 1 次结束**，旧回执哨兵字节不变。主对话基线：缓存读取率 **8.39%**；消息间隔中位 **188.020 秒**、P90 **4,365.080 秒**。本步增加观测，不宣称缓存或延迟改善。

审后修正相对 `955365d`：产品 **+80/−32**，测试 **+64/−9**；受影响测试 **18/18**。注入日志故障期间模型成功调用，诊断失败次数为 **2**，移除故障后成功写入 **2** 条；正文延迟 fixture 覆盖 ≥1,000 ms 的接收前置差。

## 4. 实际命令和退出码

`git fetch origin` / `git merge --ff-only origin/experiment/architecture-v2`、只读基线脚本、`pnpm typecheck`、定向测试（**16/16**）、`git diff --check` 均为 **0**。最终全量 `pnpm test` 退出 **0**：**2,422 通过、0 失败、13 跳过**（共 2,435）。完整命令见附表 C。

审后修正：首次 `pnpm typecheck` **2**（新模块类型导入和测试参数类型，已修复）；重跑 `pnpm typecheck` **0**；`node --test packages/assistant/dist/model-call-log.test.js packages/assistant/dist/model-usage.test.js packages/assistant/dist/round-output-timing.test.js` **0**（18 通过）；`git diff --check` **0**。

## 5. 与计划不符的地方及理由

无实施范围偏离。旧账本只剩 128 次、已裁掉 872 次，历史分段 hash/字节、固定前缀真实 token、首字等待均无法补造。已查旧约束 **143–148、192–195**（观测、hash、自主授权、回执）；权限及重试行为保持现状。测试为 macOS / Node v26.4.0 隔离验证；本轮未改日用 main、未重启进程，新日志尚未在日用进程启用。第 2 步未开始。

审后按用户裁决替换 T4 的“0 次派发 + 后续必须重启”断言：该旧行为把辅助日志当作执行屏障，与新要求相反。新断言为“两次成功派发 + 失败计数 + 下一次正常写入”；旧账本测试原样保留。没有删除测试。轮次事件只记元数据，仍使用已批准的日文件；历史首正文指标保持未知。

<details>
<summary>附表 A：只读基线口径与调用用量</summary>

采样时间：2026-10-21 00:13:23 +08:00。读取日用 `desktop-identity.json` 注册的 41 个 Thread，共 1,363 条逻辑消息；主对话占 1,140 条（83.64%），48 次压缩。普通用户消息 230 条，排除 auto-consolidation / dreaming / automation-skill 合成请求；其中 211 条有时间。采样读取已提交 JSONL 和账本，未创建 Runtime、Run 或数据副本。日用数据仍可能继续追加，本表是该时刻快照。

下表仅覆盖主对话保留的 128 次调用，不能代表完整历史；缓存率为有 input/cache 两项的成功调用之 `ΣcacheRead / Σinput`。耗时为开始到结束，不是首字等待。

| 用途 | 调用 / 成功 | 用量完整样本 | 输入 token 总数 | 缓存读取 token | 输出 token | 耗时中位 ms |
|---|---:|---:|---:|---:|---:|---:|
| chat | 50 / 49 | 49 | 5,830,923 | 489,216（8.39%） | 27,127 | 6,321 |
| memory_consolidation | 39 / 39 | 39 | 225,263 | 119,808（53.19%） | 6,275 | 1,937 |
| query_rewrite（含相关性） | 39 / 36 | 36 | 56,872 | 4,736（8.33%） | 1,618 | 2,254 |

最近一次压缩：152,553 ms / 8 次调用；其记录输入 232,902、输出 40,063、缓存读取 33,920 tokens。旧账本 128 条内没有 context_compaction，不按 0 次推断。新日志沿用旧观察启用入口（embedded Controller），没有扩展 worker / TUI 的记账范围。

</details>

<details>
<summary>附表 B：消息间隔与新日志格式</summary>

只算同一 Thread 相邻普通用户消息；优先 receivedAt，缺失时 sentAt。229 对中有效 204 对、缺时间 25 对、逆序 0 对；不跨缺时间的消息连线。

| 间隔 | 对数 | 有效样本占比 |
|---|---:|---:|
| <1 分钟 | 43 | 21.08% |
| 1–5 分钟 | 83 | 40.69% |
| 5–30 分钟 | 48 | 23.53% |
| 30 分钟–2 小时 | 18 | 8.82% |
| ≥2 小时 | 12 | 5.88% |

日志路径：`<transcriptDirectory>/model-calls-YYYY-MM-DD.jsonl`，同目录原账本为 `execution-records.json`。按 +08:00 日历日保留当天及前 29 天，每次追加时清理；不新增定时服务。只清理该日文件命名空间，当前日不按条数或大小裁剪。

- `version:1 / event:started`：调用 ID、Thread、可选 Run、用途、provider/model、开始时间、估算器和 segments。segments 为 tools + 原顺序 provider 消息（system/user/assistant/tool），含 part/index/hash/bytes/estimatedTokens。
- `event:finished`：调用 ID、状态、结束时间、durationMs、provider 报告的 input/output/cache token；缺值省略。开始/结束按 ID 关联，跨日也可关联；没有结束记录的调用保持未知。
- hash 对边界输入的 JSON 表示使用现有 `jcs-sha256:v1`；字节计 UTF-8 JSON，token 用现有 `char-half/v1` 估算，不是 provider tokenizer。没有记录请求或回复内容，也没有网络传输层的编码/缓存命中保证。
- 文件追加使用 flock、文件/目录 fsync 和 0600 新文件权限。保留崩溃残行并隔开下一条；审后改为失败跳过该条、诊断累计、下次重试。原回执继续保留原格式和限制。
- 流式 `finished.firstOutput` 为 `{kind: text|tool_call, ms}`，从 provider 派发计时，推理/空文字不算；无首输出为 null。`round` 以消息/Run 关联，含 `receivedAt`、`firstVisibleTextMs` 和 `outcome: text|tool_only|no_output`；后两种的正文延迟为 null，计算正文中位数时排除、分别计数。

</details>

<details>
<summary>附表 C：测试、命令与检查范围</summary>

工作目录：`/Users/a1-6/.codex/worktrees/cm-step0/aisdk-agent-framework`。测试文件是 `packages/assistant/src/model-call-log.test.ts`（T1–T6）及现有 `model-usage.test.ts`（T7/T8 增加日志断言）。

| 编号 | 测试名 / 覆盖 |
|---|---|
| T1 | provider segments preserve order, canonical hashes and byte/token counts without retaining content |
| T2 | daily append retains more than 128 attempts and exactly 30 calendar days at +08:00 |
| T3 | locked concurrent append and reopen preserve complete events after an interrupted suffix |
| T4 | log barrier failure stops dispatch, preserves a symlink target and latches subsequent calls |
| T5 | actual generate and cancellation log metadata once; missing usage stays unknown |
| T6 | 32K and daily-window provider inputs are fingerprinted whole without changing the request |
| T7 | actual AgentLoop streaming retry preserves two call attempts without changing loop or replaying tools |
| T8 | Demo: real Controller wiring records chat/consolidation/rewrite/compaction and old summary reuse adds no call |

未改旧断言语义、未删或跳过测试、未新增快照。现有测试文件的 −1 行仅为 import 加入 readdir。`execution-record-store.ts`、`model-usage.ts`、adapter loop 和 `context-assembler.ts` 相对 f260ba1 的 diff 都为 0。

```sh
# 退出 0：裁决文档提交只做 diff 检查，未跑测试
git diff --check
git commit -m 'docs(cm): record approved step-0 decisions before call logging'
git push origin HEAD:experiment/architecture-v2

# 退出 0：日用数据只读基线
node packages/assistant/scripts/cm-baseline.mjs '/Users/a1-6/Library/Application Support/@aisdk-agent/desktop/desktop-identity.json'

# 退出 0：类型及最新定向测试（16 通过）
pnpm typecheck
node --test packages/assistant/dist/model-call-log.test.js packages/assistant/dist/model-usage.test.js

# 退出 0：runtime 1752 通过 / 13 跳过；desktop 658 通过；scripts 12 通过
pnpm test > /tmp/serika-cm-step1-final-test.log 2>&1
```

</details>
