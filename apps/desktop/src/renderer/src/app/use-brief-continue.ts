import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AppInfo } from "../../../shared/ui-contract.js";
import type { UncertainSteer } from "../../../shared/conversation-drafts.js";
import { clearBriefContinue, planBriefContinue, readBriefContinue, type BriefContinueTarget } from "../personal/today-continue.js";
import type { WorkTaskView } from "../work-tasks.js";

export interface BriefContinueContext {
  readonly info: AppInfo | null;
  readonly draftReady: boolean;
  readonly workTasks: WorkTaskView;
  readonly uncertainSteer: UncertainSteer | null;
  readonly setError: (message: string | null) => void;
  readonly setDetailsOpen: (open: boolean) => void;
  readonly setMobileDashboard: (open: boolean) => void;
  readonly setTaskComposerId: (taskId: string | null) => void;
  readonly setInput: (text: string) => void;
  readonly inputRef: MutableRefObject<HTMLTextAreaElement | null>;
}

/**
 * "从今天继续": put a Today-brief item into the composer once drafts are ready
 * (split out of App.tsx; same state and effect, called where the effect used
 * to be declared). It only fills drafts and focuses the composer; it never
 * starts a run.
 */
export function useBriefContinue({ info, draftReady, workTasks, uncertainSteer, setError, setDetailsOpen, setMobileDashboard, setTaskComposerId, setInput, inputRef }: BriefContinueContext) {
  const [briefNonce, setBriefNonce] = useState(0);
  const briefHold = useRef<BriefContinueTarget | null>(null);
  const briefAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (!info || !draftReady || !workTasks.draftReady) return;
    const pending = readBriefContinue(sessionStorage) ?? briefHold.current;
    if (!pending || pending.threadId !== info.threadId) return;
    if (uncertainSteer) {
      briefHold.current = null;
      clearBriefContinue(sessionStorage);
      setError("还有一条补充没核对完，草稿先不动。核对之后再从今天继续。");
      setDetailsOpen(false);
      setMobileDashboard(false);
      return;
    }
    const plan = planBriefContinue(pending);
    if (plan.selectTaskId && workTasks.task?.id !== plan.selectTaskId) {
      const known = workTasks.tasks.some(task => task.id === plan.selectTaskId);
      if (workTasks.loading || (known && briefAttempt.current !== plan.selectTaskId)) {
        if (briefAttempt.current !== plan.selectTaskId) {
          briefAttempt.current = plan.selectTaskId;
          workTasks.select(plan.selectTaskId);
        }
        return;
      }
    }
    if (plan.composerTaskId !== undefined) setTaskComposerId(plan.composerTaskId);
    if (plan.taskDraft && workTasks.task && (!plan.selectTaskId || workTasks.task.id === plan.selectTaskId)) workTasks.setInstruction(plan.taskDraft);
    if (plan.ordinaryDraft) setInput(plan.ordinaryDraft);
    briefHold.current = null;
    briefAttempt.current = null;
    clearBriefContinue(sessionStorage);
    setDetailsOpen(false);
    setMobileDashboard(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [info, draftReady, workTasks.draftReady, workTasks.task, workTasks.loading, workTasks.tasks, briefNonce, uncertainSteer]);
  return { briefHold, setBriefNonce };
}
