import type { ThreadSummary } from "../../shared/ui-contract.js";

/** Display only. A missing probe or an error is never proof of emptiness. */
export function visibleThreads(threads: readonly ThreadSummary[], currentId: string, drafts: ReadonlyMap<string, string> = new Map(), showEmpty = false): ThreadSummary[] {
  return [...threads].reverse().filter(thread => showEmpty || thread.threadId === currentId || drafts.has(thread.threadId) || thread.emptyVerified !== true || !!thread.error)
    .sort((a, b) => {
      if (a.threadId === b.threadId) return 0;
      if (a.threadId === currentId) return -1;
      if (b.threadId === currentId) return 1;
      return (Date.parse(b.activityAt ?? b.savedAt ?? "") || 0) - (Date.parse(a.activityAt ?? a.savedAt ?? "") || 0);
    });
}

export function threadTitle(thread: ThreadSummary, draft?: string): string {
  return thread.emptyVerified && draft ? draft.replace(/\s+/g, " ").slice(0, 48) : thread.title;
}
