---
type: note
status: seed
created: 2026-08-13
source:
  - Serika 架构讨论
  - Pi Agent 0.82.1 本地源码与 durable-harness 设计
  - Vercel AI SDK 7 Agent、Tool Calling 与 Approval 文档
author:
  - 用户
  - Codex
tags:
  - development-experience
  - agent-runtime
  - durable-runtime
  - state-machine
  - postgresql
  - approval
  - idempotency
related:
  - "[[Pi Agent 编排设计取舍｜四层边界、双层循环、状态与扩展]]"
  - "[[Agent Day 6｜Durable Runtime、Checkpoint、恢复与幂等]]"
  - "[[开发经验｜从事实语义推导存储与组件选型]]"
confidence: high
reviewed: false
---

# 开发经验：从 Agent Loop 到可暂停、可审批、可恢复的 Durable Runtime

## 一句话结论

> Agent Loop 负责决定模型、工具和最终回答的行为顺序；Durable Runtime 负责把这一顺序拆成可持久化 Action，使它能在审批、故障和进程重启后从原位置继续。

两者不是竞争方案。持久化状态机是在 Agent 编排语义之下增加可靠执行层。

## 建议从哪里来

这套设计不是照抄 Vercel AI SDK，而是四类知识的组合：

| 来源 | 贡献 |
| --- | --- |
| 产品目标 | 审批暂停、进程退出、重启恢复、避免重复副作用 |
| Pi Agent | 内层模型—工具循环、四层边界、四类状态、StreamFn、工具数据与函数分离 |
| Vercel AI SDK | 单次模型流、Tool Call、Tool Result、Approval 消息协议和 Provider 适配 |
| Durable Runtime / 后端工程 | Action、Attempt、checkpoint、幂等、事务、结果未知和恢复 |

分析每项设计时检查六件事：

1. 进程在每个 `await` 前后崩溃会发生什么；
2. 外部副作用是否可能重复；
3. 哪些事实必须原子提交；
4. 哪些是对话事实、执行状态或瞬时流数据；
5. 状态转换能否脱离数据库和模型做纯函数测试；
6. 该能力是否真是 MVP 必需。

## 已确认的四层架构

```text
Application / Harness
        ↓
Durable Runtime
        ↓
Orchestrator
        ↓
ModelInvoker / ToolExecutor
```

- Application / Harness：提供 prompt、approve、reject、cancel 等应用 API。
- Durable Runtime：负责事务、恢复、Action、Attempt 和运行状态推进。
- Orchestrator：根据持久化状态决定下一步，不直接执行外部调用。
- Adapter：通过 AI SDK 调模型，或调用具体工具函数。

Core 统一使用 `Thread`，不使用含义容易漂移的 `Session`。

## 已确认的四类状态

### Definition State

Agent 定义、模型引用、指令、工具引用和策略版本。

### Thread State

已经提交的用户消息、Assistant Message、Tool Result 和当前消息 Head。

### Execution State

Run、Turn、Action、Attempt、Approval 和恢复状态。

### Inbox State

未来用于 Steering、Follow-up、Cancel 等运行中命令；不进入当前 MVP。

`TurnSnapshot` 是从这些状态派生的不可变输入快照，不是第五份事实来源。

## 已确认的身份层次

```text
Thread
  └── Run
        └── Turn
              └── Action
                    └── Attempt
```

- Thread：可长期继续的对话。
- Run：一条用户请求触发的一次完整 Agent 任务。
- Turn：一次模型响应及该响应关联的工具处理。
- Action：一个可独立 checkpoint 的推进单元。
- Attempt：某个 Action 的一次真实执行尝试。
- Approval：绑定具体 Tool Action 的等待条件。

审批属于原 Run，但等待审批时不持有 Worker、数据库事务、行锁或 Lease。

重启恢复时，Run、Turn、Action 和 Approval ID 不变；重新执行只创建新的 Attempt ID。

## 已确认的前向兼容字段

```text
Thread.headMessageId
Thread.activeRunId
Thread.version

Run.baseHeadMessageId
Run.triggerMessageId

Message.parentMessageId
Message.createdByRunId
```

MVP 仍按单链对话运行，但不可变父指针为未来排队 Run 和分支 Run 保留表达能力。

`active` 不是 RunStatus，而是 Thread 当前选择由哪个 Run 推进：

```text
thread.activeRunId = run-1
run-1.status = waiting_approval
```

## 已确认的 MVP 并发规则

每个 Thread 最多一个 Active Run。

- Active Run 等待审批时仍占据 Thread 的逻辑执行位置；
- 等待审批不占用任何运行资源；
- 存在 Active Run 时，新建普通 Run 返回 `THREAD_BUSY`；
- Run 终态转换与清空 `thread.activeRunId` 必须在同一事务完成；
- 将来可以增加 queued Runs，而不改变“最多一个 Active Run”；
- 并行分支需要额外的分支选择、合并和副作用冲突规则，不属于 MVP。

## 已确认的持久化粒度

不以整个 Turn 作为恢复边界，也不以 Token Chunk 作为恢复边界。

采用一个外部 Effect 对应一个 Action：

```text
Action: invoke_model
Action: execute_tool
```

执行模式：

```text
短事务：创建 Action / Attempt 并标记 started
    ↓
事务外：调用模型或工具
    ↓
短事务：提交结果、状态、事件和下一 Action
```

禁止在数据库事务中等待模型或工具。

流式 delta 可以实时发送给 UI，但只有完整 Assistant Message 才是模型上下文中的 durable fact。Provider Stream 不能跨重启从某个 Token 续传。

## 已确认的编排模型

```text
Command → State → Decision → Effect → Event → State
```

Orchestrator 的核心应尽可能是纯函数：

```ts
function decideNextAction(state: DurableRunState): Decision
```

它不连接数据库，不调用模型，不执行工具。数据库负责提供已提交 State；Executor 负责 Effect；Reducer 根据结果更新 State。

## 已确认的 Run 状态

```ts
type RunStatus =
  | "ready"
  | "executing"
  | "waiting_approval"
  | "waiting_retry"
  | "requires_reconciliation"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";
```

明确不设置：

- `created`：创建 Run 的事务同时创建首个 Action，成功后直接 `ready`；
- `queued`：MVP 不接受排队 Run；
- `paused`：不能表达审批、重试和结果未知的不同恢复语义；
- `cancelling`：取消请求保存为独立字段，Run 仍保留真实执行状态。

终态是 `completed / failed / cancelled / timed_out`，终态不可离开。

非幂等 Tool 的副作用结果未知时必须进入 `requires_reconciliation`，不能用 `failed`、`cancelled` 或 `timed_out` 掩盖。

## 已确认的标识和幂等原则

- `Run.id / threadId / agent execution snapshot / createdAt` 创建后不变；
- `updatedAt` 随提交变化，不能笼统要求所有时间不变；
- `version` 只增不减，用于乐观并发控制；
- 相同客户端幂等键不能创建两个 Run；
- Tool Action 使用稳定幂等键；重试 Attempt 不能生成新的业务幂等键；
- 数据库唯一约束只解决内部去重，外部副作用仍需要工具端幂等或人工对账。

## 已确认的 PostgreSQL MVP

PostgreSQL 是唯一真实持久化实现，但 MVP 保持单 Worker：

- 使用事务、唯一约束和乐观版本；
- 启动扫描未完成 Run；
- 工具严格顺序执行；
- 审批可跨进程恢复；
- 暂不引入 Redis、Kafka、独立队列、Lease、Fencing 和多 Worker；
- 数据库中的待执行 Action 就是事实来源。

选 PostgreSQL不是因为当前负载大，而是因为持久化恢复需要明确事务语义，并为将来多 Worker 避免重做存储模型。具体 ORM、迁移工具和 JSONB 划分仍应在状态机确认后决定。

## MVP 明确暂缓

- Pi 外层 Follow-up 循环；
- Steering 与 Follow-up；
- 通用持久化 Inbox；
- 并行工具调用；
- 多 Worker 与分布式协调；
- 多 Agent；
- RAG 与长期记忆；
- 对话分支合并。

## 当前正在评审：executing 退出规则

`executing` 只表示当前 Action 已有 started Attempt，且外部 Effect 正在进行或在崩溃后尚未完成恢复判定。

退出规则必须同时考虑：

1. Effect 是模型还是工具；
2. 结果是成功、确定失败、中断还是未知；
3. 错误是否可重试；
4. 工具是否幂等；
5. 是否已经提交取消请求；
6. 是否超过 deadline；
7. 是否还有下一 Action。

评审完成前，不应据此生成数据库表或 Runtime 实现。

## 开发经验压缩

> 不要从数据库表或 SDK 类开始设计 Durable Agent。先定义长期对话、一次任务、一次模型/工具 Effect 和执行尝试的语义，再逐个推演崩溃窗口。数据库保存不可丢失的事实，模型和工具函数由运行时重新装配，瞬时流只负责体验。状态机不是为了让 Agent 更聪明，而是为了让 Agent 在任何一次不可靠的 `await` 之后仍能知道接下来该做什么。
