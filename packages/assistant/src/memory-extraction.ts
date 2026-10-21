import { generateText, type LanguageModel, type UIMessage } from "ai";
import { z } from "zod";
import { originalBlock } from "./context-source.js";
import { hashCanonicalJson } from "@serika/core";
import { availableInputTokens, defaultContextBudget, type ContextBudgetConfig } from "./context-budget.js";
import { findCommittedUserMessage, withoutConsolidationTurns } from "./consolidation.js";
import { bindMemoryWrite, memoryText, memoryWriteSchema, MEMORY_WRITE_RULES } from "./memory-write.js";
import type { WorkspaceMemoryStore } from "./memory-store.js";
import type { V6Change, V6Document } from "./memory-v6-store.js";

const responseSchema = z.object({ proposals: z.array(memoryWriteSchema.safeExtend({ sourceMessageId: z.string().min(1) })),
  outcomes: z.array(z.object({ messageId: z.string().min(1), status: z.enum(["extracted", "no_memory", "deferred"]) }).strict()) }).strict();
const IDLE_MS = 30 * 60 * 1000;
const prefixHash = (messages: readonly UIMessage[], id: string) => hashCanonicalJson(JSON.parse(JSON.stringify(messages.slice(0, messages.findIndex(message => message.id === id) + 1))));
export function extractionThreshold(config: ContextBudgetConfig): number {
  const baseline = defaultContextBudget();
  return Math.max(1, Math.min(Math.floor(availableInputTokens(config) / availableInputTokens(baseline) * baseline.summaryInputChunkTokens!), (config.summaryInputChunkTokens ?? availableInputTokens(config)) - 1));
}
export function extractionMessages(messages: readonly UIMessage[]) {
  let excluded = false;
  return withoutConsolidationTurns(messages).filter(message => {
    if (message.role === "user") excluded = !findCommittedUserMessage(messages, message.id);
    return !excluded;
  }).map(message => ({ id: message.id, role: message.role,
    metadata: Object.fromEntries(Object.entries(message.metadata ?? {}).filter(([key]) => ["sentAt", "receivedAt", "timeZone", "channel"].includes(key))), text: memoryText(message),
    tools: message.parts.flatMap(part => part.type.startsWith("tool-") || part.type === "dynamic-tool"
      ? [{ name: "toolName" in part ? part.toolName : part.type.slice(5), status: "state" in part ? part.state : "unknown" }] : []),
    attachments: message.parts.filter(part => part.type === "file").map(part => ({ mediaType: part.mediaType, name: part.filename ?? "attachment" })),
  }));
}
export interface ExtractionDiagnostics { running: boolean; calls: number; completed: number; failed: number; cancelled: number; durationMs: number; pendingSegments: number; error?: string }

/** One preemptible, tool-free call per block; the Controller owns foreground admission. */
export function createMemoryExtraction(options: { store: WorkspaceMemoryStore; threadId: string; getMessages(): Promise<UIMessage[]>;
  workspaceRoot?: string; model: LanguageModel; budget: ContextBudgetConfig; updated(): void; now?: () => number }) {
  const now = options.now ?? Date.now, threshold = extractionThreshold(options.budget);
  const diagnostics: ExtractionDiagnostics = { running: false, calls: 0, completed: 0, failed: 0, cancelled: 0, durationMs: 0, pendingSegments: 0 };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined, task: Promise<void> | undefined, abort: AbortController | undefined;
  let urgentThrough: string | undefined;
  let generation = 0, closed = false, uncertain = false, lastActivity = now();
  const load = async () => {
    const read = await options.store.readV6!(); if (!read.ok) throw new Error(`${read.error.code}: ${read.error.message}`);
    const messages = await options.getMessages(), document = read.value;
    const saved = document.progress.find(item => item.threadId === options.threadId) ?? null;
    const index = saved?.throughMessageId ? messages.findIndex(message => message.id === saved.throughMessageId) : -1;
    if (saved?.throughMessageId && (index < 0 || prefixHash(messages, saved.throughMessageId) !== saved.prefixHash)) throw new Error("MEMORY_CURSOR_MISMATCH");
    const backlog = messages.slice(index + 1), material = extractionMessages(backlog);
    return { document, saved, messages, backlog, material, tokens: Math.ceil(JSON.stringify(material).length / 2) };
  };
  const extract = async (idle: boolean, epoch: number) => {
    const initial = await load(); if (generation !== epoch || closed) return;
    const { saved, document, messages } = initial;
    let backlog = initial.backlog;
    const pending = saved?.pending ?? [];
    for (const item of pending) if (prefixHash(messages, item.messageId) !== item.prefixHash) throw new Error("MEMORY_CURSOR_MISMATCH");
    const replay = pending.find(item => item.offset !== undefined) ?? (idle ? pending[0] : undefined);
    if (replay) { const index = messages.findIndex(message => message.id === replay.messageId); backlog = messages.slice(index, index + 1); }
    diagnostics.pendingSegments = pending.length + ((saved?.retry?.failures ?? 0) >= 2 ? 1 : 0);
    if (!backlog.length) return;
    if (saved?.retry && (saved.retry.failures >= 3 || saved.retry.failures >= 2 && !idle)) return;
    if (!idle && !urgentThrough && !replay && initial.tokens < threshold) return;
    if (saved?.retry && prefixHash(messages, saved.retry.throughMessageId) !== saved.retry.prefixHash) throw new Error("MEMORY_CURSOR_MISMATCH");
    const selected: UIMessage[] = [];
    for (const message of backlog) {
      if (Math.ceil(JSON.stringify(extractionMessages([...selected, message])).length / 2) > threshold) break;
      selected.push(message);
      if (!replay && saved?.retry?.throughMessageId === message.id) break;
    }
    let fragment: { messageId: string; end: number; complete: boolean } | undefined;
    if (!selected.length) {
      const oversized = backlog[0];
      if (!oversized) return;
      const characters = Array.from(memoryText(oversized)), offset = replay?.offset ?? 0;
      let low = 1, high = characters.length - offset, count = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2), part = { ...oversized, parts: [{ type: "text" as const, text: characters.slice(offset, offset + mid).join("") }] };
        if (Math.ceil(JSON.stringify(extractionMessages([part])).length / 2) <= threshold) { count = mid; low = mid + 1; } else high = mid - 1;
      }
      if (!count) throw new Error("抽取元数据超过块窗口，原文保留");
      selected.splice(0, selected.length, { ...oversized, parts: [{ type: "text", text: characters.slice(offset, offset + count).join("") }] });
      fragment = { messageId: oversized.id, end: offset + count, complete: offset + count === characters.length };
    }
    const users = selected.filter(message => findCommittedUserMessage(messages, message.id));
    const last = selected.at(-1)!.id, selectedHash = prefixHash(messages, last);
    const signal = new AbortController(); abort = signal;
    const started = now(); let dispatched = false;
    const progress = (failures: number): V6Document["progress"][number] => ({ threadId: options.threadId,
      throughMessageId: saved?.throughMessageId ?? null, prefixHash: saved?.prefixHash ?? null,
      pending, retry: { throughMessageId: last, prefixHash: selectedHash, failures } });
    try {
      const facts = document.entries.filter(entry => entry.state === "active" && entry.category !== "document" && entry.scope.kind === "workspace");
      const eligibleIds = new Set(extractionMessages(selected).map(message => message.id));
      const prompt = originalBlock(selected.filter(message => eligibleIds.has(message.id)), { threadId: options.threadId, project: options.workspaceRoot ?? "current-workspace" }) + "\nTask: extract memory from the preceding original block.\n" + MEMORY_WRITE_RULES +
        "\nCurrent preferences and project notes: " + JSON.stringify(facts.map(({ id, revision, text, uncertain, category, identity, scope, sources }) => ({ id, revision, text, uncertain, category, identity, scope, sourceMessageIds: sources.flatMap(source => source.kind === "conversation" ? [source.messageId] : []) }))) +
        "\nOriginal message order: " + JSON.stringify(messages.map(message => message.id)) + ". Older replay sources must never replace or withdraw newer-source memories. Mark older same-attribute values as superseded by the newer memory. Only chronologically ambiguous values remain diagnostic conflicts.\nReturn ONLY {proposals,outcomes}; each proposal has sourceMessageId and memory_write fields. Return one outcome for EACH ordinary eligible user source in order: extracted, no_memory or deferred. extracted requires ALL durable information accounted for; partial coverage is deferred. No tools, retries or prose. Already attached exact sources need no duplicate proposal. Eligible user IDs: " + JSON.stringify(users.map(user => user.id));
      if (Math.ceil(prompt.length / 2) + options.budget.summaryMaxOutputTokens > availableInputTokens(options.budget)) throw new Error("抽取请求超过有效输入窗口，未调用模型");
      signal.signal.throwIfAborted(); dispatched = true; diagnostics.calls++;
      const response = await generateText({ model: options.model, prompt, maxRetries: 0,
        maxOutputTokens: options.budget.summaryMaxOutputTokens, abortSignal: AbortSignal.any([signal.signal, AbortSignal.timeout(30_000)]),
        providerOptions: { openaiCompatible: { thinking: { type: "disabled" }, reasoningEffort: "off" } } });
      signal.signal.throwIfAborted();
      const parsed = responseSchema.safeParse(JSON.parse(response.text));
      if (!parsed.success) throw new Error("抽取输出无效，未保存");
      if (JSON.stringify(parsed.data.outcomes.map(outcome => outcome.messageId)) !== JSON.stringify(users.map(user => user.id))) throw new Error("抽取覆盖顺序无效");
      const changes: V6Change[] = parsed.data.proposals.map(proposal => {
        const user = users.find(user => user.id === proposal.sourceMessageId); if (!user || !memoryText(user).includes(proposal.sourceQuote)) throw new Error("抽取来源越界");
        const { sourceMessageId: _id, ...write } = proposal;
        return bindMemoryWrite(write, { messages, user, threadId: options.threadId });
      }).filter(change => !("text" in change && document.entries.some(entry => entry.text === change.text && entry.sources.some(source => source.kind === "conversation" && change.source.kind === "conversation" && source.messageId === change.source.messageId && source.quote === change.source.quote))));
      for (const outcome of parsed.data.outcomes) if (outcome.status === "extracted" && !parsed.data.proposals.some(proposal => proposal.sourceMessageId === outcome.messageId)) throw new Error("extracted 缺少来源提议");
      const firstDeferred = parsed.data.outcomes.findIndex(outcome => outcome.status === "deferred");
      const boundary = firstDeferred < 0 ? last : selected[selected.findIndex(message => message.id === users[firstDeferred]!.id) - 1]?.id ?? saved?.throughMessageId ?? null;
      let next: V6Document["progress"][number] = { pending, threadId: options.threadId, throughMessageId: boundary,
        prefixHash: boundary ? prefixHash(messages, boundary) : null, retry: firstDeferred < 0 ? null : progress(Math.min(3, (saved?.retry?.failures ?? 0) + 1)).retry };
      if (fragment && firstDeferred < 0 && !fragment.complete) next = {
        threadId: options.threadId, throughMessageId: saved?.throughMessageId ?? null, prefixHash: saved?.prefixHash ?? null, retry: null,
        pending: [...pending.filter(item => item.messageId !== fragment!.messageId), { messageId: fragment.messageId, prefixHash: selectedHash, offset: fragment.end }],
      };
      else if (replay) next = { ...next, throughMessageId: saved?.throughMessageId ?? null, prefixHash: saved?.prefixHash ?? null, retry: firstDeferred < 0 ? null : next.retry, pending: firstDeferred < 0 ? pending.filter(item => item.messageId !== replay.messageId) : pending,
        ...((saved?.throughMessageId === null || messages.findIndex(message => message.id === saved?.throughMessageId) < messages.findIndex(message => message.id === replay.messageId)) && firstDeferred < 0
          ? { throughMessageId: last, prefixHash: selectedHash } : {}) };
      if (urgentThrough && next.throughMessageId && messages.findIndex(message => message.id === next.throughMessageId) >= messages.findIndex(message => message.id === urgentThrough)) urgentThrough = undefined;
      const fresh = await options.getMessages(); if (prefixHash(fresh, last) !== selectedHash) throw new Error("抽取原文已变化");
      const committed = await options.store.writeV6!(changes, signal.signal, { expectedProgress: saved, progress: next, automatic: true, reextract: !!replay, sourceOrder: messages.map(message => message.id) });
      if (!committed.ok) {
        if (committed.error.code === "MEMORY_COMMIT_UNCERTAIN") uncertain = true;
        throw new Error(`${committed.error.code}: ${committed.error.message}`);
      }
      diagnostics.completed++; diagnostics.pendingSegments = next.pending.length + ((next.retry?.failures ?? 0) >= 2 ? 1 : 0); delete diagnostics.error;
      return next.retry === null && (fragment?.complete === false || next.throughMessageId !== (saved?.throughMessageId ?? null));
    } catch (error) {
      if (signal.signal.aborted) { if (dispatched) diagnostics.cancelled++; return; }
      diagnostics.failed++; diagnostics.error = error instanceof Error ? error.message : "抽取失败";
      if (!uncertain && !diagnostics.error.includes("MEMORY_LIMIT_EXCEEDED") && !diagnostics.error.includes("MEMORY_CURSOR_MISMATCH")) {
        const failure = await options.store.writeV6!([], signal.signal, { expectedProgress: saved, progress: progress(Math.min(3, (saved?.retry?.failures ?? 0) + 1)) });
        if (!failure.ok) { diagnostics.error = `${failure.error.code}: ${failure.error.message}`; uncertain = failure.error.code === "MEMORY_COMMIT_UNCERTAIN"; }
        else diagnostics.pendingSegments = pending.length + ((saved?.retry?.failures ?? 0) + 1 >= 2 ? 1 : 0);
      }
    } finally { diagnostics.durationMs += now() - started; if (abort === signal) abort = undefined;
      try { options.updated(); for (const listener of listeners) listener(); } catch { /* display only */ }
    }
  };
  const consider = (idle: boolean) => {
    if (closed || uncertain || task) return;
    const epoch = generation; diagnostics.running = true;
    let drain = false;
    task = extract(idle, epoch).then(advanced => { drain = advanced === true; }).catch(error => { diagnostics.error = error instanceof Error ? error.message : "抽取准备失败"; }).finally(() => {
      task = undefined; diagnostics.running = false;
      if (!closed && generation === epoch) { clearTimeout(timer); if (drain) queueMicrotask(() => consider(false)); else { timer = setTimeout(() => consider(true), IDLE_MS); timer.unref(); } }
    });
  };
  return {
    afterMask(messageId: string) { urgentThrough = messageId; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    diagnostics: () => structuredClone(diagnostics),
    async backlog() { const loaded = await load(); return loaded.backlog.filter(message => findCommittedUserMessage(loaded.messages, message.id)).length; },
    idle() { lastActivity = now(); consider(false); clearTimeout(timer); timer = setTimeout(() => { if (now() - lastActivity >= IDLE_MS) consider(true); }, IDLE_MS); timer.unref(); },
    async pause() { generation++; clearTimeout(timer); abort?.abort(new DOMException("Foreground chat has priority", "AbortError")); await task; },
    async close() { closed = true; generation++; clearTimeout(timer); abort?.abort(); await task; },
  };
}
export type MemoryExtraction = ReturnType<typeof createMemoryExtraction>;
