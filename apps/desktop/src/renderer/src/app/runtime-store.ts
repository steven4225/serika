import { useSyncExternalStore } from "react";
import type { HomeSnapshot } from "@serika/assistant/browser";
import type { AppInfo, MainToRenderer, PendingApproval, UiSnapshot, UiState } from "../../../shared/ui-contract.js";

export const OUTPUT_MAX_CHARS = 64 * 1024;

/**
 * Runtime state written only by main-process messages, snapshots and the
 * startup reads — never by a UI action (docs/v2-pilot/desktop-store.md, step 1).
 * Each change replaces the whole object, so a selected field keeps its identity
 * until it really changes.
 */
export interface RuntimeState {
  readonly info: AppInfo | null;
  readonly state: UiState;
  readonly output: string;
  readonly approval: PendingApproval | null;
  readonly homeSnapshot: HomeSnapshot | null;
  readonly memoryRefresh: number;
  readonly contextRefresh: number;
  readonly taskRefresh: number;
}

export interface RuntimeStore {
  getState(): RuntimeState;
  subscribe(listener: () => void): () => void;
  /** The store's part of one message; other message types leave it unchanged. */
  receive(message: MainToRenderer): void;
  /** The store's part of `applySnapshot`; the current-Run part stays in `usePrimaryRun`. */
  applySnapshot(snapshot: UiSnapshot): void;
  setInfo(info: AppInfo): void;
}

export const initialRuntimeState: RuntimeState = {
  info: null,
  state: { kind: "idle" },
  output: "",
  approval: null,
  homeSnapshot: null,
  memoryRefresh: 0,
  contextRefresh: 0,
  taskRefresh: 0,
};

/** Pure: the next state for one message, or the same object when the message does not touch the store. */
export function receiveMessage(current: RuntimeState, message: MainToRenderer): RuntimeState {
  switch (message.type) {
    case "state":
      return message.state.kind === "idle"
        ? { ...current, state: message.state, memoryRefresh: current.memoryRefresh + 1, contextRefresh: current.contextRefresh + 1, taskRefresh: current.taskRefresh + 1 }
        : { ...current, state: message.state };
    case "output":
      return { ...current, output: (current.output + message.text).slice(-OUTPUT_MAX_CHARS) };
    case "home":
      return { ...current, homeSnapshot: message.snapshot };
    case "approval":
      return { ...current, approval: message.approval };
    case "approval-cleared":
      return current.approval?.approvalId === message.approvalId ? { ...current, approval: null } : current;
    case "result": // Every result, before the current-primary check in App.
    case "memory-references-changed":
      return { ...current, contextRefresh: current.contextRefresh + 1 };
    case "memory-updated":
      return { ...current, memoryRefresh: current.memoryRefresh + 1 };
    case "work-task-updated":
      return { ...current, taskRefresh: current.taskRefresh + 1 };
    case "task-result-available":
    case "identity-changed":
    case "module-notification":
    case "steer":
    case "event":
    case "shell-progress":
    case "error":
      return current;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}

export function createRuntimeStore(initial: RuntimeState = initialRuntimeState): RuntimeStore {
  let current = initial;
  const listeners = new Set<() => void>();
  const update = (next: RuntimeState): void => {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    receive: message => update(receiveMessage(current, message)),
    applySnapshot: snapshot => update({ ...current, state: snapshot.state, approval: snapshot.pendingApproval, output: snapshot.recentOutput }),
    setInfo: info => update({ ...current, info }),
  };
}

/** Read one selected value; the component re-renders only when that value changes. */
export function useRuntime<T>(store: RuntimeStore, select: (state: RuntimeState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
