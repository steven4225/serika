# 定期 RSS 资讯简报：第一批

复用 TaskStore v4、重复任务领取/漏跑规则、单 worker、inbox/ack 和通知恢复。不新增调度器、后台 Shell/文件/web 工具或自动 Memory 写入。

## 使用

桌面工作区的「资讯订阅」：添加公开 RSS 2.0/Atom URL，预览并确认；选择每日 HH:mm 和固定 UTC offset，预览确认后排期。可以停用/删除来源、暂停/恢复排期、查看最近五条未确认结果并标为已读。暂停不撤回已开始的请求。首版一工作区一条排期，不支持修改已有时间（保留现有系列身份，避免隐式 cancel+create）。

手动运行（先 build；这会占用终端直到 Ctrl+C）：

```sh
pnpm build
RUNLOOM_MODEL=command-code node --env-file=.env \
  packages/assistant/dist/task-worker-entry.js \
  --workspace /绝对物理路径/workspace --rss --notify
```

关闭窗口/退出后继续需要独立 macOS LaunchAgent。在启动桌面前，通过主进程环境配置绝对路径 `RUNLOOM_WORKER_NODE`（独立 Node 可执行文件，不能是 Electron）和 `RUNLOOM_WORKER_ENV_FILE`（或 `RUNLOOM_ENV_FILE`）。环境文件必须有 `RUNLOOM_MODEL` 和对应模型凭据；launchd 不继承命令行临时环境。然后在面板明确启用后台服务；不会自动启用。凭据不写 plist、IPC 或摘要。既有注册服务不会自动改参数，缺 `--rss` 时明确停用再启用；停用会影响该 workspace 其他定时任务。

如使用终端管理 Store，包导出 `createRssSubscriptionStore(workspace)` 的 `get()` / `update(action)`；`update` 返回 `ok/value` 或明确错误。Controller 的 `rss` 分组为桌面提供 `getSubscriptions`、`updateSubscriptions`、`getInbox`、`acknowledgeResult`，不调用模型；写入要求 idle。

## 数据与授权合同

- `.runloom/rss.json` v1：revision、最多八个 source（id/name/url/enabled/initialized/seen）、scheduleId/enabled，以及至多一个 pending 批次。不存在是合法空配置；损坏、symlink、超限不是空列表，不覆盖坏文件。flock + 原子替换；只读查询不建文件。
- 配置修改使用 expectedRevision CAS，包含 worker 去重更新造成的冲突；失败必须刷新，不盲重试。
- scheduleId 必须与 TaskStore 创建的真实 recurring series ID 一致，任务 prompt 必须是保留的 RSS 类型标记，进程必须显式 `--rss`。只有 prompt 或只有订阅配置都不授权。普通提醒保持 scheduled-responder，不抓 feed。
- 实际请求复用公开 HTTP(S)/DNS/重定向/超时/512 KiB XML 完整性检查，无 cookie/凭据。每个来源请求前核对授权 revision；变更后停止后续请求，已在途请求无法撤回。交互 `feed_read` 确认和拒绝闩不变；订阅授权是另一个明确的后台入口。
- stable feed ID > 安全条目 URL > title + publishedAt 的 SHA-256，按 source 隔离。没有 ID/链接且标题/日期变更视为新项；同 ID 正文修改不是新资讯。
- 每次观察文档顺序前 20 个有效条目，每源最多交付五条。首次仅展示五条，成功后将观察到的最多二十条建立基线。以后只推进实际选择的条目，窗口内 backlog 下次再处理。截断必须提示，**不保证抓到窗口之外或两次抓取之间消失的条目**；不叫“最新 N 条”。
- 每源最多 4096 去重键、整个文件最多 1 MiB；达到容量失败，不静默丢弃旧键。删除再添加明确重建基线，可能重复报道。

## 交付与崩溃

1. 抓取后先持久化 pending（taskId、不可变模型 prompt、程序 manifest、拟提交键），不推进 seen。
2. scheduled-rss 使用同一 AgentLoop、无工具；最多一个文本 Run。模型整理输入最多 16 KiB，超出时 program manifest 明说只整理部分；模型不能改程序的来源/条目/失败清单。
3. 先用既有 recordOutcome/finish 保存 inbox 结果及通知意图，再提交去重键。两文件不是跨文件事务：崩溃后从同一 taskId 的持久终态补记。
4. completed 才提交；failed/interrupted/cancelled 释放 pending 不推进。安全模型重试复用冻结批次，不重复抓取；中断任务不自动重跑，下一个 occurrence 可以重新发现条目。
5. 全部启用源失败 → failed，不调用模型，不推进键；部分失败 → 来源清单明确失败，其他来源可 completed。没有新条目是 completed 的正常结果，程序结果不包含模型编造的“新闻”。首版无新条目仍执行一次短文本 Run，模型失败时仍记录失败，不伪造 runId。

结果是 feed-only，不等于读过原文。固定来源列表来自程序；模型整理单独标明未核实原文。通知 submitted 不等于用户收到，ack 不等于内容验收；关机/睡眠不保证准时，漏跑只补一次。

## 验证与未封板项

`rss-digest.test.ts` / `rss-controller.test.ts` 覆盖基线、去重、新项、部分/全部失败、授权拒绝与撤销、冻结重试、重启补记、XML 真实解析运输边界（受控 HTTP 响应）、inbox、只读/坏文件/CAS。桌面测试覆盖 IPC 服务配置拒绝、面板边界，不代表人点击过。

2026-10-03 的隔离验收：公开 `https://hnrss.org/newest` 经生产 feed reader 抓取，Command Code 真实模型完成 scheduled-rss Run，五条程序来源清单落入 inbox，首次二十条观察基线已提交，pending 已清除。验收通过 fixture 时钟推进领取，**不是墙钟到点证据**。报告保存在本机 `/private/tmp/runloom-rss-live-xNshng/report.json`（临时目录可能被系统清理，不作为永久 CI 证据）。

Electron 测试窗口已启动并核对首屏；导航点击未取得可确认的面板变化，订阅增删/确认/ack 的原生交互仍未通过。关闭窗口到点执行、launchd 杀进程拉起与睡眠恢复仍要独立验收。不能拿离线/mock 或 Store 调用模拟时间代替这些系统证据。

### 后续实机证据（2026-10-03）

- 隔离 Electron 原生 AX 操作已经核对工作区 RSS 面板、暂停预览/确认及 inbox 已读回写。暂停后 rss.json `enabled=false` 且二十条基线保留；ack 后原任务仍 completed，`acknowledgedAt` 已保存。新增/删除来源、首次排期、恢复与桌面重启整链尚未验收。该桌面窗口使用 mock，只证明操作接线；展示的简报来自前一次真实模型执行。
- 另一个全新隔离 workspace 以真实墙钟每日排期在上海时间 16:18 到期。真实 launchd 启动生产 `startTaskWorker`，显式 `--rss --notify`，Command Code 模型生成简报，任务在 16:18:07 完成，runId 非空，inbox 与二十条基线已保存，pending 清除。没有桌面进程参与。这证明无桌面运行时的独立后台到点交付，不是“从桌面创建再关闭”的全链证明。
- 完成后的测试 worker 经 launchctl SIGKILL，launchd 拉起新 PID；inbox 仍只有原任务，没有重放已完成简报。这里未测试抓取/模型执行中途被杀的崩溃。
- 通知状态为 `submitted`、attempts=1，仅证明 osascript 提交成功，不证明用户看到。测试服务已 bootout，后续查询确认服务不存在，测试 plist 已移除；未改日用服务。验收专用启动包装器固定模型选择为 command-code，凭据仍读取原外部 env 文件，不复制 key。报告在 `/private/tmp/runloom-rss-wallclock-1eOXzq/report.json`，临时文件不是永久 CI 证据。
- 睡眠/离线恢复、用户实际看到通知及真实模型 Electron 对话仍未封板。

### 真实模型桌面整链（2026-10-03，后续补验）

在全新隔离 workspace 中，用 Cua 原生 AX/键盘操作生产 Electron 页面，而非 Controller 调用代替点击。桌面为 `1db474c`，后端为 `09339be`；显式固定同一 Thread 和 transcript 目录，未测试默认 `desktop-identity.json` 的复用。

1. 页面添加 `Hacker News / https://hnrss.org/newest`。预览前后独立读盘确认 `rss.json` 尚不存在；确认后才保存来源。每日 `16:42`、固定 `+08:00` 的排期预览也未写 TaskStore；确认后绑定系列 `2f109f26-fa80-43d8-b66c-30afa0e3bfe4`，`nextRunAt=2026-10-03T08:42:00.000Z`。
2. 页面明确确认启用独立后台服务，实际 launchd 报告 worker PID。16:39 已退出测试 Electron，应用列表确认原 PID 不在运行；任务完成后、重开前再次确认它仍不在运行。到点采用真实系统时钟，未推进 fixture 时钟。
3. 原外部 env 文件选择 Command Code 的 `deepseek/deepseek-v4.1-flash`，不是 mock；凭据未复制。任务 `595a20cc-2de4-4d34-8915-0df4b8321978` 于 `08:42:00.766Z` 领取、`08:42:08.049Z` completed，Run 为 `ab14de21-b797-4bdb-b2b7-770e6cef9335`，一次 attempt。程序清单五条、模型整理单独标为 feed-only；二十条首次观察基线已保存，pending 清除。
4. 重新打开同一隔离配置/Thread，在工作区展开真实简报，核对来源链接和“未核实原文”标记，再原生点击“标为已读”。读盘确认 `acknowledgedAt=2026-10-03T08:44:51.161Z`，该系列 inbox 为空，原任务仍 completed，没有删除或重跑。
5. 同一桌面还发送了一条无工具的真实模型对话。primary Run `aa5a8f19-ac5f-4241-8fac-c624f4c7cb37` completed，页面显示指定回复，执行记录 tools 为空。这仅证明该配置的桌面模型请求成功，不是通用任务质量验收。
6. 从页面确认停用隔离后台服务。即时状态曾短暂显示旧 PID；再次查询后页面显示未注册，独立 launchctl 查询退出码 113，测试 plist 不存在。测试窗口已退出，不改变日用服务、配置或数据。

因此 **“桌面创建订阅/排期 → 明确开启后台 → 退出桌面 → 墙钟到点真实模型执行 → 重开查看 → ack”已通过**。通知 `submitted`、attempts=1 仍只表示 OS 提交，未证明用户看见。睡眠/离线恢复、执行中途崩溃、来源删除及排期恢复仍未在此链封板，不将此前 mock 或独立 worker 的不同场景拼成这些项目通过。

本机报告与原始截图在 `/private/tmp/runloom-rss-desktopchain-OsdJSQ/`（`report.json`、`digest-visible.png`、`digest-model-visible.png`、`chat-result.png`、`service-absent.png`）；临时目录可能被清理，不是永久 CI 证据。此轮未修改生产代码；文档检查和 PR CI 与上述付费实机链是不同证据层。
