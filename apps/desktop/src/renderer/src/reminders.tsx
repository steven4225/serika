import React, { useEffect, useRef, useState } from "react";
import type { AutomationScheduleAction } from "@serika/assistant";
import { reminderClock, reminderRows, type ReminderDisplayRow } from "./reminder-copy.js";

export function ReminderHome({ rows, other, truncated, loading, error, pendingCancel, working, onCancel, onConfirmCancel, onDismissCancel }: {
  rows: readonly ReminderDisplayRow[];
  other: number;
  truncated: boolean;
  loading: boolean;
  error: string;
  pendingCancel: ReminderDisplayRow | null;
  working: boolean;
  onCancel: (row: ReminderDisplayRow) => void;
  onConfirmCancel: () => void;
  onDismissCancel: () => void;
}) {
  return <section className="card" aria-label="我的提醒">
    <div className="card-head"><span>我的提醒</span></div>
    <p className="hint">已经设好的提醒在这里。到点后的结果在下面，不用再进设置。</p>
    {loading ? <p role="status">正在读取提醒…</p> : null}
    {error ? <p className="error" role="alert">{error}。读取失败不代表没有提醒。</p> : null}
    {!loading && !error && rows.length === 0 ? <p>还没有提醒。在对话里直接说，例如「每天 9:00 提醒我喝水」。</p> : null}
    {rows.map(row => <div className="capability-row" key={`${row.kind}:${row.id}`}>
      <div>
        <strong>{row.subject}</strong>
        <p>{row.when} · {row.status}</p>
        <details><summary>编号</summary><code>{row.id}</code></details>
      </div>
      {row.canCancel ? <button type="button" className="ghost" disabled={working} onClick={() => onCancel(row)}>取消提醒…</button> : null}
    </div>)}
    {truncated ? <p className="hint">只显示最近的一部分安排。</p> : null}
    {other > 0 ? <p className="hint">另有 {other} 条其他定时安排。可在下方「管理定时安排与订阅」查看。</p> : null}
    {pendingCancel ? <div className="memory-setup-preview" role="group" aria-label="取消提醒确认">
      <strong>取消「{pendingCancel.subject}」？</strong>
      <p>只停止以后的提醒，不会撤回已经弹出的通知，也不会重做已经发生的结果。</p>
      <div className="memory-actions">
        <button type="button" disabled={working} onClick={onConfirmCancel}>确认取消</button>
        <button type="button" className="ghost" disabled={working} onClick={onDismissCancel}>先不要</button>
      </div>
    </div> : null}
  </section>;
}

/** Reads the existing task arrangements. It does not start a worker or replay a result. */
export function RemindersPanel({ enabled, busy, identity, refreshSequence }: {
  enabled: boolean;
  busy: boolean;
  identity: string;
  refreshSequence: number;
}) {
  const [rows, setRows] = useState<ReminderDisplayRow[]>([]);
  const [other, setOther] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [pendingCancel, setPendingCancel] = useState<ReminderDisplayRow | null>(null);
  const generation = useRef(0);
  const context = useRef(identity);
  const lastRefresh = useRef(refreshSequence);
  context.current = identity;
  const reload = async () => {
    const request = ++generation.current;
    const captured = context.current;
    setLoading(true);
    setError("");
    try {
      const result = await window.runloom.getAutomationOverview();
      if (captured !== context.current || request !== generation.current) return;
      if (!result.ok) {
        setRows([]);
        setOther(0);
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      const view = reminderRows(result.value, reminderClock());
      setRows(view.rows);
      setOther(view.other);
      setTruncated(result.value.truncated);
    } catch {
      if (captured === context.current && request === generation.current) {
        setRows([]);
        setOther(0);
        setError("提醒读取失败，不代表没有提醒。请稍后重试。");
      }
    } finally {
      if (captured === context.current && request === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (!enabled) {
      setRows([]);
      setOther(0);
      setError("");
      setLoading(false);
      return () => { generation.current += 1; };
    }
    setPendingCancel(null);
    void reload();
    const unsubscribe = window.runloom.onMessage(message => {
      if ((message.type === "state" && message.state.kind === "idle") || message.type === "task-result-available") void reload();
    });
    return () => { generation.current += 1; unsubscribe(); };
  }, [enabled, identity]);
  useEffect(() => {
    if (!enabled || lastRefresh.current === refreshSequence) return;
    lastRefresh.current = refreshSequence;
    void reload();
  }, [enabled, refreshSequence]);
  const confirmCancel = async () => {
    if (!pendingCancel || busy || working) return;
    const action: AutomationScheduleAction = {
      id: pendingCancel.id,
      kind: pendingCancel.kind === "once" ? "once" : "recurring",
      action: "cancel",
    };
    const captured = context.current;
    setWorking(true);
    setError("");
    try {
      const result = await window.runloom.changeAutomationSchedule(action);
      if (captured !== context.current) return;
      if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
      else { setPendingCancel(null); await reload(); }
    } catch {
      if (captured === context.current) setError("取消结果未确认，请刷新核对；不会自动重试。");
    } finally {
      if (captured === context.current) setWorking(false);
    }
  };
  return !enabled ? <section className="card" aria-label="我的提醒"><p className="hint">当前没有工作区，还不能查看提醒。</p></section> : <ReminderHome
    rows={rows} other={other} truncated={truncated} loading={loading} error={error} pendingCancel={pendingCancel} working={busy || working}
    onCancel={setPendingCancel} onConfirmCancel={() => void confirmCancel()} onDismissCancel={() => setPendingCancel(null)} />;
}
