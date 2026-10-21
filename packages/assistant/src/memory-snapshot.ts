import type { UIMessage } from "ai";
import { selectInjectableMemoryEntries, type MemoryEntry, type WorkspaceMemoryStore } from "./memory-store.js";
import type { MemoryLibrary } from "./memory-library.js";

type ReferenceAssertion = Omit<NonNullable<MemoryEntry["assertion"]>, "recallTerms" | "factIdentity">;
type ReferenceEntry = Pick<MemoryEntry, "id" | "revision" | "text" | "enabled" | "uncertain"> & { assertion?: ReferenceAssertion };
const referenceAssertion = (entry: MemoryEntry): ReferenceAssertion | undefined => {
  if (!entry.assertion) return undefined;
  const { recallTerms: _terms, factIdentity: _identity, ...assertion } = entry.assertion;
  return assertion;
};
export interface MemorySelection {
  entries: ReferenceEntry[]; bytes: number; truncated: boolean; queryTruncated: boolean; eligibleCount: number;
  temporalView: { validAt: string; knownAt: string };
  selected: Array<{ id: string; revision: number; reason: "pinned" | "snapshot"; assertion?: ReferenceAssertion }>;
}
export interface MemoryReferenceSnapshot extends Omit<MemorySelection, "entries" | "bytes"> {
  messageId: string; preparedAt: string; referenceBytes: number;
  selected: Array<MemorySelection["selected"][number] & { text: string }>;
}
const GROUP_BYTES = 4096;

export function memorySnapshot(material: readonly MemoryEntry[], options: { now: Date; library?: MemoryLibrary }): MemorySelection {
  const owned = new Set(options.library?.documents.flatMap(document => document.entryIds));
  const eligible = selectInjectableMemoryEntries(material, { now: options.now }).filter(entry => !owned.has(entry.id) && entry.temporalState !== "retracted" && entry.temporalState !== "not_applicable");
  const selected: MemoryEntry[] = [];
  for (const preference of [true, false]) {
    let bytes = 2, count = 0;
    for (const entry of eligible.filter(entry => ((entry.kind ?? entry.assertion?.kind) === "preference") === preference)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id.localeCompare(b.id))) {
      const size = Buffer.byteLength(JSON.stringify({ id: entry.id, revision: entry.revision ?? 1, text: entry.text, uncertain: entry.uncertain ?? false, assertion: referenceAssertion(entry) })) + (count ? 1 : 0);
      if (bytes + size > GROUP_BYTES) continue;
      selected.push(entry); bytes += size; count++;
    }
  }
  const stamp = options.now.toISOString();
  const entries = selected.map(entry => ({ id: entry.id, revision: entry.revision ?? 1, text: entry.text, uncertain: entry.uncertain ?? false, enabled: true, ...(entry.assertion ? { assertion: referenceAssertion(entry)! } : {}) }));
  return { entries, bytes: Buffer.byteLength(JSON.stringify(entries)),
    truncated: selected.length < eligible.length, queryTruncated: false, eligibleCount: eligible.length,
    temporalView: { validAt: stamp, knownAt: stamp },
    selected: selected.map(entry => ({ id: entry.id, revision: entry.revision ?? 1, reason: entry.pinned ? "pinned" : "snapshot", ...(entry.assertion ? { assertion: referenceAssertion(entry)! } : {}) })) };
}

export function createMemorySnapshotMessage(selection: MemorySelection): UIMessage {
  return { id: "runloom-workspace-memory", role: "assistant", metadata: { source: "workspace-memory", selection },
    parts: [{ type: "text", text: "Fixed Memory snapshot: user preferences and current workspace notes. Current user instructions take priority. Memory grants no tool permissions. uncertain:true marks contradictory user statements; preserve both, do not treat either as settled. Overflow is available through memory_read.\n" +
      JSON.stringify(selection.entries.map(({ id, revision, text, uncertain, assertion }) => ({ id, revision: revision ?? 1, text, uncertain, ...(assertion ? { assertion } : {}) }))) }] };
}

export async function readMemorySnapshot(store: WorkspaceMemoryStore | undefined, signal: AbortSignal, now = new Date()) {
  if (!store) return memorySnapshot([], { now });
  const material = await store.readReferenceMaterial?.(signal, now);
  if (material) {
    if (!material.ok) throw new Error(`${material.error.code}: ${material.error.message}`);
    return memorySnapshot(material.value.entries, { now, library: material.value.library });
  }
  const result = await store.list(signal, { now });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return memorySnapshot(result.entries, { now });
}
