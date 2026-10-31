/** Lifecycle is the four stored states. Attempt failure and interruption stay on the attempt. */

export const taskLifecycleStatuses = ["pending", "running", "completed", "cancelled"] as const;
export type TaskLifecycleStatus = (typeof taskLifecycleStatuses)[number];

export function arrangementWaiting(task: { status: string; error: unknown }): boolean {
  return task.status === "pending" && task.error === null;
}

export function arrangementNeedsAttention(task: { status: string; error: unknown }): boolean {
  return task.status === "pending" && task.error !== null;
}

/** Preserved attempt fact for a pending arrangement. Null when the instance is still waiting. */
export function arrangementSettlement(task: {
  status: string;
  error: unknown;
  attempts?: readonly { status: string }[];
}): "failed" | "interrupted" | null {
  if (!arrangementNeedsAttention(task)) return null;
  return task.attempts?.at(-1)?.status === "interrupted" ? "interrupted" : "failed";
}

/** Label input for existing copy that still names the preserved failure or interruption. */
export function arrangementDisplayStatus(task: {
  status: string;
  error: unknown;
  attempts?: readonly { status: string }[];
}): string {
  return arrangementSettlement(task) ?? task.status;
}
