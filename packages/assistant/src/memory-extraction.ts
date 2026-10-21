import { generateText, type LanguageModel, type UIMessage } from "ai";
import { z } from "zod";
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
    const { saved, document, messages, backlog } = initial;
    diagnostics.pendingSegments = (saved?.retry?.failures ?? 0) >= 2 ? 1 : 0;
    if (!backlog.some(message => findCommittedUserMessage(messages, message.id))) return;
    if (saved?.retry && (saved.retry.failures >= 3 || saved.retry.failures >= 2 && !idle)) return;
    if (!idle && initial.tokens < threshold) return;
    if (saved?.retry && prefixHash(messages, saved.retry.throughMessageId) !== saved.retry.prefixHash) throw new Error("MEMORY_CURSOR_MISMATCH");
    const selected: UIMessage[] = [];
    for (const message of backlog) {
      if (Math.ceil(JSON.stringify(extractionMessages([...selected, message])).length / 2) > threshold) break;
      selected.push(message);
      if (saved?.retry?.throughMessageId === message.id) break;
    }
    const users = selected.filter(message => findCommittedUserMessage(messages, message.id));
    if (!users.length) { diagnostics.error = "原文段超过当前抽取窗口，等待第 6 步分块处理"; diagnostics.pendingSegments = 1; return; }
    const last = selected.at(-1)!.id, selectedHash = prefixHash(messages, last);
    const signal = new AbortController(); abort = signal;
    const started = now(); let dispatched = false;
    const progress = (failures: number): V6Document["progress"][number] => ({ threadId: options.threadId,
      throughMessageId: saved?.throughMessageId ?? null, prefixHash: saved?.prefixHash ?? null,
      retry: { throughMessageId: last, prefixHash: selectedHash, failures } });
    try {
      const facts = document.entries.filter(entry => entry.state === "active" && entry.category !== "document" && entry.scope.kind === "workspace");
      const prompt = JSON.stringify(extractionMessages(selected).map(message => ({ ...message, threadId: options.threadId, project: options.workspaceRoot ?? "current-workspace" }))) + "\nTask: extract memory from the preceding original block.\n" + MEMORY_WRITE_RULES +
        "\nCurrent preferences and project notes: " + JSON.stringify(facts.map(({ id, revision, text, category, identity, scope }) => ({ id, revision, text, category, identity, scope }))) +
        "\nReturn ONLY {proposals,outcomes}; each proposal has sourceMessageId and memory_write fields. Return one outcome for EACH ordinary eligible user source in order: extracted, no_memory or deferred. extracted requires ALL durable information accounted for; partial coverage is deferred. No tools, retries or prose. Already attached exact sources need no duplicate proposal. Eligible user IDs: " + JSON.stringify(users.map(user => user.id));
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
        const user = users.find(user => user.id === proposal.sourceMessageId); if (!user) throw new Error("抽取来源越界");
        const { sourceMessageId: _id, ...write } = proposal;
        return bindMemoryWrite(write, { messages, user, threadId: options.threadId });
      }).filter(change => !("text" in change && document.entries.some(entry => entry.text === change.text && entry.sources.some(source => source.kind === "conversation" && change.source.kind === "conversation" && source.messageId === change.source.messageId && source.quote === change.source.quote))));
      for (const outcome of parsed.data.outcomes) if (outcome.status === "extracted" && !parsed.data.proposals.some(proposal => proposal.sourceMessageId === outcome.messageId)) throw new Error("extracted 缺少来源提议");
      const firstDeferred = parsed.data.outcomes.findIndex(outcome => outcome.status === "deferred");
      const boundary = firstDeferred < 0 ? last : selected[selected.findIndex(message => message.id === users[firstDeferred]!.id) - 1]?.id ?? saved?.throughMessageId ?? null;
      const next: V6Document["progress"][number] = { threadId: options.threadId, throughMessageId: boundary,
        prefixHash: boundary ? prefixHash(messages, boundary) : null, retry: firstDeferred < 0 ? null : progress(Math.min(3, (saved?.retry?.failures ?? 0) + 1)).retry };
      const fresh = await options.getMessages(); if (prefixHash(fresh, last) !== selectedHash) throw new Error("抽取原文已变化");
      const committed = await options.store.writeV6!(changes, signal.signal, { expectedProgress: saved, progress: next, automatic: true });
      if (!committed.ok) {
        if (committed.error.code === "MEMORY_COMMIT_UNCERTAIN") uncertain = true;
        throw new Error(`${committed.error.code}: ${committed.error.message}`);
      }
      diagnostics.completed++; diagnostics.pendingSegments = (next.retry?.failures ?? 0) >= 2 ? 1 : 0; delete diagnostics.error;
      return boundary !== (saved?.throughMessageId ?? null) && next.retry === null;
    } catch (error) {
      if (signal.signal.aborted) { if (dispatched) diagnostics.cancelled++; return; }
      diagnostics.failed++; diagnostics.error = error instanceof Error ? error.message : "抽取失败";
      if (!uncertain && !diagnostics.error.includes("MEMORY_LIMIT_EXCEEDED") && !diagnostics.error.includes("MEMORY_CURSOR_MISMATCH")) {
        const failure = await options.store.writeV6!([], signal.signal, { expectedProgress: saved, progress: progress(Math.min(3, (saved?.retry?.failures ?? 0) + 1)) });
        if (!failure.ok) { diagnostics.error = `${failure.error.code}: ${failure.error.message}`; uncertain = failure.error.code === "MEMORY_COMMIT_UNCERTAIN"; }
        else diagnostics.pendingSegments = (saved?.retry?.failures ?? 0) + 1 >= 2 ? 1 : 0;
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
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    diagnostics: () => structuredClone(diagnostics),
    async backlog() { const loaded = await load(); return loaded.backlog.filter(message => findCommittedUserMessage(loaded.messages, message.id)).length; },
    idle() { lastActivity = now(); consider(false); clearTimeout(timer); timer = setTimeout(() => { if (now() - lastActivity >= IDLE_MS) consider(true); }, IDLE_MS); timer.unref(); },
    async pause() { generation++; clearTimeout(timer); abort?.abort(new DOMException("Foreground chat has priority", "AbortError")); await task; },
    async close() { closed = true; generation++; clearTimeout(timer); abort?.abort(); await task; },
  };
}
export type MemoryExtraction = ReturnType<typeof createMemoryExtraction>;
