# 阶段二：长上下文与记忆真实验收指南

本轮只验两条现有 TUI 主链：①低预算下真实压缩、继续任务、重启同一 Thread、回查原文；②被动自动整理、用户在可见 TUI 确认写入、新 Thread 使用。**两条主链已在隔离环境真实验收通过**；其中压缩由手动 `/compact` 触发，不代表日用配置的自动阈值表现。离线测试、mock 模型、`/compact` 的成功提示或单独一个 `completed` Run 都不能代替完整链路。这里不新增 Axx 案例、记录 schema 或验收平台；每条链路、每次尝试各写一份本地 Markdown 报告。

## 一次性隔离准备

在仓库根目录的同一个终端执行以下命令。需要本地 `.env` 已配置 DeepSeek；命令不会打印 key。只使用下方无敏感信息的测试文本，不把密钥或完整鉴权 Header 复制进报告。`mktemp` 的目录在被测 workspace 之外，两个 workspace 与 transcript 彼此隔离；保留终端中的 `RUNLOOM_PHASE2_ROOT` 值以便重开终端时重新赋值。

```bash
pnpm build
RUNLOOM_PHASE2_ROOT="$(mktemp -d /private/tmp/runloom-phase2.XXXXXX)"
RUNLOOM_CONTEXT_WORKSPACE="$RUNLOOM_PHASE2_ROOT/context-workspace"
RUNLOOM_CONTEXT_TRANSCRIPTS="$RUNLOOM_PHASE2_ROOT/context-transcripts"
RUNLOOM_CONTEXT_CONFIG="$RUNLOOM_PHASE2_ROOT/context-config.json"
RUNLOOM_MEMORY_WORKSPACE="$RUNLOOM_PHASE2_ROOT/memory-workspace"
RUNLOOM_MEMORY_TRANSCRIPTS="$RUNLOOM_PHASE2_ROOT/memory-transcripts"
RUNLOOM_MEMORY_CONFIG="$RUNLOOM_PHASE2_ROOT/memory-config.json"
mkdir -p "$RUNLOOM_CONTEXT_WORKSPACE/notes" "$RUNLOOM_CONTEXT_TRANSCRIPTS" "$RUNLOOM_MEMORY_WORKSPACE" "$RUNLOOM_MEMORY_TRANSCRIPTS" "$RUNLOOM_PHASE2_ROOT/reports"
git rev-parse HEAD
git status --short
printf 'Evidence root: %s\n' "$RUNLOOM_PHASE2_ROOT"
```

配置文件位于 workspace 外。下列 `12000` token 窗口只为隔离验收更容易触发压缩，**不是推荐的日用配置**；估算器是 `char-half/v1`，并非服务端精确 token 数。若启动时提示固定输入已占满预算，保留这次失败，另建尝试并调大窗口；不要把启动失败算成已压缩。

```bash
cat > "$RUNLOOM_CONTEXT_CONFIG" <<JSON
{
  "version": 1,
  "workspace": "$RUNLOOM_CONTEXT_WORKSPACE",
  "modules": { "read-file": { "enabled": true } },
  "contextCompaction": {
    "enabled": true,
    "contextWindowTokens": 12000,
    "maxOutputTokens": 1024,
    "safetyMarginTokens": 512,
    "keepRecentTokens": 3072,
    "summaryMaxOutputTokens": 768
  }
}
JSON
cat > "$RUNLOOM_MEMORY_CONFIG" <<JSON
{
  "version": 1,
  "workspace": "$RUNLOOM_MEMORY_WORKSPACE",
  "modules": { "memory": { "enabled": true, "autoConsolidate": true } }
}
JSON
```

## 1. 真实压缩 → 继续任务 → 重启 → 原文回查

在当前终端启动可见 TUI。操作人亲自看预览并输入 `y/n`；不要用脚本代答。

```bash
RUNLOOM_MODEL=deepseek node --env-file=.env examples/cli/dist/index.js \
  --tui "$RUNLOOM_CONTEXT_TRANSCRIPTS" --thread phase2-context-1 \
  --config "$RUNLOOM_CONTEXT_CONFIG"
```

先给一个有可检查产物的任务，例如：“在 `notes/plan.md` 新建一份三段计划；目标是整理 `ALPHA-2026`，只可修改 `notes/`，不得写 `protected/`；先写目标与约束，后续我会补充下一步。”确认 `write_file` 后检查真实文件。继续用多个**有意义的普通回合**补充计划约束、取舍与下一步，直到自动压缩发生，或在 TUI 空闲输入 `/compact`。若提示“没有可压缩内容”，继续增加真实任务回合再试；必须看到对应 Thread 的 `thread.context.compacted` JSONL 记录，才算压缩已发生。不要为了刷次数把无关填料当任务证据。

`/compact` 走模型 API，须在能解析 `api.deepseek.com` 的环境运行；沙箱 `ENOTFOUND` 不是摘要契约失败。真实 DeepSeek 常省略 `decisions`/`actions` 的 `evidenceMessageIds` 以及 `files.text`；解析会用当前压缩片段的 message id 补齐这些字段，仍不把摘要当成工具成功或当前磁盘事实。加长 `summaryMaxOutputTokens` 不能单独使缺字段的 JSON 通过。复跑前先 `pnpm build`。

压缩后要求模型依据已确认约束继续完善 `notes/plan.md`，核对实际 `read_file`/`edit_file` 预览、`y/n`、回执与磁盘内容；不得仅凭摘要声称文件仍存在或权限已获授权。退出 TUI 后，用**相同 transcript 目录和 Thread** 再运行上面的启动命令。请它说明原目标、禁止路径、已完成动作和下一步；需要当前磁盘事实时让它重新读文件。空闲输入 `/history turn:0`（也可用实际 message ID）核对原始用户文本仍可回查。另起 Thread 的内容不应混入这份回答。

只读查看压缩记录和产物：

```bash
rg -n 'thread.context.compacted' "$RUNLOOM_CONTEXT_TRANSCRIPTS"
rg -n 'ALPHA-2026' "$RUNLOOM_CONTEXT_WORKSPACE/notes/plan.md"
shasum -a 256 "$RUNLOOM_CONTEXT_WORKSPACE/notes/plan.md"
```

报告至少记下实际 commit/dirty、模型 ID、命令、低预算配置摘要、workspace/transcript/Thread、首次与后续尝试时间、人工输入和可见反馈、Run 结果、文件前后事实，以及原始 JSONL 中压缩记录的 `id`、`previousCompactionId`、`firstKeptMessageIndex/Id`、`sourcePrefixHash`、`strategyVersion`、`modelId`、`metrics`（`estimatedInputBefore/After`、`durationMs`、`attempts`、如有 `usage`）。`usage` 不可得就写不可得，不填零。再记录重启后回答、`/history` 原文和是否出现越权/虚构完成。摘要匹配已提交前缀才会恢复；报告不能仅凭存在一行压缩记录推断重启使用了它。

## 2. 被动整理 → 候选 → 用户确认 → 新 Thread 使用

用独立 workspace 和 Thread 启动真实模型 TUI：

```bash
RUNLOOM_MODEL=deepseek node --env-file=.env examples/cli/dist/index.js \
  --tui "$RUNLOOM_MEMORY_TRANSCRIPTS" --thread phase2-memory-source \
  --config "$RUNLOOM_MEMORY_CONFIG"
```

输入一条无敏感信息、明确且可持久使用的普通用户事实，例如：“我的长期写作偏好是：复盘先给一行结论，再列两条可执行步骤。可以提出记忆候选，但未经我下一轮点名和确认，不得调用写入工具。”主 Run 成功且没有请求 `memory_*` 工具后，TUI 应显示“正在自动整理记忆...”，然后给出普通回复中的候选。此时先核对 `.runloom/memory.json` **没有新增条目**：候选不是保存。若没有候选、整理失败或超时，按首次尝试记录，不跳过候选环节直接要求模型记住。

只有看到含原用户 message ID、精确 `sourceQuote`、完整文本和动作的候选后，用户才在下一轮明确说“保存候选 [1]”。检查 `memory_add` 预览确为该候选、workspace scope 与原文来源，再亲自输入 `y`；不认可时输入 `n` 并记录拒绝，不能算通过。确认后核对 `.runloom/memory.json` 当前条目的 `source.kind: "conversation"`、`threadId`、`messageId`、`quote`、`revision`、`status` 与文本；引句须是同一 Thread 已提交普通用户消息的精确子串。直接在本轮要求“记住这句话”会得到 manual source，不能替代本链验收。

退出后用**同一 workspace 与 transcript 目录、不同 Thread** 启动：

```bash
RUNLOOM_MODEL=deepseek node --env-file=.env examples/cli/dist/index.js \
  --tui "$RUNLOOM_MEMORY_TRANSCRIPTS" --thread phase2-memory-consumer \
  --config "$RUNLOOM_MEMORY_CONFIG"
```

问：“依据当前工作区记忆，给我一份三句的复盘模板；不要把旧 Thread 对话当作当前指令。”核对回答实际使用刚保存的 active workspace 记忆，又没有声称能用新 Thread 的 `/history` 打开旧 Thread 原消息。自动整理的增量边界只认**已提交、且恰好一次 `memory_prepare_consolidation` 返回 `ok: true` 的自动整理回合**；首次无有效标记最多取最近 8 个普通回合，含 `memory_*` 的回合被跳过。报告以 JSONL 中普通用户消息 ID、`auto-consolidation` 回合及实际取材结果说明 source/cursor，不自造 cursor 字段；没取材、取材失败或 Run 失败都不能声称 cursor 前进。

只读核对记录与记忆文件：

```bash
rg -n 'auto-consolidation|memory_prepare_consolidation|memory_add' "$RUNLOOM_MEMORY_TRANSCRIPTS"
rg -n 'conversation|复盘先给一行结论' "$RUNLOOM_MEMORY_WORKSPACE/.runloom/memory.json"
```

报告至少记下实际 commit/dirty、模型 ID、配置摘要、两个 Thread ID、每轮输入/输出、主 Run 与整理 Run 状态、用户原文 ID 与精确引句、候选内容及编号、确认预览与 `y/n`、确认前后 memory 文件事实、source/revision、增量标记及其前后覆盖范围、新 Thread 的真实回答。若涉及用量，记实际可得值；不可得写不可得。

## 记录与收口

把两份报告分别存到 `$RUNLOOM_PHASE2_ROOT/reports/context-attempt-1.md` 与 `memory-attempt-1.md`，证据可存同目录下独立子目录。每次失败、受阻或复验另开 `attempt-2`，保留首次错误、输入、预期、实际、所属层和证据，不覆盖旧结论；网络/DNS、鉴权、模型未按预期调用、用户拒绝、磁盘与回执不一致分别照实记录。原始 transcript 可能含用户内容，公开分享前脱敏，但不能改写原始证据。两份报告和对应原件齐备、人工核对通过前，阶段二状态均为**待验收**；低预算、受控网络、mock 或离线测试的结果必须单独标注，不能冒充日用配置或真实模型通过。
