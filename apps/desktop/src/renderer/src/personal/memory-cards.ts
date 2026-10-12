/** Presentation grouping for saved memories. This does not create a store or a new kind. */

export type MemoryCategoryId = "preference" | "project" | "work";

export const MEMORY_CATEGORIES: readonly { id: MemoryCategoryId; name: string }[] = [
  { id: "preference", name: "偏好" },
  { id: "project", name: "项目" },
  { id: "work", name: "工作" },
];

const PREFERENCE_ATTRIBUTES = new Set(["response_language", "review_format", "coffee", "residence"]);

export interface MemoryCardEntry {
  id: string;
  preview: string;
  truncated?: boolean;
  updatedAt?: string | null;
  createdAt?: string | null;
  temporalState?: "applicable" | "retracted" | "not_applicable";
  assertion?: {
    kind?: string;
    factIdentity?: { attribute?: string; scenario?: string };
    sourceIds?: readonly { kind: "manual" | "legacy" | "conversation" }[];
  };
}

export function memoryCategory(entry: Pick<MemoryCardEntry, "assertion">): MemoryCategoryId {
  const attribute = entry.assertion?.factIdentity?.attribute;
  const scenario = entry.assertion?.factIdentity?.scenario;
  const kind = entry.assertion?.kind;
  if (attribute !== undefined && PREFERENCE_ATTRIBUTES.has(attribute)) return "preference";
  if (kind === "preference" || scenario === "personal") return "preference";
  if (scenario === "work") return "work";
  if (kind === "fact") return "work";
  return "project";
}

export function memoryCategoryCounts(entries: readonly MemoryCardEntry[]): Record<MemoryCategoryId, number> {
  const counts: Record<MemoryCategoryId, number> = { preference: 0, project: 0, work: 0 };
  for (const entry of entries) counts[memoryCategory(entry)] += 1;
  return counts;
}

export function memoryCountLabel(count: number): string {
  return `${count} 项`;
}

export function memorySourcePhrase(sources: readonly { kind: "manual" | "legacy" | "conversation" }[]): string {
  if (sources.length === 0) return "来源未附带";
  const labels = sources.map(source => sourceLabel(source.kind));
  return sources.length === 1 ? `from ${labels[0]}` : `corroborated: ${labels.join(" + ")}`;
}

function sourceLabel(kind: "manual" | "legacy" | "conversation"): string {
  switch (kind) {
    case "conversation": return "对话";
    case "manual": return "手动记录";
    case "legacy": return "旧记录";
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

export function latestMemoryStamp(entries: readonly MemoryCardEntry[]): string | null {
  let best: string | null = null;
  for (const entry of entries) {
    if (entry.temporalState === "retracted") continue;
    const stamp = entry.updatedAt ?? entry.createdAt ?? null;
    if (!stamp || Number.isNaN(Date.parse(stamp))) continue;
    if (best === null || Date.parse(stamp) > Date.parse(best)) best = stamp;
  }
  return best;
}

export function memoryUnderstanding(entries: readonly MemoryCardEntry[], now: Date): { narrative: string; updatedLabel: string; empty: boolean } {
  const live = entries.filter(entry => entry.temporalState !== "retracted" && entry.preview.trim().length > 0);
  return {
    narrative: live.map(entry => entry.preview.trim()).join("\n\n"),
    updatedLabel: memoryUpdatedLabel(latestMemoryStamp(live), now),
    empty: live.length === 0,
  };
}
