# 文档索引

日常从现行架构和对应功能专题进入。历史批次保留当时的边界、命令和验收记录；执行新工作以现行计划及 [AGENTS.md](../AGENTS.md) 为准。

## 当前架构与计划

- [架构 v2：现状、边界与路线](architecture-v2.md)
- [上下文与记忆重构计划](context-memory-refactor-plan.md)：执行依据，含后续架构第 6／7 步前提和完成状态。
- [架构第 4.5 步计划](architecture-v2-step4.5-plan.md)：home、项目、目录授权和导入边界。
- [待处理事项与暂停项](v2-pilot/pending.md)
- [ADR 0001：移除 durable orchestrator 与 PostgreSQL](adr/0001-remove-durable-orchestrator-and-postgres.md)

## 功能专题

- [嵌入 AssistantController](embedding-assistant-controller.md)
- [执行中补充要求（Steer）](steering.md)
- [执行轨迹](agent-trace.md)
- [记忆文件夹与文档](memory-library.md)：功能说明；当前存储与作用域以记忆计划为准。
- [后台任务执行与交付](background-task-delivery.md)
- [定期 RSS 简报](rss-subscriptions.md)
- [能力查询与命令配方](command-recipes.md)
- [Hook、定时任务与 Skill 接入](hook-skill-integration.md)
- [已有 dreaming 方法说明](dreaming-experience-skills.md)：旧功能契约供查阅，新方法提炼已按现行记忆计划暂停。

## 开发与验证

- [仓库入口与命令](../README.md)、[桌面端入口](../apps/desktop/README.md)
- [内置模块接入约定](module-development.md)、[开发任务输入模板](development-task-template.md)
- [任务级验收操作指南](task-acceptance.md)、[WorkTask 验收与 Eval](work-task-acceptance.md)
- [工具副作用与 verifier 不变量](v2-pilot/receipt-invariants.md)
- [路径清单](v2-pilot/paths.md)、[稳定哈希盘点](v2-pilot/hashes.md)：固定基线记录，当前值须查源码。
- [桌面恢复](../apps/desktop/docs/desktop-recovery.md)、[桌面截图验证](../apps/desktop/scripts/ui-snapshots/README.md)
- [切日用 runbook](v2-pilot/cutover-runbook.md)：历史受控导入步骤，使用前重新核对授权和路径。
- [发布记录 release-3](v2-pilot/release-3.md)
- [本轮文档整理与静态检查](v2-pilot/doc-navigation-rules.md)

## 历史批次

四份归档正文逐字节保留。原文中的代码样式路径和命令保留当时写法；当前文档位置见下表，历史命令执行前须核对当前入口。

| 批次 | 任务书 | 报告 |
|---|---|---|
| A＋B 历史与回执 | [实现任务书](legacy/batches/optimization-route-impl-brief.md) | [长历史与关键回执](legacy/batches/history-durability-batch-a-b.md) |
| C＋D Telegram | [续批任务书](legacy/batches/optimization-route-batch2-plus.md) | [生命周期与过期确认](legacy/batches/telegram-lifecycle-confirmation-batch-c-d.md) |

- [第二批文档保留审查](v2-pilot/doc-cleanup-batch2.md)
- [旧剩余批次排期](optimization-route-remaining.md)、[E 备份与恢复](workspace-backup-recovery-batch-e.md)：原位保留。
- 上下文／记忆交付：[0](v2-pilot/cm-step0.md)、[1](v2-pilot/cm-step1.md)、[2](v2-pilot/cm-step2.md)、[3](v2-pilot/cm-step3.md)、[4](v2-pilot/cm-step4.md)、[5](v2-pilot/cm-step5.md)、[6](v2-pilot/cm-step6.md)、[7](v2-pilot/cm-step7.md)。
- 架构与导入交付：[s0](v2-pilot/architecture-v2-s0.md)、[s1](v2-pilot/architecture-v2-s1.md)、[a1](v2-pilot/architecture-v2-a1.md)、[a2](v2-pilot/architecture-v2-a2.md)、[a2 补正](v2-pilot/architecture-v2-a2-correction.md)、[b0＋b1](v2-pilot/architecture-v2-b0-b1.md)、[b2](v2-pilot/architecture-v2-b2.md)、[c1＋c2](v2-pilot/architecture-v2-c1c2.md)、[d1＋d2＋e](v2-pilot/architecture-v2-d1-d2-e.md)、[s05](v2-pilot/architecture-v2-s05.md)、[cutover 工具](v2-pilot/architecture-v2-cutover-tools.md)。
- 架构复盘：[试点复盘](v2-pilot/review.md)、[跨模块接口](v2-pilot/cross-module.md)、[状态事件](v2-pilot/state-events.md)、[拆 App.tsx](v2-pilot/app-split.md)、[RunContext](v2-pilot/run-context.md)、[desktop store](v2-pilot/desktop-store.md)。
- 独立批次：[round1](v2-pilot/v2-round1.md)、[round2](v2-pilot/v2-round2.md)、[round3](v2-pilot/v2-round3.md)、[Todoist](v2-pilot/todoist.md)、[Computer Read](v2-pilot/computer-read.md)、[ZCode 清理](v2-pilot/zcode-cleanup.md)。
- 旧设计与验收：[架构 v0](architecture-v0.md)、[旧开发约束](legacy/agents-constraints-2026-10-20.md)、[早期模块决策](implementation-decisions.md)、[Memory v4 存储](memory-temporal-store.md)、[原生 Memory A＋B](memory-native-acceptance.md)、[早期长上下文验收](long-context-memory-acceptance.md)、[CM6 手动验收](v2-pilot/cm6-manual-test.md)、[Today.app 交互规格](today-app-interaction-spec.md)。

## Evidence 只作证据查询

[docs/v2-pilot/evidence/](v2-pilot/evidence/) 保存各批次脚本生成的日志、清单、截图和结果。它不是日常文档导航，也不提供当前功能状态或新执行授权。先读对应报告，再按报告中的提交、脚本哈希和相对路径查询证据；目录原位保留。
