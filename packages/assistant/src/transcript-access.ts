import { excludedTranscriptView, type JsonlAgentStore, type TranscriptExclusion } from "@serika/core";
import type { UIMessage } from "ai";
import type { WorkspaceMemoryStore } from "./memory-store.js";
import type { ExecutionRunRecord } from "./execution-record-store.js";
import { memoryText } from "./memory-write.js";

/** All content consumers share exclusion records; chat display uses the raw store. */
export function createTranscriptAccess(options: { store: JsonlAgentStore; threadId: string; memory: WorkspaceMemoryStore | undefined; invalidated(): void }) {
  let recovered = false;
  const exclusions = () => options.store.getTranscriptExclusions(options.threadId);
  const redact = async (records: readonly TranscriptExclusion[]) => {
    if (!records.length || !options.memory) return;
    const result = await options.memory.excludeSources?.(options.threadId, records.map(record => record.messageId));
    if (!result?.ok) throw new Error(result ? `${result.error.code}: ${result.error.message}` : "Memory exclusion unavailable");
  };
  const reconcile = async () => { if (!recovered) { await redact(await exclusions()); recovered = true; } };
  return {
    exclusions,
    async filterRuns(runs: ExecutionRunRecord[]): Promise<ExecutionRunRecord[]> {
      const records = await exclusions(), raw = await options.store.getMessages(options.threadId);
      return excludedRunView(runs, raw, records);
    },
    async read() { await reconcile(); return options.store.getModelMessages(options.threadId); },
    async project(messages: readonly UIMessage[]) { await reconcile(); return excludedTranscriptView(messages, await exclusions()); },
    async exclude(input: { messageId: string; reason: TranscriptExclusion["reason"] }) {
      const messages = await options.store.getMessages(options.threadId), target = messages.find(message => message.id === input.messageId);
      if (!target) throw new Error("Exclusion target is not in this Thread");
      await options.store.excludeMessage({ threadId: options.threadId, ...input, at: new Date().toISOString() });
      recovered = false; options.invalidated();
      await reconcile();
      const text = memoryText(target);
      const mentions = text ? messages.filter(message => message.id !== target.id && memoryText(message).includes(text)).map(message => message.id) : [];
      const relatedDocumentIds: string[] = [];
      const library = await options.memory?.getLibrary?.(options.threadId);
      if (library && !library.ok) throw new Error(`${library.error.code}: ${library.error.message}`);
      for (const document of library?.ok ? library.value.documents : []) {
        const body = await options.memory!.readLibraryDocument!(document.id, options.threadId);
        if (!body.ok) throw new Error(`${body.error.code}: ${body.error.message}`);
        if (text && body.value.text.includes(text)) relatedDocumentIds.push(document.id);
      }
      return { ok: true, messageId: target.id, excluded: true, relatedMessageIds: mentions, relatedDocumentIds };
    },
  };
}
export type TranscriptAccess = ReturnType<typeof createTranscriptAccess>;

/** Keep effect statuses while removing payloads linked to excluded messages. */
export function excludedRunView(runs: ExecutionRunRecord[], messages: readonly UIMessage[], exclusions: readonly TranscriptExclusion[]): ExecutionRunRecord[] {
  if (!exclusions.length) return runs;
  const ids = new Set(exclusions.map(record => record.messageId));
  const excluded = messages.filter(message => ids.has(message.id));
  const calls = new Set(excluded.flatMap(message => message.parts.flatMap(part => "toolCallId" in part ? [part.toolCallId] : [])));
  const replies = excluded.filter(message => message.role === "assistant").map(memoryText).filter(Boolean);
  return runs.map(run => ({ ...run,
    ...(run.resultTextPreview && replies.some(text => text.includes(run.resultTextPreview!) || run.resultTextPreview!.includes(text)) ? { resultTextPreview: "[Excluded message]", resultTextTruncated: false } : {}),
    ...(run.steers ? { steers: run.steers.map(steer => steer.messageId && ids.has(steer.messageId) ? { ...steer, text: "[Excluded message]" } : steer) } : {}),
    tools: run.tools.map(tool => {
      if (!calls.has(tool.toolCallId)) return tool;
      const { fileInput: _input, fileRead: _read, fileWrite: _write, ...metadata } = tool;
      return { ...metadata, inputPreview: "[Excluded message]", inputTruncated: false, resultPreview: null, resultTruncated: false, errorPreview: null };
    }),
  }));
}
