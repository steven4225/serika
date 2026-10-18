import { useCallback, useRef, useState } from "react";
import type { AssistantSteerRecord, ExecutionRunRecord, MainToRenderer, UiSnapshot, UiState } from "../../../shared/ui-contract.js";
import { ShellProgressBuffer } from "../../../shared/shell-progress.js";
import {
  applyEvent,
  applySteerRecord,
  applyShellProgress,
  emptyLiveRun,
  finishRun,
  overlayShellProgress,
  resultRow,
  rowsFromToolActivity,
  type ConversationRow,
  type LiveRun,
} from "../conversation.js";
import { useSteerReceipts } from "./steers.js";

type EventMessage = Extract<MainToRenderer, { type: "event" }>;
type ResultMessage = Extract<MainToRenderer, { type: "result" }>;
type RunResult = ResultMessage["result"];
type ShellProgressMessage = Extract<MainToRenderer, { type: "shell-progress" }>;

/**
 * The primary run shown in the conversation: live rows, the final result row,
 * its execution receipt, Steer receipts, and which run id is current (split
 * out of App.tsx; the bodies are the old inline code). App.tsx's message
 * subscription calls these per message type; the hook declares no effects.
 */
export function usePrimaryRun(setError: (message: string | null) => void) {
  const [live, setLive] = useState<LiveRun>(emptyLiveRun);
  const [lastResult, setLastResult] = useState<ConversationRow | null>(null);
  const [canSteer, setCanSteer] = useState(false);
  const [finalRecord, setFinalRecord] = useState<ExecutionRunRecord | null>(null);
  const latestPrimaryId = useRef<string | null>(null);
  const latestCompletedPrimaryId = useRef<string | null>(null);
  const shellBuffer = useRef(new ShellProgressBuffer());
  const { steers, replaceSteers, mergeSteer, uncertainSteer, setUncertainSteer } = useSteerReceipts(latestPrimaryId);

  /** Run-related part of a controller snapshot (startup and reconnect). */
  const applyRunSnapshot = useCallback((snapshot: UiSnapshot) => {
    setCanSteer(snapshot.canSteer);
    replaceSteers(snapshot.steers);
    shellBuffer.current.clear();
    for (const chunk of snapshot.shellProgress) shellBuffer.current.apply(chunk);
    const activePrimary = snapshot.state.kind === "running" && snapshot.state.phase === "primary";
    latestPrimaryId.current = snapshot.state.kind === "running" && snapshot.state.phase === "primary"
      ? snapshot.state.runId : snapshot.lastPrimaryResult?.runId ?? null;
    latestCompletedPrimaryId.current = !activePrimary && snapshot.lastPrimaryResult?.status === "completed"
      ? snapshot.lastPrimaryResult.runId : null;
    setLastResult(!activePrimary && snapshot.lastPrimaryResult ? resultRow(snapshot.lastPrimaryResult) : null);
    if (!activePrimary) {
      setLive(emptyLiveRun);
    } else {
      setLive({
        rows: overlayShellProgress(rowsFromToolActivity(snapshot.toolActivity, latestPrimaryId.current ?? undefined), shellBuffer.current),
        streaming: "",
      });
    }
  }, [replaceSteers]);

  const loadFinalRun = useCallback(async (runId: string) => {
    const response = await window.runloom.getRun(runId);
    if (latestPrimaryId.current !== runId) return;
    if (!response.ok) { setError(`最终执行回执不可用：${response.message}`); return; }
    if (response.run === null) { setError("最终执行回执缺失，不能据此确认动作结果"); return; }
    setFinalRecord(response.run);
    replaceSteers(response.run.steers ?? []);
  }, [replaceSteers]);

  /**
   * A controller state change. Returns true when a new primary run has just
   * been admitted (no run id yet), after clearing the previous run's rows.
   */
  const onRunState = useCallback((state: UiState, cancelled: () => boolean): boolean => {
    setCanSteer(false);
    const admitted = state.kind === "running" && state.runId === null && state.phase === "primary";
    if (admitted) {
      shellBuffer.current.clear();
      setLive(emptyLiveRun);
      setLastResult(null);
      setFinalRecord(null);
      replaceSteers([]);
      latestPrimaryId.current = null;
      latestCompletedPrimaryId.current = null;
    }
    if (state.kind === "running" && state.phase === "primary" && state.runId !== null) {
      latestPrimaryId.current = state.runId;
      const expectedRunId = state.runId;
      void window.runloom.snapshot().then(snapshot => {
        if (cancelled() || latestPrimaryId.current !== expectedRunId || snapshot.state.kind !== "running" || snapshot.state.runId !== expectedRunId) return;
        setCanSteer(snapshot.canSteer);
      }).catch(() => {});
    }
    return admitted;
  }, [replaceSteers]);

  const onRunSteer = useCallback((steer: AssistantSteerRecord) => {
    if (!mergeSteer(steer)) return;
    setLive(previous => applySteerRecord(previous, steer));
  }, [mergeSteer]);

  const onRunEvent = useCallback((message: EventMessage) => {
    if (message.phase !== "primary") return;
    if (latestPrimaryId.current !== null && message.event.runId !== latestPrimaryId.current) return;
    setLive((previous) => applyEvent(previous, message.event));
  }, []);

  /** Whether a result belongs to the primary run currently shown. */
  const isCurrentPrimaryResult = useCallback((message: ResultMessage): boolean => {
    if (message.phase !== "primary") return false;
    if (latestPrimaryId.current !== null && message.result.runId !== latestPrimaryId.current) return false;
    return true;
  }, []);

  const finishPrimaryRun = useCallback((result: RunResult) => {
    latestPrimaryId.current = result.runId;
    latestCompletedPrimaryId.current = result.status === "completed" ? result.runId : null;
    void loadFinalRun(result.runId).catch((cause: unknown) => setError(String(cause)));
    const rows = finishRun(emptyLiveRun, result);
    setLastResult(rows.find((row) => row.kind === "result") ?? null);
    setLive((previous) => ({ rows: finishRun(previous, result), streaming: "" }));
  }, [loadFinalRun]);

  const onRunShellProgress = useCallback((message: ShellProgressMessage) => {
    if (message.phase !== "primary") return;
    if (message.runId !== latestPrimaryId.current) return;
    shellBuffer.current.apply(message.progress);
    setLive((previous) => applyShellProgress(previous, message.progress.toolCallId, shellBuffer.current));
  }, []);

  return {
    live, lastResult, canSteer, setCanSteer, finalRecord, latestPrimaryId, latestCompletedPrimaryId, shellBuffer,
    steers, replaceSteers, mergeSteer, uncertainSteer, setUncertainSteer,
    applyRunSnapshot, loadFinalRun, onRunState, onRunSteer, onRunEvent, isCurrentPrimaryResult, finishPrimaryRun, onRunShellProgress,
  };
}
