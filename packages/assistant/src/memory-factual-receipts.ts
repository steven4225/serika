import type { UIMessage } from "ai";
import type { WorkspaceMemoryStore } from "./memory-store.js";
import type { MemoryResult } from "./memory-candidates.js";
import { findCommittedUserMessage, isExactUserQuote } from "./consolidation.js";
import { consolidationPrefixHash } from "./memory-consolidation.js";
import { memoryConsolidationFailureText } from "./memory-failure.js";

/** Read-only display projection of the latest incremental batch, not a second journal. */
export interface MemoryFactReceipt {
  id: string;
  threadId: string;
  sourceMessageId: string;
  text: string;
}

export async function readMemoryFactReceipts(
  store: WorkspaceMemoryStore | undefined, threadId: string, messages: readonly UIMessage[],
): Promise<MemoryResult<MemoryFactReceipt[]>> {
  const unavailable = (): MemoryResult<MemoryFactReceipt[]> => ({ ok: false, error: {
    code: "MEMORY_RECEIPT_UNAVAILABLE", message: "记忆回执暂时无法核实，请在记忆页查看；不能当作已经记住。",
  } });
  if (store?.readV6) {
    const saved = await store.readV6();
    if (saved.ok) {
      const rows: MemoryFactReceipt[] = [];
      for (const entry of saved.value.entries) for (const source of [...entry.sources, ...(entry.withdrawal ? [entry.withdrawal] : [])]) {
        if (source.kind !== "conversation" || source.threadId !== threadId) continue;
        const user = findCommittedUserMessage(messages, source.messageId);
        if (!user || !isExactUserQuote(user.text, source.quote)) return unavailable();
        const label = entry.state === "retracted" ? "已撤回，可撤销" : entry.state === "superseded" ? "已被取代" : entry.replaces.length ? "已取代旧记忆，可撤销" : entry.sources.length > 1 && source === entry.sources.at(-1) ? "已恢复" : "已保存";
        rows.push({ id: `${entry.id}:${entry.revision}:${source.messageId}`, threadId, sourceMessageId: source.messageId, text: label });
      }
      return { ok: true, value: rows };
    }
    if (saved.error.code !== "MEMORY_MIGRATION_REQUIRED") return unavailable();
  }
  if (!store?.getConsolidationReceipt) return { ok: true, value: [] };
  try {
    const read = await store.getConsolidationReceipt(threadId);
    if (!read.ok) return unavailable();
    const receipt = read.value;
    if (!receipt) return { ok: true, value: [] };
    if (receipt.threadId !== threadId || !receipt.sourcePrefix ||
      consolidationPrefixHash(messages, receipt.sourcePrefix.throughMessageId) !== receipt.sourcePrefix.prefixHash) return unavailable();
    const candidates = [];
    for (const id of receipt.candidateIds) {
      const result = await store.getCandidate(id, undefined, { boundThreadId: threadId });
      if (!result.ok) return unavailable();
      candidates.push(result.value);
    }
    const rows: MemoryFactReceipt[] = [];
    for (const outcome of receipt.outcomes) {
      const source = findCommittedUserMessage(messages, outcome.messageId);
      if (!source) return unavailable();
      if (outcome.status === "no_memory") continue;
      const lines: string[] = [];
      for (const preview of candidates) {
        const candidate = preview.candidate;
        if (candidate.originThreadId !== threadId) return unavailable();
        const sources = candidate.sources ?? [candidate.source];
        if (!sources.every(s => s.threadId === threadId && findCommittedUserMessage(messages, s.messageId) &&
          isExactUserQuote(findCommittedUserMessage(messages, s.messageId)!.text, s.quote))) return unavailable();
        if (!sources.some(s => s.messageId === outcome.messageId)) continue;
        const text = Array.from(candidate.change.text).slice(0, 180).join("") + (Array.from(candidate.change.text).length > 180 ? "…" : "");
        if (candidate.status === "accepted" && candidate.appliedResult) {
          const operation = candidate.change.operation;
          const label = operation === "retract" ? "撤回" : operation === "disable" ? "停用" : operation === "add" ? "保存" : "更新";
          lines.push(`当时已${label}：${text}`);
        } else if (candidate.status === "pending") {
          lines.push(`这条没有自动保存：${text.replace(/[。.]$/u, "")}。原记忆没有被覆盖；需要的话可以说得更明确些再告诉我。`);
        }
      }
      if (outcome.status === "not_saved") lines.push(outcome.reason === "retry_exhausted"
        ? memoryConsolidationFailureText("MEMORY_RETRY_EXHAUSTED") : "这条记忆没保存：内容太长，请分段再告诉我。原话仍保留在对话里。");
      else if (outcome.status === "deferred") lines.push("这条记忆尚未整理完成，后续最多重试 3 次；原话仍保留。");
      if (lines.length) rows.push({ id: `${receipt.batchId}:${outcome.messageId}`, threadId,
        sourceMessageId: outcome.messageId, text: [...new Set(lines)].join("\n") });
    }
    const latest = await store.getConsolidationReceipt(threadId);
    if (!latest.ok || latest.value?.payloadHash !== receipt.payloadHash || latest.value.batchId !== receipt.batchId) return unavailable();
    return { ok: true, value: rows };
  } catch { return unavailable(); }
}
