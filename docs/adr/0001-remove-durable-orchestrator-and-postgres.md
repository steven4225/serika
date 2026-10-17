# ADR 0001：移除未使用的 durable orchestrator 与 PostgreSQL 包

- 状态：已接受（`experiment/architecture-v2`）
- 日期：2026-10-17

## 背景

`packages/core/src/durable/`（3926 行源码 + 1474 行测试）和 `packages/postgres`（1832 行源码 + 421 行测试）实现了一套基于 PostgreSQL 的持久化执行模型（Thread → Run → Turn → Action → Attempt、effect outbox、dispatcher）。实际产品（CLI、桌面端、Telegram、worker）全部运行在本地 JSON/JSONL 文件上，没有任何运行路径用到它们。唯一的外部引用是 `context-compaction.ts` 使用 `durable.hashCanonicalJson` 计算压缩前缀 hash。

这些代码让新读者误以为 Serika 依赖 PostgreSQL，增加了构建、测试和文档负担（AGENTS.md 中有整节 PostgreSQL 约束），也和计划中的 SQLite 方向冲突。

## 决定

1. 删除 `packages/core/src/durable/` 和 `packages/postgres`，以及相关脚本（`test:integration`、`db:migrate*`）、tsconfig 引用和 `@serika/core/durable` 导出。
2. `hashCanonicalJson` 移到 `packages/core/src/canonical-hash.ts`，输出格式保持 `jcs-sha256:v1:<hex>` 不变，并用固定值测试锁定。
3. 设计中仍然成立的部分（工具副作用不变量：未知结果不伪装、非幂等工具不自动重试、审批先于执行）保留在 AGENTS.md「Tool side-effect invariants」。

## 后果

- 本地状态的唯一真相是 workspace 文件；之后迁到 SQLite（路线第 5 步）。
- 旧代码可在提交 `c594574` 及之前的历史中找到，需要时可以恢复。
- 不再需要 Docker/Testcontainers 才能跑完整测试。
