import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { AppInfo, AssistantSteerRecord } from "../../../shared/ui-contract.js";
import { mergeSteerRecords } from "../../../shared/steer.js";
import { draftScope, type UncertainSteer } from "../../../shared/conversation-drafts.js";
import type { WorkTaskView } from "../work-tasks.js";

/**
 * Steer receipts shown in the conversation and the one Steer whose receipt is
 * still uncertain (split out of App.tsx; same state). `replaceSteers` and
 * `mergeSteer` keep the ref and the state in step, as the inline code did.
 */
export function useSteerReceipts(latestPrimaryId: MutableRefObject<string | null>) {
  const [steers, setSteers] = useState<readonly AssistantSteerRecord[]>([]);
  const [uncertainSteer, setUncertainSteer] = useState<UncertainSteer | null>(null);
  const steerReceipts = useRef<readonly AssistantSteerRecord[]>([]);
  const replaceSteers = useCallback((records: readonly AssistantSteerRecord[]) => {
    steerReceipts.current = records;
    setSteers(records);
  }, []);
  /** Merge one receipt for the latest primary run; false when nothing changed. */
  const mergeSteer = useCallback((steer: AssistantSteerRecord): boolean => {
    const records = mergeSteerRecords(steerReceipts.current, steer, latestPrimaryId.current);
    if (records === steerReceipts.current) return false;
    steerReceipts.current = records;
    setSteers(records);
    return true;
  }, [latestPrimaryId]);
  return { steers, replaceSteers, mergeSteer, uncertainSteer, setUncertainSteer };
}

export interface SteerReviewContext {
  readonly info: AppInfo | null;
  readonly busy: boolean;
  readonly uncertainSteer: UncertainSteer | null;
  readonly setUncertainSteer: (steer: UncertainSteer | null) => void;
  readonly mergeSteer: (steer: AssistantSteerRecord) => boolean;
  readonly workTasks: WorkTaskView;
  readonly setInput: (update: (current: string) => string) => void;
  readonly setTaskComposerId: (taskId: string | null) => void;
  readonly setError: (message: string | null) => void;
  readonly draftSave: MutableRefObject<Promise<void>>;
}

/** "核对接收状态" and "保留草稿，结束本次核对" for an uncertain Steer (moved from App.tsx unchanged). */
export function steerReview({ info, busy, uncertainSteer, setUncertainSteer, mergeSteer, workTasks, setInput, setTaskComposerId, setError, draftSave }: SteerReviewContext) {
  const recheckSteer = async () => {
    if (!uncertainSteer || !info) return;
    try {
      const receipt = await window.runloom.acknowledgeSteer(draftScope(info), uncertainSteer.id);
      if (!receipt) { setError("尚未查到这次补充的接收凭证，不能据此断言未发送；不会自动重发。"); return; }
      mergeSteer(receipt);
      setUncertainSteer(null);
      if (receipt.status !== "not_applied") {
        if (uncertainSteer.taskId) {
          workTasks.clearInstruction(uncertainSteer.taskId, uncertainSteer.text);
        } else setInput(current => current.trim() === uncertainSteer.text ? "" : current);
      }
      setError(receipt.status === "not_applied" && uncertainSteer.taskId
        ? "这次工作任务补充未应用，原文与任务目标已保留；核对任务后可显式继续，不会自动续做。"
        : null);
    } catch { setError("核对失败，草稿保持锁定，不会重发。"); }
  };
  const releaseSteer = async () => {
    if (!info || !uncertainSteer || busy) return;
    try {
      await draftSave.current;
      if (uncertainSteer.taskId) await workTasks.flushDrafts();
      if (!await window.runloom.releaseSteer(draftScope(info), uncertainSteer.id)) { setError("待核对记录已变化，请重新加载。"); return; }
      if (uncertainSteer.taskId) {
        setTaskComposerId(uncertainSteer.taskId);
        workTasks.select(uncertainSteer.taskId);
        if (workTasks.task?.id === uncertainSteer.taskId && !workTasks.instruction) workTasks.setInstruction(uncertainSteer.text);
      } else { setTaskComposerId(null); setInput(current => current || uncertainSteer.text); }
      setUncertainSteer(null);
      setError(uncertainSteer.taskId
        ? "原任务补充的接收结果仍未确认，原文保留在该任务；不会转成普通对话或自动重发。"
        : "原补充的接收结果仍未确认。草稿不会自动发送；如再次发送，将开启新一轮。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "未解除待核对状态，草稿仍锁定；不会重发。"); }
  };
  return { recheckSteer, releaseSteer };
}

export function UncertainSteerNotice({ steer, busy, onRecheck, onRelease }: { steer: UncertainSteer; busy: boolean; onRecheck: () => void; onRelease: () => void }) {
  return <div className="attention-summary" role="status"><span>补充要求的接收凭证待核对，草稿不会重发。{steer.taskId ? "原补充属于工作任务；核对前不会作为普通对话发送。" : ""}</span><details><summary>查看这次补充</summary><pre>{steer.text}</pre></details><button type="button" className="ghost" onClick={onRecheck}>核对接收状态</button>{!busy ? <button type="button" className="ghost" onClick={onRelease}>保留草稿，结束本次核对</button> : null}</div>;
}
