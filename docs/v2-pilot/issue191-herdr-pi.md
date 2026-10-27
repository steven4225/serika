# #191 Herdr/Pi 适配修复记录

## 1. 改了什么

以 `origin/main@07aebb4` 新建隔离 worktree 和 `codex/issue191-herdr-prompt`。原工作区 15 项无关修改及未跟踪方案未带入。日用现场仍为 release-3，本轮未部署。

- `packages/assistant/src/herdr.ts:138`：按已装 Herdr 0.8.2 的实际解析契约，将正文作为一个完整位置参数传入 `execFile`。
- `packages/assistant/src/herdr.test.ts`：假 CLI 校验 session、命令、target 和参数数量，拒绝旧格式；原有正常用例加入中文、换行、引号正文。
- 本报告、`evidence/issue191/`、费用台账：保留成功、失败、授权后只读恢复及清理证据。身份校验、逐次审批、unknown 停止策略均未改。

正确 argv 为 `["--session", session, "agent", "prompt", target, text]`。探针确认 TEXT 是固定位置参数，开头的 `-`、`--help` 也作为正文；没有 Shell、补空格或文本改写。

## 2. 逐条对照验收项

| 关口／项目 | 结果与证据 |
| --- | --- |
| 1. 真实 CLI 契约 | 已做。六种正文含普通、中文换行／引号、前导 `-`、精确 `--help`、类选项、Shell 字面量。旧 argv 退出 2；候选退出 1 `server_not_running`，证明解析接受。见 [cli-contract.json](evidence/issue191/cli-contract.json)。无效隔离目标未调用模型。 |
| 2. 最小修复与定向测试 | 已做。修复前回归用例失败；修复后 typecheck 退出 0，herdr.test／herdr-control.test 共 6/6。见 [targeted-guards.json](evidence/issue191/targeted-guards.json)。 |
| 3a. 构建后 HerdrClient → 交互 Pi | 已做。新建隔离 HOME／session／Pi 1.4.0，正文以 `- ` 开始，含中文、换行及引号。Pi transcript 中原文相等、回复新标记、HerdrClient 回读该标记，prompt 恰好一次。 |
| 3b. Serika 工具与一次审批 | 已做。真实 Controller／AgentLoop、Herdr 与 Pi，Serika 使用脚本模型。正文以 `--help` 开始。一个有效审批、一次 control、一次 read，Run completed，Pi 原文相等、回复与 Serika 回读标记相同。见 [live.json](evidence/issue191/live.json)。 |
| 3. unknown／目标约束 | 已做。原有 unknown／取消／身份替换测试保留。本轮没有 TOOL_OUTCOME_UNKNOWN，没有重发或另启 Run；每案一次 prompt。隔离绑定已解除，空闲隔离 session 已停止删除。 |
| 4. 相关与全套测试 | 已做。隔离 HOME：1862 通过、7 跳过、0 失败，退出 0。见 [verification.json](evidence/issue191/verification.json)。 |
| 4. desktop smoke | **未通过，交付关口阻塞。** 真实 macOS Electron 44.4.5、原 preload／IPC、干净源码。startup、chat-reply、remember-success-receipt 通过后，`electron-smoke.mjs:113` 断言 `saved.version === 6`，实际 Memory 写 7，退出 1。见 [原始结果](evidence/issue191/electron-smoke/result.json)。未改 Memory 或冒烟断言，未继续其他验收。 |
| 人工入口／真实 Serika 模型 | 没做，本批仅授权 Serika 脚本模型宿主闭环。没有原生审批点击或真实 Serika 模型行为验收结论。 |

实机标记分别为 `S191_ADAPTER_d0f957417a114f1797a20d069741c8c1` 和 `S191_HOST_d0f957417a114f1797a20d069741c8c1`。`dispatched:true / verified:false` 只作发送回执，完成依据是 transcript 新回复和明确工具回读。实机模型窗口为 32,768，未测日用大窗口或常驻进程。

## 3. 前后数字

- 产品代码 `+1/-1`，测试代码 `+4/-2`。测试超过产品行数，因为 fixture 必须先识别真实参数契约，再断言完整正文，避免旧假 CLI 对错误参数也成功。
- 被修正的测试名：`Herdr fixed actions verify the selected Pi identity, strip credentials and use only explicit argv`。旧断言期待 `TARGET -- TEXT`，真实 CLI 拒绝该格式；新断言期待一个原样 TEXT 位置参数。没有删测试或改 unknown 断言。
- 真实 Pi 请求 2 次、Pi 工具调用 0 次，317 input／173 output tokens；按公开峰时单价估算 $0.00030212，账单未核验，独立授权上限 $0.20。Serika 脚本模型调用 3 次，真实 Serika 模型调用 0 次。台账记录估算依据及证据 SHA。

## 4. 实际命令和退出码

所有源码命令均在 `/private/tmp/serika-issue191-worktree`；定向和最终测试的 `SERIKA_TEST_HOME` 每轮独立。

| 命令 | 退出码／结果 |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | 0，未改锁文件 |
| `pnpm typecheck` | 0 |
| 构建后 `node --test --test-name-pattern='Herdr fixed actions' packages/assistant/dist/herdr.test.js` | 修复前 1，预期复现 |
| `SERIKA_B2_RECORD_CONCURRENT_HOME=1 SERIKA_TEST_HOME=<temp> node scripts/test-home.mjs --home <temp> -- node --test packages/assistant/dist/herdr.test.js packages/assistant/dist/herdr-control.test.js` | 修复后 0，6/6 |
| 构建后 `/private/tmp/issue191-live.mjs` 分阶段执行 | 初次适配断言 1；授权后只读核对 0；宿主取证修复后从持久化 Run 恢复 0，未重发 |
| `SERIKA_B2_RECORD_CONCURRENT_HOME=1 SERIKA_TEST_HOME=<temp> pnpm test` | 0，runtime 1194＋desktop 656＋scripts 12 通过，7 跳过 |
| `SERIKA_B2_RECORD_CONCURRENT_HOME=1 SERIKA_TEST_HOME=<temp> pnpm --filter @serika/desktop smoke` | 第一次缺 Electron 二进制后停止本轮下载；使用已有同版依赖后重跑 1，版本断言失败 |

全套日志与冒烟日志保存在 `/private/tmp/s191-verification-ztm46fkk`，提交摘要包含日志 SHA、原始 guard SHA、退出码和分组计数。guard 自测中的预期失败与外层结果分开统计。

## 5. 与计划不符的地方及理由

- 适配层初次验收误要求 `stateChangeSeq` 增大。实际快速回复时序号保持 1，正文与新回复已到达。按失败即停暂停，用户授权修取证并只读核对后恢复；保留原失败，没有重发。
- 宿主脚本先遇到依赖解析错误，发生在创建 Run 前；随后将同一审批的无 preview／有 preview 两次通知误计为两个审批。前者修路径，后者通过持久化 Run 和 Pi transcript 核对，仅一个有效批准和一次 prompt，没有另启 Run。
- 首次定向绿测被日用 worker 的并行文件变化打断，自身写入违规为 0。之后使用仓库已有 `SERIKA_B2_RECORD_CONCURRENT_HOME=1` 模式，仍拦截本测试写日用目录，仅记录其他进程变化；全套及 smoke 的自身违规均为 0。未停止日用服务。
- Electron 首次缺二进制，只终止本轮下载进程，复用本地已装的同版 44.4.5。第二次冒烟在 Memory v7／脚本 v6 契约处失败。两处源码均不在本 PR diff；未另跑 main 基线冒烟，不能声称已独立复现基线失败。原始脚本仍有 `source: v6-record` 文案，归档原样保留。
- 冒烟失败后暂停实施。该 PR 供审核修复和证据，**第四关未通过，不应合并或部署**。Memory／S2 冲突需另行决策。历史默认冒烟证据已恢复，本轮失败归档到 issue191 独立目录。
- 用户明确允许从当前 Codex 外部控制本轮隔离 session，并指定日用 Serika env 作为凭据来源，覆盖技能／测试凭据默认限制。未伪造 HERDR_ENV，凭据未进入证据；日用目标、数据、进程未操作。
