import React from "react";
import type { ThreadSummary } from "../../shared/ui-contract.js";
import { formatRecordTime } from "../../shared/execution-records.js";
import { Icon } from "./icons.js";

/** Input is the current workspace's registered list, never filesystem discovery. */
export function recentThreads(threads: readonly ThreadSummary[], currentId: string): ThreadSummary[] {
  return [...threads].reverse().sort((a, b) => {
    if (a.threadId === b.threadId) return 0;
    if (a.threadId === currentId) return -1;
    if (b.threadId === currentId) return 1;
    return (Date.parse(b.savedAt ?? "") || 0) - (Date.parse(a.savedAt ?? "") || 0);
  }).slice(0, 5);
}

export function RecentThreads({ threads, currentId, loading, error, busy, onSelect, onAll }: {
  threads: readonly ThreadSummary[]; currentId: string; loading: boolean; error: string | null; busy: boolean;
  onSelect: (id: string) => void; onAll: () => void;
}) {
  return <section className="recent-threads" aria-label="最近对话">
    <div className="sidebar-section">最近对话</div>
    {loading ? <p className="sidebar-hint" role="status">正在读取…</p> : null}
    {error ? <p className="sidebar-hint" role="status">对话列表读取失败，旧对话未删除。</p> : null}
    {!loading && !error ? recentThreads(threads, currentId).map(thread => <button key={thread.threadId}
      className={thread.threadId === currentId ? "recent-thread selected" : "recent-thread"}
      aria-current={thread.threadId === currentId ? "true" : undefined}
      disabled={busy || !!thread.error} title={thread.error ?? thread.title}
      onClick={() => onSelect(thread.threadId)}>
      <span>{thread.title}</span><small>{thread.threadId === currentId ? "当前对话" : thread.savedAt ? `保存于 ${formatRecordTime(thread.savedAt)}` : "尚无已保存消息"}</small>
    </button>) : null}
    <button className="ghost all-threads" title="查看全部对话" aria-label={error ? "查看全部对话／重新读取" : "查看全部对话"} onClick={onAll}><Icon name="chat" /><span>查看全部对话{error ? "／重新读取" : ""}</span></button>
    {busy ? <p className="sidebar-hint">处理结束后可切换对话</p> : null}
  </section>;
}
