# Runloom Desktop

Electron 前端通过 `createRuntimeApp` + `createAssistantController` 接入后端，不创建第二条 AgentLoop。

## 启动与验证

先构建链接的后端，再启动桌面：

```sh
cd /Users/a1-6/Code/agents/aisdk-agent-framework
pnpm build
cd /Users/a1-6/Code/agents/runloom-desktop
pnpm check
pnpm dev
```

使用真实模型与外部配置（配置不能放 workspace 内）：

```sh
cd /Users/a1-6/Code/agents/runloom-desktop
RUNLOOM_MODEL=deepseek RUNLOOM_CONFIG=/absolute/path/runloom.json \
  node --env-file=../aisdk-agent-framework/.env node_modules/electron-vite/bin/electron-vite.js dev
```

不指定身份时，Electron userData 下的 `desktop-identity.json` 保存实际 config/workspace、Thread 和 transcript 目录。完整退出后，相同配置与工作区复用身份；切换配置路径或工作区生成新 Thread，旧 transcript 不删除。本次不提供历史项目列表或热切换。坏身份文件会报错，不会自动清空身份。第二份桌面进程只聚焦第一份窗口。

这份文件只保存最后一次默认身份，不是按项目维护的身份列表。切到另一个配置/workspace 后再切回来，会再次生成 Thread，不自动接回原对话；旧 transcript 仍在磁盘上，需要显式指定原 Thread 和目录才能接回。

`RUNLOOM_THREAD` / `RUNLOOM_TRANSCRIPTS` 可显式覆盖，不改写默认身份；部分覆盖从匹配身份补齐，无匹配时用稳定隔离默认值。以相同覆盖重启才能回到同一对话。`RUNLOOM_WORKSPACE` 只在首次生成配置时生效，已有配置以文件实际 workspace 为准。

新生成的 `runloom.json` 默认开启模型摘要压缩，保留后端合法默认预算；旧配置不会自动开启，显式 `RUNLOOM_CONFIG` 不会被改写。自动记忆整理仍需显式设置 `modules.memory.autoConsolidate: true`，不会自动开启。

## Command Code 与指定应用控制

桌面支持 `RUNLOOM_MODEL=command-code`，复用后端模型入口。可通过主进程显式加载受信任的环境文件；已有进程环境变量优先，不隐式寻找 cwd 下的 `.env`，不把 Key 发往页面或 IPC：

```sh
RUNLOOM_ENV_FILE=/Users/a1-6/Code/agents/aisdk-agent-framework/.env \
RUNLOOM_CONFIG=/absolute/outside-workspace/runloom.json pnpm dev
```

环境文件含 `RUNLOOM_MODEL=command-code` 与 `COMMAND_CODE_API_KEY`。缺凭据、坏文件或配置错误会显示启动失败，不静默回退模型。Computer 配置沿用外部 `modules.computer` 的 enabled/executable/allowedBundleIds；仅显示已配置，不承诺驱动可用，不自动安装、启动 daemon 或申请权限。本机 Cua Driver 不需要模型 Key。

Computer 确认卡显示精确 bundle/PID/window、动作和完整输入，技术 token 可展开；按 approvalId 提交一次确认，过期不重试、不批准新调用。空 preview 时不会绕过确认。原始 UI 文本只按纯文本展示。

`confirmed` 仍显示已派发、效果待核对；`suspected_noop` 不能被自动重试。实时事件、刷新快照和最终回执共用展示规则，`outcomeUnknown`/unknown 优先显示人工核对。主 Run 结束或取消后重读 getRun，不能仅凭 cancelled 认定没有副作用。Run completed 只表示本轮结束，不代表任务验收。

## 工作台布局

默认窗口为 1180×800，使用不透明的浅色纸面布局：左侧导航，中间对话，详情默认收起。1200px 以下详情采用可关闭的抽屉；800px 以下导航收为图标，460px 以下隐藏侧栏，详情仍可从顶部按钮进入。记忆／上下文面板始终保留挂载状态，切换分类不丢失已打开的审核详情。

回答渲染 Markdown 标题、列表、表格和代码块，代码可复制。使用 `react-markdown` + `remark-gfm`；不渲染原始 HTML，不自动加载图片，只允许 http(s) 和页内链接。正常工具回执可展开，失败／未知效果突出显示。模型、Thread、预算和路径详情收进工作区概览，不占对话顶部。

确认卡、错误提示和多行输入固定在底部。Enter 发送，Shift+Enter 换行，中文输入法选词不会发送。运行时可以编辑下一条草稿，但发送禁用，不排队、不自动重发；命令失败保留原输入。阅读旧消息时不被新输出拉到底部，“最新消息”按钮可恢复跟随。Escape 优先关闭详情，再隐藏窗口。

布局不新增后端状态、工具权限或任务调度。执行记录中的未知效果会提示人工核对；Run 结束不画成业务验收成功。

浅色重设计实测：隔离 Thread `desktop-ui-refresh-20261002`，Command Code 的真实回答正常渲染标题、加粗、表格、列表和代码块，代码复制反馈为成功；700px 窗口检查了确认卡、草稿与侧边图标导航。拒绝观察后仍为 `TOOL_DENIED`，未发送草稿不会写入 transcript 或执行记录。阅读旧消息时出现“最新消息”入口。证据目录 `/private/tmp/runloom-desktop-ui-refresh-20261002`。下方记录属于此前深色工作台验收，不代表新布局的全部尺寸已真机封板。

本批实测：隔离 Thread `desktop-workbench-qa-20261002`，真实 Command Code + Electron 已显示逐次 Computer 确认、只读窗口观察回执；第二次观察明确点击拒绝后显示 `TOOL_DENIED`，没有返回该次窗口列表。1180px、700px、390px 宽度下核对了对话、详情抽屉和底部输入，抽屉不覆盖操作区；多行粘贴与 Enter 发送可用。证据保留在 `/private/tmp/runloom-desktop-workbench-qa-20261002`。这不代表输入／读回、审批中刷新、驱动断连或取消派发后的未知效果已完成真实 Electron 封板；这些路径的展示规则有离线测试，真机链仍待补。

## 上下文面板

面板读取 `getContextDiagnostics()`，展示实际配置、估算器、最近合法压缩记录和本进程最后一次上下文准备。查询不调用模型、不创建 Run、不写 JSONL。历史记录通过 transcript 前缀校验，不等于当前 Run 已使用它；重启后本进程准备结果为空。读取失败保留上次数据并标明过时，缺失 usage 不显示成零。

手动压缩仍是空闲 `/compact`；忙时按钮禁用。估算输入不是 provider 的精确 tokenizer 计数。摘要不是长期记忆、磁盘事实或工具授权。关闭模型摘要仍有既有历史裁剪。

## 第一批真实验收边界

离线 `pnpm check` 不能替代以下两条真实 Electron 链；使用隔离 workspace、外部配置、固定 transcript，不用自己的敏感材料。

1. 开启 memory + autoConsolidate，普通对话陈述测试偏好且主 Run 不请求 memory 工具。展开候选，检查完整原话、revision、workspace 范围，点击接受。完整退出重开另一 Thread，查询与正文词法重合的问题，核对实际回答和记忆 ID。接受前正式 entries 不能增长；候选只属于来源 Thread。
2. 开启压缩，进行有目标、约束和可检查文件的真实任务，直到自动阈值写入记录（不能用手动按钮代替）。继续任务，核对真实工具回执/磁盘，完整退出同 Thread 重启，查看合法历史记录与空的本进程准备结果；下一轮应显示实际 reused/written，重新读文件核对事实且重新确认写入。

低预算触发证据与日用默认预算表现分开。失败、取消、模型未提案、没有真实自动压缩、未实际重启均不得记成通过；保留每次隔离目录与报告。不承诺后台任务或通知送达，不涉及工作任务 UI 接线。

2026-10-02 实测：真实 DeepSeek + Electron 的候选预览/接受、完整退出与另一 Thread 查询通过。自动阈值压缩后新审批读写通过（估算输入 9251 → 6350）；9000 窗口下重启续跑仍超限，调大到 16000 后复用了合法记录并重新审批读盘核对。前两次还分别遇到摘要 JSON 校验失败与四次合并容量限制，均保留失败，不放宽校验。它证明界面接线、失败诊断与恢复机制，不是同一固定配置的连续使用封板，也不代表默认预算实测通过。隔离报告在 `/private/tmp/runloom-context-desktop-rxBk4W/attempt-{1,2,3,4}.md`（本地证据，不自动入库）。
