import type { BriefContinueTarget } from "./today-brief.js";

export type { BriefContinueTarget };

const STORAGE_KEY = "serika:today-brief-continue";

export interface BriefContinuePlan {
  threadId: string;
  selectTaskId: string | null;
  /** Undefined leaves the current composer mode unchanged. */
  composerTaskId: string | null | undefined;
  ordinaryDraft: string | null;
  taskDraft: string | null;
  closeDashboard: true;
}

/** Pure routing plan. Applying it focuses chat; it never starts a run. */
export function planBriefContinue(target: BriefContinueTarget): BriefContinuePlan {
  const selectTaskId = target.kind === "task" ? target.taskId : null;
  if (target.compose && selectTaskId) {
    return {
      threadId: target.threadId,
      selectTaskId,
      composerTaskId: selectTaskId,
      ordinaryDraft: null,
      taskDraft: target.draft.length > 0 ? target.draft : null,
      closeDashboard: true,
    };
  }
  if (target.draft.length > 0) {
    return {
      threadId: target.threadId,
      selectTaskId,
      composerTaskId: null,
      ordinaryDraft: target.draft,
      taskDraft: null,
      closeDashboard: true,
    };
  }
  return {
    threadId: target.threadId,
    selectTaskId,
    composerTaskId: undefined,
    ordinaryDraft: null,
    taskDraft: null,
    closeDashboard: true,
  };
}

export function briefContinueTarget(value: unknown): BriefContinueTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "task" && record.kind !== "thread") return null;
  if (typeof record.threadId !== "string" || record.threadId.length === 0 || record.threadId.length > 256) return null;
  if (record.taskId !== null && (typeof record.taskId !== "string" || record.taskId.length === 0 || record.taskId.length > 256)) return null;
  if (typeof record.compose !== "boolean" || typeof record.draft !== "string" || record.draft.length > 2000) return null;
  if (record.kind === "thread" && (record.compose || record.taskId !== null)) return null;
  if (record.compose && (record.kind !== "task" || record.taskId === null)) return null;
  return {
    kind: record.kind,
    threadId: record.threadId,
    taskId: record.taskId,
    compose: record.compose,
    draft: record.draft,
  };
}

export function writeBriefContinue(storage: Pick<Storage, "setItem">, target: BriefContinueTarget): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(target));
}

export function readBriefContinue(storage: Pick<Storage, "getItem">): BriefContinueTarget | null {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return briefContinueTarget(JSON.parse(raw)); }
  catch { return null; }
}

export function clearBriefContinue(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(STORAGE_KEY);
}
