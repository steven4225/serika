import type { AssistantController } from "@serika/assistant";
import type { WorkTaskResult } from "@serika/assistant";
export type { WorkTaskContinuation } from "@serika/assistant";
export type { WorkTaskReadInput, WorkTaskArtifactInput, WorkTaskReadResult, WorkTaskDeliveryDraft, WorkTaskArtifactPreview } from "@serika/assistant";

export type { WorkTask, WorkTaskResult, WorkTaskStatus, WorkTaskObservedOutcome } from "@serika/assistant";

/** Desktop IPC operation name → method of the controller's `workTasks` group. */
export interface WorkTaskOperationMethods {
  createWorkTask: "create";
  runWorkTask: "run";
  submitWorkTaskDelivery: "submitDelivery";
  recordHumanAcceptance: "recordHumanAcceptance";
  reconcileWorkTask: "reconcile";
  cancelWorkTask: "cancel";
  requestWorkTaskChanges: "requestChanges";
}

export type WorkTaskInputs = {
  [K in keyof WorkTaskOperationMethods]: Parameters<AssistantController["workTasks"][WorkTaskOperationMethods[K]]>[0];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function texts(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }

/** IPC accepts data, never task ownership, supplied evidence, or a status transition. */
export function sanitizeWorkTaskInput<K extends keyof WorkTaskInputs>(operation: K, input: unknown): WorkTaskResult<WorkTaskInputs[K]> {
  const invalid = (): WorkTaskResult<never> => ({ ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Invalid work task input" } });
  if (!record(input)) return invalid();
  let value: WorkTaskInputs[keyof WorkTaskInputs];
  if (operation === "createWorkTask") {
    if (input.operationId !== undefined && (typeof input.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId))) return invalid();
    if (!text(input.goal) || (input.constraints !== undefined && !texts(input.constraints)) || !Array.isArray(input.acceptance)) return invalid();
    const acceptance: WorkTaskInputs["createWorkTask"]["acceptance"] = [];
    for (const item of input.acceptance) {
      if (!record(item) || !text(item.id) || !text(item.description) || typeof item.required !== "boolean" || !record(item.verification)) return invalid();
      if (item.method === "human" && item.verification.kind === "human") {
        acceptance.push({ id: item.id, description: item.description, required: item.required, method: "human", verification: { kind: "human" } });
      } else if (item.method === "automatic" && item.verification.kind === "artifact_exists" && text(item.verification.path)) {
        if (item.verification.requireReadback !== undefined && typeof item.verification.requireReadback !== "boolean") return invalid();
        acceptance.push({ id: item.id, description: item.description, required: item.required, method: "automatic", verification: { kind: "artifact_exists", path: item.verification.path,
          ...(item.verification.requireReadback === undefined ? {} : { requireReadback: item.verification.requireReadback }) } });
      } else if (item.method === "automatic" && item.verification.kind === "shell_exit_zero" && text(item.verification.command) && text(item.verification.cwd)) {
        acceptance.push({ id: item.id, description: item.description, required: item.required, method: "automatic", verification: { kind: "shell_exit_zero", command: item.verification.command, cwd: item.verification.cwd } });
      } else return invalid();
    }
    value = { goal: input.goal, acceptance, ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId as string }) };
  } else {
    if (!text(input.id) || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) return invalid();
    const identity = { id: input.id, expectedRevision: input.expectedRevision as number };
    switch (operation) {
      case "runWorkTask":
        if (input.instruction !== undefined && !text(input.instruction)) return invalid();
        value = { ...identity, ...(input.instruction === undefined ? {} : { instruction: input.instruction as string }) };
        break;
      case "submitWorkTaskDelivery":
        if (!text(input.summary) || (input.artifactRefs !== undefined && !texts(input.artifactRefs)) || (input.unresolved !== undefined && !texts(input.unresolved))) return invalid();
        value = { ...identity, summary: input.summary, ...(input.artifactRefs === undefined ? {} : { artifactRefs: input.artifactRefs }), ...(input.unresolved === undefined ? {} : { unresolved: input.unresolved }) };
        break;
      case "recordHumanAcceptance":
        if (!text(input.criterionId) || !["passed", "failed"].includes(String(input.decision)) || (input.note !== undefined && !text(input.note))) return invalid();
        value = { ...identity, criterionId: input.criterionId, decision: input.decision as "passed" | "failed", ...(input.note === undefined ? {} : { note: input.note as string }) };
        break;
      case "reconcileWorkTask":
        if (!["applied", "partially_applied", "not_applied", "still_unknown"].includes(String(input.observedOutcome)) || !["continue", "cancel"].includes(String(input.decision)) || !text(input.note)) return invalid();
        value = { ...identity, observedOutcome: input.observedOutcome as WorkTaskInputs["reconcileWorkTask"]["observedOutcome"], decision: input.decision as "continue" | "cancel", note: input.note };
        break;
      case "requestWorkTaskChanges":
      case "cancelWorkTask": value = identity; break;
      default: return invalid();
    }
  }
  return { ok: true, value: value as WorkTaskInputs[K] };
}
