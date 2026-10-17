# 第一批：记忆冲突不堵塞与审批等待边界

基线：main@bf102ee（含 #129）。只由本机 Codex 实现；房间验 Demo / CI，PR 先不合并。

## Before / After

- Before：无生效日的偏好冲突可能拒绝整批沉淀、阻塞后续事实；审批卡的空白、延迟及替换竞态尚须实测，不能先断言有洞或没洞。
- After：冲突保留旧正式记忆并进入明确待确认；同批及后续合法事实继续保存。只有当前完整非空审批预览可批准，旧审批不授权新调用。桌面不用 `[y/n]`，TUI 保留。
- 安全边界：不猜生效日、不自动覆盖、不跳过未处理来源；来源、目标版本、存储不确定等错误仍失败关闭。空审批可拒绝/取消，不能抢点允许。
- 无日期的 `change` 以 `effectiveAt: null` 保留在原候选存储中，强制待确认，不重新分类为纠错。完整预览上明确提供「从现在开始用新偏好」；只有这个显式选择允许后端在锁内取当前时间并保留旧事实适用段。普通 accept、模型自动写入与旧工具确认不能隐式补日期。

## 必须钉死的验收

1. 先保存咖啡不加糖；无生效日的冲突与一个无关合法事实同批提取。旧偏好仍有效，冲突待确认，无关事实保存。重开 store 后追加新事实仍可保存；不以 no_memory 掩盖冲突，不产生相反双活。
2. 审批单独覆盖空字符串、纯空白、延迟预览、取消后迟到预览，以及旧审批替换新审批。分别断言 renderer 允许态及后端是否接受；以实测结果报告，不把代码护栏当实机结论。
3. 错误主路径用中文区分未保存/待确认；英文原始原因仅技术详情。保存状态取自已提交回执，不以聊天“明白”代替。

## 五分钟 Demo（由房间验）

使用测试工作区，自动记忆开启。保存无糖咖啡 → 说另一偏好并给出无关新事实 → 查看旧偏好、待确认候选、新事实 → 再说新事实并确认仍保存。审批延迟/空白夹具：未就绪不能允许；可拒绝；替换后旧按钮不批准新操作。

确定性回归不调用付费模型；真实模型、实际 Electron 点击与日用重载作为独立证据。完成实现/开 PR 不代表已合入或日用已加载。

## 复现结果与实现判断

- 修复前无日期 `change` 触发 `Candidate change effectiveAt must be an ISO timestamp with a timezone`，同批无关事实也不能保存。缺日期不是伪造来源或版本错误：只把这个可审核的不确定性留成候选，保留原来的整批校验与原子提交。无关合法事实、待审候选及来源覆盖回执一起提交，后续仍可继续沉淀。
- 修复前控制器可以在预览仍为空或纯空白时接受 allow。renderer 已阻止空字符串，但未阻止纯空白；本批前后端都检查非空预览，拒绝/取消仍可用，computer 卡也等待后端发布预览。
- 旧审批替换与迟到预览的控制器回归在基线本来通过，本批没有声称它原来有洞；保留测试证明旧 ID 不能授权新调用、旧预览不能覆盖新审批。
- 无日期候选普通接受返回 `MEMORY_EFFECTIVE_AT_REQUIRED` 且文件不变；只有显式「从现在开始用新偏好」传入 `effectiveAt: "now"`。正式断言仍要求有效日期，锁内取当前时间，保留旧适用段。原候选内容与指纹不改，已接受回执重放不重复写入。
- 错日期、伪造来源、外部目标、过期版本继续拒绝整批，字节不变；`ignore` 不被转成待审；伪造自动接受索引不能让未定日期候选直接生效。英文诊断保留在技术详情，主路径用中文区分未完成与写入不确定。
- 现有 WorkTask/Computer 测试夹具在首次空审批事件就自动批准并标记 seen。为配合新护栏，仅调整这些夹具等完整预览后再批准；未改 WorkTask 产品流程或生产 AgentLoop，也未跳过断言。SIGKILL 验收夹具同样等待完整预览。

## 自测命令与结果（2026-10-11，Node v26.4.0）

```sh
pnpm build:runtime
node --test --test-name-pattern='undated conflict|approval preview guard|approval replacement race' \
  examples/cli/dist/memory-correctness.test.js examples/cli/dist/tui.test.js

pnpm --filter @serika/desktop exec tsx --test \
  src/renderer/src/approval.test.ts src/shared/memory-review.test.ts \
  src/main/runtime-bridge.test.ts src/renderer/src/memory-consolidation.test.ts

pnpm typecheck
pnpm test
pnpm --filter @serika/desktop build
git diff --check
```

- 先红后绿：原始无日期冲突、延迟预览 allow、纯空白 allow 的回归先失败；旧审批替换回归在基线即通过。最终定向 runtime 10/10 通过，覆盖同批事实、重开后新事实、显式 from-now 接受及幂等重放和安全边界。
- desktop 定向 35/35 通过，覆盖按钮状态、computer 预览等待、终端后缀隐藏、未定日期确认文案及 IPC 过滤。
- 最终 `pnpm test` exit 0：runtime 1334 tests / 1321 pass / 13 skipped；desktop 434/434 pass；脚本 12/12 pass。三组 fail 0、cancelled 0；包含 SIGKILL before-dispatch / unrecorded-write / recorded-write 回归。
- `pnpm typecheck`、桌面生产构建、`git diff --check` exit 0。此前完整测试暴露的旧空预览自动批准夹具已修，最后一次完整门禁在修后运行。

## 交付证据状态

- 代码和确定性 Demo：passed。
- 真实配置模型：not_run；不以预置提取结果的回归代替真模型意图提取验收。
- 原生 Electron 点击/房间 Demo：pending；renderer 静态渲染断言不等于真实抢点验证。
- PR：提交为 Draft，房间确认 Demo/CI 后才能合并。
- 日用重载：not_run；未操作日用进程、配置或数据。合入后另行在获准的空闲条件下重载，不能把代码完成当成日用已加载。

## 非目标

不做第二批提醒正文/只读放行/失败活动/锁文件，不做 Batch 3 用量，不重写 AgentLoop，不换记忆框架/向量库，不动日用进程。
