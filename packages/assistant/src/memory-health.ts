import {
  MEMORY_CONTEXT_MAX_BYTES,
  type MemoryEntry,
  type ScopedMemoryStore,
} from "./memory-types.js";
import { memorySnapshot } from "./memory-snapshot.js";

export type MemoryHealth =
  | { status: "disabled" }
  | { status: "error"; code: string; message: string }
  | {
      status: "ready";
      checkedAt: string;
      totalEntries: number;
      eligibleEntries: number;
      snapshotEntries: number;
      snapshotBytes: number;
      snapshotOverflow: boolean;
      limitBytes: number;
      excluded: { thread: number; document: number; disabled: number; expired: number };
    };

function exclusion(entry: MemoryEntry, now: Date): "thread" | "disabled" | "expired" | undefined {
  if (entry.enabled !== true || (entry.status !== undefined && entry.status !== "active")) return "disabled";
  if (entry.expiresAt !== undefined && entry.expiresAt !== null) {
    const expiry = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) return "expired";
  }
  return undefined;
}

export async function readMemoryHealth(
  store: ScopedMemoryStore | undefined,
  _threadId: string,
  now: Date = new Date(),
): Promise<MemoryHealth> {
  if (store === undefined) return { status: "disabled" };
  const material = await store.readReferenceMaterial?.(new AbortController().signal, now);
  const result = material ? (material.ok ? { ok: true as const, entries: material.value.entries } : material) : await store.list();
  if (!result.ok) return { status: "error", code: result.error.code, message: result.error.message };

  const library = material?.ok ? material.value.library : undefined;
  const documents = new Set(library?.documents.flatMap(document => document.entryIds));
  const excluded = { thread: 0, document: 0, disabled: 0, expired: 0 };
  for (const entry of result.entries) {
    const reason = documents.has(entry.id) ? "document" : exclusion(entry, now);
    if (reason !== undefined) excluded[reason] += 1;
  }
  const preview = memorySnapshot(result.entries, { now, ...(library ? { library } : {}) });
  return {
    status: "ready",
    checkedAt: now.toISOString(),
    totalEntries: result.entries.length,
    eligibleEntries: preview.eligibleCount,
    snapshotEntries: preview.entries.length,
    snapshotBytes: preview.bytes,
    snapshotOverflow: preview.truncated,
    limitBytes: MEMORY_CONTEXT_MAX_BYTES,
    excluded,
  };
}

export function formatMemoryHealth(health: MemoryHealth): string {
  if (health.status === "disabled") return "记忆诊断: disabled（未读取文件）";
  if (health.status === "error") return `记忆诊断: error ${health.code}: ${health.message}`;
  return `记忆诊断: ready · checkedAt ${health.checkedAt} · storage ${health.totalEntries} · eligible ${health.eligibleEntries} · snapshot ${health.snapshotEntries} · ${health.snapshotBytes}/${health.limitBytes} bytes · overflow ${health.snapshotOverflow} · excluded thread ${health.excluded.thread}, documents ${health.excluded.document}, disabled ${health.excluded.disabled}, expired ${health.excluded.expired}\n当前可生成快照的预览；已运行请求使用其保存的固定版本。超额及文档正文可通过 memory_read 按需读取。`;
}
