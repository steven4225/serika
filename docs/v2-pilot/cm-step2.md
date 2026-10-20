# 上下文与记忆：第 2 步离线重放（2026-10-21）

## 1. 改了什么（文件和原因）

`five-layer-context.ts` 提供纯组装及连续前缀比较；`scripts/cm-replay.mjs` 只读主对话、验证旧压缩记录、按快照周期重放。Karpathy 指南用于限定为离线测量：生产组装路径保持原样。前置日志/计时修正单独提交 `1fcb265`，全量发现的计时收尾回归另修于 `842c692`。

## 2. 逐条对照验收项

| 验收项 | 状态与证据 |
|---|---|
| 主对话原文离线、不调用模型 | 已做：读取 1,140 条；230 条普通用户消息中重放有时间的 211 条，19 条无法还原时序；Node 权限禁止网络、写入和子进程 |
| 五层顺序、各段 hash 稳定性 | 已做：`five layers preserve…`、`snapshot replacement breaks…`；190 个同周期相邻请求，②/③变化和④追加断裂均 **0** |
| 理论缓存命中率 | 已做：可复原②–⑤的完整消息前缀可复用比例 **94.79%**（无驱逐假设）；①历史内容和任务引用缺失，不报全请求命中率 |
| 32K / 日用窗口 | 已测：可复原部分分别 **35/211、211/211** 未超输入预算；32K **176** 次超限，完整小窗口验收未通过，详见附表 |
| 当前缓存保留时长、基线间隔占比 | 已查：当前 Command Code 路由 TTL **未知**，对应占比也未知；2h / 4h 假设下间隔占比 **94.12% / 98.04%**，不是实测 TTL |

## 3. 前后数字

相对 `842c692`：产品/工具 **+174/−0**（TS 31、离线脚本 143），测试 **+24/−0**。主对话 hash、记忆文件字节重放前后相同；真实模型调用 **0**。旧账本聊天缓存率 **8.39%** 是实测历史，**94.79%** 是有限复原的理论值，两者不构成 A/B 改善结论；历史首正文延迟仍未知。

## 4. 实际命令和退出码

`pnpm typecheck`、定向测试（2/2）、只读重放、`git diff --check` 均 **0**。首次 `pnpm test` **1**（桌面两处失败）；修复计时收尾后最终重跑 **0**：**2,426 通过、0 失败、13 跳过**。未跑 live eval、未重启日用进程。

## 5. 与计划不符的地方及理由

五层排序已离线测量，完整历史请求无法复原：①定义、任务/检查点/WorkTask 引用未存档，19 条消息缺时间。②使用可追溯的工作区记忆投影，③沿用已验证旧摘要；分层摘要和块屏蔽按第 5/6 步实现。32K 超限与旧近期原文过长已暴露，未截掉摘要或滑动裁剪来制造通过。第 3 步保持未开始。

全量发现的前置计时回归按 diagnosing-bugs 指南先复现、补 Controller 断言再修；旧 TG 权限断言未改，细节归入第 1 步报告。ego-browser 用于核对缓存资料，没有改变产品配置。

<details>
<summary>附表 A：数据、哈希及复用算法</summary>

采样时间：2026-10-21 00:40:24 +08:00。从身份文件注册的 Thread 中，按已提交逻辑消息数选主对话。读取使用 `JsonlAgentStore.getMessages/getContextCompactions`，不创建 Runtime、Run、模型客户端或写锁；Node permission 仅开放文件读取，连子进程也禁止。原话只在进程内使用，输出只有数字和指纹。

- 原文快照 hash：`jcs-sha256:v1:ea3b1576529bd91c402b414644269f0eebc25c6b7661bea8e03912cfeea7c124`。
- 记忆原文件 SHA-256：`17ba4edba47851d46c3a7a503719bb2e5cd9550938aeb019a0d7f31bb156607d`；重放前后字节一致。
- 48 条旧压缩记录中，16 条满足现行前缀 hash、首保留消息、辅助轮排除及摘要校验；其余 32 条未强行复用。规则对应 `context-compactor.ts:111` 的读取检查；重放另外要求压缩创建时间早于当前消息，避免用未来摘要。
- 211 个有时间的普通消息形成 16 个快照周期；19 个缺时间的消息不进入请求时序统计，也不跨缺时间的位置计算间隔。普通用户的旧“不沉淀”标记仍只管沉淀，没有当成全面排除；辅助整理/方法/Skill 轮从主聊天输入中剔除。
- 每轮只重放收到用户消息后的首个请求；没有从最终助手消息虚构同一 Run 的中间 provider 请求。原文中的工具调用及结果保留并经 SDK `convertToModelMessages` 转换。
- ②在初始时刻或已验证的压缩边界读取一次旧记忆的历史断言/管理版本，此周期内冻结。仅按 C07 投影工作区偏好及事实/笔记；4 条 Thread 记忆留待第 7 步逐条裁决，未迁移任何文件。当前正式文档库和方法索引数量均 0；存在这类索引时脚本标为 current-only，不假造历史版本。
- ⑤只补有证据的接收时间（+08:00，到分钟）及已有渠道字段；缺渠道标 unknown。补注仅存在重放内存，下一轮仍复用完全相同的原消息+补注。缺失的任务、检查点及 WorkTask 不用空白 fixture 冒充真实引用。

| 层 | 不同整层 hash 数 | 同周期稳定性 |
|---|---:|---|
| ① 系统/工具 | 未知；空槽不作真实 hash 证据 | 顺序/原样保留由 fixture 测试覆盖 |
| ② 固定参考 | 2 | 190 对中 0 次变化；刷新只发生在周期边界 |
| ③ 已验证旧摘要 | 16（含初始无摘要） | 190 对中 0 次变化 |
| ④ 近期原文 | 211 | 整层随追加而变；190 对中前请求连续前缀断裂 0 次 |
| ⑤ 当前消息及可复原附注 | 211 | 位于末尾；进入后续历史时保持原字节 |

比较单位是有序 SDK 消息的 `jcs-sha256:v1` hash。只累加从开头起连续相同的完整消息，首次不同即停；不把后面同 hash 的片段拼成命中。分母为所有重放请求②–⑤的 `char-half/v1` 估算总和 **24,797,583**，可复用前缀合计 **23,505,909**，比值 **94.7911%**。首个请求/缺时间后请求为冷请求；跨压缩边界照常比较而非强制算热。

这个比例描述请求布局的复用潜力，不含未知①、真实 tokenizer、传输模板、provider 缓存单元持久化/驱逐/路由。DeepSeek 当前文档要求完整命中已持久化的前缀单元，建设还需要时间；公共前缀相同本身不构成读取成功证据。第 3 步仍须用 provider 的 cacheRead/input 实测。

</details>

<details>
<summary>附表 B：窗口与缓存保留时长</summary>

本次按既有压缩边界完整保留旧摘要/原文，没有提前实现第 5/6 步。容量只算可复原②–⑤，真实请求还要加①和缺失的动态引用。

| 输入预算 | 未超 / 超限请求 | 近期原文比例目标 | 超过该原文目标 | 有效容量内相邻前缀复用比例 |
|---|---:|---:|---:|---:|
| 32,768 窗口对应 26,624 | 35 / 176 | 4,992 | 190 | 67.07%（仅 35 个未超限请求，前请求超限则不算已缓存） |
| 日用 256,000 | 211 / 0 | 48,000 | 139 | 94.79% |

最大可复原输入 **244,671**，旧摘要单独最大 **33,493** 估算 tokens，已经超过 32K 档有效输入。旧边界不能直接当作新的按比例块屏蔽。这里是容量风险证据，不是新摘要/块屏蔽的通过结果。

当前路线证据（本机只读核对）：resident 身份中的模型别名为 `command-code`；对应环境 endpoint 为 `https://api.commandcode.ai/provider/v1`，模型为 `deepseek/deepseek-v4.1-flash-fast`。主对话保留的调用账本也全部报告该模型及 `openai-compatible.chat`。未读取或输出凭据值。

[Command Code 模型页](https://commandcode.ai/models/deepseek-v4-1-flash-fast)及 [Provider API 文档](https://commandcode.ai/docs/provider)没有给出这个路由的缓存 TTL；其上游路由也不等于直连 DeepSeek。[DeepSeek 官方缓存说明](https://api-docs.deepseek.com/guides/kv_cache/#additional-notes)只给出闲置后通常数小时至数天清理的 best-effort 范围，不是固定 TTL，也不能转写为 Command Code 的保证。因此“当前模型保留多久”及“基线小于该时长的占比”当前均只能记 **未知**。

基线 230 条普通用户消息共 229 对，相邻且时间有效 **204** 对；缺时间 **25**、逆序 **0**。以下是敏感性分析，不选其中一行冒充实际 TTL。每行“理论比例”把间隔达到假设 TTL 的整次前缀复用计为 0，分母仍含全部 211 次可复原输入。

| 假设闲置 TTL | 基线间隔严格小于 TTL | 占 204 对 | 对应②–⑤理论复用比例 |
|---|---:|---:|---:|
| 1 小时 | 183 | 89.71% | 86.94% |
| 2 小时 | 192 | 94.12% | 88.75% |
| 4 小时 | 200 | 98.04% | 92.62% |
| 24 小时 | 204 | 100% | 94.79% |
| 72 小时 | 204 | 100% | 94.79% |

用户消息间隔不等于实际 provider 闲置间隔：中间工具步/后台请求可能触碰缓存；本表仅回答基线消息间隔问题，未据此推断真实驱逐。

</details>

<details>
<summary>附表 C：命令、测试和范围</summary>

工作目录：`/Users/a1-6/.codex/worktrees/cm-step0/aisdk-agent-framework`。本步新增测试：

1. `five layers preserve tools, exact message order and appended current references without mutating inputs`。
2. `snapshot replacement breaks at layer two even when later summary/history hashes match`。

没有修改旧测试断言、删除测试或新增快照；新测试 24 行小于新增产品代码 31 行（另有脚本 143 行）。所有测试为 macOS / Node v26.4.0 的隔离证据，没有原生 Electron、常驻进程或真实模型验收。

```sh
# 退出 0
pnpm typecheck
node --test packages/assistant/dist/five-layer-context.test.js
node --permission --allow-fs-read='*' packages/assistant/scripts/cm-replay.mjs \
  '/Users/a1-6/Library/Application Support/@aisdk-agent/desktop/desktop-identity.json' \
  '/Users/a1-6/Library/Application Support/@aisdk-agent/desktop/runloom.json'
git diff --check

# 首次退出 1：运行时 1756 通过 / 13 跳过；桌面 656 通过 / 2 失败，脚本未执行
pnpm test > /tmp/serika-cm-step2-test.log 2>&1

# 842c692 修复后，最终退出 0
pnpm test > /tmp/serika-cm-step2-final-test.log 2>&1
```

最终运行时：1,769 个测试，1,756 通过、0 失败、13 跳过；桌面 658/658、scripts 12/12，共 2,439 个测试。首次失败为 `package2: desktop phone buttons…` 的清理目录 ENOTEMPTY（定向复测未再出现），以及 `independent TG authorization runs chat…` 第 1220 行任务提议未出现（定向复现，由本次计时等待造成；独立修正及回归测试见 `842c692`）。旧断言未改。失败记录保留，不把首次全量报为通过。

最终离线重放于 00:43:15 +08:00 再跑一次，除 capturedAt 外与 00:40:24 的输出逐项一致。重放及类型检查不调用真实模型；公共资料核对不进入模型 endpoint。初始一次本地探查从仓库根导入 `ai` 失败（退出 1），改从 assistant 包运行后退出 0，正式脚本按包路径解析，无数据写入。

</details>
