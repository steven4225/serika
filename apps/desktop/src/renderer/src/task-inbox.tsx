import React, { useEffect, useRef, useState } from "react";
import type { TaskListV3, TaskNotification, TaskRecordV4 } from "@aisdk-agent/example-cli/dist/task-store.js";
import { MessageContent } from "./markdown.js";
import { automationArrangementLabel } from "./automation-schedule.js";
import { humanFacingTitle } from "../../shared/human-title.js";
import { inboxPrimaryLine, localWhen, reminderClock, scheduleStatusLabel } from "./reminder-copy.js";

function notificationText(notification: TaskNotification | null): string {
  if (notification === null) return "未安排系统通知";
  switch (notification.status) {
    case "submitted":
      return "已提交系统通知，不代表你已看到";
    case "omitted":
      return "前台省略，未向系统提交";
    case "failed":
      return "系统通知提交失败";
    case "pending":
      return "等待提交系统通知";
    default: {
      const unreachable: never = notification.status;
      return unreachable;
    }
  }
}

export function taskResultPresentation(task: TaskRecordV4, now = new Date()): { kind: string; status: string; notification: string; body: string } {
  const kind = automationArrangementLabel(task.arrangement);
  const notification = notificationText(task.notification);
  const body = task.resultText?.trim() || (task.status === "failed" ? "任务执行失败，详情在收件箱。"
    : task.status === "interrupted" ? "执行中断，结果尚未确定；不会自动重做。" : "没有保存结果正文，请查看详情。");
  return { kind, status: scheduleStatusLabel(task.status, task.runAt, now, task.arrangement?.kind), notification, body };
}

/** One workspace inbox, backed only by existing TaskStore terminal records. */
export function TaskInbox({ enabled, busy, canAcknowledge = true, focus, onResultsRead }: { enabled: boolean; busy: boolean; canAcknowledge?: boolean; focus?: { taskId: string; sequence: number } | null; onResultsRead?: () => void }) {
  const [page, setPage] = useState<TaskListV3 | null>(null);
  const [detail, setDetail] = useState<TaskRecordV4 | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const generation = useRef(0);
  const openedFocus = useRef<number | null>(null);
  const detailElement = useRef<HTMLElement | null>(null);
  const reload = async () => {
    const request = ++generation.current;
    setLoading(true); setError(""); setDetail(null);
    try {
      const result = await window.runloom.getTaskInbox();
      if (request !== generation.current) return;
      if (result.ok) { setPage(result.value); onResultsRead?.(); }
      else { setPage(null); setError(`${result.error.code}: ${result.error.message}`); }
    } catch (cause) {
      if (request === generation.current) { setPage(null); setError(`结果读取失败：${String(cause)}`); }
    } finally { if (request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    if (enabled) void reload();
    else { setPage(null); setDetail(null); setError(""); setLoading(false); }
    return () => { generation.current++; };
  }, [enabled]);
  const open = async (id: string) => {
    if (working || loading) return;
    const request = ++generation.current;
    setWorking(true); setError(""); setNotice(""); setDetail(null);
    try {
      const result = await window.runloom.getScheduledTask(id);
      if (request !== generation.current) return;
      if (result.ok) { setDetail(result.value); onResultsRead?.(); }
      else setError(`${result.error.code}: ${result.error.message}`);
    } catch (cause) { if (request === generation.current) setError(`详情读取失败：${String(cause)}`); }
    finally { if (request === generation.current) setWorking(false); }
  };
  const acknowledge = async () => {
    if (!detail || !canAcknowledge || busy || working || detail.acknowledgedAt !== null) return;
    const id = detail.id;
    setWorking(true); setError(""); setNotice("");
    try {
      const result = await window.runloom.acknowledgeTaskResult(id);
      if (!result.ok) { setError(`${result.error.code}: ${result.error.message}`); return; }
      setNotice("已标为已读。原始结果仍保留；不会重新执行任务。");
      await reload();
    } catch (cause) { setDetail(null); setError(`标记未得到确认，请刷新核对，不会自动重试：${String(cause)}`); }
    finally { setWorking(false); }
  };
  useEffect(() => {
    if (enabled && focus && !working && !loading && openedFocus.current !== focus.sequence) {
      openedFocus.current = focus.sequence;
      void open(focus.taskId);
    }
  }, [enabled, focus?.sequence, working, loading]);
  const presentation = detail ? taskResultPresentation(detail) : null;
  useEffect(() => {
    if (detail && focus?.taskId === detail.id) detailElement.current?.scrollIntoView({ block: "nearest" });
  }, [detail?.id, focus?.sequence]);
  const clock = reminderClock();
  return <section id="scheduled-results" className="card task-inbox" aria-label="刚刚触发">
    <div className="card-head"><span>刚刚触发</span><button className="ghost" disabled={!enabled || loading || working} onClick={() => void reload()}>刷新结果</button></div>
    <p className="hint">提醒、日报、资讯和定时 Skill 的结果都在这里。没有变化的检查可不通知；失败与中断不会被当成“没有内容”。</p>
    {!enabled ? <p className="hint">当前未连接工作区，不能读取定时结果。</p> : null}
    {loading ? <p role="status">正在读取结果…</p> : null}
    {error ? <p className="error" role="alert">{error}。读取失败不代表没有结果。</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {enabled && !loading && !error && page?.tasks.length === 0 ? <p>没有未读的定时结果。排期中的任务不在此列表。</p> : null}
    {page?.tasks.map(task => {
      const line = inboxPrimaryLine(task, clock);
      return <div className="capability-row" key={task.id}>
        <div><strong>{line.subject}</strong><p>{line.when} · {line.status}</p>
          <details className="technical-id"><summary>编号</summary><code>{task.id}</code></details>
          {task.error ? <p className="error">{humanFacingTitle(task.error.messagePreview, "执行没有完成，打开详情查看原因。")}</p> : null}
        </div><button className="ghost" disabled={working || loading} onClick={() => void open(task.id)}>查看结果</button>
      </div>;
    })}
    {page?.truncated ? <p className="hint">只显示最近 50 条未读结果；标为已读后刷新可查看更早的记录。</p> : null}
    {detail && presentation ? <section ref={detailElement} className="card" aria-label="定时结果详情">
      <div className="card-head"><span>{presentation.kind} · {presentation.status}</span><button className="ghost" disabled={working} onClick={() => { setDetail(null); setError(""); }}>收起</button></div>
      <p>{detail.prompt}</p>
      <dl className="session-facts"><dt>排期时间</dt><dd>{localWhen(detail.runAt, clock)}</dd><dt>实际开始</dt><dd>{detail.startedAt ? localWhen(detail.startedAt, clock) : "未记录"}</dd><dt>结束时间</dt><dd>{detail.finishedAt ? localWhen(detail.finishedAt, clock) : "未记录"}</dd><dt>通知</dt><dd>{presentation.notification}</dd><dt>已读</dt><dd>{detail.acknowledgedAt ? localWhen(detail.acknowledgedAt, clock) : "尚未标为已读"}</dd></dl>
      <details><summary>原始时间与编号</summary><p>{detail.runAt}</p><code>{detail.id}</code></details>
      {detail.startedAt && Date.parse(detail.startedAt) - Date.parse(detail.runAt) > 1_000 ? <p className="hint">实际开始晚于排期；此结果不是准点执行的证明。</p> : null}
      {detail.resultText !== null ? <MessageContent text={detail.resultText} /> : <p className="hint">没有保存结果正文。</p>}
      {detail.error ? <p className="error" role="alert">{detail.error.code}: {detail.error.message}</p> : null}
      {detail.notification?.error ? <p className="error">通知错误：{detail.notification.error.code}: {detail.notification.error.message}。不会因此重新执行任务。</p> : null}
      <p className="hint">执行结束不等于内容质量已通过；提交系统通知不等于收到或已读。中断的任务不会从这里自动重放。</p>
      {canAcknowledge ? <button className="ghost" disabled={busy || working || detail.acknowledgedAt !== null} onClick={() => void acknowledge()}>标为已读</button> : <p className="hint">任务能力已关闭，仍可查看保存的结果；需要标为已读时请开启任务能力。</p>}
    </section> : null}
  </section>;
}
