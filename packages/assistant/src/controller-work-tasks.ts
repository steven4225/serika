import { randomUUID } from "node:crypto";
import type { AssistantRunOptions, StartRunResponse } from "./assistant-controller.js";
import type { ControllerKernel } from "./controller-kernel.js";
import { readWorkTaskArtifact, workTaskDeliveryDraft, type WorkTaskArtifactInput, type WorkTaskArtifactPreview, type WorkTaskDeliveryDraft, type WorkTaskReadInput, type WorkTaskReadResult } from "./work-task-artifacts.js";
import { workTaskContinuation, type WorkTaskContinuation } from "./work-task-continuation.js";
import type { CreateWorkTaskInput, WorkTask, WorkTaskEvidence, WorkTaskFailure, WorkTaskObservedOutcome, WorkTaskResult } from "./work-task-store.js";
import { verifyAutomaticCriterion } from "./work-task-verification.js";

/** Work tasks bound to this Thread: their records, receipts, execution and acceptance. */
export interface AssistantWorkTaskControls {
  create(input: Omit<CreateWorkTaskInput, "threadId">): Promise<WorkTaskResult<WorkTask>>;
  list(): Promise<WorkTaskResult<WorkTask[]>>;
  get(id: string): Promise<WorkTaskResult<WorkTask>>;
  getDeliveryDraft(input: WorkTaskReadInput): Promise<WorkTaskReadResult<WorkTaskDeliveryDraft>>;
  getContinuation(input: WorkTaskReadInput): Promise<WorkTaskResult<WorkTaskContinuation>>;
  getArtifact(input: WorkTaskArtifactInput): Promise<WorkTaskReadResult<WorkTaskArtifactPreview>>;
  run(input: { id: string; expectedRevision: number; instruction?: string; completionCheck?: boolean; source?: "telegram" }, options?: { desktopEntry?: true }): Promise<StartRunResponse>;
  submitDelivery(input: {
    id: string;
    expectedRevision: number;
    summary: string;
    artifactRefs?: string[];
    unresolved?: string[];
  }): Promise<WorkTaskResult<WorkTask>>;
  recordHumanAcceptance(input: {
    id: string;
    expectedRevision: number;
    criterionId: string;
    decision: "passed" | "failed";
    note?: string;
  }): Promise<WorkTaskResult<WorkTask>>;
  reconcile(input: {
    id: string;
    expectedRevision: number;
    observedOutcome: WorkTaskObservedOutcome;
    decision: "continue" | "cancel";
    note: string;
  }): Promise<WorkTaskResult<WorkTask>>;
  cancel(input: { id: string; expectedRevision: number }): Promise<WorkTaskResult<WorkTask>>;
  requestChanges(input: { id: string; expectedRevision: number }): Promise<WorkTaskResult<WorkTask>>;
}

/**
 * The core's single "next / active work task" slot. A task Run is reserved
 * here before the primary Run starts; the Run engine moves it to active.
 */
export interface WorkTaskSlot {
  busy(): boolean;
  reserve(task: WorkTask, completionCheck: boolean): void;
  release(): void;
}

function unavailableWorkTask(): WorkTaskResult<never> {
  return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "WorkTask requires a configured workspace" } };
}

function missingWorkTask(): WorkTaskResult<never> {
  return { ok: false, error: { code: "WORK_TASK_NOT_FOUND", message: "Work task not found" } };
}

export function createWorkTaskControls(k: ControllerKernel, deps: {
  slot: WorkTaskSlot;
  run(text: string, options?: AssistantRunOptions): Promise<StartRunResponse>;
  /** A human acceptance completed a task. */
  onCompleted(): void;
}): AssistantWorkTaskControls {
  const { app } = k;
  const { slot } = deps;
  const workTaskRecoveryFailure = async (): Promise<WorkTaskFailure | undefined> => {
    try {
      await k.ensureRecovered();
      return undefined;
    } catch (error) {
      const message = `WorkTask recovery unavailable: ${String(error)}`;
      k.emit({ type: "error", message });
      return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message } };
    }
  };
  const readTaskForDisplay = async (input: WorkTaskReadInput): Promise<WorkTaskResult<WorkTask>> => {
    if (k.isClosed()) return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "Controller is closed" } };
    if (!input || typeof input.id !== "string" || !input.id.trim() || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Task id and current revision are required" } };
    }
    const recoveryFailure = await workTaskRecoveryFailure();
    if (recoveryFailure) return recoveryFailure;
    if (!app.workTasks) return unavailableWorkTask();
    const found = await app.workTasks.get(input.id);
    if (!found.ok) return found;
    if (found.value.threadId !== app.threadId) return missingWorkTask();
    if (found.value.revision !== input.expectedRevision) return { ok: false, error: { code: "WORK_TASK_REVISION_CONFLICT", message: "Task changed; reload before reading its artifact or draft" } };
    return found;
  };
  const busy = (): boolean => k.isClosed() || !k.isIdle() || slot.busy();
  return {
    create: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const created = await app.workTasks.create({ ...input, threadId: app.threadId });
      if (created.ok) k.emit({ type: "work-task-updated", task: created.value });
      return created;
    },
    list: async () => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      return app.workTasks?.list({ threadId: app.threadId }) ?? unavailableWorkTask();
    },
    get: async (id) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const task = await app.workTasks.get(id);
      if (task.ok && task.value.threadId !== app.threadId) {
        return { ok: false, error: { code: "WORK_TASK_NOT_FOUND", message: "Work task not found" } };
      }
      return task;
    },
    getContinuation: async (input) => {
      const task = await readTaskForDisplay(input);
      if (!task.ok) return task;
      try {
        const runId = task.value.runIds.at(-1);
        const run = runId ? await app.executionRecords.getRun(app.threadId, runId) : null;
        return { ok: true, value: workTaskContinuation(task.value, run) };
      } catch {
        return { ok: false, error: { code: "WORK_TASK_READ_FAILED", message: "Unable to read continuation receipts; no older Run was substituted" } };
      }
    },
    getDeliveryDraft: async (input) => {
      const task = await readTaskForDisplay(input);
      if (!task.ok) return task;
      const runId = task.value.runIds.at(-1);
      try {
        const run = runId ? await app.executionRecords.getRun(app.threadId, runId) : null;
        return { ok: true, value: workTaskDeliveryDraft(task.value, run) };
      } catch {
        return { ok: false, error: { code: "WORK_TASK_READ_FAILED", message: "Unable to read the latest execution receipt; no older draft was used" } };
      }
    },
    getArtifact: async (input) => {
      const task = await readTaskForDisplay(input);
      if (!task.ok) return task;
      if (typeof input.path !== "string" || !input.path.trim() || input.path.length > 1024) {
        return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "A bounded artifact path is required" } };
      }
      if (!app.moduleConfig?.enabled["read-file"] || !app.workspaceRoot) {
        return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "Artifact preview requires enabled file module and workspace" } };
      }
      const runId = task.value.runIds.at(-1);
      try {
        const run = runId ? await app.executionRecords.getRun(app.threadId, runId) : null;
        return await readWorkTaskArtifact(app.workspaceRoot, task.value, run, input.path);
      } catch {
        return { ok: false, error: { code: "WORK_TASK_READ_FAILED", message: "Unable to read artifact preview or its execution receipt" } };
      }
    },
    run: async (input, options) => {
      if (await workTaskRecoveryFailure() !== undefined) return { ok: false, reason: "starting" };
      if (app.workTasks === undefined || app.workspaceRoot === undefined) return { ok: false, reason: "starting" };
      if (busy()) return { ok: false, reason: "busy" };
      const found = await app.workTasks.get(input.id);
      if (!found.ok || found.value.threadId !== app.threadId || found.value.revision !== input.expectedRevision ||
          !["ready", "paused"].includes(found.value.status)) {
        return { ok: false, reason: "starting" };
      }
      if (busy()) return { ok: false, reason: "busy" };
      let clearBinding: (() => void) | undefined;
      try {
        const runId = found.value.runIds.at(-1);
        const run = runId ? await app.executionRecords.getRun(app.threadId, runId) : null;
        // Receipt reads are asynchronous. Recheck the idle mutex before reserving the next Run.
        if (busy()) return { ok: false, reason: "busy" };
        app.workTaskContext.begin(found.value, workTaskContinuation(found.value, run));
        slot.reserve(found.value, input.completionCheck !== false);
        clearBinding = app.bindNextExecutionWorkTask({ id: found.value.id, expectedRevision: found.value.revision });
        // A task execution instruction is not evidence of a lasting user preference.
        // Persist the existing exclusion marker so later history consolidation also skips it.
        const started = await deps.run(input.instruction?.trim() || found.value.goal, {
          memoryConsolidation: "exclude",
          ...(input.source ? { source: input.source } : {}),
          ...(options?.desktopEntry ? { desktopEntry: true } : {}),
        });
        clearBinding();
        clearBinding = undefined;
        if (!started.ok) {
          slot.release();
          app.workTaskContext.end();
        }
        return started;
      } catch (error) {
        clearBinding?.();
        slot.release();
        app.workTaskContext.end();
        k.emit({ type: "error", message: String(error) });
        return { ok: false, reason: "starting" };
      }
    },
    submitDelivery: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      let current = await app.workTasks.submitDelivery(input.id, {
        expectedRevision: input.expectedRevision,
        delivery: {
          summary: input.summary,
          artifactRefs: input.artifactRefs ?? [],
          evidence: [],
          unresolved: input.unresolved ?? [],
        },
      });
      if (!current.ok) return current;
      const automaticCriteria = current.value.acceptance
        .filter((criterion) => criterion.method === "automatic")
        .sort((left, right) => Number(left.required) - Number(right.required));
      for (const criterion of automaticCriteria) {
        const verified = await verifyAutomaticCriterion(app, current.value, criterion);
        current = await app.workTasks.recordAcceptance(current.value.id, {
          expectedRevision: current.value.revision,
          criterionId: criterion.id,
          actor: "automatic",
          status: verified.status,
          evidence: verified.evidence,
          note: verified.note,
        });
        if (!current.ok) return current;
      }
      k.emit({ type: "work-task-updated", task: current.value });
      return current;
    },
    recordHumanAcceptance: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      const evidence: WorkTaskEvidence[] = input.decision === "passed"
        ? [{ id: randomUUID(), kind: "human", criterionId: input.criterionId, acceptedAt: new Date().toISOString() }]
        : [];
      const updated = await app.workTasks.recordAcceptance(input.id, {
        expectedRevision: input.expectedRevision,
        criterionId: input.criterionId,
        actor: "human",
        status: input.decision,
        evidence,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      if (updated.ok) {
        k.emit({ type: "work-task-updated", task: updated.value });
        if (updated.value.status === "completed") deps.onCompleted();
      }
      return updated;
    },
    reconcile: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      const updated = await app.workTasks.reconcile(input.id, {
        expectedRevision: input.expectedRevision,
        observedOutcome: input.observedOutcome,
        decision: input.decision,
        note: input.note,
      });
      if (updated.ok) k.emit({ type: "work-task-updated", task: updated.value });
      return updated;
    },
    requestChanges: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      if (k.isClosed() || !k.isIdle()) return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "Controller must be idle to request changes" } };
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      const updated = await app.workTasks.requestChanges(input.id, input.expectedRevision);
      if (updated.ok) k.emit({ type: "work-task-updated", task: updated.value });
      return updated;
    },
    cancel: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      const cancelled = await app.workTasks.cancel(input.id, input.expectedRevision);
      if (cancelled.ok) k.emit({ type: "work-task-updated", task: cancelled.value });
      return cancelled;
    },
  };
}
