/** Display keyboard policy only. Never queues a Run or changes controller state. */
export function shouldSubmitComposer(event: { key: string; shiftKey: boolean; isComposing: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
import type { UiState } from "./ui-contract.js";

/** UI admission only: the controller still settles the old Run before starting chat. */
export function canSubmitComposer(state: UiState, mode: "chat" | "command" | "task" = "chat"): boolean {
  return state.kind === "idle" || mode === "chat" && state.kind === "running" &&
    state.phase === "consolidation" && state.background === true;
}
