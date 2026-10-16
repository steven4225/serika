import React from "react";
import { Briefcase, ChevronLeft, ChevronRight, Crown, Folder, Sparkles } from "lucide-react";
import { MessageContent } from "../markdown.js";
import { savedMemoryEmptyCopy } from "../memory-copy.js";
import {
  MEMORY_CATEGORIES,
  isCurrentMemory,
  memoryCategory,
  memoryCategoryCounts,
  memoryCountLabel,
  memoryItemTitle,
  memorySourcePhrase,
  memoryUnderstanding,
  memoryUpdatedLabel,
  type MemoryCardEntry,
  type MemoryCategoryId,
} from "./memory-cards.js";

const ICONS = { preference: Sparkles, project: Folder, work: Briefcase } as const;

export function MemoryBack({ label, onBack }: { label: string; onBack: () => void }) {
  return <div className="memory-back-row">
    <button type="button" className="memory-back" aria-label="返回" onClick={onBack}><ChevronLeft size={18} /></button>
    <h1>{label}</h1>
  </div>;
}

export function MemoryCardHome({ loaded, entries, now, onOpenSummary, onOpenCategory }: {
  loaded: boolean;
  entries: readonly MemoryCardEntry[];
  now: Date;
  onOpenSummary: () => void;
  onOpenCategory: (category: MemoryCategoryId) => void;
}) {
  const understanding = memoryUnderstanding(entries, now);
  const counts = memoryCategoryCounts(entries, now);
  const current = entries.filter(entry => isCurrentMemory(entry, now) && entry.preview.trim());
  return <div className="memory-home" data-memory-view="home">
    <button type="button" className="memory-summary-card" onClick={onOpenSummary} aria-label="我对你的了解，打开全文">
      <span className="memory-summary-heading"><span className="memory-summary-mark" aria-hidden="true"><Crown size={22} /></span><h2>我对你的了解</h2></span>
      {loaded && !understanding.empty ? <p className="memory-updated">{understanding.updatedLabel}</p> : <p className="memory-updated">{loaded ? "还没有更新" : "读取中…"}</p>}
      {loaded && current.length > 0 ? <>
        <ul className="memory-summary-items">{current.slice(0, 3).map(entry => <li key={entry.id}>
          <p className="memory-summary-body">{entry.preview.replace(/^#{1,6}\s+/gm, "").trim()}{entry.truncated ? "…" : ""}</p>
        </li>)}</ul>
        <span className="memory-summary-more">查看全部 {current.length} 条记忆</span>
      </> : <p className="memory-summary-body">{loaded ? savedMemoryEmptyCopy() : "正在读取已经记住的内容。"}</p>}
    </button>
    <h2 className="memory-section-label">全部</h2>
    <div className="memory-bento">
      {MEMORY_CATEGORIES.map(category => {
        const Icon = ICONS[category.id];
        const count = counts[category.id];
        return <button type="button" className="personal-entry-card memory-category-card" key={category.id} data-category={category.id} onClick={() => onOpenCategory(category.id)} aria-label={`${category.name}，${loaded ? memoryCountLabel(count) : "读取中"}`}>
          <span className={`memory-category-icon ${category.id}`} aria-hidden="true"><Icon size={18} /></span>
          <span className="entry-card-copy"><strong>{category.name}</strong><span>{loaded ? memoryCountLabel(count) : "读取中"}</span></span>
          <span className="entry-card-arrow" aria-hidden="true"><ChevronRight size={18} /></span>
        </button>;
      })}
    </div>
  </div>;
}

export function MemoryCategoryFolder({ category, entries, now, onBack, onOpen }: {
  category: MemoryCategoryId;
  entries: readonly MemoryCardEntry[];
  now: Date;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const name = MEMORY_CATEGORIES.find(item => item.id === category)?.name ?? "记忆";
  const items = entries.filter(entry => isCurrentMemory(entry, now) && memoryCategory(entry) === category);
  return <div className="memory-folder" data-memory-view="category">
    <MemoryBack label={name} onBack={onBack} />
    <p className="memory-updated">{memoryCountLabel(items.length)}</p>
    {items.length === 0 ? <p className="memory-empty">{savedMemoryEmptyCopy()}</p> : null}
    {items.map(entry => <button type="button" className="memory-item-card" key={entry.id} onClick={() => onOpen(entry.id)}>
      <strong>{memoryItemTitle(entry.preview)}</strong>
      <small>{memoryUpdatedLabel(entry.updatedAt ?? entry.createdAt, now)}</small>
      <p>{entry.preview.replace(/^#{1,6}\s+/gm, "").trim() || "当前没有适用内容"}{entry.truncated ? "…" : ""}</p>
      <span className="memory-source-line">{memorySourcePhrase(entry.assertion?.sourceIds ?? [])}</span>
    </button>)}
  </div>;
}

export function MemoryUnderstanding({ entries, texts, now, onBack }: {
  entries: readonly MemoryCardEntry[];
  texts: Readonly<Record<string, string>>;
  now: Date;
  onBack: () => void;
}) {
  const understanding = memoryUnderstanding(entries, now);
  const live = entries.filter(entry => isCurrentMemory(entry, now));
  return <div className="memory-understanding" data-memory-view="summary">
    <MemoryBack label="我对你的了解" onBack={onBack} />
    {!understanding.empty ? <p className="memory-updated">{understanding.updatedLabel}</p> : null}
    {understanding.empty ? <p>{savedMemoryEmptyCopy()}</p> : MEMORY_CATEGORIES.map(category => {
      const items = live.filter(entry => memoryCategory(entry) === category.id && (entry.preview.trim() || texts[entry.id]));
      if (items.length === 0) return null;
      return <section key={category.id}>
        <h2>{category.name}</h2>
        {items.map(entry => {
          const saved = texts[entry.id];
          const body = saved !== undefined && saved !== "" ? saved : `${entry.preview}${entry.truncated ? "…" : ""}`;
          return <article key={entry.id}>
            <MessageContent text={body || "当前没有适用内容"} />
            <p className="memory-source-line">{memorySourcePhrase(entry.assertion?.sourceIds ?? [])}</p>
          </article>;
        })}
      </section>;
    })}
  </div>;
}
