import { useCallback, useRef, useState } from "react";
import type { RecordDetailState, RecordsState } from "../records.js";

/**
 * Execution records ("执行记录") list, the opened record and the live trace
 * refresh (split out of App.tsx; same state, request counters and timer).
 * The hook declares no effects: App.tsx keeps the records-tab load effect and
 * the main subscription cleanup at their original positions and calls
 * `reloadOpen` / `invalidate` there, so effect order is unchanged.
 */
export function useRunRecords(traceVisibleNow: boolean, setError: (message: string) => void) {
  const [records, setRecords] = useState<RecordsState>({ status: "loading" });
  const [recordDetail, setRecordDetail] = useState<RecordDetailState>({ status: "idle" });
  const selectedRecordId = useRef<string | null>(null);
  const recordListRequest = useRef(0);
  const recordDetailRequest = useRef(0);
  const recordRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const traceVisible = useRef(false);
  const [traceFocusTool, setTraceFocusTool] = useState<string | null>(null);
  traceVisible.current = traceVisibleNow;

  const readRecord = useCallback(async (runId: string) => {
    const request = ++recordDetailRequest.current;
    const opened = await window.runloom.getRun(runId);
    if (request !== recordDetailRequest.current || selectedRecordId.current !== runId) return;
    if (!opened.ok) setRecordDetail({ status: "unavailable", runId, message: opened.message });
    else if (opened.run === null) setRecordDetail({ status: "missing", runId });
    else setRecordDetail({ status: "ready", run: opened.run });
  }, []);

  const loadRecords = useCallback(async (selectedRunId?: string) => {
    const request = ++recordListRequest.current;
    const listed = await window.runloom.listRuns();
    if (request !== recordListRequest.current) return;
    if (!listed.ok) {
      setRecords({ status: "unavailable", message: listed.message });
      return;
    }
    setRecords({ status: "ready", runs: listed.runs, ...(listed.modelUsage ? { modelUsage: listed.modelUsage } : {}) });
    if (selectedRunId !== undefined && selectedRecordId.current === selectedRunId) await readRecord(selectedRunId);
  }, [readRecord]);

  /** Reload the list and, if one is open, the opened record. */
  const reloadOpen = useCallback(() => loadRecords(selectedRecordId.current ?? undefined), [loadRecords]);

  const openRecord = useCallback(async (runId: string, toolCallId?: string) => {
    selectedRecordId.current = runId;
    setTraceFocusTool(toolCallId ?? null);
    setRecordDetail({ status: "loading", runId });
    await readRecord(runId);
  }, [readRecord]);

  const closeRecord = useCallback(() => { selectedRecordId.current = null; recordDetailRequest.current += 1; setTraceFocusTool(null); setRecordDetail({ status: "idle" }); }, []);

  const refreshOpenTrace = useCallback(() => {
    if (!traceVisible.current || recordRefreshTimer.current !== null) return;
    recordRefreshTimer.current = setTimeout(() => {
      recordRefreshTimer.current = null;
      if (traceVisible.current) void loadRecords(selectedRecordId.current ?? undefined).catch(() => setError("执行追踪读取失败"));
    }, 250);
  }, [loadRecords]);

  /** Drop in-flight list/detail reads and the pending trace refresh (subscription teardown). */
  const invalidate = useCallback(() => {
    recordListRequest.current += 1;
    recordDetailRequest.current += 1;
    if (recordRefreshTimer.current !== null) clearTimeout(recordRefreshTimer.current);
    recordRefreshTimer.current = null;
  }, []);

  return { records, recordDetail, traceFocusTool, loadRecords, reloadOpen, openRecord, closeRecord, refreshOpenTrace, invalidate };
}
