import { useEffect, useState } from "react";
import type { AppInfo, ThreadSummary, UiState } from "../../../shared/ui-contract.js";
import { humanFacingTitle } from "../../../shared/human-title.js";

/**
 * The thread list and the header's conversation title (split out of App.tsx;
 * same state and effect, called where the effect used to be declared so the
 * effect order is unchanged). The list refreshes only while idle.
 */
export function useThreadList(info: AppInfo | null, stateKind: UiState["kind"]) {
  const [conversationTitle, setConversationTitle] = useState("当前对话");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [threadsRefresh, setThreadsRefresh] = useState(0);
  useEffect(() => {
    if (!info) return;
    let active = true;
    const idle = stateKind === "idle";
    if (idle) setThreadsLoading(true);
    void window.runloom.listThreads().then(threads => {
      if (!active) return;
      // The header title stays human while a confirmation is open; the list itself refreshes only when idle.
      setConversationTitle(humanFacingTitle(threads.find(thread => thread.threadId === info.threadId)?.title, "当前对话"));
      if (idle) { setThreads(threads); setThreadsError(null); }
    }).catch(() => { if (active && idle) setThreadsError("对话列表读取失败"); })
      .finally(() => { if (active && idle) setThreadsLoading(false); });
    return () => { active = false; };
  }, [info, stateKind, threadsRefresh]);
  // threadsLoading/threadsError are written but not read, as before the split.
  return { conversationTitle, threads, refreshThreads: () => setThreadsRefresh(value => value + 1) };
}
