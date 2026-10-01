# 原生 Memory A+B：验收入口与边界

本轮实现原生待审候选与确定性词法检索。不依赖向量库或外部记忆服务。离线通过、真实模型后端通过、Electron 界面通过是三层不同证据；本仓未修改桌面前端，不宣称 UI 封板。

## 离线验证

```sh
pnpm typecheck
pnpm test
git diff --check
```

固定词法 Eval 在 `examples/cli/src/memory-retrieval.test.ts`：28 例，直接匹配、中英文问句、scope、禁用/过期、pin、旧 history、预算均给预期/禁止 ID。强同义改写两例记录实际 0/2 命中，代表首版词法边界，不是语义能力通过。另测真实最终 JSON 字节、Unicode 查询边界、大项跳过、空选材和最多 12 条。

消费路径测试检查：普通/压缩使用同一份引用；摘要生成期间更新只影响下次 preparation；重启当前 revision；worker task.prompt 单次读取且无 Thread 私有项；checkpoint pinned-only；候选和历史从不注入。

## 真实模型后端一条命令

在仓库根目录、已配置本地 `.env` 的环境运行：

```sh
pnpm build
RUNLOOM_MEMORY_ACCEPTANCE=1 RUNLOOM_MODEL=deepseek \
  node --env-file=.env examples/cli/dist/memory-native-acceptance.js
```

也可使用已配置的 `RUNLOOM_MODEL=minimax-m3`。无显式 opt-in 时入口拒绝，普通 `pnpm test` 不联网。命令返回隔离 root 和 passed；不要把 root 放进自己的日用 workspace，也不要删除它再声称有证据。

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

## 桌面接线待验项（未跑）

前端另一个 agent 负责。需用户真正预览原话/改动并点击 accept/reject、处理 stale/revision 冲突、刷新后重读候选；不能将 consolidation completed 显示为已保存正式记忆。普通审批仍用 approvalId；candidateId 不是 approvalId。通知/launchd/TUI 体验不属于本入口封板。
