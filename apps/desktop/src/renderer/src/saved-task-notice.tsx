import React, { useEffect, useState } from "react";
import type { TaskRecordV4 } from "@aisdk-agent/example-cli/dist/task-store.js";
import { createSavedTaskNoticeReader } from "../../shared/saved-task-result.js";
import { taskResultPresentation } from "./task-inbox.js";

export function SavedTaskNoticeView({ task, onOpen, onDismiss }: {
  task: TaskRecordV4; onOpen: (taskId: string) => void; onDismiss: () => void;
}) {
  const { kind, status, body } = taskResultPresentation(task);
  const characters = Array.from(body);
  const clipped = characters.length > 280;
  return <div className="review-notice saved-task-notice" role="status" aria-label="已保存的定时结果">
    <span><strong>{kind} · {status}</strong><br />{characters.slice(0, 280).join("")}{clipped ? "…（正文已截短）" : ""}</span>
    <button type="button" className="ghost" onClick={() => onOpen(task.id)}>查看结果</button>
    <button type="button" className="ghost" aria-label="收起定时结果提示，不标为已读" onClick={onDismiss}>收起</button>
  </div>;
}

/** One window-level read refresh. OS notifications keep their separate privacy-safe summary. */
export function SavedTaskNotice({ enabled, refreshSequence, onOpen }: {
  enabled: boolean; refreshSequence: number; onOpen: (taskId: string) => void;
}) {
  const [task, setTask] = useState<TaskRecordV4 | null>(null);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { setTask(null); setError(""); return; }
    const reader = createSavedTaskNoticeReader(window.runloom, setTask, setError);
    const onFocus = () => { if (!document.hidden) void reader.refresh(); };
    onFocus();
    const timer = window.setInterval(onFocus, 15_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { reader.dispose(); window.clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [enabled, refreshSequence]);
  if (!enabled) return null;
  if (error) return <div className="attention-summary" role="status"><span>{error}</span></div>;
  if (!task || dismissed === `${task.id}:${task.finishedAt}`) return null;
  return <SavedTaskNoticeView task={task} onOpen={onOpen} onDismiss={() => setDismissed(`${task.id}:${task.finishedAt}`)} />;
}
