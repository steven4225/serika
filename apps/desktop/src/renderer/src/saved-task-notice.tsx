import React, { useEffect, useState } from "react";
import type { TaskRecordV4 } from "@aisdk-agent/example-cli/dist/task-store.js";
import { createSavedTaskNoticeReader } from "../../shared/saved-task-result.js";
import { taskNoticeTitle } from "../../shared/human-title.js";
import { taskResultPresentation } from "./task-inbox.js";

export function SavedTaskNoticeView({ task, onOpen, onDismiss }: {
  task: TaskRecordV4; onOpen: (taskId: string) => void; onDismiss: () => void;
}) {
  const { kind, status } = taskResultPresentation(task);
  const title = taskNoticeTitle({ prompt: task.prompt, resultText: task.resultText, status: task.status, arrangementKind: task.arrangement?.kind });
  const quietNote = !task.resultText?.trim() && task.status === "interrupted" ? "执行中断，结果尚未确定；不会自动重做。"
    : !task.resultText?.trim() && task.status === "failed" ? "任务执行失败，详情在收件箱。" : null;
  const finishedAt = task.finishedAt && Number.isFinite(Date.parse(task.finishedAt)) ? task.finishedAt : null;
  const timestamp = finishedAt ?? (Number.isFinite(Date.parse(task.runAt)) ? task.runAt : null);
  const timeLabel = finishedAt ? "结束时间" : "计划时间";
  const localTime = timestamp ? new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZoneName: "short",
  }).format(new Date(timestamp)) : null;
  return <div className="review-notice saved-task-notice" role="status" aria-label="已保存的定时结果">
    <span><strong>{title}</strong><br />
      <small>{kind} · {status}{quietNote ? ` · ${quietNote}` : ""} · {timestamp ? <>{timeLabel} <time dateTime={timestamp}>{localTime}</time>{!finishedAt ? "（结束时间未记录）" : ""}</> : "时间未记录"}</small></span>
    <button type="button" className="allow" onClick={() => onOpen(task.id)}>查看</button>
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
