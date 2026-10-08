import type { AssistantSteerResponse } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
/** Obtain this identity from the active main-process AppInfo, never renderer input. */
export interface ConversationDraftScope {
  workspaceRoot: string | null;
  directory: string;
  threadId: string;
}
export interface ConversationDraft { text: string; excludeFromMemory: boolean }
export interface UncertainSteer { id: string; runId: string; text: string; taskId?: string }
export interface TaskCreationDraft {
  goal: string; constraints: string; artifacts: string; human: string; commands: string; testCwd: string; template: string | null;
}
export interface TaskDrafts { creation: TaskCreationDraft | null; instructions: Record<string, string>; composerTaskId: string | null }
export type TaskDraftUpdate = { kind: "creation"; value: TaskCreationDraft | null }
  | { kind: "instruction"; taskId: string; text: string; expectedText?: string }
  | { kind: "composer"; taskId: string | null };
export function emptyTaskDrafts(): TaskDrafts { return { creation: null, instructions: {}, composerTaskId: null }; }
export interface ConversationDraftState {
  draft: ConversationDraft;
  uncertainSteer: UncertainSteer | null;
  taskDrafts?: TaskDrafts;
}
export type DesktopSteerInput = { expectedRunId: string; id: string; text: string; taskId?: string; scope: ConversationDraftScope };
export type DesktopSteerResponse = AssistantSteerResponse | { ok: false; reason: "storage" | "unresolved" };

export function sameDraftScope(a: ConversationDraftScope, b: ConversationDraftScope): boolean {
  return a.workspaceRoot === b.workspaceRoot && a.directory === b.directory && a.threadId === b.threadId;
}

export function draftScope(info: ConversationDraftScope): ConversationDraftScope {
  return { workspaceRoot: info.workspaceRoot, directory: info.directory, threadId: info.threadId };
}
