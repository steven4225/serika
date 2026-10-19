import { useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import type { HomeSnapshot } from "@serika/assistant/browser";
import type { AppInfo, AssistantSteerRecord, ExecutionRunRecord, MainToRenderer, PendingApproval, RendererApi, UiSnapshot, UiState } from "../../../shared/ui-contract.js";
import type { UncertainSteer } from "../../../shared/conversation-drafts.js";
import { mergeSteerRecords } from "../../../shared/steer.js";
import { ShellProgressBuffer } from "../../../shared/shell-progress.js";
import {
  annotateHistoryTools,
  annotateMemoryReceipts,
  applyEvent,
  applySteerRecord,
  applyShellProgress,
  emptyLiveRun,
  finishRun,
  overlayShellProgress,
  resultRow,
  rowsFromHistory,
  rowsFromToolActivity,
  type ConversationRow,
  type LiveRun,
} from "../conversation.js";

export const OUTPUT_MAX_CHARS = 64 * 1024;

type EventMessage = Extract<MainToRenderer, { type: "event" }>;
type ResultMessage = Extract<MainToRenderer, { type: "result" }>;
type RunResult = ResultMessage["result"];
type ShellProgressMessage = Extract<MainToRenderer, { type: "shell-progress" }>;

/** The bridge calls the store makes itself; read from `window.runloom` at call time, as the inline code did. */
export type RuntimeBridge = Pick<RendererApi, "snapshot" | "getRun" | "historyPage" | "listRuns" | "info">;

/** The conversation read back from the Thread, and the completed primary run that read already includes. */
export interface StoredHistory {
  readonly rows: ConversationRow[];
  readonly runId: string | null;
}

/** What "查看更早的对话" does to the page around the store's update; captured at click time. */
export interface OlderHistoryView {
  /** Right before the older rows are shown. */
  readonly beforeShow: () => void;
  /** Right after. */
  readonly afterShow: () => void;
}

/**
 * Runtime state from main-process messages, snapshots and startup reads
 * (docs/v2-pilot/desktop-store.md). Each change replaces the whole object, so a
 * selected field keeps its identity until it really changes.
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
  /** The primary run shown in the conversation (was `usePrimaryRun` in app/primary-run.ts). */
  readonly live: LiveRun;
  readonly lastResult: ConversationRow | null;
  readonly canSteer: boolean;
  readonly finalRecord: ExecutionRunRecord | null;
  /** Steer receipts and the one Steer whose receipt is still uncertain (was `useSteerReceipts` in app/steers.tsx). */
  readonly steers: readonly AssistantSteerRecord[];
  readonly uncertainSteer: UncertainSteer | null;
  /** History (was `storedHistory`, `historyBefore` and `historyLoading` in App). */
  readonly history: StoredHistory;
  /** Cursor for the previous page; null when the oldest message is shown. */
  readonly historyBefore: string | null;
  readonly historyLoading: boolean;
}

export interface RuntimeStore {
  getState(): RuntimeState;
  subscribe(listener: () => void): () => void;
  /** The store's part of one message; other message types leave it unchanged. */
  receive(message: MainToRenderer): void;
  /** A controller snapshot (startup and reconnect): state, approval, output and the current run. */
  applySnapshot(snapshot: UiSnapshot): void;
  setInfo(info: AppInfo): void;

  /** Which run id is current. Plain fields read and written synchronously (were refs). */
  latestPrimaryId(): string | null;
  latestCompletedPrimaryId(): string | null;
  shellBuffer(): ShellProgressBuffer;
  /**
   * A controller state change. Returns true when a new primary run has just
   * been admitted (no run id yet), after clearing the previous run's rows.
   */
  onRunState(state: UiState, cancelled: () => boolean): boolean;
  onRunSteer(steer: AssistantSteerRecord): void;
  onRunEvent(message: EventMessage): void;
  /** Whether a result belongs to the primary run currently shown. */
  isCurrentPrimaryResult(message: ResultMessage): boolean;
  finishPrimaryRun(result: RunResult): void;
  onRunShellProgress(message: ShellProgressMessage): void;
  loadFinalRun(runId: string): Promise<void>;
  setCanSteer(canSteer: boolean): void;
  replaceSteers(records: readonly AssistantSteerRecord[]): void;
  /** Merge one receipt for the latest primary run; false when nothing changed. */
  mergeSteer(steer: AssistantSteerRecord): boolean;
  setUncertainSteer(steer: UncertainSteer | null): void;

  /** Reread the newest history page; a newer read, a newly admitted run or `invalidateHistory` makes it stale. Rejects as the bridge does. */
  reloadHistory(): Promise<void>;
  /** Prepend the previous page; does nothing while one is loading or when there is none. Failures go to `onError`. */
  loadOlderHistory(view: () => OlderHistoryView): Promise<void>;
  /** Make any history read in flight stale (App unmount). */
  invalidateHistory(): void;
}

export interface RuntimeStoreOptions {
  readonly bridge: () => RuntimeBridge;
  /** App's `setError`; `error` is not in the store (written by messages and by UI actions). */
  readonly onError: (message: string) => void;
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
  live: emptyLiveRun,
  lastResult: null,
  canSteer: false,
  finalRecord: null,
  steers: [],
  uncertainSteer: null,
  history: { rows: [], runId: null },
  historyBefore: null,
  historyLoading: false,
};

/** Pure: the next state for one message, or the same object when the message does not touch these fields. */
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

export function createRuntimeStore({ bridge, onError }: RuntimeStoreOptions, initial: RuntimeState = initialRuntimeState): RuntimeStore {
  let current = initial;
  let latestPrimaryId: string | null = null;
  let latestCompletedPrimaryId: string | null = null;
  const shellBuffer = new ShellProgressBuffer();
  /** The messages behind `history.rows`, and the read counter (were refs in App). */
  let historyMessages: UIMessage[] = [];
  let historyRequest = 0;
  const listeners = new Set<() => void>();
  const update = (next: RuntimeState): void => {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const patch = (fields: Partial<RuntimeState>): void => update({ ...current, ...fields });

  const loadFinalRun = async (runId: string): Promise<void> => {
    const response = await bridge().getRun(runId);
    if (latestPrimaryId !== runId) return;
    if (!response.ok) { onError(`最终执行回执不可用：${response.message}`); return; }
    if (response.run === null) { onError("最终执行回执缺失，不能据此确认动作结果"); return; }
    patch({ finalRecord: response.run, steers: response.run.steers ?? [] });
  };

  const mergeSteer = (steer: AssistantSteerRecord): boolean => {
    const records = mergeSteerRecords(current.steers, steer, latestPrimaryId);
    if (records === current.steers) return false;
    patch({ steers: records });
    return true;
  };

  const reloadHistory = async (): Promise<void> => {
    const request = ++historyRequest;
    const primaryId = latestPrimaryId;
    const completedId = latestCompletedPrimaryId;
    const [page, receipts, identity] = await Promise.all([bridge().historyPage(), bridge().listRuns().catch(() => null), bridge().info()]);
    if (request !== historyRequest || primaryId !== latestPrimaryId || completedId !== latestCompletedPrimaryId) return;
    if (page.threadId !== identity.threadId) return;
    if (page.memoryReceiptError) onError(page.memoryReceiptError);
    const messages = page.messages;
    historyMessages = messages;
    // Only a reread made after this primary Run completed can supply its full
    // outcomes. Provider tool IDs are not unique across the whole Thread.
    const rows = receipts?.ok ? annotateHistoryTools(rowsFromHistory(messages), receipts.runs, identity.threadId) : rowsFromHistory(messages);
    const withMemory = annotateMemoryReceipts(rows, page.memoryReceipts ?? [], identity.threadId);
    patch({ historyBefore: page.beforeId, history: { rows: completedId === null ? withMemory : overlayShellProgress(withMemory, shellBuffer), runId: completedId } });
  };

  const loadOlderHistory = async (capture: () => OlderHistoryView): Promise<void> => {
    const before = current.historyBefore;
    if (!before || current.historyLoading) return;
    const request = ++historyRequest;
    // Read the page before the store update, as App read it before its `setHistoryLoading` rendered.
    const view = capture();
    patch({ historyLoading: true });
    try {
      const [page, identity, receipts] = await Promise.all([bridge().historyPage({ beforeId: before }), bridge().info(), bridge().listRuns().catch(() => null)]);
      if (request !== historyRequest || page.threadId !== identity.threadId) return;
      if (page.memoryReceiptError) onError(page.memoryReceiptError);
      const messages = [...page.messages, ...historyMessages];
      historyMessages = messages; patch({ historyBefore: page.beforeId });
      const rows = receipts?.ok ? annotateHistoryTools(rowsFromHistory(messages), receipts.runs, identity.threadId) : rowsFromHistory(messages);
      view.beforeShow();
      patch({ history: { ...current.history, rows: annotateMemoryReceipts(rows, page.memoryReceipts ?? [], identity.threadId) } });
      view.afterShow();
    } catch { onError("更早的对话读取失败；当前内容仍保留，可以重试"); }
    finally { patch({ historyLoading: false }); }
  };

  return {
    getState: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    receive: message => update(receiveMessage(current, message)),
    applySnapshot(snapshot) {
      shellBuffer.clear();
      for (const chunk of snapshot.shellProgress) shellBuffer.apply(chunk);
      const activePrimary = snapshot.state.kind === "running" && snapshot.state.phase === "primary";
      latestPrimaryId = snapshot.state.kind === "running" && snapshot.state.phase === "primary"
        ? snapshot.state.runId : snapshot.lastPrimaryResult?.runId ?? null;
      latestCompletedPrimaryId = !activePrimary && snapshot.lastPrimaryResult?.status === "completed"
        ? snapshot.lastPrimaryResult.runId : null;
      patch({
        state: snapshot.state,
        approval: snapshot.pendingApproval,
        output: snapshot.recentOutput,
        canSteer: snapshot.canSteer,
        steers: snapshot.steers,
        lastResult: !activePrimary && snapshot.lastPrimaryResult ? resultRow(snapshot.lastPrimaryResult) : null,
        live: !activePrimary ? emptyLiveRun : {
          rows: overlayShellProgress(rowsFromToolActivity(snapshot.toolActivity, latestPrimaryId ?? undefined), shellBuffer),
          streaming: "",
        },
      });
    },
    setInfo: info => patch({ info }),

    latestPrimaryId: () => latestPrimaryId,
    latestCompletedPrimaryId: () => latestCompletedPrimaryId,
    shellBuffer: () => shellBuffer,
    onRunState(state, cancelled) {
      const admitted = state.kind === "running" && state.runId === null && state.phase === "primary";
      if (admitted) {
        shellBuffer.clear();
        latestPrimaryId = null;
        latestCompletedPrimaryId = null;
        historyRequest += 1; // A history read started before this run would show the previous run as current.
        patch({ canSteer: false, live: emptyLiveRun, lastResult: null, finalRecord: null, steers: [] });
      } else patch({ canSteer: false });
      if (state.kind === "running" && state.phase === "primary" && state.runId !== null) {
        latestPrimaryId = state.runId;
        const expectedRunId = state.runId;
        void bridge().snapshot().then(snapshot => {
          if (cancelled() || latestPrimaryId !== expectedRunId || snapshot.state.kind !== "running" || snapshot.state.runId !== expectedRunId) return;
          patch({ canSteer: snapshot.canSteer });
        }).catch(() => {});
      }
      return admitted;
    },
    onRunSteer(steer) {
      if (!mergeSteer(steer)) return;
      patch({ live: applySteerRecord(current.live, steer) });
    },
    onRunEvent(message) {
      if (message.phase !== "primary") return;
      if (latestPrimaryId !== null && message.event.runId !== latestPrimaryId) return;
      patch({ live: applyEvent(current.live, message.event) });
    },
    isCurrentPrimaryResult(message) {
      if (message.phase !== "primary") return false;
      if (latestPrimaryId !== null && message.result.runId !== latestPrimaryId) return false;
      return true;
    },
    finishPrimaryRun(result) {
      latestPrimaryId = result.runId;
      latestCompletedPrimaryId = result.status === "completed" ? result.runId : null;
      void loadFinalRun(result.runId).catch((cause: unknown) => onError(String(cause)));
      const rows = finishRun(emptyLiveRun, result);
      patch({
        lastResult: rows.find((row) => row.kind === "result") ?? null,
        live: { rows: finishRun(current.live, result), streaming: "" },
      });
    },
    onRunShellProgress(message) {
      if (message.phase !== "primary") return;
      if (message.runId !== latestPrimaryId) return;
      shellBuffer.apply(message.progress);
      patch({ live: applyShellProgress(current.live, message.progress.toolCallId, shellBuffer) });
    },
    loadFinalRun,
    setCanSteer: canSteer => patch({ canSteer }),
    replaceSteers: records => patch({ steers: records }),
    mergeSteer,
    setUncertainSteer: uncertainSteer => patch({ uncertainSteer }),

    reloadHistory,
    loadOlderHistory,
    invalidateHistory: () => { historyRequest += 1; },
  };
}

/** Read one selected value; the component re-renders only when that value changes. */
export function useRuntime<T>(store: RuntimeStore, select: (state: RuntimeState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
