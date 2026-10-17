import React, { useEffect, useState } from "react";
import type { RssAction, RssInbox, RssView } from "@serika/example-cli/dist/rss-subscriptions.js";
import type { RssWorkerResponse } from "../../shared/ui-contract.js";
import { MessageContent } from "./markdown.js";

export function RssPanel({ enabled, busy, showInbox = true }: { enabled: boolean; busy: boolean; showInbox?: boolean }) {
  const [view, setView] = useState<RssView | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [time, setTime] = useState("09:00");
  const [offset, setOffset] = useState("+08:00");
  const [preview, setPreview] = useState<{ action: RssAction; label: string } | null>(null);
  const [workerPreview, setWorkerPreview] = useState<boolean | null>(null);
  const [worker, setWorker] = useState<RssWorkerResponse | null>(null);
  const [inbox, setInbox] = useState<RssInbox | null>(null);
  const [inboxError, setInboxError] = useState("");
  async function reloadInbox() {
    try {
      const result = await window.runloom.getRssInbox();
      if (result.ok) { setInbox(result.value); setInboxError(""); }
      else { setInbox(null); setInboxError(result.error.message); }
    } catch { setInbox(null); setInboxError("简报读取失败，不代表没有结果。"); }
  }
  async function reload() {
    try {
      const result = await window.runloom.getRssSubscriptions();
      if (result.ok) { setView(result.value); setError(""); }
      else { setView(null); setError(result.error.message); }
    } catch { setView(null); setError("资讯订阅读取失败，不代表列表为空。"); }
  }
  useEffect(() => { if (enabled) { void reload(); if (showInbox) void reloadInbox(); } }, [enabled, showInbox]);
  async function save() {
    if (!preview || pending || busy) return;
    setPending(true);
    try {
      const result = await window.runloom.updateRssSubscriptions(preview.action);
      setPreview(null);
      if (result.ok) { setView(result.value); setError(""); setName(""); setUrl(""); }
      else { await reload(); setError(result.error.message + "；请重新核对后操作。"); }
    } catch { setPreview(null); setError("修改失败，请刷新核对状态，勿盲目重试。"); }
    finally { setPending(false); }
  }
  if (!enabled) return null;
  const disabled = busy || pending;
  return <section className="card rss-panel">
    <div className="card-head"><span>资讯订阅</span><button className="ghost" disabled={disabled} onClick={() => { setPreview(null); void reload(); }}>刷新</button></div>
    <p className="hint">公开 RSS／Atom；后台仅抓取这些订阅。每源每次最多展示 5 条，首次在读取的最多 20 条内建立基线。简报不代表核实了文章原文，也不会自动写入记忆。</p>
    {error ? <p role="alert">{error}</p> : null}
    {view ? <>
      <p>{view.scheduleId ? `排期${view.enabled ? "已启用" : "已暂停"}，不代表 worker 正在运行。` : "尚未排期。先添加订阅，再明确启用。"}</p>
      {view.schedule ? <p className="hint">{view.schedule.recurrence.kind === "daily" ? "每天" : `每周 weekday ${view.schedule.recurrence.weekday}`} {view.schedule.recurrence.time} · 固定 UTC{view.schedule.recurrence.utcOffset} · series {view.schedule.status} · 下次 {view.schedule.nextRunAt ?? "无"}</p> : null}
      {view.sources.map(source => <div className="capability-row" key={source.id}>
        <div><strong>{source.name}</strong><p>{source.url}</p><small>{source.enabled ? "启用" : "停用"} · {source.initialized ? `已记录 ${source.seenCount} 个条目标识` : "等待首次抓取"}</small></div>
        <div><button className="ghost" disabled={disabled} onClick={() => setPreview({ action: { action: "source-enabled", id: source.id, enabled: !source.enabled, expectedRevision: view.revision }, label: `${source.enabled ? "停用" : "启用"} ${source.name}` })}>{source.enabled ? "停用" : "启用"}</button>
          <button className="ghost" disabled={disabled} onClick={() => setPreview({ action: { action: "remove", id: source.id, expectedRevision: view.revision }, label: `删除 ${source.name} 及其去重记录；重新添加会再次建立基线` })}>删除</button></div>
      </div>)}
      <form className="work-task-form" onSubmit={event => { event.preventDefault(); setPreview({ action: { action: "add", name, url, expectedRevision: view.revision }, label: `添加并启用订阅 ${name}：${url}` }); }}>
        <label>来源名称<input value={name} onChange={e => setName(e.target.value)} required maxLength={100} disabled={disabled} /></label>
        <label>Feed 地址<input type="url" value={url} onChange={e => setUrl(e.target.value)} required maxLength={2048} placeholder="https://…/feed.xml" disabled={disabled} /></label>
        <button className="ghost" disabled={disabled || view.sources.length >= 8}>添加订阅…</button>
      </form>
      {!view.scheduleId ? <form className="work-task-form" onSubmit={e => { e.preventDefault(); setPreview({ action: { action: "schedule", expectedRevision: view.revision, recurrence: { kind: "daily", time, utcOffset: offset } }, label: `每天 ${time}（固定 UTC${offset}）抓取启用的订阅；不处理夏令时` }); }}>
        <label>每天<input type="time" required value={time} onChange={e => setTime(e.target.value)} disabled={disabled} /></label>
        <label>固定 UTC 偏移<input value={offset} pattern="[+-][0-9]{2}:[0-9]{2}" required onChange={e => setOffset(e.target.value)} disabled={disabled} /></label>
        <button className="ghost" disabled={disabled || !view.sources.some(s => s.enabled)}>启用排期…</button>
      </form> : <button className="ghost" disabled={disabled} onClick={() => setPreview({ action: { action: "enabled", enabled: !view.enabled, expectedRevision: view.revision }, label: `${view.enabled ? "暂停" : "恢复"}资讯排期；已经开始的请求或交付无法撤回` })}>{view.enabled ? "暂停排期…" : "恢复排期…"}</button>}
      {preview ? <div className="card"><p>{preview.label}</p><p className="hint">只修改订阅或排期，不会立即抓取，也不会自动启动后台服务。</p><button disabled={disabled} onClick={() => void save()}>确认</button><button className="ghost" disabled={pending} onClick={() => setPreview(null)}>取消</button></div> : null}
    </> : null}
    <details><summary>后台服务与授权</summary>
    <p className="hint">关窗口或退出后继续执行，需要独立 macOS 后台服务。这里不会自动启用；服务会处理当前工作区全部到期任务，但只有已绑定的资讯任务能抓取订阅。</p>
    {worker ? <p role="status">{worker.ok ? `${worker.registered ? "服务已注册" : "服务未注册"} · ${worker.running ? "launchd 报告进程运行中" : "未报告运行 PID"}${worker.registered && !worker.rssEnabled ? "；未确认 RSS 开关，需停用后重新启用" : ""}` : worker.message}</p> : null}
    <button className="ghost" disabled={disabled} onClick={() => { setPending(true); void window.runloom.rssWorkerStatus().then(setWorker).catch(() => setWorker({ ok: false, message: "后台状态查询失败。" })).finally(() => setPending(false)); }}>查询后台状态</button>
    <button className="ghost" disabled={disabled} onClick={() => setWorkerPreview(true)}>启用后台服务…</button>
    <button className="ghost" disabled={disabled} onClick={() => setWorkerPreview(false)}>停用后台服务…</button>
    {workerPreview !== null ? <div className="card"><p>{workerPreview ? "允许独立后台服务抓取已启用订阅，将 feed 快照发送给配置的模型，结果保存在 inbox；开启任务状态通知，但不保证你已看到。" : "停用当前工作区后台服务。这也会停止其他定时任务的后台执行；已有 inbox 结果不会删除。"}</p>
      <button disabled={disabled} onClick={() => { setPending(true); void window.runloom.setRssWorkerEnabled(workerPreview).then(setWorker).catch(() => setWorker({ ok: false, message: "服务操作失败，请查询状态后再决定。" })).finally(() => { setPending(false); setWorkerPreview(null); }); }}>确认</button><button className="ghost" disabled={pending} onClick={() => setWorkerPreview(null)}>取消</button></div> : null}
    </details>
    {showInbox ? <><div className="card-head"><span>未确认的资讯结果</span><button className="ghost" disabled={disabled} onClick={() => void reloadInbox()}>刷新结果</button></div>
    <p className="hint">已排期 ≠ 已执行 ≠ 已收到通知。completed 只表示 Run 正常结束，不保证内容正确。</p>
    {inboxError ? <p role="alert">{inboxError}</p> : null}
    {inbox?.tasks.length === 0 ? <p>没有未确认的资讯结果。</p> : null}
    {inbox?.tasks.map(task => <details key={task.id}><summary>{task.status} · {task.finishedAt ?? "结束时间未记录"}</summary>
      <small>任务 ID：{task.id}</small><MessageContent text={task.text} />{task.textTruncated ? <p className="hint">显示内容已截断；完整结果保存在任务 inbox。</p> : null}
      <button className="ghost" disabled={disabled} onClick={() => { setPending(true); void window.runloom.acknowledgeRssResult(task.id).then(async result => { if (result.ok) await reloadInbox(); else setInboxError(result.error.message); }).catch(() => setInboxError("确认失败，请刷新核对。")).finally(() => setPending(false)); }}>标为已读</button>
    </details>)}
    {inbox?.truncated ? <p className="hint">只显示最近 5 条未确认结果；标为已读后刷新可看更早记录。</p> : null}</> : <p className="hint">资讯结果与提醒、日报统一显示在「提醒」页的刚刚触发。</p>}
  </section>;
}
