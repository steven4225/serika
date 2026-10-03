import type { AssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import type { WorkTaskResult } from "@aisdk-agent/example-cli/dist/work-task-store.js";
export type { WorkTaskContinuation } from "@aisdk-agent/example-cli/dist/work-task-continuation.js";
export type { WorkTaskReadInput, WorkTaskArtifactInput, WorkTaskReadResult, WorkTaskDeliveryDraft, WorkTaskArtifactPreview } from "@aisdk-agent/example-cli/dist/work-task-artifacts.js";

export type { WorkTask, WorkTaskResult, WorkTaskStatus, WorkTaskObservedOutcome } from "@aisdk-agent/example-cli/dist/work-task-store.js";

export type WorkTaskInputs = {
  [K in "createWorkTask" | "runWorkTask" | "submitWorkTaskDelivery" | "recordHumanAcceptance" | "reconcileWorkTask" | "cancelWorkTask" | "requestWorkTaskChanges"]: Parameters<AssistantController[K]>[0];
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
    if (!text(input.goal) || (input.constraints !== undefined && !texts(input.constraints)) || !Array.isArray(input.acceptance)) return invalid();
    const acceptance: WorkTaskInputs["createWorkTask"]["acceptance"] = [];
    for (const item of input.acceptance) {
      if (!record(item) || !text(item.id) || !text(item.description) || typeof item.required !== "boolean" || !record(item.verification)) return invalid();
      if (item.method === "human" && item.verification.kind === "human") {
        acceptance.push({ id: item.id, description: item.description, required: item.required, method: "human", verification: { kind: "human" } });
      } else if (item.method === "automatic" && item.verification.kind === "artifact_exists" && text(item.verification.path)) {
        acceptance.push({ id: item.id, description: item.description, required: item.required, method: "automatic", verification: { kind: "artifact_exists", path: item.verification.path } });
      } else return invalid();
    }
    value = { goal: input.goal, acceptance, ...(input.constraints === undefined ? {} : { constraints: input.constraints }) };
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
