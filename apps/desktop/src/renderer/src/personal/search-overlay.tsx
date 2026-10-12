import React, { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import {
  deferredSearchHint,
  inspectMessageSearch,
  isDeferredSearchFilter,
  messageSearchNotice,
  revealSearchRow,
  SEARCH_FILTER_LABEL,
  SEARCH_FILTERS,
  SEARCH_HISTORY_UNAVAILABLE,
  SEARCH_KEYBOARD_HINT,
  SEARCH_NO_MATCH,
  SEARCH_PARTIAL_FAILURE,
  searchKeyAction,
  type MessageSearchHit,
  type MessageSearchInspection,
  type MessageSearchNotice,
  type SearchFilter,
} from "./search.js";

const EMPTY_INSPECTION: MessageSearchInspection = { hits: [], failedThreads: 0, readableThreads: 0 };

function SearchHint({ text, status = false }: { text: string; status?: boolean }) {
  const pivot = text.indexOf("，按 ↩");
  return <p role={status ? "status" : undefined}>{pivot === -1 ? text : <>{text.slice(0, pivot + 1)}<br />{text.slice(pivot + 1)}</>}</p>;
}

export function SearchResults({ hits, notice, index, filter, busy = false, listRef, onHover, onOpen }: {
  hits: readonly MessageSearchHit[];
  notice: MessageSearchNotice;
  index: number;
  filter: SearchFilter;
  busy?: boolean;
  listRef?: React.Ref<HTMLDivElement>;
  onHover?: (hitIndex: number) => void;
  onOpen?: (threadId: string) => void;
}) {
  if (hits.length === 0 && notice === "unavailable") {
    return <div className="personal-search-empty">
      <Search size={72} strokeWidth={1.25} aria-hidden="true" />
      <SearchHint text={SEARCH_HISTORY_UNAVAILABLE} status={true} />
      <SearchHint text={SEARCH_KEYBOARD_HINT} />
    </div>;
  }
  if (hits.length === 0) {
    return <div className="personal-search-empty">
      <Search size={72} strokeWidth={1.25} aria-hidden="true" />
      <SearchHint text={SEARCH_NO_MATCH} status={true} />
      {notice === "partial" ? <p className="personal-search-status" role="status">{SEARCH_PARTIAL_FAILURE}</p> : null}
      <SearchHint text={SEARCH_KEYBOARD_HINT} />
    </div>;
  }
  return <>
    {notice === "partial" ? <p className="personal-search-status" role="status">{SEARCH_PARTIAL_FAILURE}</p> : null}
    <div role="listbox" aria-label="搜索结果" ref={listRef}>
      <p className="personal-search-group">消息</p>
      {hits.map((hit, hitIndex) => <button type="button" role="option" className="personal-search-hit" key={`${hit.title}:${hit.preview}:${hitIndex}`} aria-selected={hitIndex === index} disabled={busy} onMouseEnter={() => onHover?.(hitIndex)} onClick={() => { if (!busy) onOpen?.(hit.threadId); }}>
        <strong>{hit.title}</strong>
        <small>{hit.preview}</small>
      </button>)}
      {filter === "all" ? <p className="personal-search-note">文件、链接和图片还不能在这里搜索，这次不会报错。</p> : null}
    </div>
  </>;
}

export function SearchOverlay({ drafts, busy = false, onClose, onOpenThread }: {
  drafts: ReadonlyMap<string, string>;
  busy?: boolean;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("message");
  const [inspection, setInspection] = useState<MessageSearchInspection>(EMPTY_INSPECTION);
  const [index, setIndex] = useState(-1);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const resultsRef = useRef<HTMLDivElement>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draftStamp = [...drafts].map(([id, text]) => `${id}\u0000${text}`).join("\u0001");

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (isDeferredSearchFilter(filter) || query.trim() === "") {
      setInspection(EMPTY_INSPECTION);
      setIndex(-1);
      setStatus("idle");
      return;
    }
    let active = true;
    setInspection(EMPTY_INSPECTION);
    setIndex(-1);
    setStatus("loading");
    const timer = window.setTimeout(() => {
      void window.runloom.listThreads(query.trim()).then(threads => {
        if (!active) return;
        const next = inspectMessageSearch(threads, query, draftsRef.current);
        setInspection(next);
        setIndex(next.hits.length > 0 ? 0 : -1);
        setStatus("ready");
      }).catch(() => {
        if (!active) return;
        setInspection(EMPTY_INSPECTION);
        setIndex(-1);
        setStatus("failed");
      });
    }, 160);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, filter, draftStamp]);

  useEffect(() => {
    if (index < 0) return;
    const row = resultsRef.current?.querySelectorAll<HTMLElement>('[role="option"]').item(index);
    revealSearchRow(row);
  }, [index, inspection]);

  const hits = inspection.hits;
  const notice = status === "ready" ? messageSearchNotice(inspection) : "none";
  const deferred = isDeferredSearchFilter(filter) ? deferredSearchHint(filter) : null;
  const showHits = !deferred && hits.length > 0;
  const emptyHint = deferred
    ?? (query.trim() === "" ? SEARCH_KEYBOARD_HINT : status === "failed" ? "消息搜索暂时失败，可以再试一次。" : status === "loading" ? "正在搜索…" : notice === "unavailable" ? SEARCH_HISTORY_UNAVAILABLE : SEARCH_NO_MATCH);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const action = searchKeyAction({ key: event.key, shiftKey: event.shiftKey, filter, index, count: showHits ? hits.length : 0 });
    switch (action.type) {
      case "ignore":
        return;
      case "close":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      case "cycle":
        event.preventDefault();
        setFilter(action.filter);
        setIndex(-1);
        return;
      case "move":
        event.preventDefault();
        setIndex(action.index);
        return;
      case "select": {
        event.preventDefault();
        const hit = hits[action.index];
        if (hit && !busy) onOpenThread(hit.threadId);
        return;
      }
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  };

  return <div className="personal-search-layer" onMouseDown={onClose}>
    <div className="personal-search-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={event => event.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="personal-search-input-row">
        <Search size={22} aria-hidden="true" />
        <input id={titleId} type="search" autoFocus autoComplete="off" maxLength={200} placeholder="搜索" aria-label="搜索" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="personal-search-filters" role="toolbar" aria-label="搜索筛选">
        {SEARCH_FILTERS.filter(item => item !== "all").map(item => <button type="button" key={item} aria-pressed={filter === item} onClick={() => { setFilter(item); setIndex(-1); }}>{SEARCH_FILTER_LABEL[item]}</button>)}
        <button type="button" className="personal-search-all" aria-pressed={filter === "all"} onClick={() => { setFilter("all"); setIndex(-1); }}><SlidersHorizontal size={15} aria-hidden="true" />{SEARCH_FILTER_LABEL.all}</button>
      </div>
      <div className="personal-search-body">
        {showHits || (status === "ready" && !deferred && query.trim() !== "") ? <SearchResults hits={hits} notice={notice} index={index} filter={filter} busy={busy} listRef={resultsRef} onHover={setIndex} onOpen={onOpenThread} /> : <div className="personal-search-empty">
          <Search size={72} strokeWidth={1.25} aria-hidden="true" />
          <SearchHint text={emptyHint} status={true} />
          {deferred || query.trim() !== "" ? <SearchHint text={SEARCH_KEYBOARD_HINT} /> : null}
        </div>}
      </div>
    </div>
  </div>;
}
