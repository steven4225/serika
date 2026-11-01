import type { WorkTask, WorkTaskPhase } from "./work-task-store.js";

/** Visible phase. Storage stays on the four lifecycle states. */
export function workTaskPhase(task: Pick<WorkTask, "status" | "effectReviewRequired" | "acceptanceOpen" | "runIds" | "delivery">): WorkTaskPhase {
  switch (task.status) {
    case "completed": return "completed";
    case "cancelled": return "cancelled";
    case "running": return "running";
    case "pending":
      if (task.effectReviewRequired) return "needs_review";
      if (task.acceptanceOpen) return "awaiting_acceptance";
      if (task.runIds.length === 0 && task.delivery === null) return "ready";
      return "paused";
    default: {
      const unreachable: never = task.status;
      throw new Error(`Unhandled work task status: ${String(unreachable)}`);
    }
  }
}
