# Serika 架构 v2：现状、边界与重构路线

> 状态：进行中（分支 `experiment/architecture-v2`）。本文取代 `docs/architecture-v0.md`。
> 规则：所有 v2 重构只在 `experiment/architecture-v2` 上进行；不修改、合并或同步 `main`，不强推、不改写历史。

## 1. 现状（以代码为准）

| 层 | 目录 | 实际职责 |
|---|---|---|
| Core | `packages/core` | Thread/Run 类型、JSONL transcript store、steering、事件、`hashCanonicalJson` |
| Loop | `packages/ai-sdk-adapter` | `AgentLoop`：model → tool → model 循环（`loop.ts` 963 行，`execute` 约 480 行） |
| 助理领域 + Controller | `examples/cli` | 记忆、任务、WorkTask、上下文压缩、dreaming、RSS、Telegram、权限、`AssistantController`（约 70 个方法）、`RuntimeApp` |
| 桌面端 | `apps/desktop` | Electron 主进程 + React 渲染层；深度引用 `@serika/example-cli/dist/*.js` 共 45 个模块 |
| Eval | `examples/eval` | 离线/真实模型评测、记忆召回、压缩保真度 |

事实上的核心是 `examples/cli`，名字叫 example，但承载了全部产品逻辑。

已知结构问题（重构对象）：

1. God object：`AssistantController`（1849 行）、`RuntimeApp`（`app.ts` 1657 行）、`App.tsx`（1324 行，65 个 `useState`）。
2. Loop 与应用耦合：adapter 内写死应用工具名和中文提示文本；工具抛错直接终止 Run；工具串行；每步重复 clone/convert/prepare。
3. 两套上下文策略并存（8 回合/128 KiB 截断 vs token 预算压缩），token 用 字符数/2 估算，压缩同步阻塞，学习技能/checkpoint 位于前缀前部破坏 prompt cache。
4. 记忆单文件 `memory.json` 混存事实、候选、游标、回执、文档库；只有 workspace/thread 两种作用域；每步最多重复检索 3 次。
5. 约 17 个文件各自实现原子写，16 个各自用 flock。
6. UI 状态由文本流 `recordOutput` 反推；约 15 个手动刷新按钮。
7. WorkTask 把评测 harness 暴露成产品，与定时任务是两套系统。
8. 文档滞后：README 55 KB、AGENTS.md 58 KB，大量内容是变更日志。

## 2. 目标结构（v2 终态）

```text
apps/desktop ─┐
apps/cli ─────┼─> packages/assistant ─> packages/agent-loop ─> packages/core
apps/telegram ┘        (领域：记忆/任务/上下文/沉淀，扩展 API)
```

- `packages/core`：只有类型、事件、transcript 存储、hash，不依赖 AI SDK、Electron 或存储引擎。
- `packages/agent-loop`：参考 pi 的最小循环（目标 ≤ 500 行）。通过 hook 扩展：`transformContext`、`convertToLlm`、`beforeToolCall`/`afterToolCall`、steering、follow-up。hook 不得抛错，错误编码为消息。
- `packages/assistant`：助理领域 + 扩展 API。权限、记忆、任务、上下文组装都以扩展形式挂到 loop 上。
- 桌面端通过事件订阅拿状态，不再解析文本流，不再深度引用 `dist/*.js`。

## 3. 不动的东西

以下是 Serika 的核心价值，重构中只搬位置、不改语义：

- 工具副作用语义：未知结果不伪装成失败；非幂等工具不自动重试；审批先于执行持久化（见 AGENTS.md「Tool side-effect invariants」）。
- verifier 概念。
- 双时态记忆模型的内部语义，以及「事实只能来自用户原话」（`isExactUserQuote`）这条边界。
- 权限模型（会改成扩展形式，但判定规则不变）。
- 现有测试：先保持全绿，再随代码迁移。
- 常驻进程架构、AI SDK adapter 边界。
- `jcs-sha256:v1` hash 输出格式（已持久化）。
- 用户数据路径：userData `@aisdk-agent/desktop`、`.runloom/`、`runloom.json`、`RUNLOOM_*`，在有「新名优先、旧名兜底」的兼容层之前不改。

## 4. 重构路线

每一步：测试全绿才提交；记录前后指标；一步一组提交，提交信息以 `refactor(vN-stepX):` 开头。

| 步 | 内容 | 主要指标 |
|---|---|---|
| 0 | 定边界：本文档、ADR、改名 Serika、移除 durable/postgres | 删除约 5.8k 行无用源码 |
| 1 | 删冗余用户操作：记忆审核队列、手动刷新、模拟按钮、功能开关等；记忆默认自动写入（待确认默认选项） | 用户可见按钮/开关数 |
| 2 | Loop 瘦身（pi 风格 hook，移出应用工具名和文案，工具错误编码为消息） | `loop.ts` ≤ 500 行 |
| 3 | 拆包 + 扩展 API：`packages/assistant`、`apps/cli`；权限扩展（记住选择）；上下文组装器；事件订阅 UI；拆 `App.tsx` | 深度引用 45 → 0；`AssistantController` 方法数 |
| 4 | 统一上下文：裁剪工具输出 → 真实 token 用量 → 后台压缩；稳定前缀排序 | 只剩一套策略；cache 命中率 |
| 4.5 | 去掉用户可见的「工作区」：用户级 home（`~/.serika` / userData）+ 自动识别的项目层；授权目录列表；记忆增加 `user` 作用域；`.runloom/` 一次性导入 | 「未配置工作区」类拦截数 → 0 |
| 5 | SQLite（`node:sqlite`）：先迁记忆，拆表；表结构按 4.5 的两级设计（`project_id` 可空）；备份改为导出/导入 JSON；保留旧 `memory.json` | `memory-store.ts` 行数；并发写冲突 |
| 6 | 任务重做：`work_task_create` 工具、自动推导校验、宿主执行校验、4 个状态、与定时任务合并 | 状态数 7 → 4 |
| 7 | 沉淀管线：自动整理 + dreaming 合并为一条空闲反思管线，使用隐式信号；增加精确率/撤销率评测 | 撤销率 |

候选补充（参考 OpenClaw / Hermes，待确认后并入对应步骤）：

- 4.5：home 首次启动自动创建，不要求用户配置。
- 4：用户画像设硬预算，会话开始时冻结注入；事实库改为工具按需检索。
- 7：压缩前先沉淀（pre-compaction flush）。
- 可选：桌面端与 Telegram 共用单一主会话，需要时分出线程。

## 4.1 进度

- 第 0 步：完成（改名、本文档、ADR 0001、移除 durable/postgres）。
- 第 1 步（进行中）：
  - 已完成：删除「内置功能开关」卡片；删除「找回旧目录里的对话」；记忆默认自动写入（仅限工作区外的配置）；删除记忆审核队列（今日卡片、简报项、提醒、角标）。
  - 保留：浏览器预览页（`*-preview.html`，含「模拟」按钮）只是开发用夹具，不进入产品；没有 Electron 图形环境时可以用它们验证界面，所以不删。
  - 挪到后续步骤（和那一步的改动耦合，单独删会做两遍）：上下文模式选择和手动压缩 → 第 4 步；Telegram 投递核对 → 第 6 步（关系到未知效果的核对，不能先删界面）；`add` 演示工具 → 第 2 步（mock 模型和测试依赖它）。
  - 待确认：记忆文件夹（记忆页主视图）、双时间编辑界面、导入拆分预览。

## 5. 度量基线（`c594574`，改名后、移除 durable/postgres 前）

| 指标 | 值 |
|---|---|
| `packages/core` 源码行数 | 约 5.6k（其中 durable 3926） |
| `packages/postgres` 源码行数 | 1832（未被使用） |
| `packages/ai-sdk-adapter/src/loop.ts` | 963 行 |
| `examples/cli` 源码 / 测试行数 | 33.5k / 41.4k |
| `apps/desktop` 源码 / 测试行数 | 18.0k / 13.3k |
| `assistant-controller.ts` / `app.ts` / `memory-store.ts` | 1849 / 1657 / 2003 行 |
| `App.tsx` | 1324 行，65 个 `useState` |
| 桌面端深度引用 `example-cli/dist` 模块数 | 45 |
| README.md / AGENTS.md | 55 KB / 58 KB |
| 测试 | runtime 1730（20 跳过）；desktop 641 + 12（1 跳过） |
