# 原生 Memory A+B：验收入口与边界

本轮实现原生待审候选与确定性词法检索。不依赖向量库或外部记忆服务。离线通过、真实模型后端通过、Electron 界面通过是三层不同证据；本仓未修改桌面前端，不宣称 UI 封板。

## 离线验证

```sh
pnpm typecheck
pnpm test
git diff --check
```

固定词法 Eval 在 `packages/assistant/src/memory-retrieval.test.ts`：28 例，直接匹配、中英文问句、scope、禁用/过期、pin、旧 history、预算均给预期/禁止 ID。强同义改写两例记录实际 0/2 命中，代表首版词法边界，不是语义能力通过。另测真实最终 JSON 字节、Unicode 查询边界、大项跳过、空选材和最多 12 条。

消费路径测试检查：普通/压缩使用同一份引用；摘要生成期间更新只影响下次 preparation；重启当前 revision；worker task.prompt 单次读取且无 Thread 私有项；checkpoint pinned-only；候选和历史从不注入。

## 真实模型后端一条命令

在仓库根目录、已配置本地 `.env` 的环境运行：

```sh
pnpm build
RUNLOOM_MEMORY_ACCEPTANCE=1 RUNLOOM_MODEL=deepseek \
  node --env-file=.env packages/assistant/dist/memory-native-acceptance.js
```

也可使用已配置的 `RUNLOOM_MODEL=minimax-m3` 或 `RUNLOOM_MODEL=command-code`（后者使用 `COMMAND_CODE_API_KEY`）。无显式 opt-in 时入口拒绝，普通 `pnpm test` 不联网。命令返回隔离 root 和 passed；不要把 root 放进自己的日用 workspace，也不要删除它再声称有证据。

验收创建临时 workspace、配置和两个 Thread，记录 `report.json`、`provider-inputs.json`、聊天与 worker JSONL、execution receipts、`memory.json` 和 `tasks.json`。只使用内置无敏感信息文本，不复制 API key/header。provider inputs 含测试对话，公开前仍需检查。

实际链路：

1. 真模型普通用户声明两条偏好 → 自动 prepare/stage → pending；正式 entries 仍空。
2. 同 Thread 重新创建 Controller → 拒绝一条、接受一条 → 相同原请求重放不重复写。
3. 新 Thread 查询 → 直接检查实际 provider 输入里的 id/revision，而非只相信回答自报。
4. 真模型调用 memory_update，经本次隔离测试明示授权接受该工具 → revision 2；旧对话仍保留。
5. 实际普通对话 → 真模型 `/compact` → 重开同 Thread → 当前 revision 2 注入且回答使用三步，不用历史两步。
6. 显式程序禁用测试条目 → 参考为空且真实回答 NO_MATCH。禁用不是自动清理；历史仍保留，不宣称旧信息物理删除。
7. 合法存储超过 8 KiB → 真 worker 领取/执行并 completed，固定 reference <=8 KiB、只用 task.prompt、无 Thread 私有项、引用实际所选 ID。completed 只证明 Run 正常结束，不是通知已送达。

Controller review 是明确测试操作，不是模型自动保存。脚本只自动确认隔离样例明确请求的 memory_update，拒绝其它主工具；它验证后端授权链，不替代用户点击 y/n 或 Electron 按钮的 UI 测试。

每次失败保留原目录和原报告，不在同一份证据上覆盖“通过”。尤其模型错传参数、sourceQuote 错误、网络失败、摘要坏 JSON、旧偏好复活必须判失败，不放宽存储/来源协议去追求通过。来源精确匹配仅证明原话存在，不证明概括正确。

## 本次后端实测记录（2026-10-01）

DeepSeek 后端 Controller + worker 完整链通过，隔离证据目录为 `/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-memory-native-live-3DTFRy`。`report.json` 与 `provider-inputs.json` 保留实际 Run、候选、记忆 ID/revision；压缩后重开仍回答三条步骤，禁用后回答 `NO_MATCH`；worker 固定参考 7344 字节并完成。此记录不代表 UI 或通知送达通过，也不代表多次重复运行成功率。

失败尝试同样保留：`n0F5se` 最初脚本误判通过，人工核对发现旧 ID 复活并补 `audit.md`；`idSU5O` 因模型混用 incremental 与 turns 失败；`dst3e2` 更新未执行；`o7jiQb` 压缩失败。后续收紧空选材说明、明确工具参数互斥，并让更新测试先提交新版原话，再下一轮确认；未放宽来源或摘要校验。

通过轮的更新回执为 revision 2，但模型最终解释误称并非从 revision 1 更新；这是回答准确性瑕疵，不应当作程序版本事实。验收时以实际工具回执与存储为准。

## 后端复验（2026-10-03，Command Code）

使用默认 `deepseek/deepseek-v4.1-flash`，同一入口完整通过。证据目录：`/var/folders/z8/lnxfbycd69n_nh_fwzg1gtmw0000gn/T/runloom-memory-native-live-uXjlHH`。待审时正式 entries 为空；重开接受/拒绝和接受重放、跨 Thread revision 1、新版 revision 2、真实 `/compact` 后重开引用当前版本、禁用后 `NO_MATCH`、worker 7344 字节参考及 Thread 私有项排除均通过。接受得到的记忆 ID 是 `a12a7bc5-73d5-419f-b15a-eb04edcc169e`；最后的测试禁用操作将它推进到 revision 3，历史仍可查，不代表物理删除。

最初 `REe8Li` 目录保留失败：primary 输出耗尽 1024 token，Run 为 failed，未写正式记忆。定位后发现 Command Code 的 DeepSeek 路由没有用 `thinking: disabled` 关闭思考，需额外发送 `reasoning_effort: off`；修复网关参数后按原预算复跑，没有增加输出额度、改来源契约或放宽摘要校验。此处只记录一次完整后端通过，不宣称重复运行成功率或 Electron 人工审核已由本脚本证明。

随后补上摘要预算提示与 `finishReason: length` 拒绝安装后，在全新隔离目录 `runloom-memory-native-live-WHnptq`（同一临时目录父路径）再次完整通过，未改验收预算。正式记忆 ID `e958b5a8-c3e4-4ef7-9d1f-efd993aefa44`；原话取材、待审无正式写入、重开接受/拒绝与重放、跨 Thread revision 1、更新 revision 2、压缩后恢复当前版本、禁用后 `NO_MATCH`、workspace-only worker 7344 字节快照均通过。`report.json` 仍将 `uiAcceptance` 与 `notificationDelivery` 标为 `not_run`；两次独立后端通过不能据此宣称总体成功率。

## 桌面接线待验项（本入口未跑）

前端另一个 agent 负责。需用户真正预览原话/改动并点击 accept/reject、处理 stale/revision 冲突、刷新后重读候选；不能将 consolidation completed 显示为已保存正式记忆。普通审批仍用 approvalId；candidateId 不是 approvalId。通知/launchd/TUI 体验不属于本入口封板。
