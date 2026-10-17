import React, { useEffect, useMemo, useState } from "react";
import type { TaskRecordV4 } from "@serika/assistant";
import { taskNotificationCopy } from "@serika/assistant/browser";
import { createSavedTaskNoticeReader, createTaskNoticeDismissals } from "../../shared/saved-task-result.js";
import { taskResultPresentation } from "./task-inbox.js";
import { NotificationSettingsButton } from "./notification-settings-button.js";

export function SavedTaskNoticeView({ task, onOpen, onDismiss }: {
  task: TaskRecordV4; onOpen: (taskId: string) => void; onDismiss: () => void;
}) {
  const { kind, status, notification } = taskResultPresentation(task);
  // The in-app banner may show the saved reminder; OS copy must stay private.
  const reminder = task.status === "completed" && task.arrangement?.kind === "reminder"
    ? (task.resultText?.trim() || task.prompt).replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim() : "";
  const characters = Array.from(reminder);
  const title = reminder ? characters.length > 42 ? `${characters.slice(0, 41).join("")}…` : reminder : taskNotificationCopy(task).title;
  const finishedAt = task.finishedAt && Number.isFinite(Date.parse(task.finishedAt)) ? task.finishedAt : null;
  const timestamp = finishedAt ?? (Number.isFinite(Date.parse(task.runAt)) ? task.runAt : null);
  const timeLabel = finishedAt ? "结束时间" : "计划时间";
  const localTime = timestamp ? new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZoneName: "short",
  }).format(new Date(timestamp)) : null;
  const time = timestamp
    ? <>{timeLabel} <time dateTime={timestamp}>{localTime}</time>{!finishedAt ? "（结束时间未记录）" : ""}</>
    : "时间未记录";
  return <div className="review-notice saved-task-notice" role="status" aria-label="已保存的定时结果">
    <p className="saved-task-notice-title">{title}</p>
    <p className="saved-task-notice-meta">{kind} · {status} · {time}</p>
    {task.notification ? <p className={task.notification.status === "failed" ? "error" : "hint"}>{notification}</p> : null}
    {task.notification?.status === "failed" ? <p className="hint">到期结果已保存，但系统通知未提交成功。请核对通知权限和组件；不会重新执行任务。<NotificationSettingsButton /></p> : null}
    <div className="saved-task-notice-actions">
      <button type="button" className="allow" onClick={() => { onOpen(task.id); onDismiss(); }}>查看</button>
      <button type="button" className="ghost" aria-label="收起定时结果提示，不标为已读" onClick={onDismiss}>收起</button>
    </div>
  </div>;
}

/** One window-level read refresh. Viewing and dismissing do not run the task or mark it read. */
export function SavedTaskNotice({ enabled, workspaceRoot, refreshSequence, onOpen, onDismiss }: {
  enabled: boolean; workspaceRoot: string; refreshSequence: number; onOpen: (taskId: string) => void; onDismiss?: () => void;
}) {
  const [task, setTask] = useState<TaskRecordV4 | null>(null);
  const [error, setError] = useState("");
  const dismissals = useMemo(() => createTaskNoticeDismissals({
    getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value),
  }, workspaceRoot), [workspaceRoot]);
  useEffect(() => {
    if (!enabled) { setTask(null); setError(""); return; }
    const reader = createSavedTaskNoticeReader(window.runloom, setTask, setError, dismissals.has);
    const onFocus = () => { if (!document.hidden) void reader.refresh(); };
    onFocus();
    const timer = window.setInterval(onFocus, 15_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { reader.dispose(); window.clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [enabled, refreshSequence, dismissals]);
  if (!enabled) return null;
  if (error) return <div className="attention-summary" role="status"><span>{error}</span></div>;
  if (!task || dismissals.has(task)) return null;
  return <SavedTaskNoticeView task={task} onOpen={onOpen} onDismiss={() => { dismissals.dismiss(task); setTask(null); onDismiss?.(); }} />;
}
