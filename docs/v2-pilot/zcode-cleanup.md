# 桌面端：清理 ZCode 改编代码（计划，排在 D1 第 3 步之后）

状态：D1 第 3、4 步已做完，清理已开工。

- 已做：改名（目录 `src/renderer/src/zcode/` → `src/renderer/src/ui-kit/`；测试 `zcode-*.test.ts` → `ui-kit-*.test.ts`；预览入口 `zcode-preview.html` / `zcode-preview.tsx` → `shell-preview.html` / `shell-preview.tsx`，`vite.preview.config.ts` 同步）；`package.json` 的 `ui:zcode` → `ui:preview`（单独一个提交）。`upstream/` 子目录名和 `.theme-zai-*` 类名保留，作为核对上游的锚点；`zcode-` 类名、布局值 `"zcode"`、`third-party/zcode/` 目录这次没动。下文第 4 节的路径是改名前的写法，`zcode/` 现在对应 `ui-kit/`。
- 改名验收（`scripts/ui-snapshots/check-entry-rename.sh 改名前目录 改名后目录`，三条同时成立才通过）：A. HTML 按标签拆行后，所有差异行都匹配 `^[<>] <script type="module" src="\./src/(zcode|shell)-preview\.tsx">`，且差异文件恰好 51 个；B. 把这一行换回旧名后，138 个文件（127 个 HTML + 11 个 `calls-*.txt`）逐字一致；C. 11 个调用顺序记录零差异。
- 已定：保留改编实现，不重写。

## 1. 来历

- `aff8b02`（2026-10-05）「add ZCode-style layout」和 `b9814b3`（2026-10-07）「adapt ZCode source components to Serika chat」，把开源项目 `zai-org/ZCode`（Copyright 2026 Z.AI Co., Ltd.，Apache-2.0，固定在 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`）的部分界面源码改编了进来。
- `081282f`（2026-10-09）加了 personal 布局，之后 `cursor/wave-*` 等分支在上面接着做搜索、任务、设置页。新界面是叠在 ZCode 那层底子上的，底子没拆。
- 远端所有分支都查过了：从桌面端并进本仓库（2026-10-09）以后，每个分支都带着这 22 个 zcode 文件，main 也是。

## 2. 结论修正：不是「做完就没有痕迹」

Apache-2.0 要求衍生作品保留署名，**删文件不等于能删署名**。这次清理的准确目标是：**自己重写实现，并按许可证保留必要的署名**。

- `zcode/conversation-data.ts` 的轮次分组和「修改 N 个文件」摘要改编自上游的 `v4/conversationTurnFlowItems.ts`、`v4/conversationTurnRenderUnits.ts`，工具摘要改编自 `ToolCallBlocks/ToolSummaryRow.tsx`。
- `zcode/theme.css` 引用的是上游主题（`upstream/styles.css` 里原样的 `@theme`、`.theme-zai-light`、`.theme-zai-dark`）。
- `zcode/message.tsx` 还牵出另一个来源：vercel/ai-elements（Copyright 2023 Vercel, Inc.，Apache-2.0）。
- `third-party/zcode/NOTICE.md` 里还有 shadcn 的 MIT 许可声明（上游样式里有 shadcn 的内容）。
- 规则：
  - 只要文件里还留着上游代码或改编来的实现（包括第 3 节说的「只改名」的主题），文件头的署名和 NOTICE 里对应的条目都要留。
  - 只有不对照上游、自己从头写的实现，才可以不写这条署名。
  - 拿不准算不算重写的，一律保留，并在提交说明里写清楚原因。
  - 每个文件最后是删署名、留署名还是改写署名，都要逐个列进提交说明。
  - 上游代码全部去掉之后，才能删 NOTICE 里对应的条目。shadcn（MIT）和 vercel/ai-elements（Apache-2.0）也一样处理。

## 3. 已决定的

1. **主题：先改名，颜色值不变，不换配色。**换配色会让 138 项截图全部失效、要重录基线；而且换成什么颜色是产品决策，方向还没定。只改名的话截图应该不变，可以单独验证。改名后作者署名注释不能删；NOTICE 里主题那一条改成「仅改名，颜色值不变」。
2. **时间：等第 3 步做完再动。**第 3 步要改 `zcode/conversation-data.ts`（personal 对话区在用）和 store 里调用 `applyEvent` 的地方，跟这次清理是同一批文件，同时改会很难合并。
3. **截图覆盖不够**：138 项快照对 CSS 主题和窗口外框的覆盖最弱（hover、focus、滚动中、动效都没覆盖）。纯样式改动光靠截图验证最容易漏，必须补验收手段（第 5 节）。
4. 不在 D1 计划里，单独提交，每个提交照常推送、发补丁，前缀和提交说明的格式不变。

## 4. 文件清单（2026-10-18 盘点，HEAD `443c28b`）

体积：`upstream/styles.css` 469 行、23 KB，`theme.css` 213 行、18 KB，合计 682 行、42 KB（之前口头估的「900 多行」偏高，以这里的实数为准）。「几十行一个」只适用于窗口外框、按钮这类组件，不适用于主题。

### 正式界面在用

| 文件 | 行数 | 谁在用 | 处理 |
| --- | --- | --- | --- |
| `zcode/upstream/desktop-window-frame.tsx` | 53 | `App.tsx`，包住整个窗口 | 自己重写 |
| `zcode/upstream/button.tsx` | 73 | `App.tsx` 2 处（发送/停止），另有死代码在用 | 自己重写 |
| `zcode/upstream/utils.ts` | 26 | 上面几个组件 | 自己重写，或改用依赖包自带的工具 |
| `zcode/upstream/chat-prompt-shell.tsx` + `zcode/prompt-editor.tsx` | 26 + 44 | `personal/composer.tsx` 转引（输入框外壳） | 自己重写 |
| `zcode/upstream/styles.css` + `zcode/theme.css` | 469 + 213 | `App.tsx` 引入；`personal/*.css` 有 21 处引用 `zcode-` 类名或 `zai` 主题变量 | 只改名、颜色值不变；保留署名；NOTICE 改成「仅改名，颜色值不变」 |
| `zcode/conversation-data.ts` | 112 | `personal/conversation.tsx`（工具名表、摘要、轮次分组），也是第 3 步要改的文件 | 搬到 personal 下并改名；重写实现还是保留改编实现另定，保留时署名照留 |
| `zcode/message.tsx` | 24 | classic `Row`（`app/conversation-row.tsx`，内部布局） | 改名或重写；ZCode 和 vercel/ai-elements 的署名按第 2 节处理 |
| `zcode/layout.ts` | 6 | `App.tsx`、`app/conversation-row.tsx` | 改名。布局值 `"zcode"` 写死在代码里、不落盘（已核实；外观偏好的 localStorage 键是 `serika:personal-appearance`，不含 zcode） |
| `App.tsx` 里的 `ZCode*` 别名和 4 种 `zcode-` 类名 | — | 正式界面 | 改名 |

### 只剩测试、预览在用（死代码）

| 文件 | 行数 | 处理 |
| --- | --- | --- |
| `zcode/conversation.tsx`（`ZCodeConversation`、`ZCodeTool`） | 89 | 删除 |
| `zcode/sidebar.tsx` | 90 | 删除 |
| `zcode/appearance.ts` | 6 | 删除（只有 `sidebar.tsx` 和测试在用） |
| `zcode/upstream/chat-loading.tsx`、`new-task-button.tsx` | 13 + 18 | 删除 |

### 测试、预览、文档

| 文件 | 处理 |
| --- | --- |
| `zcode-upstream.test.ts`（45 行）、`zcode-layout.test.ts`（38 行）、`zcode-conversation.test.ts`（146 行），共 229 行 | 删之前逐条列出每个用例；测正式界面在用的断言迁到新文件，只测死代码的随文件删除，提交说明写明删了哪些 |
| `tool-preview-golden.test.ts` 里渲染 `ZCodeTool` 的部分 | 这是死代码，正式界面渲染的是 `PersonalTool`（也已覆盖）。清理时删掉；如果第 3 步先碰到这个文件，可以先删 |
| `zcode-preview.tsx`（118 行）、`zcode-preview.html`、`package.json` 的 `ui:zcode`、`vite.preview.config.ts` | **不是死代码**：`scripts/ui-snapshots/flows.mjs`、`states.mjs` 的截图流程从这里进入。只能改名不能删；改名后截图文件名、`calls-*.txt` 的来源 URL 会跟着变，要按新旧名映射后再比对 |
| `apps/desktop/README.md` | 11 处提到 ZCode（第 164、268–300 行），按改名后的实际情况改；保留「改编自哪里、许可证在哪」的说明 |
| `third-party/zcode/LICENSE`、`NOTICE.md` | 保留，内容按清理后的实际情况更新；目录要不要改名另定 |

## 5. 验收（开工前再细化）

- 每个提交照常跑 typecheck、test:runtime、desktop test、138 项截图和调用顺序，并收集 console 错误。
- 改名的提交：页面 HTML 快照按新旧类名映射后必须一致；CSS 按改名映射替换后，逐条规则必须相同（颜色值、选择器结构都不变）。
- 截图覆盖不到的状态（hover、focus、滚动中、动效、窗口缩放、深浅色切换）：补针对性截图，或者在真实 Electron 里逐项核对，并在提交说明里写明是哪一种。
- 重写的组件（窗口外框、按钮、输入框外壳）：渲染出的 DOM 和类名要和原来一致，任何差异逐条列出。
- 署名：每个提交列出动过的每个文件的署名是删、留还是改，以及原因。

## 6. 待定

- 布局值 `"zcode"`、`zcode-` 类名前缀、`third-party/zcode/` 目录名要不要改、改成什么。
