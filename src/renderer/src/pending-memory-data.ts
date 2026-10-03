import type { MemoryPanelAction, MemoryPanelState } from "../../shared/memory-review.js";
import { initialMemoryPanel, listErrorText, memoryPanelReducer, reviewErrorText } from "../../shared/memory-review.js";

export interface PendingMemoryStatus {
  /** Pending candidates in the returned page, never a claimed total. */
  count: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  reviewing: boolean;
}

export type PendingMemoryAction = MemoryPanelAction | { type: "disabled" };

export function initialPendingMemory(): MemoryPanelState {
  return { ...initialMemoryPanel(), open: true };
}

/** Keep the existing review guards, but advance after a confirmed terminal result. */
export function pendingMemoryReducer(state: MemoryPanelState, action: PendingMemoryAction): MemoryPanelState {
  if (action.type === "disabled") return initialPendingMemory();
  let next = memoryPanelReducer(state, action);
  let finishedId: string | null = null;
  if (action.type === "resolve-result" && state.resolving && action.result.ok) {
    finishedId = action.result.value.candidateId;
  }
  if (action.type === "detail-result"
    && action.request === state.detailRequest
    && action.id === state.selectedId
  ) {
    if (!action.result.ok && action.result.error.code === "MEMORY_CANDIDATE_NOT_FOUND") {
      // A list can become outdated before its detail is read. Do not select it forever.
      finishedId = action.id;
    } else if (action.result.ok && action.result.value.candidate.status !== "pending") {
      finishedId = action.result.value.candidate.id;
    } else if (action.result.ok && state.outcomeUnknown) {
      next = { ...next, reviewError: null, receipt: "已重新读取：此候选仍为待审。上次审核没有自动重发。" };
    }
  }
  if (finishedId === null) return next;
  return {
    ...next,
    candidates: next.candidates.filter((candidate) => candidate.id !== finishedId),
    ...(next.selectedId === finishedId ? {
      selectedId: null,
      preview: null,
      detailLoading: false,
      detailError: null,
      previewNeedsReview: false,
      previewChanged: false,
      outcomeUnknown: false,
    } : {}),
  };
}

export function pendingMemoryStatus(
  state: MemoryPanelState,
  enabled: boolean,
  visible: boolean,
  fresh: boolean,
): PendingMemoryStatus {
  if (!enabled) return { count: 0, hasMore: false, loading: false, error: null, reviewing: false };
  return {
    count: state.candidates.filter((candidate) => candidate.status === "pending").length,
    hasMore: state.nextOffset !== null || state.truncated,
    loading: !fresh || state.listLoading || state.detailLoading,
    error: state.listError !== null ? listErrorText(state.listError)
      : state.detailError !== null ? reviewErrorText(state.detailError, state.controllerIdle)
      : state.reviewError,
    reviewing: visible && fresh && state.controllerIdle && !state.detailLoading
      && state.preview?.candidate.status === "pending",
  };
}
