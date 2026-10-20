# Serika 开发约束

> 这份文件每次都会加载，所以只放长期有效、每条不超过 3 行的约束。
> 旧版全文在 `docs/legacy/agents-constraints-2026-10-20.md`，改权限、沙箱、自主执行、Computer Use、回执相关代码前先查对应条目。

## 1. 当前在做什么

- 分支：只在 `experiment/architecture-v2` 上工作。不改、不合并、不同步、不移植 `main`，不开 PR。
- 依据：上下文与记忆以 `docs/context-memory-refactor-plan.md` 为唯一依据；整体结构见 `docs/architecture-v2.md`。旧约束与计划冲突时，以计划为准。
- 提交：每个步骤做完直接提交并推送到实验分支，一步一个或几个提交，提交说明写清依据。
- 日常数据只读；迁移只在副本上验证；不重启用户正在用的进程。

## 2. 什么时候必须停下来问

只有下面几类，计划里没写到的才停：

- 权限、审批、回执格式、verifier 判定（不变量 I1–I5 见 `docs/v2-pilot/receipt-invariants.md`）；
- 数据路径、数据格式、hash 格式；
- 用户能看到的行为、记忆语义；
- 会产生费用的操作：live eval、用真实模型做离线重放。

计划里已确认的内容不用再问。其余情况直接按判断做，在提交说明里写依据：

- 没有入口、界面和测试引用的代码：删；
- 文档与代码不符：按代码改文档；
- 容易混淆的别名：改名；
- 发现与当前步骤无关的缺口：记进 `docs/v2-pilot/pending.md`，不顺手修。

一次做完一整个步骤再回报，不要拆成“发现 → 问 → 再做”。

## 3. 写代码的规矩

这些规则针对本仓库里反复出现的问题。

1. **先删后加。** 新路径替换旧路径时，旧路径在同一步删掉。不加 `enabled` 开关让新旧两套并存，不留 `legacy` / `compat` / `fallback` / `V2` 并行实现，不写“以后再删”。
2. **只在边界校验一次。** 用户输入、文件读入、模型输出、外部进程是边界；内部函数之间不重复校验。不为不可能的状态写分支，遇到就直接抛错。
3. **不自创上限。** 新的大小、条数、时间上限必须来自计划或现有配置，不随手写 1 KiB、2 KiB、8 条这类常数。
4. **不加空抽象。** 只有一个实现的接口、工厂、注册表不建。不建 `utils` / `helpers` / `common` / `manager` 这类杂物文件。新文件要能用一句话说清职责。
5. **不往大文件里堆。** `AssistantController`、`app.ts`、`App.tsx` 不再增加新逻辑，新逻辑放进所属模块。函数参数超过 3 个改用参数对象。
6. **不打补丁规则。** 不为单个失败案例加话题、关键词或句式规则。失败了就改提示词或参数，并写进报告。
7. **一个概念一个名字。** 不造近义词，领域里用 `Thread`，不用 `Session`。
8. **注释只写“为什么”。** 不复述代码，不写“这不是 X、不意味着 Y、不保证 Z”这类免责声明。
9. **只做当前步骤。** 不顺手重构，不升级依赖，不为以后的步骤提前建 schema、接口或配置项。
10. **保持 TypeScript strict。** 领域类型不依赖 AI SDK、数据库和传输层对象。

## 4. 测试：少而准

**只在这几种情况新增测试：**

- 回执、verifier、工具副作用不变量（I1–I5）；
- 数据迁移和格式版本；
- 修 bug：一条能复现的用例；
- 有分支的核心逻辑（如请求组装、阈值计算、来源校验）：一个正常用例，加一到两个关键边界。

**不写：**

- 逐个配置字段、文案、界面布局、简单 getter 的测试；
- 只验证 mock 自己的测试；
- 同一逻辑的多种排列组合；
- 并发、崩溃恢复、幂等用例：只在改动锁或持久化时才写。

**其他规则：**

- 删功能时同步删它的测试。行为改了就改断言，不留 `skip`，不改历史分数或快照来凑绿。
- 每步新增的测试代码行数不超过新增的产品代码行数；超过时在报告里说明原因。
- 不新增快照文件，除非计划要求。
- 怎么跑：中间提交只跑 `pnpm typecheck` 和受影响包的测试；步骤最后一个提交跑 `pnpm test`；只有改了桌面界面或装配文本时，才跑快照和像素对比。

## 5. 文档

- 每个步骤只交一份报告，写进 `docs/v2-pilot/` 下对应文件，尽量控制在一屏表格以内。不为每步另写设计文档，不把计划内容抄进报告。
- 报告固定四段：改了什么（文件和原因）→ 前后数字（产品和测试代码各自的行数变化、计划里的指标）→ 实际命令和退出码 → 与计划不符的地方及理由。没有实测数字，不能写“已改善”“全过”。
- 这份 AGENTS.md 不是变更日志：功能说明不写进来，全文控制在 12 KB 以内。新约束要先得到用户同意。
- 不提交密钥、`.env`、生成物、依赖目录、编辑器状态和 Obsidian 元数据。

## Terminology and architecture

- The project name is Serika.
- Core domain language uses `Thread`; do not introduce `Session` as an alias.
- Current architecture and refactor boundaries: `docs/architecture-v2.md`. Architecture decisions: `docs/adr/`.
- Preserve this dependency direction:

  ```text
  apps/desktop -> packages/assistant (assistant domain + controller) -> packages/ai-sdk-adapter -> packages/core
  ```

- `packages/core` must not import the AI SDK adapter, the assistant domain, Electron or any storage engine.
- The workspace files (JSON/JSONL under `.runloom/`) are the local source of truth. The former PostgreSQL durable orchestrator was removed (ADR 0001); do not reintroduce a second source of execution truth.

## Tool side-effect invariants

- The identity hierarchy is `Thread -> Run -> Turn -> Action -> Attempt`; an Approval binds to a Tool Action.
- A Thread has at most one active Run in the MVP.
- Each external effect is represented by one Action; each real invocation is represented by a new persisted Attempt.
- External model and tool calls run outside database transactions. Persist intent before the call and persist its resolution in a new short transaction afterward.
- AI SDK and Tool adapters do not retry tools or hide retries by default. The interactive TUI may explicitly opt into bounded model-request retries for a still-empty step; The Runtime remains the owner of external-effect retry policy and every real invocation must remain auditable.
- A tool without an explicit replay-safety classification is treated as non-idempotent and defaults to one attempt.
- Never automatically retry a non-idempotent tool when dispatch or outcome is unknown; transition to reconciliation instead.
- Approval is persisted before any Tool Attempt is created. Approval authorizes execution but does not execute the tool inside the approval transaction.
- Terminal Run states never transition back to a non-terminal state.
- Do not hide an unknown external side effect as an ordinary failure, cancellation, or timeout.


## Stable hashes

- Stable content hashes (for example compaction prefix hashes) use the versioned `jcs-sha256:v1` protocol over RFC 8785 canonical JSON via `hashCanonicalJson` in `@serika/core`. Never change the output format of an existing version; persisted hashes depend on it.

