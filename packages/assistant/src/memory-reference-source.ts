import type { ReferenceSource } from "./context-assembler.js";
import { buildMemoryContextView } from "./memory-context-view.js";
import { memoryQueryTopics, type createMemoryQueryRewriter, type MemoryReferenceSnapshot } from "./memory-query-rewrite.js";
import type { createMemoryRelevanceSelector, MemoryRelevanceResult } from "./memory-relevance.js";
import { boundedMemoryQuery, createRetrievedMemoryContextMessage, memorySemanticTextHash, retrieveMemories, RETRIEVED_MEMORY_MAX_BYTES, RETRIEVED_MEMORY_MAX_ENTRIES, selectEligibleMemoryEntries } from "./memory-retrieval.js";
import type { LocalMemorySemanticIndex, MemoryEmbeddingPort, MemorySemanticHit } from "./memory-semantic-index.js";
import { isMemoryConsolidationExcluded } from "./consolidation.js";
import type { MemoryEntry } from "./memory-store.js";
import type { WorkTaskStore } from "./work-task-store.js";

export interface MemoryReferenceSourceOptions {
  readonly threadId: string;
  /** Current entries from the store; undefined when Memory is not assembled. */
  readonly readEntries: ((signal: AbortSignal, now: Date) => Promise<MemoryEntry[]>) | undefined;
  readonly relevanceEnabled: boolean;
  readonly queryRewriteEnabled: boolean;
  readonly contextViewEnabled: boolean;
  readonly semanticModelId: string | undefined;
  readonly rewriteQuery: ReturnType<typeof createMemoryQueryRewriter>;
  readonly selectRelevance: ReturnType<typeof createMemoryRelevanceSelector>;
  readonly semanticIndex: LocalMemorySemanticIndex | undefined;
  readonly embedding: MemoryEmbeddingPort | undefined;
  readonly workTasks: WorkTaskStore | undefined;
  /** A WorkTask contract is not a user fact; its Runs get no ordinary retrieval. */
  readonly workTaskActive: () => boolean;
}

/**
 * Retrieved Memory plus the optional derived profile view. They share one byte
 * and entry budget, so they are one source. Ordinary primary input may use query
 * rewrite, semantic hits and relevance judgment; other preparations use plain retrieval.
 */
export function createMemoryReferenceSource(options: MemoryReferenceSourceOptions): ReferenceSource {
  const { threadId, readEntries, rewriteQuery, selectRelevance, semanticIndex, embedding, workTasks } = options;
  let semanticCache: { key: string; hits: MemorySemanticHit[]; candidates: MemorySemanticHit[]; state: "ready" | "warming" | "degraded" } | undefined;
  return {
    name: "memory",
    slots: ["memory", "memory-context-view"],
    collect: async ({ messages, signal, primary, now, user, query }) => {
      const origin = (user?.metadata as { source?: unknown } | undefined)?.source;
      const ordinaryPrimary = primary && user !== undefined && query.trim().length > 0 && !options.workTaskActive()
        && !isMemoryConsolidationExcluded(user) && (origin === undefined || origin === "steer");
      const relevanceEnabled = options.relevanceEnabled === true;
      const rewrite = ordinaryPrimary && !relevanceEnabled && options.queryRewriteEnabled
        ? await rewriteQuery(user.id, query, signal, memoryQueryTopics(messages, user.id)) : undefined;
      let entries = readEntries === undefined ? undefined : await readEntries(signal, now);
      let semantic: NonNullable<MemoryReferenceSnapshot["semantic"]> = { state: semanticIndex ? "not_applicable" : "off" };
      let semanticHits: MemorySemanticHit[] | undefined;
      let semanticCandidates: MemorySemanticHit[] | undefined;
      const eligibleForEmbedding = entries ? selectEligibleMemoryEntries(entries, { now, threadId }) : [];
      if (ordinaryPrimary && semanticIndex && embedding && entries && eligibleForEmbedding.length > 0) {
        const key = JSON.stringify([user.id, boundedMemoryQuery(query).text, embedding.modelId,
          eligibleForEmbedding.map(entry => [entry.id, entry.revision ?? 1, memorySemanticTextHash(entry.text)])]);
        if (semanticCache?.key !== key) {
          const hits = await semanticIndex.search(entries, { query, now, threadId, signal });
          const candidates = semanticIndex.lastDiagnostics?.candidates.flatMap(item => item.score === null ? []
            : [{ id: item.id, revision: item.revision, textHash: item.textHash, score: item.score }]) ?? hits;
          semanticCache = { key, hits, candidates, state: semanticIndex.lastState };
        }
        semanticHits = semanticCache.hits;
        semanticCandidates = semanticCache.candidates;
        semantic = { state: semanticCache.state, modelId: options.semanticModelId ?? embedding.modelId };
        // External inference can overlap a formal edit. Only fresh eligible revisions
        // can be injected; retrieval verifies every returned id/revision/text hash.
        entries = await readEntries!(signal, new Date());
      }
      let relevance: MemoryRelevanceResult | undefined = relevanceEnabled
        ? { state: "not_applicable", selected: [], queries: [], candidateCount: 0, truncated: false } : undefined;
      if (ordinaryPrimary && relevanceEnabled && entries) {
        relevance = await selectRelevance(user.id, query, entries, {
          now: new Date(), threadId, signal, ...(semanticCandidates ? { semanticCandidates } : {}),
          recentUserTopics: memoryQueryTopics(messages, user.id),
        });
        // The decision binds the shown revision and hash. New/changed facts must
        // not enter through lexical matches or derived profiles in later steps.
        entries = await readEntries!(signal, new Date());
      }
      const selectedAt = new Date();
      if (semantic.state !== "off" && entries && selectEligibleMemoryEntries(entries, { now: selectedAt, threadId }).length === 0) {
        semantic = { state: "not_applicable" };
      }
      // A judged empty answer or an empty eligible pool is a strict empty
      // selection for ordinary input, not permission for profile fallback.
      // Excluded/scheduled/WorkTask preparations retain their existing path.
      const relevanceSelection = ordinaryPrimary && relevanceEnabled && relevance
        && (relevance.state === "succeeded" || relevance.state === "not_applicable") ? relevance.selected : undefined;
      let view: ReturnType<typeof buildMemoryContextView> | undefined;
      if (ordinaryPrimary && entries && options.contextViewEnabled) {
        const tasks = await workTasks?.list({ threadId, limit: 100 });
        signal.throwIfAborted();
        if (tasks && !tasks.ok) throw new Error(`Unable to prepare current Thread continuation: ${tasks.error.message}`);
        const profileEntries = relevanceSelection === undefined ? entries : entries.filter(entry => entry.pinned || relevanceSelection.some(hit =>
          hit.id === entry.id && hit.revision === (entry.revision ?? 1) && hit.textHash === memorySemanticTextHash(entry.text)));
        view = buildMemoryContextView(profileEntries, tasks?.ok ? tasks.value : [], { threadId, now: selectedAt,
          excludedMemoryIds: entries.filter(entry => entry.pinned).map(entry => entry.id) });
      }
      const profileIds = new Set(view?.profile.map(item => item.id));
      const selection = entries === undefined ? undefined : retrieveMemories(entries.filter(entry => !profileIds.has(entry.id)), {
        query, threadId, now: selectedAt, ...(rewrite ? { rewrittenQueries: rewrite.queries } : relevance ? { rewrittenQueries: relevance.queries } : {}),
        ...(semanticHits ? { semanticHits } : {}),
        ...(relevanceSelection === undefined ? {} : { relevanceSelection }),
        maxBytes: RETRIEVED_MEMORY_MAX_BYTES - (view?.bytes ?? 0),
        maxEntries: RETRIEVED_MEMORY_MAX_ENTRIES - (view?.profile.length ?? 0),
      });
      // The profile is also a current formal reference. Do not put a contradictory
      // "selected entries: []" inventory beside a nonempty derived profile.
      const memoryMessage = selection && (selection.entries.length > 0 || !view?.profile.length)
        ? createRetrievedMemoryContextMessage(selection) : undefined;
      const reference: MemoryReferenceSnapshot | null = primary && user && selection ? {
        messageId: user.id, preparedAt: new Date().toISOString(), truncated: selection.truncated || (view?.truncated ?? false) || (relevance?.truncated ?? false), queryTruncated: selection.queryTruncated,
        temporalView: selection.temporalView,
        rewrite: rewrite?.state ?? (!relevanceEnabled && options.queryRewriteEnabled ? "not_applicable" : "off"),
        semantic,
        ...(relevance ? { relevance: { state: relevance.state, candidateCount: relevance.candidateCount, truncated: relevance.truncated } } : {}),
        ...(view ? { contextView: { profileCount: view.profile.length, continuationCount: view.continuation.length, truncated: view.truncated } } : {}),
        referenceBytes: (memoryMessage ? selection.bytes : 0) + (view?.bytes ?? 0),
        selected: [...(view?.profile.map(({ id, revision, text, assertion }) => ({ id, revision, text, assertion, reason: "stable_profile" as const })) ?? []),
          ...selection.selected.map(item => ({ ...item, text: selection.entries.find(entry => entry.id === item.id)!.text }))],
      } : null;
      return { messages: { memory: memoryMessage, "memory-context-view": view?.message }, memoryReference: reference };
    },
  };
}
