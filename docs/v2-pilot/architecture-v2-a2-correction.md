# a2 审核补正

## 1. 改了什么

worker 参数解析要求显式 `--home`，类型改为必填；共享 home 解析器的 CLI/桌面规则保持。核对桌面 `index.ts`、resident `resident-entry.ts` 经 `rss-worker-service.ts` → `task-worker-service.ts` 启动 worker，argv 均包含 `--home H`。计划按用户新节奏更新，后续产品尚未实施。

## 2. 逐条对照验收项

- 已做：`task-worker-entry.test.ts` 的 `requires explicit --home before accessing default or environment storage` 启动真实 Node 子进程，分别无环境 home/有环境 home，均退出 1，未建默认或环境数据目录。原成功参数测试改为显式 home，符合本轮批准的行为变更。
- 已做：下表仅通过 `readdir/lstat` 采集名称、大小、修改时间，未读内容、未删除、未计算文件内容 hash。证据见 `evidence/architecture-v2-a2-correction/default-data-metadata.json`。切日用前 `~/.serika/data` 必须干净，残留处理由用户决定，本轮不处置。

| 文件名（相对 ~/.serika/data） | 字节 | 修改时间（UTC） |
|---|---:|---|
| task-worker-health.json | 206 | 2026-10-22T17:33:49.354Z |
| task-worker.lock | 0 | 2026-10-22T17:32:47.922Z |
| tasks.json.lock | 0 | 2026-10-22T17:32:47.977Z |

- 已做：计划写明切日用前 a2 → b0+b1 → d1+d2+e → macOS S0–S1 → 另行授权切日用；三文档暂时在 user、导入器保留供新一致快照重导；S1 前移自主切换，逐条变化待批准，Docker 保留；切日用后 b2、c1+c2 的备份/回滚原地 v7 升级、Linux、S2、S3 删除 Docker。

## 3. 前后数字

相对 `613d33e`：产品 +3/−2，净 +1；迁移工具 0；测试 +33/−11，净 +22。测试多于产品，因为该入口必须通过真实子进程证明缺参数时先报错，且不触碰隐式数据目录。文档及元数据证据另计，不算产品。无真实模型调用、无费用。

## 4. 命令与退出码

`pnpm typecheck`：0；`pnpm build:runtime && node --test packages/assistant/dist/task-worker-entry.test.js`：0，12/0/0；补齐 RSS 参数夹具后两文件合跑 16/0/0。首次统一验证 UTC 因 RSS 旧夹具缺 --home 失败，已修复并保留原断言。统一验证结果在后续联合报告中归档，验证退出 0 前不开始 b0+b1。

## 5. 差异与边界

已批准的新节奏取代旧计划顺序。只列默认目录元数据是用户本轮明确例外。未触碰日用其他数据、main、真实模型、服务注册或 TG 外发。采用最小改动和真实入口验证原则；不做多目录、可信文件新规则或系统沙箱。
