import type {
  CandidatePage,
  CandidatePreview,
  CandidateResolution,
  CandidateResolveInput,
  MemoryCandidate,
  MemoryResult,
} from "@aisdk-agent/example-cli/dist/memory-candidates.js";
import type { MemoryKind, MemoryValidTime } from "@aisdk-agent/example-cli/dist/memory-temporal.js";

export type CandidateFilter = "pending" | "accepted" | "rejected" | "stale";

export interface MemoryPanelState {
  open: boolean;
  filter: CandidateFilter;
  controllerIdle: boolean;
  candidates: MemoryCandidate[];
  nextOffset: number | null;
  truncated: boolean;
  listRequest: number;
  listLoading: boolean;
  listAppend: boolean;
  listError: { code: string; message: string } | null;
  selectedId: string | null;
  detailRequest: number;
  detailLoading: boolean;
  preview: CandidatePreview | null;
  detailError: { code: string; message: string } | null;
  /** Accept stays disabled until the detail reload finishes. */
  previewNeedsReview: boolean;
  /** Set after a reload shows different text or revision. */
  previewChanged: boolean;
  resolving: boolean;
  /** The last review IPC did not return. Buttons stay off until a later read succeeds. */
  outcomeUnknown: boolean;
  receipt: string | null;
  reviewError: string | null;
}

export type MemoryPanelAction =
  | { type: "toggle" }
  | { type: "controller"; idle: boolean }
  | { type: "set-filter"; filter: CandidateFilter; request: number }
  | { type: "list-start"; request: number; append: boolean }
  | { type: "list-result"; request: number; result: MemoryResult<CandidatePage> }
  | { type: "select"; id: string; request: number }
  | { type: "detail-result"; request: number; id: string; result: MemoryResult<CandidatePreview> }
  | { type: "invalidate"; listRequest: number; detailRequest: number }
  | { type: "resolve-start"; decision: "accept" | "reject" }
  | { type: "resolve-result"; result: MemoryResult<CandidateResolution> }
  | { type: "resolve-unconfirmed" };

export function initialMemoryPanel(): MemoryPanelState {
  return {
    open: false,
    filter: "pending",
    controllerIdle: true,
    candidates: [],
    nextOffset: null,
    truncated: false,
    listRequest: 0,
    listLoading: false,
    listAppend: false,
    listError: null,
    selectedId: null,
    detailRequest: 0,
    detailLoading: false,
    preview: null,
    detailError: null,
    previewNeedsReview: false,
    previewChanged: false,
    resolving: false,
    outcomeUnknown: false,
    receipt: null,
    reviewError: null,
  };
}

export function canAccept(state: MemoryPanelState): boolean {
  return state.controllerIdle
    && !state.resolving
    && !state.outcomeUnknown
    && !state.previewNeedsReview
    && !state.detailLoading
    && state.detailError === null
    && state.preview !== null
    && state.preview.candidate.status === "pending"
    && state.preview.applicable === true;
}

export function canReject(state: MemoryPanelState): boolean {
  return state.controllerIdle
    && !state.resolving
    && !state.outcomeUnknown
    && !state.detailLoading
    && state.detailError === null
    && state.preview !== null
    && state.preview.candidate.status === "pending";
}

/** The review call uses the candidate revision currently on screen. */
export function resolvePayload(preview: CandidatePreview, decision: "accept" | "reject"): CandidateResolveInput {
  return {
    candidateId: preview.candidate.id,
    expectedCandidateRevision: preview.candidate.revision,
    decision,
  };
}

export function receiptText(value: CandidateResolution): string {
  if (value.replayed) return "该决定此前已完成，返回原回执；没有重复写入。";
  if (value.status === "rejected") return "已拒绝候选，正式记忆未修改。";
  return `已接受候选。写入记忆 ${value.memoryId ?? ""}，本次写入版本为 revision ${String(value.memoryRevision ?? "")}。`;
}

export function reviewErrorText(error: { code: string; message: string }, controllerIdle: boolean): string {
  if (error.code === "MEMORY_DISABLED") return "记忆模块未启用";
  if (error.code === "MEMORY_CANDIDATE_NOT_FOUND") return "当前 Thread 不可见或记录已不存在";
  if (error.code === "MEMORY_CANDIDATE_STALE") return `${error.code}: ${error.message}`;
  if (error.code === "MEMORY_CANDIDATE_CONFLICT") {
    if (!controllerIdle || /idle|closed/i.test(error.message)) return "当前忙，空闲后再试";
    if (/revision|already/i.test(error.message)) return "候选已变化，请重新核对后再审核";
    return error.message;
  }
  return `${error.code}: ${error.message}`;
}

export function listErrorText(error: { code: string; message: string }): string {
  if (error.code === "MEMORY_DISABLED") return "记忆模块未启用";
  return `${error.code}: ${error.message}`;
}

export function loadedLabel(count: number): string {
  return `已加载 ${count} 条`;
}

export function capabilityText(memory: { enabled: boolean; autoConsolidate: boolean }): string {
  if (!memory.enabled) return "记忆模块未启用";
  if (!memory.autoConsolidate) return "自动候选整理未开启；仍可查看本 Thread 已有候选";
  return "符合条件的对话结束后可提出待审候选，需你接受才保存为正式记忆";
}

export function candidateKindLabel(candidate: MemoryCandidate): string {
  switch (candidate.change.operation) {
    case "add": return "新增";
    case "update": return "更新";
    case "change": return "事实变更";
    case "correct": return "纠错";
    case "retract": return "撤回事实";
    case "disable": return "停用";
  }
}

export function candidateAcceptLabel(candidate: MemoryCandidate): string {
  switch (candidate.change.operation) {
    case "add": return "保存这条记忆";
    case "update": case "change": return "确认更新";
    case "correct": return "确认纠错";
    case "retract": return "确认撤回";
    case "disable": return "确认停用";
  }
}

export function candidateOperationExplanation(candidate: MemoryCandidate): string {
  switch (candidate.change.operation) {
    case "add": return "接受后新增正式记忆。";
    case "update": return "更新已有记忆；系统保留此前记录。";
    case "change": return "事实从指定时间起变化；此前适用的事实仍保留在历史里。";
    case "correct": return "纠正此前记错的事实，不把纠错日当成事实变化日。";
    case "retract": return "撤回对这条事实的认可，不再把它当作当前事实引用；历史仍保留。";
    case "disable": return "停止引用这条记忆；不改变事实历史，也不是永久删除。";
  }
}

export function memoryKindLabel(kind: MemoryKind | undefined): string {
  switch (kind) {
    case "preference": return "偏好";
    case "fact": return "事实";
    case "event": return "事件";
    case "note": return "笔记";
    case undefined: return "未提供";
  }
}

/** Unknown bounds are not evidence that a fact has always been true. */
export function validTimeLabel(value: MemoryValidTime | undefined): string {
  if (value === undefined) return "未提供";
  const basis = value.basis === "explicit" ? "明确陈述" : value.basis === "reported" ? "报告时起算" : "边界未知";
  return `${value.from ?? "起点未确定"} 至 ${value.to ?? "未指定终点"}（${basis}；不含终点）`;
}

export function systemTimeLabel(value: { from: string | null; to: string | null } | undefined): string {
  if (value === undefined) return "未提供";
  return `${value.from ?? "开始记录时间未知"} 至 ${value.to ?? "仍是系统当前认知"}`;
}

export function statusLabel(status: MemoryCandidate["status"]): string {
  switch (status) {
    case "pending":
      return "待审";
    case "accepted":
      return "已接受";
    case "rejected":
      return "已拒绝";
    case "stale":
      return "已失效";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Saved quote. This is the checked substring, not a transcript reconstruction. */
export function sourceQuote(preview: CandidatePreview): string {
  return preview.candidate.source.quote;
}

/** Sources are already verified by the backend. Never reconstruct text from messages. */
export function candidateSources(preview: CandidatePreview): MemoryCandidate["source"][] {
  return preview.candidate.sources ?? [preview.candidate.source];
}

/** Full proposed text. When `proposed` is absent, the change text is still the backend field. */
export function proposedText(preview: CandidatePreview): string {
  return preview.proposed?.text ?? preview.candidate.change.text;
}

export function scopeLabel(preview: CandidatePreview): "workspace" | "当前 Thread" | null {
  const scope = preview.proposed?.scope
    ?? (preview.candidate.change.operation === "add" ? preview.candidate.change.scope : preview.current?.scope);
  if (scope === undefined) return null;
  return scope.kind === "workspace" ? "workspace" : "当前 Thread";
}

export function unavailableLabel(preview: CandidatePreview): string | null {
  if (preview.candidate.staleReason !== null) return preview.candidate.staleReason;
  if (preview.candidate.status === "pending" && preview.unavailableReason !== null) return preview.unavailableReason;
  return null;
}

export function shortPreview(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function dedupe(candidates: readonly MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>();
  const next: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    next.push(candidate);
  }
  return next;
}

function previewKey(preview: CandidatePreview): string {
  return JSON.stringify([
    preview.candidate,
    preview.current,
    preview.proposed,
    preview.applicable,
    preview.unavailableReason,
  ]);
}

export function memoryPanelReducer(state: MemoryPanelState, action: MemoryPanelAction): MemoryPanelState {
  switch (action.type) {
    case "toggle":
      return { ...state, open: !state.open };
    case "controller":
      return { ...state, controllerIdle: action.idle };
    case "set-filter":
      if (action.filter === state.filter) return state;
      return {
        ...state,
        filter: action.filter,
        candidates: [],
        nextOffset: null,
        truncated: false,
        listRequest: action.request,
        listLoading: true,
        listAppend: false,
        listError: null,
        selectedId: null,
        preview: null,
        detailError: null,
        detailLoading: false,
        previewNeedsReview: false,
        previewChanged: false,
        reviewError: null,
      };
    case "list-start":
      return {
        ...state,
        listRequest: action.request,
        listLoading: true,
        listAppend: action.append,
        listError: action.append ? state.listError : null,
      };
    case "list-result": {
      if (action.request !== state.listRequest) return state;
      if (!action.result.ok) {
        return {
          ...state,
          listLoading: false,
          listError: action.result.error,
          candidates: state.listAppend ? state.candidates : [],
          nextOffset: state.listAppend ? state.nextOffset : null,
          truncated: state.listAppend ? state.truncated : false,
        };
      }
      const page = action.result.value;
      return {
        ...state,
        listLoading: false,
        listError: null,
        candidates: dedupe(state.listAppend ? [...state.candidates, ...page.candidates] : page.candidates),
        nextOffset: page.nextOffset,
        truncated: page.truncated,
      };
    }
    case "select":
      return {
        ...state,
        selectedId: action.id,
        detailRequest: action.request,
        detailLoading: true,
        preview: null,
        detailError: null,
        previewNeedsReview: false,
        previewChanged: false,
        reviewError: null,
        outcomeUnknown: false,
        receipt: null,
      };
    case "detail-result": {
      if (action.request !== state.detailRequest || action.id !== state.selectedId) return state;
      if (!action.result.ok) {
        if (action.result.error.code === "MEMORY_CANDIDATE_NOT_FOUND") {
          return {
            ...state,
            detailLoading: false,
            selectedId: null,
            preview: null,
            detailError: action.result.error,
            previewNeedsReview: false,
            previewChanged: false,
          };
        }
        return {
          ...state,
          detailLoading: false,
          detailError: action.result.error,
          previewNeedsReview: true,
        };
      }
      const next = action.result.value;
      const changed = state.preview !== null
        && state.previewNeedsReview
        && next.candidate.status === "pending"
        && previewKey(state.preview) !== previewKey(next);
      return {
        ...state,
        detailLoading: false,
        detailError: null,
        preview: next,
        previewNeedsReview: false,
        previewChanged: changed,
        outcomeUnknown: false,
      };
    }
    case "invalidate":
      return {
        ...state,
        listRequest: action.listRequest,
        listLoading: true,
        listAppend: false,
        candidates: [],
        nextOffset: null,
        truncated: false,
        listError: null,
        detailRequest: state.selectedId === null ? state.detailRequest : action.detailRequest,
        detailLoading: state.selectedId !== null,
        previewNeedsReview: state.preview !== null,
      };
    case "resolve-start": {
      if (state.resolving) return state;
      if (action.decision === "accept" && !canAccept(state)) return state;
      if (action.decision === "reject" && !canReject(state)) return state;
      return { ...state, resolving: true, reviewError: null, receipt: null };
    }
    case "resolve-result": {
      if (!state.resolving) return state;
      if (!action.result.ok) {
        return {
          ...state,
          resolving: false,
          reviewError: reviewErrorText(action.result.error, state.controllerIdle),
        };
      }
      return {
        ...state,
        resolving: false,
        reviewError: null,
        receipt: receiptText(action.result.value),
      };
    }
    case "resolve-unconfirmed":
      if (!state.resolving) return state;
      return {
        ...state,
        resolving: false,
        outcomeUnknown: true,
        previewNeedsReview: true,
        reviewError: "审核结果未确认，请刷新核对",
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
