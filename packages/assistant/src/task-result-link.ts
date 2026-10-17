import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

/** Read-only navigation identity, never an execution or acknowledgement grant. */
export function taskResultWorkspaceKey(workspace: string): string {
  if (!isAbsolute(workspace)) throw new Error("Task result workspace must be absolute");
  return createHash("sha256").update(resolve(workspace)).digest("hex");
}

export function taskResultLink(workspace: string, taskId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new Error("Invalid notification task id");
  return `serika://task-result/${taskId}?workspace=${taskResultWorkspaceKey(workspace)}`;
}

export function parseTaskResultLink(value: string): { taskId: string; workspaceKey: string } | null {
  if (value.length > 512) return null;
  // Match raw input so URL normalization cannot turn ../ or encoded segments
  // into another otherwise valid record identity.
  const match = /^serika:\/\/task-result\/([A-Za-z0-9_-]{1,128})\?workspace=([a-f0-9]{64})$/.exec(value);
  return match ? { taskId: match[1]!, workspaceKey: match[2]! } : null;
}
