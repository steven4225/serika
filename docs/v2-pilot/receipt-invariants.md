# v2 试点：回执与 verifier 不变量（基线 `9fa8678`）

回执格式和 verifier 判定在本轮完全不动（`docs/architecture-v2.md` §4.4 底线）。本文把五条不变量对应到现有测试；现有测试只间接覆盖的，用 `packages/assistant/src/baseline-verifier.test.ts` 按当前行为补锁定测试（只描述现状，不是规格变更）。判定入口是 `work-task-verification.ts` 的 `verifyAutomaticCriterion`，证据来自 `execution-records.json`。

| 不变量 | 现在的规则（代码位置） | 现有测试 | 新增锁定测试 |
|---|---|---|---|
| I1 路径一致 | 只认 `fileInput.path`、`fileWrite.path` 都等于验收路径的写入回执（`execution-record-store.ts` `matchesFileWritePath`、`readFileWriteReceipt`） | `execution-record-store.test.ts`「does not create file success evidence for denial, unknown, wrong digest/path…」 | I1：别的路径、回执路径与输入路径不一致 → `failed` |
| I2 内容 hash 对应 | 当前磁盘字节的 SHA-256 和长度必须等于回执；`write_file` 的输入 hash 必须等于结果 hash | `execution-record-store.test.ts`（wrong digest）；`work-task-completion.test.ts`「explicit readback criteria reject missing, pre-write, stale…」 | I2：磁盘内容被改、文件不存在、输入 hash 与结果 hash 不一致 → `failed` |
| I3 回读在写入之后 | `requireReadback` 时，最新写入之后必须有一次成功、hash 相同的 `read_file`（`hasMatchingFileReadback`） | `work-task-completion.test.ts`（missing、pre-write、stale、denied） | I3：先读后写、没有回读、回读内容过期、回读失败 → `failed`；写后成功回读 → `passed` |
| I4 后来的失败让旧成功失效 | 文件：取同一路径「最后一次」写入意图（包括失败的写入），失败即无回执。Shell：通过的测试之后，任何已派发的写文件/Shell/电脑操作（包括失败的 Shell）都让它失效；被拒绝、未开始的调用不算（`work-task-shell-evidence.ts` `invalidatesTaskTest`） | `work-task-shell-evidence.test.ts`「invalidates old test receipts after dispatched Shell, file or computer effects, even failed Shell」 | I4：后来失败的写入、后来失败的 Shell、后来的写入 → `failed`；后来被拒绝的 Shell → 仍为 `passed` |
| I5 Shell 退出码证据 | 命令和 cwd 逐字匹配（或批量测试命令），`exitCode === 0`，结果未截断，没有超时或取消 | `work-task-shell-evidence.test.ts`「checks real Shell mutations…」「runs a fail-fast multi-test batch…」；`work-task-completion.test.ts` 第 21 行 | I5：退出码非 0、超时、取消、结果截断、命令多了一段 → `failed` |
| 附：未知结果不当成失败 | 最新 Run 里有 `unknown` 工具或 Run 被中断 → `blocked`（需要人工核对），不是 `failed` 也不是 `passed` | `receipt-durability.test.ts`；`execution-record-store.test.ts`「preserves explicit unknown outcomes…」「marks interrupted Run…」 | 未知工具结果、中断的 Run → `blocked` |

verifier 读取 `shell_exec`/`write_file` 证据的部分保持不动（A2 已确认）。后面各步改动后，这个文件里列出的所有测试都必须原样通过。
