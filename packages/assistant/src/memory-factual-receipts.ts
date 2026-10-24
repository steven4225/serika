import type { ScopedMemoryStore } from "./memory-types.js";
import type { MemoryResult } from "./memory-types.js";
import type { MemoryAction } from "./memory-controls.js";

/** Read-only projection of validated v7 sources and replacement chains. */
export interface MemoryFactReceipt {
  id: string;
  threadId: string;
  sourceMessageId: string;
  text: string;
  undo?: MemoryAction;
}

export async function readMemoryFactReceipts(
  store: ScopedMemoryStore | undefined, threadId: string,
): Promise<MemoryResult<MemoryFactReceipt[]>> {
  if (!store?.readV7) return { ok: true, value: [] };
  const saved = await store.readV7();
  if (!saved.ok) return { ok: false, error: {
    code: "MEMORY_RECEIPT_UNAVAILABLE", message: "记忆回执暂时无法核实，请在记忆页查看；不能当作已经记住。",
  } };
  const rows: MemoryFactReceipt[] = [];
  for (const entry of saved.value.entries.filter(entry => !entry.privacyExcluded)) for (const source of [...entry.sources, ...(entry.withdrawal ? [entry.withdrawal] : [])]) {
    if (source.kind !== "conversation" || source.threadId !== threadId) continue;
    const label = entry.state === "retracted" ? "已撤回" : entry.state === "superseded" ? "已被取代" : entry.replaces.length ? "已取代旧记忆" : entry.sources.length > 1 && source === entry.sources.at(-1) ? "已恢复" : "已保存";
    const undo: MemoryAction | undefined = entry.state === "active"
      ? entry.replaces.length ? { operation: "undo", id: entry.id, expectedRevision: entry.revision } : { operation: "retract", id: entry.id, expectedRevision: entry.revision }
      : entry.state === "retracted" && entry.supersededBy === null ? { operation: "undo", id: entry.id, expectedRevision: entry.revision } : undefined;
    rows.push({ id: `${entry.id}:${entry.revision}:${source.messageId}`, threadId, sourceMessageId: source.messageId,
      text: label + (entry.uncertain ? " · 不确定，可以纠正" : ""),
      ...(undo && source === (entry.withdrawal ?? entry.sources.at(-1)) ? { undo } : {}) });
  }
  return { ok: true, value: rows };
}
