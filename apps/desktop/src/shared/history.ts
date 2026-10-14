import type { UIMessage } from "ai";
import type { MemoryFactReceipt } from "@aisdk-agent/example-cli/dist/memory-factual-receipts.js";
export interface HistoryPageInput { beforeId?: string; limit?: number }
export interface HistoryPage { threadId: string; messages: UIMessage[]; beforeId: string | null; memoryReceipts?: MemoryFactReceipt[]; memoryReceiptError?: string }

/** Newest page first, but preserve message order and complete tool interactions. */
export function historyPage(messages: readonly UIMessage[], threadId: string, input: HistoryPageInput = {}): HistoryPage {
  if (!input || Object.keys(input).some(key => !["beforeId", "limit"].includes(key)) ||
    (input.beforeId !== undefined && (typeof input.beforeId !== "string" || !input.beforeId)) ||
    (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100))) throw new Error("历史分页参数无效");
  const end = input.beforeId === undefined ? messages.length : messages.findIndex(message => message.id === input.beforeId);
  if (end < 0) throw new Error("历史位置已变化，请重新打开对话");
  let start = end, bytes = 0;
  while (start > 0 && end - start < (input.limit ?? 50)) {
    const size = new TextEncoder().encode(JSON.stringify(messages[start - 1])).byteLength;
    if (start < end && bytes + size > 1024 * 1024) break;
    bytes += size; start--;
  }
  return { threadId, messages: messages.slice(start, end), beforeId: start > 0 ? messages[start]!.id : null };
}
