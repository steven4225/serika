# 界面前后对比（拆 App.tsx 用）

只用于开发验证，不进产品、不进测试套件。用浏览器预览页（真实 `App` + 假数据，不连 Electron、模型或磁盘）
把界面状态逐个存成归一化后的 DOM（时间戳、UUID、vite 缓存参数已去掉）和截图，改动前后逐个比对。

- `states.mjs`：7 个预览页 × 导航、全部设置页、发送并允许、侧栏收起/展开、窄窗口（100 个状态）。
- `flows.mjs`：`shell-preview.html?lifecycle` 上的脚本化流程：拒绝、停止、推送事件与 Shell 实时输出、
  失败结果、补充要求（接收/应用/凭证未确认）、切换和新建对话、连接失败与恢复、执行记录、输出消息
  （18 个状态），并按顺序记录 App 调用的每个接口及参数（`calls-*.txt`）。

```sh
cd apps/desktop && npx vite --config vite.preview.config.ts &   # http://127.0.0.1:5187
node scripts/ui-snapshots/states.mjs /tmp/before && node scripts/ui-snapshots/flows.mjs /tmp/before
# …改代码…
node scripts/ui-snapshots/states.mjs /tmp/after && node scripts/ui-snapshots/flows.mjs /tmp/after
scripts/ui-snapshots/compare.sh /tmp/before /tmp/after
```

需要能 import 的 `playwright`；`CHROMIUM_PATH` 指定浏览器，`PREVIEW_URL` 改预览地址。
