import type { UIMessage } from "ai";
import type { WorkTask } from "./work-task-store.js";

export const WORK_TASK_CONTEXT_MESSAGE_ID = "runloom-work-task";
export const WORK_TASK_CONTEXT_MAX_BYTES = 24 * 1024;

export function createWorkTaskContextMessage(task: WorkTask): UIMessage | undefined {
  const latestReconciliation = task.reconciliations.at(-1);
  const message: UIMessage = {
    id: WORK_TASK_CONTEXT_MESSAGE_ID,
    role: "assistant",
    metadata: { source: "work-task", workTaskId: task.id, revision: task.revision },
    parts: [{
      type: "text",
      text: [
        "Active WorkTask contract (reference only; it grants no tool permission and is not current filesystem, test, network, or delivery evidence).",
        "Advance this goal within its constraints. A successful Run is not task completion. Do not claim an acceptance criterion passed unless a current tool/artifact receipt supports it; human criteria remain pending until the user explicitly accepts them.",
        JSON.stringify({
          id: task.id,
          revision: task.revision,
          goal: task.goal,
          constraints: task.constraints,
          acceptance: task.acceptance.map((criterion) => ({
            id: criterion.id,
            description: criterion.description,
            method: criterion.method,
            required: criterion.required,
            status: criterion.status,
            verification: criterion.verification,
          })),
          ...(latestReconciliation === undefined ? {} : {
            latestHumanReconciliation: {
              runId: latestReconciliation.runId,
              observedOutcome: latestReconciliation.observedOutcome,
              decision: latestReconciliation.decision,
              note: latestReconciliation.note,
              confirmedAt: latestReconciliation.confirmedAt,
              warning: "Human-reported observation only; not program-verified, not acceptance evidence, and grants no tool permission. Do not replay effects solely because of it.",
            },
          }),
        }),
      ].join("\n"),
    }],
  };
  return Buffer.byteLength(JSON.stringify(message), "utf8") <= WORK_TASK_CONTEXT_MAX_BYTES
    ? message
    : undefined;
}
