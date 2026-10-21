# 上下文与记忆：第 6 步（进行中）

## 1. 改了什么

首个产品提交 `866ba7e`：`cm-step5-verify.mjs` 的 Linux Xvfb 参数补为 `-a -s "-screen 0 1440x900x24"`；`context-assembler.ts`、`memory-observation-policy.ts` 按既定 Asia/Shanghai / +08:00 / 分钟写入和组装时间。`telegram-gateway.test.ts` 未改。

## 2. 逐条对照验收项

| 项目 | 结果 |
|---|---|
| UTC 复现与产品修复 | 先红：`Telegram receive clock…` 在 gateway 测试 105 行缺少原始 +08:00 时间；`createReferenceAssembler` 使用宿主 UTC 重格式化造成。修后原测试在 `TZ=UTC` 下通过 |
| Linux Xvfb | 已补启动参数；本次实测 macOS，未声称本机执行 Linux |
| 全套 / 真实 Electron | 1806 通过、0 失败、11 跳过；8/8，干净源码；证据 `evidence/cm-step6/first-fixes.json` 和 `evidence/electron-smoke/result.json` |
| 第 6 步主体 / 合批真实模型 / 14 行表 | 仍待本步后续实现和验证；尚未执行付费请求 |

## 3. 前后数字

首个产品提交相对 `a183ddf`：产品 +2/−2、测试 +0/−0、验证脚本 +1/−1。smoke 脚本 SHA-256 保持 `9a1d20f8297237fe313858188e4dce6744d9428f0e4e14b03f21d58b767b143f`。

## 4. 实际命令和退出码

`TZ=UTC pnpm --filter @serika/desktop exec tsx --test --test-name-pattern='Telegram receive clock' src/main/telegram-gateway.test.ts`：修前 1、修后 0；`TZ=UTC pnpm typecheck`：0；`TZ=UTC pnpm test`：0；`TZ=UTC pnpm --filter @serika/desktop smoke`：0。实测 macOS、真实构建 Electron、假模型；非真实模型验收。

## 5. 与计划不符的地方及理由

没有扩范围。查过 legacy 108（TG 不继承对话内记住审批）、193（TG 信任绑定及权限）；仅修时间，不改这些授权。使用现有实验工作树，主目录 dirty main 未动；应用拒绝附加已归属另一聊天的工作树，终端在其绝对路径执行。后续仍须完成本步并停在第 7 步前。
