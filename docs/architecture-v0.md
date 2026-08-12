# AI SDK Agent Framework：v0 架构与实现约定

状态：提案基线  
日期：2026-08-12

## 1. 要解决的问题

在具体用途未知时，框架只解决所有 Tool-using Agent 都共同需要的问题：

1. 定义 Agent、模型、指令和工具；
2. 驱动模型与工具的多步循环；
3. 控制步数、总时间、取消和重试；
4. 对高风险工具进行人工审批；
5. 用统一事件暴露文本、步骤、工具、用量和错误；
6. 保存产品消息和运行记录；
7. 用 mock model 做确定性测试。

v0 明确不做：多 Agent 协作、规划器、工作流 DAG、RAG、向量库、长期记忆、定时任务、分布式队列、MCP 管理平台、Web UI。

## 2. 核心选择

### 2.1 运行时

- TypeScript，开启 strict mode；Node.js LTS；ESM。
- pnpm workspace，但首版只放一个核心包和一个 CLI 示例。
- 数据结构和配置边界使用 Zod 校验。

### 2.2 Agent 循环

首版用 AI SDK `ToolLoopAgent`，因为它已经提供工具循环、`stopWhen`、`prepareStep`、流式返回和取消能力。

框架不直接向应用暴露 `ToolLoopAgent`。应用只依赖 `AgentRuntime`，AI SDK 实现在 adapter 内。这样将来出现以下需求时可以替换成基于 `generateText` / `streamText` 的自定义循环：

- 精确的恢复点和 checkpoint；
- 每步不同的重试与预算策略；
- 确定性分支或工作流；
- AI SDK agent API 发生不兼容变化。

### 2.3 产品状态与模型状态分离

- `UIMessage` 是会话持久化和 UI 展示的事实来源，保留结构化 parts、工具生命周期和 metadata。
- `ModelMessage` 只在调用模型前生成，用作精简后的模型上下文。
- 不将 provider 原始响应或 SDK 私有对象直接作为数据库模型。

## 3. 分层

```text
CLI / HTTP / UI adapter
          |
          v
    AgentRuntime             自有稳定契约
      |    |    |
      |    |    +-- RunStore / MessageStore
      |    +------- EventSink / ApprovalGateway
      +------------ AiSdkAgentLoop adapter
                         |       |
                         |       +-- ToolRegistry -> Tool executors
                         +---------- ModelRegistry -> AI SDK providers
```

边界约束：

- `AgentRuntime` 管一次 run 的状态、预算、事件、取消和结果，不写具体工具业务。
- `AiSdkAgentLoop` 只处理模型消息、工具循环、停止条件和 token usage。
- `ToolRegistry` 负责工具发现、schema 与执行包装；工具不知道会话存储实现。
- store 是端口接口；v0 只有内存 adapter。
- transport 只做协议转换，不能包含 agent 决策。

## 4. 最小公共契约

下面是实现时应保持的语义，具体泛型可以在编码阶段微调。

```ts
type RunStatus =
  | 'created'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

interface AgentDefinition<TContext = unknown> {
  id: string;
  version: string;
  instructions: string;
  model: string;
  tools: readonly string[];
  limits: {
    maxSteps: number;
    totalTimeoutMs: number;
    stepTimeoutMs: number;
    maxOutputTokens?: number;
  };
  contextSchema?: z.ZodType<TContext>;
}

interface RunRequest<TContext = unknown> {
  agentId: string;
  threadId: string;
  messages: UIMessage[];
  context?: TContext;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

interface RunHandle {
  runId: string;
  events: AsyncIterable<AgentEvent>;
  result: Promise<RunResult>;
  cancel(reason?: string): Promise<void>;
}

interface AgentRuntime {
  run(request: RunRequest): Promise<RunHandle>;
  approve(input: ToolApprovalDecision): Promise<void>;
}
```

首版不要设计一个巨大的 `Agent` class。定义、运行、存储、工具和 provider 分别由独立对象负责。

## 5. Run 与事件协议

每次调用产生不可复用的 `runId`；同一 `threadId` 默认只允许一个 active run，避免消息和工具副作用乱序。

必要事件：

```text
run.started
message.delta
step.started
step.completed
tool.call.requested
tool.call.approval_required
tool.call.started
tool.call.completed
tool.call.failed
usage.updated
run.completed
run.failed
run.cancelled
run.timed_out
```

所有事件至少包含：

```ts
interface EventEnvelope<TType extends string, TData> {
  id: string;
  type: TType;
  occurredAt: string;
  runId: string;
  threadId: string;
  sequence: number;
  data: TData;
}
```

`sequence` 在单个 run 内严格递增。UI 和存储可以据此去重、排序和恢复。事件是框架协议，不能直接透传 AI SDK chunk。

## 6. 工具契约与安全

工具以 AI SDK `tool()` 和 Zod `inputSchema` 为底层定义，同时增加框架 metadata：

```ts
type ToolRisk = 'read' | 'write' | 'external_side_effect' | 'destructive';

interface ToolMetadata {
  name: string;
  version: string;
  risk: ToolRisk;
  timeoutMs: number;
  idempotent: boolean;
  redact?: readonly string[];
}
```

策略：

- `read` 默认可自动执行；其余风险默认需要审批，业务之后可以收紧。
- 删除、发送消息、付款、发布、修改外部状态必须审批。
- 模型不能通过 prompt 改写权限；授权由代码策略判断。
- 外部内容与工具结果默认是不可信数据，不能覆盖 system instructions。
- 工具输入必须 schema 校验；输出在进入事件和日志前做大小限制与敏感字段脱敏。
- `AbortSignal` 和剩余 deadline 传给每个工具。
- v0 不自动重试有副作用或 `idempotent: false` 的工具。

审批不是阻塞进程等待。run 进入 `waiting_approval` 并持久化 approval request；收到 decision 后以新一次模型调用继续。该设计与 AI SDK 的 approval message 流程一致。

## 7. 模型和 Provider

使用一个 `ModelRegistry` 将稳定的逻辑名映射到 AI SDK model：

```ts
interface ModelRegistry {
  resolve(modelId: string): LanguageModel;
}
```

AgentDefinition 保存 `default`、`fast` 之类的逻辑 ID，不保存 API key，也不在业务代码中直接调用 provider factory。provider 凭证只从运行环境注入。

v0 只接一个真实 provider adapter，但测试全部使用 `MockLanguageModelV3`。不要为了“通用”同时实现多个 provider。

## 8. 预算、终止和重试

默认值：

- `maxSteps = 8`，而不是沿用 SDK 较宽松的默认值；
- `totalTimeoutMs = 120_000`；
- `stepTimeoutMs = 45_000`；
- provider 瞬态错误最多重试 2 次；
- 工具层默认 0 次重试。

规则：

1. total deadline 使用绝对时间计算；所有子调用只拿剩余预算。
2. 达到步数、总时间、取消信号或 approval request 时必须停止本轮循环。
3. SDK、loop 和 runtime 不能同时对同一故障重试。
4. schema/权限/无效工具错误不可重试；限流和短暂网络故障可在预算内重试。
5. 超时后迟到的工具结果不得写回已终态 run。

## 9. 错误模型

不把原始 SDK exception 暴露成公共协议：

```ts
type AgentErrorCode =
  | 'MODEL_AUTH'
  | 'MODEL_RATE_LIMIT'
  | 'MODEL_TIMEOUT'
  | 'MODEL_BAD_RESPONSE'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_INVALID_INPUT'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_DENIED'
  | 'RUN_CONFLICT'
  | 'RUN_CANCELLED'
  | 'RUN_TIMEOUT'
  | 'INTERNAL';

interface AgentError {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  phase: 'runtime' | 'model' | 'tool' | 'storage' | 'approval';
  cause?: unknown; // 只在服务端内部保留
}
```

流式错误必须同时满足两点：事件流发出 `run.failed`；`result` promise 返回同一个终态错误。不能只关闭 stream。

## 10. 存储边界

v0 定义接口但只实现内存版本：

- `RunStore`：run 状态、版本、终态和 approval request；
- `MessageStore`：完整 `UIMessage`；
- `EventStore`：按 run 追加事件并按 sequence 读取。

首版不实现长期 memory。会话历史和 memory 是两件事；后者只有在业务用例能说明“需要跨会话记住什么”后再设计。

## 11. 可观测性

每次 run 传播 `traceId -> runId -> step -> toolCallId/providerRequestId`。至少记录：

- 模型 ID、step 数、finish reason；
- input/output/total tokens；
- run、step、tool duration；
- approval 决策；
- 标准化错误 code。

日志中不默认保存 system prompt、用户原文、工具完整输入输出和 provider key。AI SDK DevTools 只在本地开发启用，不能成为生产协议的一部分。

## 12. 测试要求

测试金字塔：

1. 工具单测：schema、超时、取消、脱敏、错误映射；
2. loop 契约测试：使用 `MockLanguageModelV3` 固定产生文本、工具调用和错误；
3. runtime 状态机测试：完成、审批、拒绝、取消、超时、并发冲突；
4. 一条可选真实 provider smoke test，默认不在 CI 运行。

M1 完成标准：不使用真实 API key，也能稳定复现“用户消息 -> 模型请求 -> 调工具 -> 模型总结 -> 完成事件”的完整闭环。

## 13. 初始目录

```text
aisdk-agent-framework/
  package.json
  pnpm-workspace.yaml
  tsconfig.json
  packages/
    core/                 # 公共契约、AgentRuntime、事件和错误
    ai-sdk-adapter/       # ToolLoopAgent、provider/model adapter
  examples/
    cli/                  # 最小可运行入口
  tests/
    contract/             # adapter 与状态机契约测试
  docs/
    architecture-v0.md
```

暂不拆 `memory`、`workflow`、`mcp`、`observability` 等包；出现第二个真实实现后再抽包。

## 14. 实施顺序

### M1：最小闭环

- workspace、TypeScript、lint/test；
- 公共类型、事件总线、内存 store；
- model/tool registry；
- AI SDK loop adapter；
- 一个只读示例工具和 CLI；
- mock 驱动的完整契约测试。

### M2：安全控制

- tool risk policy；
- approval resume；
- deadline/cancel；
- 错误标准化和日志脱敏。

### M3：接第一个业务

选择真实场景后再增加：持久化 adapter、HTTP/UI transport、memory/RAG 或 workflow。只增加该场景证明确实需要的能力。

## 15. 现在拍板的默认项

在用途尚未确定的前提下，先采用以下默认值，不阻塞开工：

| 决策 | 默认选择 |
| --- | --- |
| 形态 | headless library + CLI harness |
| Agent 循环 | AI SDK `ToolLoopAgent` adapter |
| 消息事实来源 | `UIMessage`，调用前转 `ModelMessage` |
| 存储 | 接口 + in-memory adapter |
| 工具策略 | 读自动执行，副作用默认审批 |
| 并发 | 每个 thread 同时一个 active run |
| 长期记忆/RAG | 不进入 v0 |
| 多 Agent/工作流 | 不进入 v0 |
| 测试 | mock-first，真实 provider 仅 smoke test |

只有三个选择应随第一个真实用例再确定：首个 provider、首个持久化数据库、首个 transport（CLI/HTTP/Web UI）。它们不应渗透进 core 契约。
