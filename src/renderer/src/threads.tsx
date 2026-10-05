import { useEffect, useState } from "react";
import type { AppInfo, ThreadSummary } from "../../shared/ui-contract.js";
import { formatRecordTime } from "../../shared/execution-records.js";

export function ThreadsPanel({ info, busy, onSelect, onCreate, onChanged }: { info: AppInfo; busy: boolean; onSelect?: (id: string) => Promise<void>; onCreate?: () => Promise<void>; onChanged?: () => void }) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [directory, setDirectory] = useState("");
  const [discovered, setDiscovered] = useState<ThreadSummary[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    setLoading(true);
    try { setThreads(await window.runloom.listThreads()); setError(""); onChanged?.(); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh().catch(cause => setError(String(cause))); }, []);
  const act = async (operation: () => Promise<void>) => {
    if (busy || working) return;
    setWorking(true); setError("");
    try { await operation(); await refresh(); }
    catch (cause) { setError(String(cause)); }
    finally { setWorking(false); }
  };
  return <section className="card thread-list">
    <div className="card-head"><span>当前工作区的对话</span><div className="actions"><button className="ghost" disabled={working} onClick={() => void refresh().catch(cause => setError(String(cause)))}>重新读取</button><button disabled={busy || working} onClick={() => void act(() => onCreate ? onCreate() : window.runloom.createThread())}>新对话</button></div></div>
    <p className="hint">{info.workspaceRoot ?? "未配置工作区"} · 对话单独保存，正式 workspace 记忆可跨会话使用。</p>
    {info.identitySource === "explicit" ? <p className="hint">这次启动使用了环境变量指定的会话。移除 RUNLOOM_THREAD / RUNLOOM_TRANSCRIPTS 覆盖后，才按列表里的选择启动。</p> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
    {loading ? <p role="status" className="hint">正在读取已登记的对话…</p> : !error && threads.length === 0 ? <p className="hint">当前工作区没有已登记的对话。旧记录不会自动导入，请在下方选择历史目录。</p> : null}
    {threads.map(thread => <div className={`thread-item${thread.threadId === info.threadId ? " current" : ""}`} key={thread.threadId}>
      <div><strong>{thread.title}</strong><p className="hint">{thread.threadId === info.threadId ? "当前 · " : ""}{thread.messageCount === null ? "历史不可读" : `${thread.messageCount} 条已保存消息`}</p>
        {thread.savedAt ? <p className="hint">最后保存：{formatRecordTime(thread.savedAt)}</p> : null}
        {thread.error ? <p className="error">{thread.error}</p> : null}
        <details><summary className="hint">保存位置</summary><code>{thread.transcriptDirectory}</code><p className="hint">Thread：{thread.threadId}</p></details>
      </div>
      <button className="ghost" disabled={busy || working || !!thread.error} onClick={() => void act(() => onSelect ? onSelect(thread.threadId) : window.runloom.selectThread(thread.threadId))}>{thread.threadId === info.threadId ? "回到当前对话" : "打开对话"}</button>
    </div>)}
    <details className="history-registration">
      <summary>找回旧目录里的对话</summary>
      <p className="hint">先查看旧 transcript 目录，再明确登记所选对话属于当前工作区。原文件留在原处；这里只保存入口。</p>
      <label>历史目录<input aria-label="历史目录" value={directory} onChange={event => { setDirectory(event.target.value); setDiscovered([]); setSearched(false); setConfirmed(false); }} placeholder="旧 transcript 目录的绝对路径" /></label>
      <div className="memory-actions">
        <button className="ghost" disabled={working || busy} onClick={() => void act(async () => { const path = await window.runloom.chooseHistoryDirectory(); if (path) { setDirectory(path); setDiscovered([]); setSearched(false); setConfirmed(false); } })}>选择目录</button>
        <button disabled={working || busy || !directory} onClick={() => void act(async () => { setSearched(false); setDiscovered([]); setConfirmed(false); setDiscovered(await window.runloom.discoverThreads(directory)); setSearched(true); })}>查看旧对话</button>
      </div>
      {searched && discovered.length === 0 ? <p role="status" className="hint">这个目录没有可识别的 Runloom 对话，请核对是否选择了 transcript 目录。没有导入或移动任何文件。</p> : null}
      {discovered.length ? <label className="history-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认所选旧对话属于当前工作区，允许在这里继续使用</label> : null}
      {discovered.map(thread => <div className="thread-item" key={thread.threadId}><div><strong>{thread.title}</strong><p className="hint">{thread.threadId} · {thread.messageCount ?? "未知"} 条消息</p>{thread.error ? <p className="error">{thread.error}</p> : null}</div>
        <button disabled={!confirmed || working || busy || !!thread.error} onClick={() => void act(() => window.runloom.registerThread({ threadId: thread.threadId, transcriptDirectory: thread.transcriptDirectory, confirmedWorkspace: true }))}>登记对话</button></div>)}
    </details>
  </section>;
}
