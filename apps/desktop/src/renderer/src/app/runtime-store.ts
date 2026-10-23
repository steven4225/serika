import { useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import type { HomeSnapshot } from "@serika/assistant/browser";
import type { AppInfo, AssistantSteerRecord, ExecutionRunRecord, MainToRenderer, PendingApproval, RendererApi, ThreadSummary, UiSnapshot, UiState } from "../../../shared/ui-contract.js";
import { draftScope, type ConversationDraftState, type UncertainSteer } from "../../../shared/conversation-drafts.js";
import type { RecordDetailState, RecordsState } from "../records.js";
import { mergeSteerRecords } from "../../../shared/steer.js";
import { humanFacingTitle } from "../../../shared/human-title.js";
import { commandError } from "./command-error.js";
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
export type RuntimeBridge = Pick<RendererApi, "snapshot" | "getRun" | "historyPage" | "listRuns" | "info" | "listThreads" | "onMessage" | "loadConversationDraft" | "takeTaskResultOpen" | "home" | "retryConnection">;

/** The conversation read back from the Thread, and the completed primary run that read already includes. */
export interface StoredHistory {
  readonly rows: ConversationRow[];
  readonly runId: string | null;
}

/**
 * What startup and messages do to App's own interface state (composer, navigation, attachments).
 * App passes these to `start()`; each runs at the point where App's code used to run inline.
 */
export interface RuntimeHost {
  /** Startup: the saved draft was read; put it in the composer. */
  readonly applyDraft: (info: AppInfo, saved: ConversationDraftState) => void;
  /** Startup: the saved draft could not be read (or applying it threw). */
  readonly draftUnreadable: (info: AppInfo) => void;
  /** A task result to open (notification click): focus it under 提醒. */
  readonly openTaskResult: (route: { taskId: string; workspaceRoot: string }) => void;
  /** The attachment part of a primary result. */
  readonly settleSentAttachments: (result: RunResult) => void;
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
  /** Execution records ("执行记录"): the list, the opened record and the tool it focuses (was `useRunRecords`). */
  readonly records: RecordsState;
  readonly recordDetail: RecordDetailState;
  readonly traceFocusTool: string | null;
  /** The thread list and the header's conversation title (was `useThreadList`); `threadsRefresh` asks App's effect to reread. */
  readonly conversationTitle: string;
  readonly threads: ThreadSummary[];
  readonly threadsRefresh: number;
  /** The error banner (was App's `error`): failures from messages, startup and reads, and from App's own actions via `setError`. */
  readonly error: string | null;
  /** The runtime-recovery banner's "重新连接" is in flight (was App's `reconnecting`). */
  readonly reconnecting: boolean;
  /**
   * Asks the automation panels (saved-task notice, today's brief feeds, reminders, schedules, skills) to reread
   * after the task inbox's results are read or a saved-task notice is dismissed (was App's `automationRefresh`).
   */
  readonly automationRefresh: number;
}

export interface RuntimeStore {
  getState(): RuntimeState;
  subscribe(listener: () => void): () => void;
  /** The store's part of one message; other message types leave it unchanged. */
  receive(message: MainToRenderer): void;
  /**
   * Subscribe to main-process messages and run the startup reads (was AssistantPage's
   * subscription effect): info → draft → runtime recovery notice → task result route →
   * snapshot twice → final receipt → history → Steer snapshot → records → Home.
   */
  start(host: RuntimeHost): void;
  /** The effect cleanup: stop this startup, make history and records reads stale, unsubscribe. */
  dispose(): void;
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

  /** Reload the records list; when `selectedRunId` is still the opened record, reread it too. */
  loadRecords(selectedRunId?: string): Promise<void>;
  /** Reload the list and, if one is open, the opened record. */
  reloadOpenRecords(): Promise<void>;
  openRecord(runId: string, toolCallId?: string): Promise<void>;
  closeRecord(): void;
  /** Whether the records tab is on screen; set by App on every render (was a ref written in render). */
  setTraceVisible(visible: boolean): void;
  /** While the records tab is visible, reload it 250 ms after the first of a burst of run changes. */
  refreshOpenTrace(): void;
  /** Drop in-flight list/detail reads and the pending trace refresh (subscription teardown). */
  invalidateRecords(): void;

  /**
   * Read the thread list for `info` (App's effect, on info, state kind and `threadsRefresh`).
   * The title always follows the read; the list only when the read started while idle.
   * Returns the effect cleanup: a read answered after it is ignored.
   */
  readThreads(info: AppInfo, idle: boolean): () => void;
  /** Ask for a reread (ThreadsPanel `onChanged`). */
  refreshThreads(): void;

  /** Show (or with null, clear) the error banner; App's actions and its hooks call this (was App's `setError`). */
  setError(message: string | null): void;
  /** The "重新连接" button: one retry at a time; a failure shows the banner. Resolves when the retry settles. */
  retryConnection(): Promise<void>;
  /** Bump `automationRefresh` (TaskInbox `onResultsRead`, SavedTaskNotice `onDismiss`). */
  refreshAutomation(): void;
}

export interface RuntimeStoreOptions {
  readonly bridge: () => RuntimeBridge;
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
  records: { status: "loading" },
  recordDetail: { status: "idle" },
  traceFocusTool: null,
  conversationTitle: "当前对话",
  threads: [],
  threadsRefresh: 0,
  error: null,
  reconnecting: false,
  automationRefresh: 0,
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

export function createRuntimeStore({ bridge }: RuntimeStoreOptions, initial: RuntimeState = initialRuntimeState): RuntimeStore {
  let current = initial;
  let latestPrimaryId: string | null = null;
  let latestCompletedPrimaryId: string | null = null;
  const shellBuffer = new ShellProgressBuffer();
  /** The messages behind `history.rows`, and the read counter (were refs in App). */
  let historyMessages: UIMessage[] = [];
  let historyRequest = 0;
  /** Records bookkeeping (were refs in useRunRecords). */
  let selectedRecordId: string | null = null;
  let recordListRequest = 0;
  let recordDetailRequest = 0;
  let recordRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let traceVisible = false;
  /** One `start()` per mount; `dispose()` ends it (were the effect's `cancelled` and `stop`). */
  let session = 0;
  let stopMessages = (): void => undefined;
  const listeners = new Set<() => void>();
  const update = (next: RuntimeState): void => {
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const patch = (fields: Partial<RuntimeState>): void => update({ ...current, ...fields });
  /** The store's own failures go to the same banner App writes through `setError`. */
  const onError = (message: string): void => patch({ error: message });

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

  const readRecord = async (runId: string): Promise<void> => {
    const request = ++recordDetailRequest;
    const opened = await bridge().getRun(runId);
    if (request !== recordDetailRequest || selectedRecordId !== runId) return;
    if (!opened.ok) patch({ recordDetail: { status: "unavailable", runId, message: opened.message } });
    else if (opened.run === null) patch({ recordDetail: { status: "missing", runId } });
    else patch({ recordDetail: { status: "ready", run: opened.run } });
  };

  const loadRecords = async (selectedRunId?: string): Promise<void> => {
    const request = ++recordListRequest;
    const listed = await bridge().listRuns();
    if (request !== recordListRequest) return;
    if (!listed.ok) {
      patch({ records: { status: "unavailable", message: listed.message } });
      return;
    }
    patch({ records: { status: "ready", runs: listed.runs, ...(listed.modelUsage ? { modelUsage: listed.modelUsage } : {}) } });
    if (selectedRunId !== undefined && selectedRecordId === selectedRunId) await readRecord(selectedRunId);
  };

  const store: RuntimeStore = {
    getState: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    receive: message => update(receiveMessage(current, message)),
    applySnapshot(snapshot) {
      const sameRun = snapshot.state.kind === "running" && snapshot.state.phase === "primary" && snapshot.state.runId !== null && snapshot.state.runId === latestPrimaryId;
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
        live: !activePrimary ? emptyLiveRun : sameRun ? current.live : {
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

    loadRecords,
    reloadOpenRecords: () => loadRecords(selectedRecordId ?? undefined),
    async openRecord(runId, toolCallId) {
      selectedRecordId = runId;
      patch({ traceFocusTool: toolCallId ?? null, recordDetail: { status: "loading", runId } });
      await readRecord(runId);
    },
    closeRecord() {
      selectedRecordId = null;
      recordDetailRequest += 1;
      patch({ traceFocusTool: null, recordDetail: { status: "idle" } });
    },
    setTraceVisible: visible => { traceVisible = visible; },
    refreshOpenTrace() {
      if (!traceVisible || recordRefreshTimer !== null) return;
      recordRefreshTimer = setTimeout(() => {
        recordRefreshTimer = null;
        if (traceVisible) void loadRecords(selectedRecordId ?? undefined).catch(() => onError("执行追踪读取失败"));
      }, 250);
    },
    invalidateRecords() {
      recordListRequest += 1;
      recordDetailRequest += 1;
      if (recordRefreshTimer !== null) clearTimeout(recordRefreshTimer);
      recordRefreshTimer = null;
    },

    readThreads(info, idle) {
      let active = true;
      void bridge().listThreads().then(threads => {
        if (!active) return;
        // The header title stays human while a confirmation is open; the list itself refreshes only when idle.
        patch({ conversationTitle: humanFacingTitle(threads.find(thread => thread.threadId === info.threadId)?.title, "当前对话"), ...(idle ? { threads } : {}) });
      }).catch(() => { /* A failed read keeps the previous list; nothing shows an error for it. */ });
      return () => { active = false; };
    },
    refreshThreads: () => patch({ threadsRefresh: current.threadsRefresh + 1 }),
    setError: error => patch({ error }),
    async retryConnection() {
      if (current.reconnecting) return;
      patch({ reconnecting: true });
      try { await bridge().retryConnection(); }
      catch { onError("连接恢复失败。请修正配置后重试；不会重放之前的任务。"); }
      finally { patch({ reconnecting: false }); }
    },
    refreshAutomation: () => patch({ automationRefresh: current.automationRefresh + 1 }),

    start(host) {
      const mine = ++session;
      const cancelled = () => mine !== session;
      stopMessages = () => undefined;
      const openNotificationResult = async () => {
        const route = await bridge().takeTaskResultOpen?.();
        if (!route || cancelled()) return;
        host.openTaskResult(route);
      };

      let generation = 0;
      let readyToRefresh = false;
      let pending: Promise<UiSnapshot | null> | undefined;
      const refreshSnapshot = (recover = false): Promise<UiSnapshot | null> => {
        if (pending) return pending;
        const expected = generation;
        pending = (async () => {
          const snapshot = await bridge().snapshot();
          if (cancelled() || generation !== expected) return null;
          const recoveredIdle = recover && snapshot.state.kind === "idle" &&
            (current.state.kind !== "idle" || snapshot.lastPrimaryResult?.runId !== (latestPrimaryId ?? undefined));
          store.applySnapshot(snapshot);
          if (recoveredIdle) {
            patch({ memoryRefresh: current.memoryRefresh + 1, contextRefresh: current.contextRefresh + 1, taskRefresh: current.taskRefresh + 1 });
            await Promise.all([store.reloadHistory(), store.reloadOpenRecords(), ...(snapshot.lastPrimaryResult ? [store.loadFinalRun(snapshot.lastPrimaryResult.runId)] : [])]);
          }
          return snapshot;
        })().finally(() => { pending = undefined; });
        return pending;
      };
      const refreshVisible = () => {
        if (readyToRefresh && document.visibilityState === "visible") void refreshSnapshot(true).catch(cause => { if (!cancelled()) onError(`助手状态同步失败：${String(cause)}`); });
      };
      if (typeof window !== "undefined") {
        window.addEventListener("focus", refreshVisible);
        document.addEventListener("visibilitychange", refreshVisible);
      }
      const refreshTimer = typeof window === "undefined" ? undefined : setInterval(() => { if (current.state.kind !== "idle") refreshVisible(); }, 1000);
      const onMessage = (message: MainToRenderer): void => {
        generation += 1;
        store.receive(message);
        switch (message.type) {
          case "task-result-available":
            void openNotificationResult().catch(cause => { if (!cancelled()) onError(String(cause)); });
            return;
          case "identity-changed":
            return; // The outer App remounts this view for the new controller.
          case "state":
            {
              const observed = generation;
              store.onRunState(message.state, () => cancelled() || generation !== observed);
            }
            if (message.state.kind === "idle") {
              void store.reloadHistory().catch((cause: unknown) => onError(String(cause)));
              void store.reloadOpenRecords().catch((cause: unknown) => onError(String(cause)));
            }
            return;
          case "output":
            return;
          case "home":
            return;
          case "module-notification":
            // Shown by the main process; its text is also in the output log.
            return;
          case "approval":
            store.refreshOpenTrace();
            return;
          case "approval-cleared":
            return;
          case "steer":
            store.onRunSteer(message.steer);
            return;
          case "event":
            if (message.event.type !== "message.delta" && message.event.type !== "usage.updated") store.refreshOpenTrace();
            store.onRunEvent(message);
            return;
          case "result":
            if (!store.isCurrentPrimaryResult(message)) return;
            store.setCanSteer(false);
            host.settleSentAttachments(message.result);
            store.finishPrimaryRun(message.result);
            return;
          case "memory-references-changed":
            return;
          case "shell-progress":
            store.onRunShellProgress(message);
            return;
          case "memory-updated":
            void store.reloadHistory().catch((cause: unknown) => onError(String(cause)));
            return;
          case "work-task-updated":
            return;
          case "error":
            onError(message.message);
            return;
          default: {
            const exhaustive: never = message;
            return exhaustive;
          }
        }
      };

      void (async () => {
        try {
          const unsubscribe = bridge().onMessage(onMessage);
          stopMessages = () => {
            unsubscribe();
            if (refreshTimer !== undefined) clearInterval(refreshTimer);
            if (typeof window !== "undefined") {
              window.removeEventListener("focus", refreshVisible);
              document.removeEventListener("visibilitychange", refreshVisible);
            }
          };
          const nextInfo = await bridge().info();
          if (cancelled()) return;
          store.setInfo(nextInfo);
          try {
            const saved = await bridge().loadConversationDraft(draftScope(nextInfo));
            if (cancelled()) return;
            host.applyDraft(nextInfo, saved);
          } catch {
            if (cancelled()) return;
            host.draftUnreadable(nextInfo);
          }
          if (nextInfo.runtimeRecovery) { onError(nextInfo.runtimeRecovery.message); return; }
          await openNotificationResult();
          readyToRefresh = true;
          await refreshSnapshot();
          if (cancelled()) return;
          const second = await refreshSnapshot();
          if (cancelled()) return;
          if (second?.lastPrimaryResult && !(second.state.kind === "running" && second.state.phase === "primary")) {
            await store.loadFinalRun(second.lastPrimaryResult.runId);
          }
          await store.reloadHistory();
          // History waits for receipt recovery; only now is the restart Steer state authoritative.
          await refreshSnapshot();
          if (cancelled()) return;
          await store.loadRecords();
          const homeResult = await bridge().home();
          if (!homeResult.ok && homeResult.reason !== "busy" && !cancelled()) onError(commandError(homeResult));
        } catch (cause: unknown) {
          if (!cancelled()) onError(String(cause));
        }
      })();
    },
    dispose() {
      session += 1;
      store.invalidateHistory();
      store.invalidateRecords();
      stopMessages();
    },
  };
  return store;
}

/** Read one selected value; the component re-renders only when that value changes. */
export function useRuntime<T>(store: RuntimeStore, select: (state: RuntimeState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
