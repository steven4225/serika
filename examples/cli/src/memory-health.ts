import {
  MEMORY_CONTEXT_MAX_BYTES,
  type MemoryEntry,
  type WorkspaceMemoryStore,
} from "./memory-store.js";
import { retrieveMemories } from "./memory-retrieval.js";

export type MemoryHealth =
  | { status: "disabled" }
  | { status: "error"; code: string; message: string }
  | {
      status: "ready";
      checkedAt: string;
      totalEntries: number;
      eligibleEntries: number;
      pinnedPreviewEntries: number;
      pinnedPreviewBytes: number;
      pinnedPreviewTruncated: boolean;
      limitBytes: number;
      excluded: { otherThread: number; disabled: number; expired: number };
    };

function exclusion(entry: MemoryEntry, threadId: string, now: Date): "otherThread" | "disabled" | "expired" | undefined {
  if (entry.scope?.kind === "thread" && entry.scope.threadId !== threadId) return "otherThread";
  if (entry.enabled !== true || (entry.status !== undefined && entry.status !== "active")) return "disabled";
  if (entry.expiresAt !== undefined && entry.expiresAt !== null) {
    const expiry = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) return "expired";
  }
  return undefined;
}

export async function readMemoryHealth(
  store: WorkspaceMemoryStore | undefined,
  threadId: string,
  now: Date = new Date(),
): Promise<MemoryHealth> {
  if (store === undefined) return { status: "disabled" };
  const result = await store.list();
  if (!result.ok) return { status: "error", code: result.error.code, message: result.error.message };

  const excluded = { otherThread: 0, disabled: 0, expired: 0 };
  for (const entry of result.entries) {
    const reason = exclusion(entry, threadId, now);
    if (reason !== undefined) excluded[reason] += 1;
  }
  const preview = retrieveMemories(result.entries, { query: "", threadId, now });
  return {
    status: "ready",
    checkedAt: now.toISOString(),
    totalEntries: result.entries.length,
    eligibleEntries: preview.eligibleCount,
    pinnedPreviewEntries: preview.entries.length,
    pinnedPreviewBytes: preview.bytes,
    pinnedPreviewTruncated: preview.truncated,
    limitBytes: MEMORY_CONTEXT_MAX_BYTES,
    excluded,
  };
}

export function formatMemoryHealth(health: MemoryHealth): string {
  if (health.status === "disabled") return "记忆诊断: disabled（未读取文件）";
  if (health.status === "error") return `记忆诊断: error ${health.code}: ${health.message}`;
  return `记忆诊断: ready · checkedAt ${health.checkedAt} · storage ${health.totalEntries} · eligible ${health.eligibleEntries} · pinned preview ${health.pinnedPreviewEntries} · ${health.pinnedPreviewBytes}/${health.limitBytes} bytes · truncated ${health.pinnedPreviewTruncated} · excluded otherThread ${health.excluded.otherThread}, disabled ${health.excluded.disabled}, expired ${health.excluded.expired}\n无查询 pinned 预览不是下一轮实际命中数；未选中不表示已删除。记忆详情: 使用 memory_list / memory_get 查询（沿用工具确认）`;
}
