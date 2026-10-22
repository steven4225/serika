/** Presentation grouping for saved memories. This does not create a store or a new kind. */

export type MemoryCategoryId = "preference" | "project" | "work";

export const MEMORY_CATEGORIES: readonly { id: MemoryCategoryId; name: string }[] = [
  { id: "preference", name: "偏好" },
  { id: "project", name: "项目" },
  { id: "work", name: "工作" },
];

export interface MemoryCardEntry {
  id: string;
  preview: string;
  truncated?: boolean;
  updatedAt?: string | null;
  createdAt?: string | null;
  kind?: string;
  enabled?: boolean;
  status?: string;
  expiresAt?: string | null;
  sourceKinds?: readonly { kind: "manual" | "conversation" }[];
}

export function memoryCategory(entry: Pick<MemoryCardEntry, "kind">): MemoryCategoryId {
  if (entry.kind === "preference") return "preference";
  if (entry.kind === "fact") return "work";
  return "project";
}

/** This is a current view, not a history or a claim that inactive records were deleted. */
export function isCurrentMemory(entry: MemoryCardEntry, now: Date): boolean {
  if (entry.enabled === false || entry.status === "disabled") return false;
  if (entry.expiresAt && (!Number.isFinite(Date.parse(entry.expiresAt)) || Date.parse(entry.expiresAt) <= now.getTime())) return false;
  return true;
}

export function memoryCategoryCounts(entries: readonly MemoryCardEntry[], now = new Date()): Record<MemoryCategoryId, number> {
  const counts: Record<MemoryCategoryId, number> = { preference: 0, project: 0, work: 0 };
  for (const entry of entries) if (isCurrentMemory(entry, now)) counts[memoryCategory(entry)] += 1;
  return counts;
}

export function memoryCountLabel(count: number): string {
  return `${count} 项`;
}

export function memorySourcePhrase(sources: readonly { kind: "manual" | "conversation" }[]): string {
  if (sources.length === 0) return "来源未附带";
  const labels = sources.map(source => sourceLabel(source.kind));
  return sources.length === 1 ? `来自${labels[0]}` : `多条来源：${labels.join("、")}`;
}

function sourceLabel(kind: "manual" | "conversation"): string {
  switch (kind) {
    case "conversation": return "对话";
    case "manual": return "手动记录";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function memoryItemTitle(preview: string): string {
  const line = preview.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? "未命名";
  const plain = line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "");
  const chars = Array.from(plain);
  return chars.length > 32 ? `${chars.slice(0, 32).join("")}…` : plain || "未命名";
}

function calendarDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

/** Relative label for the summary card. Unknown stamps stay unknown. */
export function memoryUpdatedLabel(iso: string | null | undefined, now: Date): string {
  if (!iso) return "更新时间未记录";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "更新时间未记录";
  const diff = Math.round((calendarDay(now) - calendarDay(date)) / 86_400_000);
  if (diff <= 0) return "更新于 今天";
  if (diff === 1) return "更新于 昨天";
  if (diff === 2) return "更新于 前天";
  if (diff < 30) return `更新于 ${diff} 天前`;
  return `更新于 ${date.getMonth() + 1}月${date.getDate()}日`;
}

export function latestMemoryStamp(entries: readonly MemoryCardEntry[], now = new Date()): string | null {
  let best: string | null = null;
  for (const entry of entries) {
    if (!isCurrentMemory(entry, now)) continue;
    const stamp = entry.updatedAt ?? entry.createdAt ?? null;
    if (!stamp || Number.isNaN(Date.parse(stamp))) continue;
    if (best === null || Date.parse(stamp) > Date.parse(best)) best = stamp;
  }
  return best;
}

function plainMemoryText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function memoryUnderstanding(entries: readonly MemoryCardEntry[], now: Date): { narrative: string; updatedLabel: string; empty: boolean } {
  const live = entries.filter(entry => isCurrentMemory(entry, now) && entry.preview.trim().length > 0);
  return {
    narrative: live.map(entry => plainMemoryText(entry.preview)).filter(Boolean).join(" "),
    updatedLabel: memoryUpdatedLabel(latestMemoryStamp(live, now), now),
    empty: live.length === 0,
  };
}
