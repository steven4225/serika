import { useEffect, useRef, useState } from "react";
import type { TelegramStatus } from "../../shared/telegram.js";
import type { AutomationOverview } from "@serika/assistant";

export function telegramConnectionLabel(status: TelegramStatus | null) {
  return !status ? "正在读取连接状态…" : !status.available ? "请先启用常驻助手" : status.lastError && !status.enabled ? "Telegram 状态需核对" :
    !status.enabled ? "Telegram 未开启" : status.connection === "online" ? "Telegram 已连接" : status.connection === "connecting" ? "正在连接 Telegram" : "Telegram 连接失败";
}

export function TelegramPanel({ busy }: { busy: boolean }) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [autonomyPreview, setAutonomyPreview] = useState(false);
  const [enablePreview, setEnablePreview] = useState(false);
  const [review, setReview] = useState<{ key: string; note: string } | null>(null);
  const [deliveryReview, setDeliveryReview] = useState<{ key: string; note: string } | null>(null);
  const [cancelDelivery, setCancelDelivery] = useState<string | null>(null);
  const [arrangements, setArrangements] = useState<AutomationOverview | null>(null);
  const [routePreview, setRoutePreview] = useState<{ id: string; kind: "once" | "recurring"; label: string } | null>(null);
  const [workerState, setWorkerState] = useState("");
  const inFlight = useRef(false);
  const deliveryDetails = useRef<HTMLDetailsElement>(null);
  const act = async (action: () => Promise<TelegramStatus>) => {
    if (inFlight.current) return;
    inFlight.current = true; setWorking(true); setError("");
    try { setStatus(await action()); setEnablePreview(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Telegram 状态未确认，请刷新核对。"); }
    finally { inFlight.current = false; setWorking(false); }
  };
  useEffect(() => { if (window.runloom.telegramStatus) void act(() => window.runloom.telegramStatus!()); }, []);
  const loadArrangements = async () => {
    setError("");
    try {
      const value = await window.runloom.getAutomationOverview();
      if (!value.ok) throw new Error(value.error.message);
      setArrangements(value.value);
      const worker = await window.runloom.rssWorkerStatus();
      setWorkerState(worker.ok ? worker.running ? "后台任务服务正在运行" : worker.registered ? "后台任务服务已注册，当前未运行" : "后台任务服务未启用；仅连接 Telegram 不会执行到点提醒" : "后台任务服务状态未确认");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "安排读取失败"); }
  };
  if (!window.runloom.telegramStatus) return null;
  const label = error && !status ? "Telegram 状态未确认" : telegramConnectionLabel(status);
  return <section className="card" aria-label="Telegram 私聊入口">
    <div className="card-head"><span>从 Telegram 使用 Serika</span><button className="ghost" disabled={working} onClick={() => void act(() => window.runloom.telegramStatus!())}>刷新状态</button></div>
    <p role="status">{label}{status?.botUsername ? ` · @${status.botUsername}` : ""}</p>
    {status?.lastError ? <p className="hint">{status.lastError}</p> : null}
    {status?.capacity?.blocked ? <p className="error" role="alert">容量已满，请处理待核对或明确发送失败的项后重新连接。</p> : null}
    {status?.available && !status.tokenConfigured ? <p>在常驻助手使用的外部环境文件中添加 <code>TELEGRAM_BOT_TOKEN</code>，重启服务后再连接。不要把 Token 发到对话里。应用不会复制密钥到配置或页面。</p> : null}
    <p className="hint">在手机私聊中交办事项。Mac 与常驻助手需保持运行、联网。</p>
    {status?.owner ? <div><strong>已绑定：{status.owner.name}</strong><button className="ghost" disabled={busy || working} onClick={() => void act(async () => { await window.runloom.selectThread(status.owner!.threadId); return window.runloom.telegramStatus!(); })}>打开 Telegram 对话</button></div> : null}
    {status?.owner && window.runloom.setTelegramAutonomyEnabled ? <div className="telegram-autonomy">
      <p><strong>私聊自主执行：{status.autonomyPaused ? "已暂停" : status.autonomyEnabled ? "已开启" : "未开启"}</strong></p>
      <p className="hint">仅当前绑定私聊的聊天和工作任务；与桌面授权独立。更改在新执行中生效。“停止”取消当前执行并暂停免确认；手机发送“恢复自主执行”，或在这里重新明确授权，可恢复。</p>
      <button className="ghost" disabled={busy || working} onClick={() => status.autonomyEnabled
        ? void act(() => window.runloom.setTelegramAutonomyEnabled!({ enabled: false, expectedEnabled: true, expectedOwner: { userId: status.owner!.userId, chatId: status.owner!.chatId, threadId: status.owner!.threadId } }))
        : setAutonomyPreview(true)}>{status.autonomyEnabled ? "关闭私聊自主执行" : "开启私聊自主执行…"}</button>
      {autonomyPreview ? <div className="memory-setup-preview"><strong>允许 {status.owner.name} 从当前绑定私聊自主执行？</strong>
        <p>该私聊可连续读取和修改授权目录内的文件，Shell 复用桌面 Seatbelt，默认断网、不可用时拒绝执行。联网的本机 Shell、Computer、浏览器和终端控制仍需逐次确认。后台和定时任务不继承此授权。</p>
        <button disabled={busy || working} onClick={() => void act(async () => { const next = await window.runloom.setTelegramAutonomyEnabled!({ enabled: true, expectedEnabled: false, expectedOwner: { userId: status.owner!.userId, chatId: status.owner!.chatId, threadId: status.owner!.threadId } }); setAutonomyPreview(false); return next; })}>确认授权当前私聊</button>
        <button className="ghost" onClick={() => setAutonomyPreview(false)}>取消</button>
      </div> : null}
    </div> : null}
    <details><summary>连接诊断</summary>
      {status?.owner ? <p className="hint">账号 {status.owner.userId} · 私聊 {status.owner.chatId}</p> : null}
      {status?.capacity ? <p className="hint">活动入站 {status.capacity.inputs}/{status.capacity.inputLimit} · 活动投递 {status.capacity.deliveries}/{status.capacity.deliveryLimit}。已结束记录保留归档去重标记。</p> : null}
      <p className="hint">共享当前工作区记忆，使用独立对话。普通聊天忙时拒绝，不排队；确认、拒绝和停止优先处理。文件和命令是否逐次确认，取决于私聊独立授权；其他工具沿用原权限。</p>
    </details>
    {status?.pairing ? <div className="memory-setup-preview"><strong>在机器人私聊发送：<code>/start {status.pairing.code}</code></strong><p className="hint">有效至 {new Date(status.pairing.expiresAt).toLocaleTimeString()}。发送后点击刷新，再核对账号。</p>
      {status.pairing.proposed ? <><p>待绑定：{status.pairing.proposed.name} · 账号 {status.pairing.proposed.userId} · 私聊 {status.pairing.proposed.chatId}</p><button disabled={busy || working} onClick={() => void act(() => window.runloom.confirmTelegramPairing!(status.pairing!.code))}>确认这是我的账号并绑定</button></> : null}
    </div> : null}
    <div className="memory-actions">
      {!status?.enabled ? <button className="ghost" disabled={busy || working || !status?.available || !status.tokenConfigured} onClick={() => setEnablePreview(true)}>连接 Telegram…</button> : <button className="ghost" disabled={busy || working} onClick={() => void act(() => window.runloom.setTelegramEnabled!(false))}>关闭 Telegram 连接</button>}
      {status?.connection === "failed" && status.enabled ? <button className="ghost" disabled={busy || working} onClick={() => void act(() => window.runloom.setTelegramEnabled!(true))}>重新连接</button> : null}
      {status?.connection === "online" && !status.owner ? <button className="ghost" disabled={busy || working} onClick={() => void act(() => window.runloom.beginTelegramPairing!())}>生成一次性绑定码</button> : null}
    </div>
    {enablePreview ? <div className="memory-setup-preview"><strong>允许当前工作区连接你的 Telegram 机器人？</strong><p>绑定前不接收任务；绑定后仅向该私聊发送你交办的回复和工具确认。不会外发旧桌面对话、自动转发全部提醒或扩大权限。</p><button disabled={busy || working} onClick={() => void act(() => window.runloom.setTelegramEnabled!(true))}>确认连接</button><button className="ghost" disabled={working} onClick={() => setEnablePreview(false)}>取消</button></div> : null}
    {status && (status.awaitingReview || status.failedDeliveries || status.unknownDeliveries) ? <div className="error" role="status">效果待核对 {status.awaitingReview} · 发送失败 {status.failedDeliveries} · 发送结果未知 {status.unknownDeliveries}。<button className="ghost" onClick={() => { if (deliveryDetails.current) { deliveryDetails.current.open = true; deliveryDetails.current.scrollIntoView({ block: "nearest" }); } }}>查看并核对</button><p className="hint">投递失败不重做任务；未知投递不自动重发。</p></div> : null}
    {status?.owner ? <details ref={deliveryDetails}><summary>提醒投递设置与回执 · 已选择 {status.routes.length} 项 · 待发送 {status.pendingDeliveries}</summary>
      <p className="hint">在 Telegram 新建的完整安排发送到这个私聊；桌面旧安排必须逐项选择。执行、平台接收和你已阅读是不同状态。</p>
      <button className="ghost" disabled={working} onClick={() => void loadArrangements()}>查看可选择的已有安排</button>
      {workerState ? <p className="hint">{workerState}</p> : null}
      {arrangements && !arrangements.tasksEnabled ? <p className="hint">当前任务能力已关闭，无法在这里选择新安排；已选定的后台投递不因此停止。</p> : null}
      {arrangements?.truncated ? <p className="hint">只显示最近的部分安排；未显示的安排不会自动选择。</p> : null}
      {arrangements ? [...arrangements.scheduled.filter(x => x.arrangement && !x.recurringTaskId).map(x => ({ id: x.id, kind: "once" as const, label: x.promptPreview })),
        ...arrangements.recurring.filter(x => x.arrangement && x.status === "active").map(x => ({ id: x.id, kind: "recurring" as const, label: x.promptPreview }))]
        .filter(x => !status.routes.some(route => route.id === x.id && route.kind === x.kind)).map(item => <div className="capability-row" key={`${item.kind}:${item.id}`}><span>{item.label}</span><button className="ghost" disabled={working || !status.enabled} onClick={() => setRoutePreview(item)}>发送到 Telegram…</button></div>) : null}
      {status.routes.map(item => <div className="capability-row" key={`${item.kind}:${item.id}`}><span>{item.kind === "recurring" ? "定期安排（仅选择后的新结果）" : "一次性安排"}<code>{item.id}</code></span><button className="ghost" disabled={working} onClick={() => void act(() => window.runloom.setTelegramTaskRoute!({ ...item, enabled: false }))}>停止此项 Telegram 投递</button></div>)}
      {routePreview ? <div className="memory-setup-preview"><strong>将这项安排的结果发送给 {status.owner.name}？</strong><p>{routePreview.label}</p><p className="hint">结果正文将外发到绑定私聊；定期安排只发送选择之后的新结果。不改变执行权限，也不重做旧任务。</p><button disabled={working || !status.enabled} onClick={() => void act(async () => { const next = await window.runloom.setTelegramTaskRoute!({ id: routePreview.id, kind: routePreview.kind, enabled: true }); setRoutePreview(null); return next; })}>确认投递目的地</button><button className="ghost" onClick={() => setRoutePreview(null)}>取消</button></div> : null}
      {status.deliveries.map(item => <div key={item.key} className="capability-row"><div><strong>{item.state === "submitted" ? "平台已接收（不代表已读）" : item.state === "failed" ? "明确发送失败" : item.state === "unknown" ? "发送结果未知，不重发" : "等待发送"}</strong><p className="hint">{item.preview}</p>{item.error ? <p className="hint">{item.error}</p> : null}{item.reviewReport ? <p className="hint">已记录观察：{item.reviewReport}（原结果仍未知）</p> : null}</div>{item.retryAllowed ? <button className="ghost" disabled={working} onClick={() => void act(() => window.runloom.retryTelegramDelivery!(item.key))}>只重试发送</button> : null}{window.runloom.resolveTelegramDelivery && ["pending", "failed"].includes(item.state) ? <button className="ghost" disabled={working} onClick={() => setCancelDelivery(item.key)}>停止发送…</button> : null}{window.runloom.resolveTelegramDelivery && item.state === "unknown" && !item.reviewReport ? <button className="ghost" disabled={working} onClick={() => setDeliveryReview({ key: item.key, note: "" })}>记录投递核对…</button> : null}</div>)}
      {cancelDelivery ? <div className="memory-setup-preview"><strong>停止这条消息的后续发送？</strong><p>保留原任务和执行回执；不会撤回已经提交的消息，也不会重做任务。</p><button disabled={working} onClick={() => void act(async () => { const value = await window.runloom.resolveTelegramDelivery!({ key: cancelDelivery, action: "cancel" }); setCancelDelivery(null); return value; })}>确认停止发送</button><button className="ghost" onClick={() => setCancelDelivery(null)}>返回</button></div> : null}
      {deliveryReview ? <div className="memory-setup-preview"><strong>记录手机上实际看到的投递情况</strong><p>原记录仍是未知，不会改成成功或重发；处理后允许归档其去重与核对记录。</p><textarea aria-label="投递核对观察" value={deliveryReview.note} maxLength={2000} onChange={event => setDeliveryReview({ ...deliveryReview, note: event.target.value })}/><button disabled={working || !deliveryReview.note.trim()} onClick={() => void act(async () => { const value = await window.runloom.resolveTelegramDelivery!({ ...deliveryReview, action: "review" }); setDeliveryReview(null); return value; })}>保存核对观察</button><button className="ghost" onClick={() => setDeliveryReview(null)}>返回</button></div> : null}
    </details> : null}
    {status?.reviews.map(item => <div key={item.key} className="capability-row"><div><strong>需核对：{item.runId ?? "启动结果未确认"}</strong><p className="hint">{item.taskId ? "先在工作任务中核对未知效果，再报告已完成核对。" : "先打开 Telegram 对话，检查执行回执及实际文件或应用状态。"}</p></div><button className="ghost" disabled={busy || working} onClick={() => setReview({ key: item.key, note: "" })}>记录核对观察…</button></div>)}
    {review ? <div className="memory-setup-preview"><strong>记录你实际观察到的效果</strong><p>这只解除通道的待核对提醒，不修改原回执，不证明成功，也不会重做或恢复授权。</p><textarea aria-label="Telegram 执行核对观察" value={review.note} maxLength={2000} onChange={event => setReview({ ...review, note: event.target.value })} /><button disabled={busy || working || !review.note.trim()} onClick={() => void act(async () => { const value = await window.runloom.reviewTelegramInput!(review); setReview(null); return value; })}>确认已核对并保存观察</button><button className="ghost" disabled={working} onClick={() => setReview(null)}>取消</button></div> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}
