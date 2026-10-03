import type { UIMessage } from "ai";
import type { WorkTask } from "./work-task-store.js";
import type { WorkTaskContinuation } from "./work-task-continuation.js";

export const WORK_TASK_CONTEXT_MESSAGE_ID = "runloom-work-task";
export const WORK_TASK_CONTEXT_MAX_BYTES = 24 * 1024;

export function createWorkTaskContextMessage(task: WorkTask, continuation?: WorkTaskContinuation): UIMessage | undefined {
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
        "Before editing an existing artifact, read its current disk contents in this Run. Historical delivery, receipts and compaction summaries are references, not current disk truth. Preserve unrelated sections, verify the result by reading it back, and report any verification gap. Never replay an old tool just because it appears in this reference.",
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
          ...(continuation === undefined ? {} : { continuation }),
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
