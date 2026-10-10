# 剩余批次（A–D 已合并 main）

已合并：https://github.com/steven4225/runloom/pull/117 （历史＋回执＋Telegram C／D）

## 继续按序（每批必须 commit＋push＋开 PR 或直接合入 main 前先 PR）

### E 备份／恢复（核对是否已部分落地，补齐验收）
手动备份指定 workspace；不含 key／token；恢复校验不覆盖在用；不自动跑历史任务。Demo 写进 docs。

### F Node 22 门禁
`node --test packages/ai-sdk-adapter/dist/loop.test.js` 在 engines≥22.12.0 上不得大面积 cancelled。

### G README
确认 desktop README 启动路径正确（PR117 可能已改，核对即可）。

### 第五批 记忆正确性（不换框架）
处理覆盖防漏记；固定沉淀工作流；少量事实身份；可选小画像＋按需改写。

## 强制流程
1. 从最新 `main` 开分支 `fix/...`
2. 实现 → 测试 → **git commit → push → gh pr create → gh pr merge**（用户已授权每批提交合并）
3. Before／After／Demo 汇报
4. 再开下一批；禁止只改不提交
