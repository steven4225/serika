# 桌面端：清理 ZCode 改编代码（计划，排在 D1 第 3 步之后）

状态：D1 第 3、4 步已做完，清理已开工。

- 已做：改名（目录 `src/renderer/src/zcode/` → `src/renderer/src/ui-kit/`；测试 `zcode-*.test.ts` → `ui-kit-*.test.ts`；预览入口 `zcode-preview.html` / `zcode-preview.tsx` → `shell-preview.html` / `shell-preview.tsx`，`vite.preview.config.ts` 同步）；`package.json` 的 `ui:zcode` → `ui:preview`（单独一个提交）。`upstream/` 子目录名和 `.theme-zai-*` 类名保留，作为核对上游的锚点；`zcode-` 类名、布局值 `"zcode"`、`third-party/zcode/` 目录这次没动。下文第 4 节的路径是改名前的写法，`zcode/` 现在对应 `ui-kit/`。
- 改名验收（`scripts/ui-snapshots/check-entry-rename.sh 改名前目录 改名后目录`，三条同时成立才通过）：A. HTML 按标签拆行后，所有差异行都匹配 `^[<>] <script type="module" src="\./src/(zcode|shell)-preview\.tsx">`，且差异文件恰好 51 个；B. 把这一行换回旧名后，138 个文件（127 个 HTML + 11 个 `calls-*.txt`）逐字一致；C. 11 个调用顺序记录零差异。
- 之后 `scripts/ui-snapshots/compare.sh` 加了白名单：HTML 里的入口标签 `<script type="module" src="./src/<名字>-preview.tsx">` 不参与比对。用它对比 37d7707 快照（只把文件名 `zcode_preview_html` 换成 `shell_preview_html`，内容不动）和改名后的快照：compared=138 diffs=0。
- 已做：删死代码（`ui-kit/conversation.tsx`、`sidebar.tsx`、`appearance.ts`、`upstream/chat-loading.tsx`、`upstream/new-task-button.tsx`）；只测死组件渲染的用例删除，数据层断言保留，渲染断言能换到 `PersonalConversation` / `PersonalTool` 的换过去（逐条见该提交说明）。`personal/conversation.tsx` 里沿用旧 `ui-kit/conversation.tsx` 的展示，署名移到它的文件头和 NOTICE。
- 已做：改类名和布局值：`zcode-*` 类名 → `serika-*`（`serika-zcode-shell` → `serika-shell`），布局值 `"zcode"` → `"serika"`，组件名 `ZCode*` → `Serika*`。`.theme-zai-*`、`upstream/` 不动；预览示例的 threadId `zcode-preview-plan` 不动（在调用记录里）。验收：`scripts/ui-snapshots/check-class-rename.sh 改名前目录 改名后目录 改名前提交`。
- 已做：删 `ui-kit/theme.css` 里只属于已删组件的样式：选择器里含有只在已删组件里出现、别处都不再引用的类（29 个，如 `serika-sidebar`、`serika-turn`、`serika-tool`）的，删掉该选择器；整条规则或整个 `@media` 块的选择器都删光了就整条删。别处还在用的类、动态拼接的类（`status-*`、`tone-*`、`serika-layout`）不动。验收：138 项快照 0 差异。
- 已做：删 `SerikaPromptEditor`（`ui-kit/prompt-editor.tsx`）和 `ui-kit/upstream/chat-prompt-shell.tsx`：正式界面输入框是 `personal/composer.tsx` 自己的实现，两者只剩两个测试用例在用；用例、相关 CSS、NOTICE 条目一并处理。`SerikaPromptOptions`（“更多操作”菜单）仍在用，保留。
- 已做：按“正式界面不用且没有入口引用就删”的原则清 CSS：类名在源码里没有字面引用（也没有动态拼接）、在 138 项快照的 DOM 里也不出现的，删掉含它的选择器。最大的一块是 `.serika-layout`：App 根节点只有 `personal-layout`，`serika-layout` 从未被加到页面上，`theme.css` 里以它开头的布局规则全部不生效。`.theme-zai-*` 按决定保留，`tone-*` 是动态拼接的，保留。验收：138 项快照 0 差异。
- 已定：保留改编实现，不重写（见第 7 节）。

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

- `third-party/zcode/` 目录名：用户定为不动。

## 7. 已决定不做及原因

用户已定保留改编实现。下面四项是原计划（第 3、4 节）里写了、现在决定不做的，署名和 NOTICE 照第 2 节保留：

1. **自己重写窗口外框**（`ui-kit/upstream/desktop-window-frame.tsx`）：不做。它按平台（macOS / Windows / Linux）切换根背景，Linux 下还有圆角、`clip-path` 和最大化时归零的处理；重写后必须保证 DOM 和类名与原来一致（第 5 节），而平台差异、最大化、拖拽缩放正是 138 项截图覆盖不到的地方（第 3 节第 3 条），收益只是少一条署名，风险大于收益。
2. **自己重写按钮**（`ui-kit/upstream/button.tsx`、`utils.ts`）：不做。`theme.css` 的按钮样式直接按它输出的 `data-slot` / `data-variant` 选中，重写要逐条核对这些样式；hover、focus 状态截图也覆盖不到。
3. **自己重写输入框外壳**（`ui-kit/upstream/chat-prompt-shell.tsx`）：不做，且已删除。核对发现正式界面不用它：`personal/composer.tsx` 的 `PersonalPromptEditor` 是自己的实现；`ChatPromptShell` 只被 `SerikaPromptEditor` 用，后者只剩两个测试用例在用，两者已一起删掉（第 4 节表里“`personal/composer.tsx` 转引（输入框外壳）”已过时）。
4. **主题改名**（`.theme-zai-*`、`upstream/styles.css` 的主题变量）：不做。`.theme-zai-*` 和 `upstream/` 保留原名，作为对照上游代码的锚点；改名不改颜色本身没有用户可见收益，换配色是另一回事（第 3 节第 1 条，方向未定）。

## 8. 独立待办（清理阶段不处理、属于设计问题）

- **正式界面不显示“当时已保存”的记忆回执**：删死代码（`9b120c6`）时发现，这类记忆回执原来只有已删的旧组件 `ui-kit/conversation.tsx` 会渲染，正式 personal 界面（`personal/conversation.tsx`）本来就不渲染。这是删除前就有的缺口，不是清理引入的。清理阶段不处理：在 personal 界面里放在哪、长什么样、文案和顺序怎么定属于设计问题，要单独定方案、单独提交。

