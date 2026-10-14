import type { CandidateListInput, CandidatePage, CandidatePreview, MemoryCandidate, MemoryResult } from "@aisdk-agent/example-cli/dist/memory-candidates.js";

export interface PendingMemoryReadApi {
  listMemoryCandidates(input: CandidateListInput): Promise<MemoryResult<CandidatePage>>;
  getMemoryCandidate(id: string): Promise<MemoryResult<CandidatePreview>>;
}

/** Read the same current-Thread review projection for the badge and list. */
export async function loadActionablePending(api: PendingMemoryReadApi, threadId: string): Promise<MemoryResult<CandidatePage>> {
  const candidates: MemoryCandidate[] = [], seen = new Set<string>();
  let offset = 0;
  // The store permits at most 64 pending candidates. Never infer a total from
  // one response: its byte limit can paginate even a very small list.
  for (let pages = 0; pages < 64; pages++) {
    const page = await api.listMemoryCandidates({ status: "pending", limit: 20, offset });
    if (!page.ok) return page;
    for (const candidate of page.value.candidates) {
      if (candidate.status !== "pending" || candidate.originThreadId !== threadId || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const detail = await api.getMemoryCandidate(candidate.id);
      if (!detail.ok) {
        if (detail.error.code === "MEMORY_CANDIDATE_NOT_FOUND") continue;
        return detail;
      }
      const preview = detail.value;
      // A semantic conflict/capacity limit may disable acceptance, but the
      // user can still reject it. Only definite expiry/target loss is omitted.
      const invalid = ["expired", "target_changed", "target_missing", "duplicate", "MEMORY_EXPIRED"].includes(preview.unavailableReason ?? "");
      if (preview.candidate.originThreadId === threadId && preview.candidate.status === "pending" && !invalid) candidates.push(preview.candidate);
    }
    const next = page.value.nextOffset;
    if (next === null) return { ok: true, value: { candidates, nextOffset: null, truncated: false } };
    if (next <= offset) break;
    offset = next;
  }
  return { ok: false, error: { code: "MEMORY_CANDIDATE_CONFLICT", message: "待确认列表正在变化，请刷新后核对；不能据此判断数量。" } };
}
