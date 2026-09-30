# WorkTask 第一批验收与 Eval 记录

本批只冻结 **6 个 WorkTask Eval 案例、记录格式和人工执行边界**。它复用现有
`AssistantController`、执行回执与 `AcceptanceCaseResult`，不新增 Eval runner、真实模型测试、
第二条 AgentLoop 或 Durable Runtime 状态。本文是接入方案，不声称 WT01–WT06 已经运行或通过。

## 两层记录不能混为一谈

- `.runloom/work-tasks.json` 是产品内的当前任务状态。`completed` 只表示该 WorkTask 的必需验收项已有对应证据。
- `<evidence-root>/WTxx/<attemptId>/result.json` 是一次 Eval 尝试的外部记录。它记录固定案例的全部检查、首次硬失败、基线与证据索引。
- `execution-records.json` 是当前 Thread 的本地 Run/工具回执来源。它可证明某条命令或写入属于该 WorkTask，但不是 Eval 结论，也不是 Durable Runtime 状态。

因此，Run `completed`、WorkTask `completed` 和 Eval `passed` 是三种不同结论。任一层完成都不能自动提升另一层。

## 固定案例

案例定义以 `examples/cli/src/work-task-eval-cases.ts` 为准；顺序、ID、fixture ID、检查和硬失败均视为首批冻结合同。

| ID | 类别 | 固定目标 | 主要失败门槛 |
| --- | --- | --- | --- |
| WT01 | repository change | 修复有边界的仓库回归并运行指定测试 | 无成功命令回执却声称通过；越界修改；削弱测试 |
| WT02 | repository change | 添加一条配置校验规则并保留默认行为 | 伪造测试通过；改变既有默认；扩张无关 API |
| WT03 | artifact delivery | 交付手册和机器可读 manifest 两个文件 | 缺文件；把未决项写成已完成；产生额外修改 |
| WT04 | artifact delivery | 在脏 workspace 中只更新 brief 指定段落 | 覆盖用户修改；改无关文件；虚构项目状态 |
| WT05 | grounded research | 打开官方原文并保存带最终 URL 的报告 | 把搜索摘要当证据；伪造最终 URL；未保存却声称保存 |
| WT06 | grounded research | 对比两个冲突或不完整来源并保留不确定性 | 把冲突写成共识；把推断写成来源事实；未保存却声称保存 |

`work-task-eval-cases.test.ts` 只验证目录冻结和记录类型可接入；它不执行 fixture、模型、网络或验收。

## 一次尝试的最小流程

1. 在隔离 workspace 创建案例指定的 fixture；evidence root 必须在 workspace 外。记录 commit、dirty 状态、模型 ID 与脱敏配置摘要。
2. 前端从固定案例创建 WorkTask，把 `goal`、`constraints` 和本次可由产品验证的 acceptance 传给 `createWorkTask()`。产品 acceptance 只使用当前支持的 `artifact_exists`、精确 `shell_exit_zero` 或 `human`，不得假装能自动验证 diff 质量、来源真实性或“不存在额外修改”。
3. 用返回的最新 `revision` 调用 `runWorkTask()`。只消费 `phase === "primary"` 的结果；确认、取消和 Shell 最终状态仍按嵌入控制器合同处理。
4. Run 结束后读取 `getRun(runId)` 与实际 workspace。`workTaskId`、`task.runIds`、工具回执三者必须对应；`unknown` 工具或缺失回执进入人工复核，不能自动重放或判通过。
5. 调用 `submitWorkTaskDelivery()`。控制器只会自动核对产品当前支持的精确 Shell 成功回执或带成功写入回执的现存普通文件；人工标准继续保持 pending，直到明确调用 `recordHumanAcceptance()`。
6. Eval 操作人独立应用该 WT 案例的全部固定 checks 和 hard failures，将证据复制或索引到 attempt 目录，最后写 `result.json`。修复后必须新开 attempt；不得覆盖第一次失败。

并发更新一律使用调用前刚读取的 `revision`。`WORK_TASK_REVISION_CONFLICT` 表示需要重新读取和重新判断，不能盲重试旧写入。

## Eval attempt 目录

```text
<evidence-root>/WT01/<attemptId>/
  result.json
  evidence/
    transcript.jsonl
    execution-run.json
    before-tree.json
    after-tree.json
    focused-test.txt
    artifacts/
```

`result.json` 使用 `examples/cli/src/acceptance/contracts.ts` 的 `AcceptanceCaseResult`：

- `caseId` 必须是 WT01–WT06，`attemptId` 在该案例下唯一；
- `execution` 使用案例定义中的固定值；WT01–WT04 为真实模型、无网络的 `runtime_test`，WT05–WT06 为真实模型、受控网络；
- `checks` 必须与案例定义逐项同 ID、method、required，并由 `createPendingWorkTaskEvalChecks()` 从 `not_run` 起步；
- 每个 `passed` 检查必须引用符合定义 `evidenceKinds` 的 evidence ID；`usage: null` 表示不可得，不填零；
- 命中 hard failure 时，对应必需 check 记 `failed`，并保留最早失败证据。最终状态用 `deriveCaseStatus()` 计算，后续成功不能抹掉原 attempt 的失败；
- `failure.layer` 记录本次最早阻断或失败所属层。凭据、API key、完整鉴权 Header 不得进入记录。

仓库现有 `pnpm acceptance start|finish` 目前只认识 A01–A09，**不要**用它生成 WTxx 的伪记录。首批先由 fixture/操作人按上述合同保存 `AcceptanceCaseResult`；只有出现重复机械工作时，才另行讨论是否扩展 recorder，届时也不能顺带引入通用 runner。

## 当前可验证与尚未验证

当前静态验证命令：

```bash
pnpm build
node --test examples/cli/dist/work-task-eval-cases.test.js
```

它证明 6 个案例顺序和类别冻结、hard failure 均绑定必需检查、初始 checks 可组成 `AcceptanceCaseResult` 且不会虚构已执行工作。它不证明 fixture 存在、模型质量、网络行为、前端交互或任一案例通过。真实尝试完成前，WT01–WT06 均保持 `not_run`。
