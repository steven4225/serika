import type { ThreadSummary } from "../../../shared/ui-contract.js";
import { humanFacingTitle } from "../../../shared/human-title.js";
import { threadTitle } from "../thread-list-data.js";

export const SEARCH_FILTERS = ["message", "file", "link", "image", "all"] as const;
export type SearchFilter = (typeof SEARCH_FILTERS)[number];

export const SEARCH_FILTER_LABEL: Record<SearchFilter, string> = {
  message: "消息",
  file: "文件",
  link: "链接",
  image: "图片",
  all: "全部",
};

export const SEARCH_KEYBOARD_HINT = "按 Tab 切换筛选，按 ↑↓ 导航，按 ↩ 选择，按 ESC 关闭";

const DEFERRED_FILTERS = ["file", "link", "image"] as const;
export type DeferredSearchFilter = (typeof DEFERRED_FILTERS)[number];

export function isDeferredSearchFilter(filter: SearchFilter): filter is DeferredSearchFilter {
  return filter === "file" || filter === "link" || filter === "image";
}

export function nextSearchFilter(current: SearchFilter, direction: 1 | -1): SearchFilter {
  const index = SEARCH_FILTERS.indexOf(current);
  const next = (index + direction + SEARCH_FILTERS.length) % SEARCH_FILTERS.length;
  return SEARCH_FILTERS[next] ?? "message";
}

export interface MessageSearchHit {
  threadId: string;
  title: string;
  preview: string;
}

/** Message hits reuse thread search. Titles and previews stay human; ids are not display text. */
export function messageSearchHits(threads: readonly ThreadSummary[], query: string, drafts: ReadonlyMap<string, string>): MessageSearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const hits: MessageSearchHit[] = [];
  for (const thread of threads) {
    const draft = drafts.get(thread.threadId);
    const draftHit = draft ? draft.toLocaleLowerCase().includes(needle) : false;
    if (thread.matchesQuery !== true && !draftHit) continue;
    const previewSource = (thread.preview ?? draft ?? "").replace(/\s+/g, " ").trim();
    hits.push({
      threadId: thread.threadId,
      title: threadTitle(thread, draft),
      preview: humanFacingTitle(previewSource, "打开这段对话"),
    });
  }
  return hits;
}

export function deferredSearchHint(filter: DeferredSearchFilter): string {
  return `${SEARCH_FILTER_LABEL[filter]}还不能在这里搜索，这次不会报错。可以改搜消息。`;
}

export type SearchKeyAction =
  | { type: "close" }
  | { type: "cycle"; filter: SearchFilter }
  | { type: "move"; index: number }
  | { type: "select"; index: number }
  | { type: "ignore" };

export function searchKeyAction(input: {
  key: string;
  shiftKey: boolean;
  filter: SearchFilter;
  index: number;
  count: number;
}): SearchKeyAction {
  switch (input.key) {
    case "Escape":
      return { type: "close" };
    case "Tab":
      return { type: "cycle", filter: nextSearchFilter(input.filter, input.shiftKey ? -1 : 1) };
    case "ArrowDown":
    case "ArrowUp": {
      if (input.count === 0) return { type: "move", index: -1 };
      const step = input.key === "ArrowDown" ? 1 : -1;
      if (input.index < 0) return { type: "move", index: step === 1 ? 0 : input.count - 1 };
      return { type: "move", index: (input.index + step + input.count) % input.count };
    }
    case "Enter":
      if (input.count === 0) return { type: "ignore" };
      return { type: "select", index: input.index < 0 ? 0 : input.index };
    default:
      return { type: "ignore" };
  }
}
