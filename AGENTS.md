# Serika 开发约束

> 这份文件每次都会加载，所以只放长期有效、每条不超过 3 行的约束。
> 旧版全文在 `docs/legacy/agents-constraints-2026-10-20.md`，改权限、沙箱、自主执行、Computer Use、回执相关代码前先查对应条目。

## 1. 当前在做什么

- 分支：只在 `experiment/architecture-v2` 工作。不改、合并、同步或移植 `main`，不开 PR。
- 依据：上下文与记忆以 `docs/context-memory-refactor-plan.md` 为唯一依据；整体结构见 `docs/architecture-v2.md`。旧约束与计划冲突时，以计划为准。
- 提交：每个步骤做完直接提交并推送到实验分支，一步一个或几个提交，提交说明写清依据。
- 日常数据只读；迁移只在副本上验证；不重启用户正在用的进程。

## 2. 什么时候必须停下来问

除第 4 节约定的复现／审核／迁移关口外，只在以下情况停：

- 计划和用户授权均未确定的权限、数据格式、用户可见行为改动；回执、verifier、数据路径、hash、记忆语义的未决改动归入对应类别。
- 测试或 Electron 冒烟失败，先复现、查因并修复；自己修不好时报告具体阻塞，不进入下一步。

新增产品代码超过 400 行时说明原因和拆法，不另设暂停关口；沿用用户已批准的范围。

计划里已确认的内容不用再问。其余情况直接按判断做，在提交说明里写依据：

- 没有入口、界面和测试引用的代码：删；
- 文档与代码不符：按代码改文档（权限、审批、沙箱相关的不符算“两套规则冲突”，要停）；
- 容易混淆的别名：改名；
- 发现与当前步骤无关的缺口：记进 `docs/v2-pilot/pending.md`，不顺手修。

一次做完一整个步骤再回报，不要拆成“发现 → 问 → 再做”。不要提交“加演示代码、下一个提交又撤掉”这种来回，演示放在报告里说明，或者在本地做完不提交。

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
11. **修 bug 先复现。** 先找到实际触发路径（文件:行号）并复现，分清是真 bug 还是界面残留，再修；复现不了的不修。报告里写触发路径、复现结果和修法。
12. **查旧约束有触发条件。** 改到权限、审批、Shell / Docker 沙箱、网页抓取、Computer Use、自主执行、TG 信任相关的文件时，必须先查 `docs/legacy/agents-constraints-2026-10-20.md` 里的对应条目，并在报告里写明查过哪几条。

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

- **不许靠改断言、删测试、跳过测试让结果变绿**，也不改历史分数和快照来凑绿。确实要改的，在报告里单独列：测试名、旧断言、为什么旧行为是错的。删功能时同步删它的测试，删掉的测试文件逐个列出，不能只报测试总数。
- 每步新增的测试代码行数不超过新增的产品代码行数；超过时在报告里说明原因。
- 不新增快照文件，除非计划要求。
- **按真实环境测。** 窗口至少测 32,768（有效输入 26,624）和日用的大窗口两档；报告标明实测操作系统与进程形态；没覆盖到的要写明，例如“未在 32K 窗口下验证”“未在 macOS / 常驻进程下验证”。
- 怎么跑：中间提交只跑 `pnpm typecheck` 和受影响包的测试；步骤最后一个提交跑 `pnpm test`；只有改了桌面界面或装配文本时，才跑快照和像素对比。

### 验证证据、费用与审核

- 每个验证结论标明：真实 Electron／真实模型／假模型脚本／浏览器预览／单元测试。假模型脚本和浏览器预览不得写成“通过验收”；旧浏览器预览验收标“未在 Electron 验证”。
- 每步结束跑 `pnpm test` 和 `pnpm --filter @serika/desktop smoke`；Linux 用 Xvfb。启动构建后的 Electron，保留原 preload／IPC；全路径用新建临时目录，测完清理。
- 假模型必须经过真实记忆工具调用、宿主来源校验和实际存储；不得伪造成功工具结果、注入记忆或替换 preload／IPC 来满足断言。每项都断言无意外错误／警告，负例只放行明确预期的提示。
- 证据只能由验证脚本在运行时生成，并带当次随机编号；不得手写／补造运行字段、编号或结果。报告数字须能从提交证据复算，旧证据不补编号。
- 冒烟须从干净工作区生成（`sourceWorktreeDirty=false`），提交到 `docs/v2-pilot/evidence/electron-smoke/`；保留主进程 Electron 版本／pid／userData、renderer UA、重启 pid／记忆 SHA-256、逐项结果／截图及 SHA-256、源码提交和脚本 SHA-256；缺一即失败，不得跳过或标“不适用”。
- 第 4 步代码审核已通过；须等 bot1 在云电脑独立复现冒烟通过后才进第 5 步。独立复现绑定 smoke 脚本 SHA-256；以后 hash 不变可复用该复现，任何变化都须重新独立复现通过。
- 每步全套测试和冒烟通过后提交、推送，进入下一步；第 5 步完成后停下等审核，获准再做第 6 步。第 7 步开工前停下，先交 14 行旧记忆对照表，等用户决定旧对话级条目的留丢及迁移。
- 第 4–6 步真实模型验收合成一批，在第 6 步完成、第 7 步开工前运行，预算 $2；此前暂停，不拖到切日用。批次已批准，不套用旧 $1/步限制；其他请求仍须有费用授权，计划累计最多 $5，任一适用上限到达立即停止。
- 真实模型仅用测试专用密钥：从 `~/.serika-test.env` 复制到临时 env 文件，用完删除；费用累计记入 `docs/v2-pilot/evidence/cost-ledger.json`，原累计 $0.36，未运行不得记成已花费。
- 密钥不得进入日志、截图、证据或提交；截图不拍配置／设置页。提交前按密钥前缀扫描证据目录，命中即禁止提交；日用配置副本不提交。
- 用 `gh` 查标题“experiment/architecture-v2 审核记录”的 issue 评论，只认 `steven4225` 及用户明确指定的审核账号；核对真实作者 login，不认正文自称或其他账号转述，未指定的账号不自行加入。
- 审核意见先按现有授权处理；涉及计划未定的权限／数据格式／用户可见行为时等用户确认，其余查因修复。

## 5. 文档

- 每个步骤只交一份报告，写进 `docs/v2-pilot/` 下对应文件，尽量控制在一屏表格以内。不为每步另写设计文档，不把计划内容抄进报告。
- 报告固定五段：改了什么（文件和原因）→ **逐条对照验收项**（每项标“已做 + 测试名”或“没做 + 原因”，不许漏项不提）→ 前后数字（产品和测试代码各自的行数变化、计划里的指标）→ 实际命令和退出码 → 与计划不符的地方及理由。没有实测数字，不能写“已改善”“全过”。
- 这份 AGENTS.md 不是变更日志：功能说明不写进来，全文控制在 12 KB 以内。新约束要先得到用户同意。
- 不提交密钥、`.env`、生成物、依赖目录、编辑器状态和 Obsidian 元数据。`evals/inbox/` 不进 git；其他 eval 材料提交前去掉个人信息。

## 6. 固定的产品约定

- 给模型的时间用用户本地时间，带 `+08:00` 偏移，精确到分钟。
- 主界面不出现 UUID、revision 这类工程 ID；需要时放进诊断或详情。
- 测试数据由用户在界面上撤回，不能直接删数据文件。

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

