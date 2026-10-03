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

## 对话与查阅

默认窗口为 1180×800，使用不透明的浅色布局。对话是唯一主项；侧栏分为查阅（工作区、执行记录、记忆审核）、工具（番茄钟）和维护（模块能力、上下文与压缩）。查阅在同一窗口展开，带「回到对话」；对话与草稿保持挂载，缩窄窗口不自动关闭查阅页。800px 以下导航收为图标，窄窗口仍保留全部入口。

回答渲染 Markdown 标题、列表、表格和代码块，代码可复制。使用 `react-markdown` + `remark-gfm`；不渲染原始 HTML，不自动加载图片，只允许 http(s) 和页内链接。文件工具的完整成功返回直接显示路径与实际返回字节数；不从模型文字或截断预览编造回执。不完整回执是中性状态，不等于返回成功或效果未知。当前 Run 的回执和 Shell 进度不串用旧 Run 的同名 ID。模型、Thread、预算和路径详情收进工作区概览，不占对话顶部。

主屏上方只展开一件待处理事项，依次为工具确认、效果未知的执行、当前 Thread 待审记忆；其余只显示紧凑入口。记忆卡先显示完整原话、拟保存正文、范围与期限，接受用当前预览的候选 revision，不使用 approvalId。忙时、预览失效或审核结果未知时不能写入；未知结果只重新读取，不自动重发决定。接受／拒绝后主屏推进到下一条，历史仍可查阅。

明确标注为核对说明的工具后最终回复可分为结论、助手声明的未核对项与可展开的原文；实际计划、报告或未标注正文保持可见，不生成另一个模型摘要。普通回复和流式文字保持原样。错误提示和输入位于底部。Enter 发送，Shift+Enter 换行，中文输入法选词不会发送。运行时可以编辑下一条草稿，但发送禁用，不排队、不自动重发；命令失败保留原输入。阅读旧消息时不被新输出拉到底部，「最新消息」可恢复跟随。Escape 优先关闭详情，再隐藏窗口。

布局不新增后端状态、工具权限或任务调度。执行记录中的未知效果会提示人工核对；Run 结束不画成业务验收成功。

浅色重设计实测：隔离 Thread `desktop-ui-refresh-20261002`，Command Code 的真实回答正常渲染标题、加粗、表格、列表和代码块，代码复制反馈为成功；700px 窗口检查了确认卡、草稿与侧边图标导航。拒绝观察后仍为 `TOOL_DENIED`，未发送草稿不会写入 transcript 或执行记录。阅读旧消息时出现“最新消息”入口。证据目录 `/private/tmp/runloom-desktop-ui-refresh-20261002`。下方记录属于此前深色工作台验收，不代表新布局的全部尺寸已真机封板。

本批实测：隔离 Thread `desktop-workbench-qa-20261002`，真实 Command Code + Electron 已显示逐次 Computer 确认、只读窗口观察回执；第二次观察明确点击拒绝后显示 `TOOL_DENIED`，没有返回该次窗口列表。1180px、700px、390px 宽度下核对了对话、详情抽屉和底部输入，抽屉不覆盖操作区；多行粘贴与 Enter 发送可用。证据保留在 `/private/tmp/runloom-desktop-workbench-qa-20261002`。这不代表输入／读回、审批中刷新、驱动断连或取消派发后的未知效果已完成真实 Electron 封板；这些路径的展示规则有离线测试，真机链仍待补。

## 工作任务（桌面第一批）

对话输入区有「创建工作任务」，工作区里也可创建。普通消息仍只走 `run()`，不自动建任务；定时提醒的 scheduler / worker 是另一套入口，本批没有修改。

1. 填目标、约束、相对工作区的产物路径和人工验收项。至少一项，初版全部为必需项；创建只落任务，不调用模型。暂不提供 Shell 验收编辑器，已有 Shell 标准只读显示。
2. 点「开始执行」或「开始下一轮」调用 `runWorkTask()`，回到对话看进度；每次工具调用仍用原来的 `approvalId` 确认。Run 正常结束只变成 `paused`，不会自动标任务通过。
3. 在工作区提交交付结论、产物引用和未解决事项。产物引用只是声明；自动验收由后端核对最新归属正确的 primary Run 写入回执和当前磁盘文件/hash。文件预先存在、助手声称成功、人类核对记录都不算自动通过。人工项逐项预览，再确认通过或未通过；所有必需项通过后才显示「验收通过」。重新交付会重置验收，按钮明确标明。
4. 重启用原配置、workspace、Thread、transcript 后重新读取存储。`needs_review` 先读最新回执，核对实际文件/应用，再填写观察与说明。「仍然不确定」不能继续，但可带核对记录取消；不存在直接取消绕过。成功继续只回到 `paused`，必须另点下一轮，不重放工具。回执缺失或不可用会明示，人类报告仍不是程序证据。

主屏只显示所选任务的紧凑状态；详情、验收、关联 Run 和人工核对历史都在工作区，没有新侧栏或任务队列。执行记录可回到归属任务。核对后的旧 `unknown` 回执原样保留，只从尚待处理的横幅数量中去除；核对不代表旧执行成功。

每次变更传当前详情的 `revision`。刷新中、忙时或数据不可用时禁用变更；冲突、丢失响应后只重读，不重发旧请求。表单随任务 id/revision 重置，防止旧预览继续接受；普通聊天草稿不动。列表复用后端最近 20 条，不宣称整个 workspace 所有任务。

沿用现有后端状态机：`awaiting_acceptance` 不可直接开启新 Run；初版可以重交付核验、修改人工验收决定或取消，但没有“验收失败后回到执行”的新状态接口。`completed` / `cancelled` 不可重开。验收通过仅指所列必需标准，不承诺所有未解决事项已消失，也不承诺关窗口后继续执行。

离线验证使用真实 Controller 与隔离磁盘存储、mock 模型，覆盖创建→新 Run→逐次确认→暂停→产物核验→人工验收→重启读取；另外覆盖旧 revision、跨 Thread、不自动把聊天建任务、坏文件、遗留 unknown 核对不调用模型/不改旧回执、核对报告不作验收证据。真实模型/压缩后的任务连续成功率及系统后台交付仍是后续验收，不由本批离线测试代替。

## 上下文面板

面板读取 `getContextDiagnostics()`，展示实际配置、估算器、最近合法压缩记录和本进程最后一次上下文准备。查询不调用模型、不创建 Run、不写 JSONL。历史记录通过 transcript 前缀校验，不等于当前 Run 已使用它；重启后本进程准备结果为空。读取失败保留上次数据并标明过时，缺失 usage 不显示成零。

手动压缩仍是空闲 `/compact`；忙时按钮禁用。估算输入不是 provider 的精确 tokenizer 计数。摘要不是长期记忆、磁盘事实或工具授权。关闭模型摘要仍有既有历史裁剪。

## 第一批真实验收边界

离线 `pnpm check` 不能替代以下两条真实 Electron 链；使用隔离 workspace、外部配置、固定 transcript，不用自己的敏感材料。

1. 开启 memory + autoConsolidate，普通对话陈述测试偏好且主 Run 不请求 memory 工具。展开候选，检查完整原话、revision、workspace 范围，点击接受。完整退出重开另一 Thread，查询与正文词法重合的问题，核对实际回答和记忆 ID。接受前正式 entries 不能增长；候选只属于来源 Thread。
2. 开启压缩，进行有目标、约束和可检查文件的真实任务，直到自动阈值写入记录（不能用手动按钮代替）。继续任务，核对真实工具回执/磁盘，完整退出同 Thread 重启，查看合法历史记录与空的本进程准备结果；下一轮应显示实际 reused/written，重新读文件核对事实且重新确认写入。

低预算触发证据与日用默认预算表现分开。失败、取消、模型未提案、没有真实自动压缩、未实际重启均不得记成通过；保留每次隔离目录与报告。不承诺后台任务或通知送达，不涉及工作任务 UI 接线。

2026-10-02 实测：真实 DeepSeek + Electron 的候选预览/接受、完整退出与另一 Thread 查询通过。自动阈值压缩后新审批读写通过（估算输入 9251 → 6350）；9000 窗口下重启续跑仍超限，调大到 16000 后复用了合法记录并重新审批读盘核对。前两次还分别遇到摘要 JSON 校验失败与四次合并容量限制，均保留失败，不放宽校验。它证明界面接线、失败诊断与恢复机制，不是同一固定配置的连续使用封板，也不代表默认预算实测通过。隔离报告在 `/private/tmp/runloom-context-desktop-rxBk4W/attempt-{1,2,3,4}.md`（本地证据，不自动入库）。
