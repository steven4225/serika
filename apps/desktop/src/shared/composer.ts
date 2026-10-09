/** Display keyboard policy only. Never queues a Run or changes controller state. */
export function shouldSubmitComposer(event: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
import type { UiState } from "./ui-contract.js";

/** Primary Run steering is not permission to start a new Run or execute a command. */
export function canSteerComposer(state: UiState, canSteer: boolean): state is Extract<UiState, { kind: "running" }> & { runId: string } {
  return canSteer && state.kind === "running" && state.phase === "primary" && state.runId !== null && state.background !== true;
}

/** UI admission only: the controller still settles the old Run before starting chat. */
export function canSubmitComposer(state: UiState, mode: "chat" | "command" | "task" = "chat"): boolean {
  return state.kind === "idle" || mode === "chat" && state.kind === "running" &&
    (state.phase === "consolidation" || state.phase === "skill") && state.background === true;
}
