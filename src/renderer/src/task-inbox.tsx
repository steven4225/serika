import React, { useEffect, useRef, useState } from "react";
import type { TaskListV3, TaskRecordV4 } from "@aisdk-agent/example-cli/dist/task-store.js";
import { MessageContent } from "./markdown.js";

const statuses = { scheduled: "已排期", running: "正在执行", completed: "执行结束", failed: "执行失败", cancelled: "已取消", interrupted: "执行中断，结果未确定" };

export function taskResultPresentation(task: TaskRecordV4): { kind: string; status: string; notification: string } {
  const kind = task.arrangement?.kind === "reminder" ? "提醒" : task.arrangement?.kind === "todoist-brief" ? "Todoist 日报" : task.arrangement?.kind === "rss-digest" ? "RSS 资讯" : "定时任务";
  const notification = task.notification === null ? "未安排系统通知" : task.notification.status === "submitted"
    ? "已提交系统通知，不代表你已看到"
    : task.notification.status === "failed" ? "系统通知提交失败" : "等待提交系统通知";
  return { kind, status: statuses[task.status], notification };
}

/** One workspace inbox, backed only by existing TaskStore terminal records. */
export function TaskInbox({ enabled, busy }: { enabled: boolean; busy: boolean }) {
  const [page, setPage] = useState<TaskListV3 | null>(null);
  const [detail, setDetail] = useState<TaskRecordV4 | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const generation = useRef(0);
  const reload = async () => {
    const request = ++generation.current;
    setLoading(true); setError(""); setDetail(null);
    try {
      const result = await window.runloom.getTaskInbox();
      if (request !== generation.current) return;
      if (result.ok) setPage(result.value);
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
      if (result.ok) setDetail(result.value);
      else setError(`${result.error.code}: ${result.error.message}`);
    } catch (cause) { if (request === generation.current) setError(`详情读取失败：${String(cause)}`); }
    finally { if (request === generation.current) setWorking(false); }
  };
  const acknowledge = async () => {
    if (!detail || busy || working || detail.acknowledgedAt !== null) return;
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
  const presentation = detail ? taskResultPresentation(detail) : null;
  return <section className="card task-inbox" aria-label="定时任务结果收件箱">
    <div className="card-head"><span>定时任务收件箱</span><button className="ghost" disabled={!enabled || loading || working} onClick={() => void reload()}>刷新结果</button></div>
    <p className="hint">提醒、日报和资讯的结果都在这里。没有变化的检查可不通知；失败与中断不会被当成“没有内容”。</p>
    {!enabled ? <p className="hint">当前配置未启用工作区任务模块，不能读取定时结果。</p> : null}
    {loading ? <p role="status">正在读取结果…</p> : null}
    {error ? <p className="error" role="alert">{error}。读取失败不代表没有结果。</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {enabled && !loading && !error && page?.tasks.length === 0 ? <p>没有未读的定时结果。排期中的任务不在此列表。</p> : null}
    {page?.tasks.map(task => <div className="capability-row" key={task.id}>
      <div><strong>{task.promptPreview}</strong><p>{statuses[task.status]} · 排期 {task.runAt}</p><small>结束 {task.finishedAt ?? "尚未记录"} · {task.id}</small>
        {task.error ? <p className="error">{task.error.code}: {task.error.messagePreview}</p> : null}
      </div><button className="ghost" disabled={working || loading} onClick={() => void open(task.id)}>查看结果</button>
    </div>)}
    {page?.truncated ? <p className="hint">只显示最近 50 条未读结果；标为已读后刷新可查看更早的记录。</p> : null}
    {detail && presentation ? <section className="card" aria-label="定时结果详情">
      <div className="card-head"><span>{presentation.kind} · {presentation.status}</span><button className="ghost" disabled={working} onClick={() => { setDetail(null); setError(""); }}>收起</button></div>
      <p>{detail.prompt}</p>
      <dl className="session-facts"><dt>排期时间</dt><dd>{detail.runAt}</dd><dt>实际开始</dt><dd>{detail.startedAt ?? "未记录"}</dd><dt>结束时间</dt><dd>{detail.finishedAt ?? "未记录"}</dd><dt>通知</dt><dd>{presentation.notification}</dd><dt>已读</dt><dd>{detail.acknowledgedAt ?? "尚未标为已读"}</dd></dl>
      {detail.startedAt && Date.parse(detail.startedAt) - Date.parse(detail.runAt) > 1_000 ? <p className="hint">实际开始晚于排期；此结果不是准点执行的证明。</p> : null}
      {detail.resultText !== null ? <MessageContent text={detail.resultText} /> : <p className="hint">没有保存结果正文。</p>}
      {detail.error ? <p className="error" role="alert">{detail.error.code}: {detail.error.message}</p> : null}
      {detail.notification?.error ? <p className="error">通知错误：{detail.notification.error.code}: {detail.notification.error.message}。不会因此重新执行任务。</p> : null}
      <p className="hint">执行结束不等于内容质量已通过；提交系统通知不等于收到或已读。中断的任务不会从这里自动重放。</p>
      <button className="ghost" disabled={busy || working || detail.acknowledgedAt !== null} onClick={() => void acknowledge()}>标为已读</button>
    </section> : null}
  </section>;
}
