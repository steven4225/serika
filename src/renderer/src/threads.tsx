import { useEffect, useState } from "react";
import type { AppInfo, ThreadSummary } from "../../shared/ui-contract.js";

export function ThreadsPanel({ info, busy }: { info: AppInfo; busy: boolean }) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [directory, setDirectory] = useState("");
  const [discovered, setDiscovered] = useState<ThreadSummary[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => setThreads(await window.runloom.listThreads());
  useEffect(() => { void refresh().catch(cause => setError(String(cause))); }, []);
  const act = async (operation: () => Promise<void>) => {
    if (busy || working) return;
    setWorking(true); setError("");
    try { await operation(); await refresh(); }
    catch (cause) { setError(String(cause)); }
    finally { setWorking(false); }
  };
  return <section className="card thread-list">
    <div className="card-head"><span>当前工作区的对话</span><button disabled={busy || working} onClick={() => void act(() => window.runloom.createThread())}>新对话</button></div>
    <p className="hint">{info.workspaceRoot ?? "未配置工作区"} · 对话单独保存，正式 workspace 记忆可跨会话使用。</p>
    {info.identitySource === "explicit" ? <p className="hint">这次启动使用了环境变量指定的会话。移除 RUNLOOM_THREAD / RUNLOOM_TRANSCRIPTS 覆盖后，才按列表里的选择启动。</p> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
    {threads.map(thread => <div className="thread-item" key={thread.threadId}>
      <div><strong>{thread.title}</strong><p className="hint">{thread.threadId === info.threadId ? "当前 · " : ""}{thread.messageCount === null ? "历史不可读" : `${thread.messageCount} 条已保存消息`}</p>
        {thread.error ? <p className="error">{thread.error}</p> : null}
        <details><summary className="hint">保存位置</summary><code>{thread.transcriptDirectory}</code><p className="hint">Thread：{thread.threadId}</p></details>
      </div>
      <button className="ghost" disabled={busy || working || !!thread.error || thread.threadId === info.threadId} onClick={() => void act(() => window.runloom.selectThread(thread.threadId))}>打开对话</button>
    </div>)}
    <details className="history-registration">
      <summary>找回旧目录里的对话</summary>
      <p className="hint">先查看旧 transcript 目录，再明确登记所选对话属于当前工作区。原文件留在原处；这里只保存入口。</p>
      <label>历史目录<input aria-label="历史目录" value={directory} onChange={event => { setDirectory(event.target.value); setDiscovered([]); setConfirmed(false); }} placeholder="旧 transcript 目录的绝对路径" /></label>
      <div className="memory-actions">
        <button className="ghost" disabled={working || busy} onClick={() => void act(async () => { const path = await window.runloom.chooseHistoryDirectory(); if (path) { setDirectory(path); setDiscovered([]); setConfirmed(false); } })}>选择目录</button>
        <button disabled={working || busy || !directory} onClick={() => void act(async () => { setDiscovered(await window.runloom.discoverThreads(directory)); setConfirmed(false); })}>查看旧对话</button>
      </div>
      {discovered.length ? <label className="history-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认所选旧对话属于当前工作区，允许在这里继续使用</label> : null}
      {discovered.map(thread => <div className="thread-item" key={thread.threadId}><div><strong>{thread.title}</strong><p className="hint">{thread.threadId} · {thread.messageCount ?? "未知"} 条消息</p>{thread.error ? <p className="error">{thread.error}</p> : null}</div>
        <button disabled={!confirmed || working || busy || !!thread.error} onClick={() => void act(() => window.runloom.registerThread({ threadId: thread.threadId, transcriptDirectory: thread.transcriptDirectory, confirmedWorkspace: true }))}>登记对话</button></div>)}
    </details>
  </section>;
}
