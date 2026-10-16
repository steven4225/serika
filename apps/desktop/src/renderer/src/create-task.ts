import type { RendererApi } from "../../shared/ui-contract.js";
import type { ConversationDraftScope } from "../../shared/conversation-drafts.js";
import { submitCreation } from "./creation-operation.js";

/** Persist the task and its composer target before attempting execution. Never retry a Run. */
export async function createAndStartTask(api: Pick<RendererApi, "createWorkTask" | "saveTaskDraft" | "runWorkTask">,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, scope: ConversationDraftScope, goal: string, attached: (id: string) => void) {
  const input = { goal, acceptance: [{ id: "human-1", description: "交付符合我的任务要求", required: true, method: "human" as const, verification: { kind: "human" as const } }] };
  const created = await submitCreation(storage, `${JSON.stringify(scope)}:work`, input, async operationId => {
    const result = await api.createWorkTask({ ...input, operationId });
    if (result.ok) {
      await api.saveTaskDraft(scope, { kind: "created", taskId: result.value.id, expectedGoal: goal });
    }
    return result;
  });
  if (!created.ok) return { kind: "create_failed" as const, message: created.error.message };
  attached(created.value.id);
  try {
    const started = await api.runWorkTask({ id: created.value.id, expectedRevision: created.value.revision });
    return { kind: started.ok ? "started" as const : "saved" as const };
  } catch { return { kind: "start_unknown" as const }; }
}
