# 上下文与记忆：第 6 步（进行中）

## 1. 改了什么

首个产品提交 `866ba7e`：`cm-step5-verify.mjs` 的 Linux Xvfb 参数补为 `-a -s "-screen 0 1440x900x24"`；`context-assembler.ts`、`memory-observation-policy.ts` 按既定 Asia/Shanghai / +08:00 / 分钟写入和组装时间。`telegram-gateway.test.ts` 未改。

## 2. 逐条对照验收项

| 项目 | 结果 |
|---|---|
| UTC 复现与产品修复 | 先红：`Telegram receive clock…` 在 gateway 测试 105 行缺少原始 +08:00 时间；`createReferenceAssembler` 使用宿主 UTC 重格式化造成。修后原测试在 `TZ=UTC` 下通过 |
| Linux Xvfb | 已补启动参数；本次实测 macOS，未声称本机执行 Linux |
| 全套 / 真实 Electron | 1806 通过、0 失败、11 跳过；8/8，干净源码；原始终端日志及 `evidence/electron-smoke/result.json`；本步最终 runner 会重新验证首个修复 |
| 第 6 步主体 / 合批真实模型 / 14 行表 | 仍待本步后续实现和验证；尚未执行付费请求 |

## 3. 前后数字

首个产品提交相对 `a183ddf`：产品 +2/−2、测试 +0/−0、验证脚本 +1/−1。smoke 脚本 SHA-256 保持 `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f`。

## 4. 实际命令和退出码

`TZ=UTC pnpm --filter @serika/desktop exec tsx --test --test-name-pattern='Telegram receive clock' src/main/telegram-gateway.test.ts`：修前 1、修后 0；`TZ=UTC pnpm typecheck`：0；`TZ=UTC pnpm test`：0；`TZ=UTC pnpm --filter @serika/desktop smoke`：0。实测 macOS、真实构建 Electron、假模型；非真实模型验收。

## 5. 与计划不符的地方及理由

没有扩范围。查过 legacy 108（TG 不继承对话内记住审批）、193（TG 信任绑定及权限）；仅修时间，不改这些授权。使用现有实验工作树，主目录 dirty main 未动；应用拒绝附加已归属另一聊天的工作树，终端在其绝对路径执行。后续仍须完成本步并停在第 7 步前。

证据更正：删除 `first-fixes.json`。它曾在真实命令结束后包装结果并补编号，不符合运行时生成证据的规则，不能作为验证凭据。后续结论以 `cm-step6-verify.mjs` 当场执行并生成的记录为准。

第 6 步主体按职责拆为 `context-blocks`（比例边界与分层）、`context-source`（共用原文前缀）、`thread-background`（单队列优先级）、`transcript-access`（排除投影）和 `history-tools`（按需原文读取）。新增超过 400 行，沿用本步批准；旧同步压缩及其即时重试实现已删除。

断言变更依据（第 6 步替换旧行为）：

| 用例／组 | 旧断言 → 新断言与理由 |
|---|---|
| `context-compactor.test.ts` 同步 prepare／force／重试／多块合并组 | 同步等待并多次调用 → prepare 零调用、每队列项一次、无效输出不推进；旧同步路径已删除，保留回执纯函数、未知副作用、重启、来源与预算断言 |
| `context-compaction-runtime` / `context-compaction-acceptance` | 同轮先摘要后主请求 → 主请求先屏蔽、后台完成后新轮复用；每日／长任务原始规模不变，32K 另测 |
| `model-context-budget` / `foreground-autonomy` | 单条过大直接失败／等待摘要 → 截断占位、原文不变、原请求继续保留；固定材料超限仍失败 |
| `memory-m1-acceptance` | 跳过过大旧来源再推进新来源 → 按 Unicode 连续分片、最后一片才推进；旧 pending 重抽不能覆盖新值 |
| `model-usage` | 人工强制同步 compact → 实际 prepare / runPending；短聊天零抽取和用量账本断言保留 |
| `baseline-assembly` | 固定工具集合 → 单独断言新增 `history_read/search` 后，与旧固定集合比较；未改历史快照 |
| `examples/eval/*` 块形状检查 | 旧多块合并器 → 产品同一完整工具边界；冻结 fixture、truth、旧 Oracle 的正负断言不变；新分层路径另记 |

未删除测试文件；旧同步实现对应用例被合并成新生命周期用例，不以历史测试数量充当本步质量指标。首个包装证据已撤回，最终结果待运行时 runner 生成。
