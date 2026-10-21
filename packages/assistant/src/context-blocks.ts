import type { UIMessage } from "ai";
import { formatLocalTaskTime, MODEL_TIME_ZONE } from "./task-instructions.js";
import { availableInputTokens, defaultContextBudget, estimateMessageTokens, estimateSerializedTokens, partitionMessagesForCompaction, type ContextBudgetConfig } from "./context-budget.js";
import { validateContextSummary, type ContextCompactionRecord, type ContextSummaryV2 } from "./context-compaction.js";

export interface SummarySegment {
  firstMessageId: string;
  lastMessageId: string;
  timeRange: [string | null, string | null];
  summary: ContextSummaryV2;
}
export interface LayeredSummary {
  index: Array<Omit<SummarySegment, "summary"> & { text: string }>;
  recent: SummarySegment[];
}
export function blockLimits(budget: ContextBudgetConfig) {
  const scale = availableInputTokens(budget) / availableInputTokens(defaultContextBudget());
  return { block: Math.max(1, Math.floor(32_000 * scale)), recent: Math.max(1, Math.floor(48_000 * scale)),
    section: Math.max(1, Math.floor(2_000 * scale)), totalSummary: Math.max(1, Math.floor(12_000 * scale)) };
}
export function summaryText(summary: ContextSummaryV2): string {
  return [summary.goal.text, ...summary.constraints.map(item => item.text),
    ...summary.decisions.map(item => `${item.source}/${item.status}: ${item.text}`),
    ...summary.pending.map(item => item.text), ...summary.actions.filter(item => item.status !== "unknown" && item.status !== "failed").map(item => `${item.status} ${item.toolCallIds.join(",")}: ${item.text}`),
    ...summary.files.map(item => `${item.path}: ${item.purpose}`), ...(summary.nextStep ? [summary.nextStep.text] : [])].join("\n");
}
export function layerMessage(record: ContextCompactionRecord): UIMessage {
  const layers = record.layers;
  const range = (segment: Omit<SummarySegment, "summary">) => ({ messages: [segment.firstMessageId, segment.lastMessageId],
    time: segment.timeRange.map(stamp => stamp ? formatLocalTaskTime(new Date(stamp), MODEL_TIME_ZONE) : null) });
  const view = layers ? { index: layers.index.map(segment => ({ ...range(segment), text: segment.text })),
    recent: layers.recent.map(segment => ({ ...range(segment), text: summaryText(segment.summary) })) } : summaryText(record.summary);
  return { id: "runloom-context-summary", role: "assistant", metadata: { source: "context-compaction" },
    parts: [{ type: "text", text: "Historical index and summaries; history_read/search gives originals:\n" + JSON.stringify(view) }] };
}

/** Opaque index text is retained: the host cannot identify its important clauses. */
export function fitSummaryLayer(record: ContextCompactionRecord, maxTokens: number) {
  const original = layerMessage(record), originalTokens = estimateMessageTokens([original]);
  const segments = record.layers?.recent ?? [{ firstMessageId: "1", lastMessageId: String(record.firstKeptMessageIndex), timeRange: [null, null], summary: record.summary }];
  const essential = (summary: ContextSummaryV2) => summaryText({ ...summary, files: [],
    actions: summary.actions.filter(action => action.status === "not_executed") });
  const reduced = segments.map(segment => ({ ...segment, summary: { ...segment.summary } }));
  let message = original, reducedSegments = 0;
  for (const segment of reduced) {
    if (estimateMessageTokens([message]) <= maxTokens) break;
    segment.summary = { ...segment.summary, files: [], actions: segment.summary.actions.filter(action => action.status === "not_executed") };
    reducedSegments++;
    message = layerMessage({ ...record, layers: { index: record.layers?.index ?? [], recent: reduced } });
  }
  // Exact duplicates can share one display copy; different wording/statuses stay distinct.
  const requiredLines = [...new Set(segments.flatMap(segment => essential(segment.summary).split("\n")))];
  const indexLines = (record.layers?.index ?? []).flatMap(segment => segment.text.split("\n"));
  const index = [...new Set(indexLines)].filter(line => !requiredLines.includes(line));
  const ranges = record.layers ? [...record.layers.index, ...segments].map(segment =>
    [segment.firstMessageId, segment.lastMessageId, segment.timeRange.map(stamp => stamp ? formatLocalTaskTime(new Date(stamp), MODEL_TIME_ZONE) : null)]) : [["1", record.firstKeptMessageIndex]];
  const minimum: UIMessage = { ...original, parts: [{ type: "text", text:
    "Historical continuation (exact duplicate clauses shown once); history_read/search gives originals.\n" +
    `Ranges [first,last,time]: ${JSON.stringify(ranges)}\n` + requiredLines.join("\n") +
    (index.length ? "\nFar index:\n" + index.join("\n") : "") }] };
  const requiredTokens = estimateMessageTokens([minimum]);
  const compacted = estimateMessageTokens([message]) > maxTokens;
  if (compacted) message = minimum;
  return { message, fits: estimateMessageTokens([message]) <= maxTokens,
    diagnostics: { originalTokens, requiredTokens, budget: maxTokens, reducedSegments, compacted,
      indexDuplicateLines: compacted ? indexLines.length - index.length : 0 } };
}

/** Preserve call/result units; one masking event removes a whole proportional block. */
export function maskOldestBlock(messages: readonly UIMessage[], through: number, tokens: number): number {
  const partition = partitionMessagesForCompaction(messages);
  const units = [...partition.history, ...partition.current].filter(unit => unit.startIndex >= through);
  let end = through, size = 0;
  for (const unit of units) {
    if (!unit.completeToolCalls) break;
    if (unit.messages.some(message => message.role === "user") && unit.endIndex === messages.length - 1) break;
    end = unit.endIndex + 1; size += estimateMessageTokens(unit.messages);
    if (size >= tokens) break;
  }
  return end;
}

/** Only the provider projection is clipped; the numbered journal keeps every byte. */
export function fitMessage(message: UIMessage, maxTokens: number): UIMessage {
  const size = (value: UIMessage) => {
    const { contextReferences: _refs, contextSnapshot: _snapshot, ...metadata } = (value.metadata ?? {}) as Record<string, unknown>;
    return estimateMessageTokens([{ ...value, metadata }]);
  };
  if (size(message) <= maxTokens) return message;
  const bounded = { ...message, parts: message.parts.map(part => part.type === "file"
    ? { type: "text" as const, text: `[Attachment in message ${message.id}; read with history_read.]` } : part) } as UIMessage;
  const marker = `\n[Message ${message.id} truncated for context; use history_read with start/end for the complete original.]\n`;
  const fit = (count: number): UIMessage => ({ ...bounded, parts: bounded.parts.map(part => {
    const clip = (text: string) => {
      const chars = Array.from(text), perPart = Math.floor(count / Math.max(1, bounded.parts.length));
      return chars.length <= perPart ? text : chars.slice(0, Math.ceil(perPart / 2)).join("") + marker + chars.slice(chars.length - Math.floor(perPart / 2)).join("");
    };
    if (part.type === "text") return { ...part, text: clip(part.text) };
    if (part.type === "dynamic-tool" && part.state === "output-available") return { ...part, input: { excerpt: clip(JSON.stringify(part.input)) }, output: clip(JSON.stringify(part.output)) };
    if (part.type === "dynamic-tool" && part.state === "output-error") return { ...part, input: { excerpt: clip(JSON.stringify(part.input)) }, errorText: clip(part.errorText) };
    return part;
  }) });
  let low = 0, high = Array.from(JSON.stringify(bounded.parts)).length, best = fit(0);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2), candidate = fit(mid);
    if (size(candidate) <= maxTokens) { best = candidate; low = mid + 1; } else high = mid - 1;
  }
  if (size(best) > maxTokens) throw new Error("Context cannot fit required message/tool metadata; original retained");
  return best;
}

export function appendSummaryLayer(input: { previous?: ContextCompactionRecord; messages: readonly UIMessage[]; start: number; end: number; summary: ContextSummaryV2; farIndex?: string }): LayeredSummary {
  const before = input.previous?.layers ?? { index: [], recent: input.previous ? [{ firstMessageId: input.messages[0]?.id ?? "", lastMessageId: input.messages[Math.max(0, input.start - 1)]?.id ?? "", timeRange: [null, null] as [null, null], summary: input.previous.summary }] : [] };
  const stamp = (message: UIMessage | undefined) => {
    const meta = message?.metadata as { receivedAt?: string; sentAt?: string } | undefined;
    return meta?.receivedAt ?? meta?.sentAt ?? null;
  };
  const recent = [...before.recent, { firstMessageId: input.messages[input.start]!.id, lastMessageId: input.messages[input.end - 1]!.id,
    timeRange: [stamp(input.messages[input.start]), stamp(input.messages[input.end - 1])] as [string | null, string | null], summary: input.summary }];
  const archived = recent.length > 4 ? recent.shift()! : undefined;
  if (!archived) return { index: before.index, recent };
  if (!input.farIndex?.trim()) throw new Error("Far index was not returned; original summaries retained");
  const first = before.index[0] ?? archived;
  return { index: [{ firstMessageId: first.firstMessageId, lastMessageId: archived.lastMessageId,
    timeRange: [first.timeRange[0], archived.timeRange[1]], text: input.farIndex }], recent };
}

export const layerTokens = (layers: LayeredSummary) => estimateSerializedTokens(layers);

export function validLayers(value: unknown): value is LayeredSummary {
  if (!value || typeof value !== "object") return false;
  const layers = value as LayeredSummary;
  const range = (entry: SummarySegment | LayeredSummary["index"][number]) => entry && typeof entry.firstMessageId === "string" && entry.firstMessageId.length > 0 &&
    typeof entry.lastMessageId === "string" && entry.lastMessageId.length > 0 && Array.isArray(entry.timeRange) && entry.timeRange.length === 2 && entry.timeRange.every(time => time === null || typeof time === "string" && Number.isFinite(Date.parse(time)));
  return Array.isArray(layers.index) && layers.index.length <= 1 && layers.index.every(entry => range(entry) && typeof entry.text === "string" && entry.text.trim()) &&
    Array.isArray(layers.recent) && layers.recent.length <= 4 && layers.recent.every(entry => range(entry) && validateContextSummary(entry.summary));
}
