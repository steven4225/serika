import { useEffect, useState } from "react";
import type { AppInfo, ThreadSummary } from "../../shared/ui-contract.js";
import { formatRecordTime } from "../../shared/execution-records.js";
import { humanFacingTitle } from "../../shared/human-title.js";
import { visibleThreads, threadTitle } from "./thread-list-data.js";

export function ThreadsPanel({ info, busy, onSelect, onCreate, onChanged, drafts = new Map() }: { info: AppInfo; busy: boolean; onSelect?: (id: string) => Promise<void>; onCreate?: () => Promise<void>; onChanged?: () => void; drafts?: ReadonlyMap<string, string> }) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [directory, setDirectory] = useState("");
  const [discovered, setDiscovered] = useState<ThreadSummary[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = async () => { setRefreshToken(value => value + 1); onChanged?.(); };
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void window.runloom.listThreads(query).then(result => { if (active) { setThreads(result); setError(""); } })
        .catch(cause => { if (active) setError(String(cause)); }).finally(() => { if (active) setLoading(false); });
    }, query ? 180 : 0);
    return () => { active = false; clearTimeout(timer); };
  }, [query, refreshToken]);
  const act = async (operation: () => Promise<void>) => {
    if (busy || working) return;
    setWorking(true); setError("");
    try { await operation(); await refresh(); }
    catch (cause) { setError(String(cause)); }
    finally { setWorking(false); }
  };
  const matched = query.trim() ? threads.filter(thread => thread.matchesQuery || thread.error || drafts.get(thread.threadId)?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : threads;
  const shown = visibleThreads(matched, info.threadId, drafts, showEmpty);
  return <section className="thread-list">
    <div className="thread-search"><label htmlFor="conversation-search">搜索对话</label><input id="conversation-search" type="search" autoComplete="off" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入聊过的内容或任务关键词" /><button className="ghost" disabled={working || loading} onClick={() => void refresh()}>刷新</button></div>
    {info.identitySource === "explicit" ? <p className="hint">这次启动使用了环境变量指定的会话。移除 RUNLOOM_THREAD / RUNLOOM_TRANSCRIPTS 覆盖后，才按列表里的选择启动。</p> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
    <p className="thread-list-caption">{query ? "搜索当前工作区已登记的完整对话正文和任务目标" : "最近使用的对话"}{busy ? " · 当前处理结束后可切换" : ""}</p>
    {loading ? <p role="status" className="hint">{query ? "正在搜索…" : "正在读取对话…"}</p> : !error && shown.length === 0 ? <p role="status" className="thread-empty">{query ? "没有匹配的对话，试试另一关键词。" : "还没有聊过的内容。回到对话，直接说你想完成什么。"}</p> : null}
    {!loading && !error ? shown.map(thread => <article className={`conversation-list-item${thread.threadId === info.threadId ? " current" : ""}`} key={thread.threadId}>
      <button className="conversation-list-open" disabled={busy || working || !!thread.error} aria-label={`${thread.threadId === info.threadId ? "回到当前对话" : "打开对话"}：${threadTitle(thread, drafts.get(thread.threadId))}`} onClick={() => void act(() => onSelect ? onSelect(thread.threadId) : window.runloom.selectThread(thread.threadId))}>
        <span className="conversation-list-heading"><strong>{threadTitle(thread, drafts.get(thread.threadId))}</strong><small>{thread.activityAt || thread.savedAt ? formatRecordTime(thread.activityAt ?? thread.savedAt!) : ""}</small></span>
        <span className="conversation-list-preview">{thread.error ? "记录暂不可读，请查看详情" : drafts.has(thread.threadId) ? `草稿：${drafts.get(thread.threadId)}` : thread.preview || (thread.taskCount ? "已创建工作任务，打开后查看下一步" : thread.runCount ? "有执行记录，打开后查看结果" : "尚未发送消息")}</span>
        <span className="conversation-list-tags">{thread.threadId === info.threadId ? <span>当前对话</span> : null}{thread.taskCount ? <span>{thread.taskCount} 项工作任务</span> : null}{drafts.has(thread.threadId) ? <span>未发送</span> : null}</span>
      </button>
      <details className="conversation-list-details"><summary aria-label={`记录详情：${thread.title}`}>记录详情</summary>{thread.error ? <p role="alert" className="error">{thread.error}</p> : null}<p className="hint">{thread.messageCount ?? "未知"} 条已保存消息 · {thread.runCount ?? "未知"} 条执行记录</p><code>{thread.transcriptDirectory}</code><p className="hint">Thread：{thread.threadId}</p></details>
    </article>) : null}
    {!query ? <label className="thread-empty-toggle"><input type="checkbox" checked={showEmpty} onChange={event => setShowEmpty(event.target.checked)} />显示未使用的对话（不删除记录）</label> : null}
    <details className="history-registration"><summary>工作区与启动配置</summary><p className="hint">只搜索当前工作区已登记的内容，不扫描其他目录。</p><code>{info.workspaceRoot ?? "未配置工作区"}</code><p className="hint">{info.entryMode === "test" ? "隔离测试入口" : "日用入口"}</p></details>
    <details className="history-registration">
      <summary>找回旧目录里的对话</summary>
      <p className="hint">先查看旧 transcript 目录，再明确登记所选对话属于当前工作区。原文件留在原处；这里只保存入口。</p>
      <label>历史目录<input aria-label="历史目录" value={directory} onChange={event => { setDirectory(event.target.value); setDiscovered([]); setSearched(false); setConfirmed(false); }} placeholder="旧 transcript 目录的绝对路径" /></label>
      <div className="memory-actions">
        <button className="ghost" disabled={working || busy} onClick={() => void act(async () => { const path = await window.runloom.chooseHistoryDirectory(); if (path) { setDirectory(path); setDiscovered([]); setSearched(false); setConfirmed(false); } })}>选择目录</button>
        <button disabled={working || busy || !directory} onClick={() => void act(async () => { setSearched(false); setDiscovered([]); setConfirmed(false); setDiscovered(await window.runloom.discoverThreads(directory)); setSearched(true); })}>查看旧对话</button>
      </div>
      {searched && discovered.length === 0 ? <p role="status" className="hint">这个目录没有可识别的 Serika 对话，请核对是否选择了 transcript 目录。没有导入或移动任何文件。</p> : null}
      {discovered.length ? <label className="history-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认所选旧对话属于当前工作区，允许在这里继续使用</label> : null}
      {discovered.map(thread => <div className="thread-item" key={thread.threadId}><div><strong>{humanFacingTitle(thread.title, "旧对话")}</strong><p className="hint">{thread.messageCount ?? "未知"} 条消息</p><details className="technical-id"><summary>编号</summary><code>{thread.threadId}</code></details>{thread.error ? <p className="error">{thread.error}</p> : null}</div>
        <button disabled={!confirmed || working || busy || !!thread.error} onClick={() => void act(() => window.runloom.registerThread({ threadId: thread.threadId, transcriptDirectory: thread.transcriptDirectory, confirmedWorkspace: true }))}>登记对话</button></div>)}
    </details>
  </section>;
}
