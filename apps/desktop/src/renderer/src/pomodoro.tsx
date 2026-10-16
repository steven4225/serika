import { useEffect, useRef, useState } from "react";
import type { PomodoroStatus } from "@aisdk-agent/example-cli/dist/modules/pomodoro-module.js";
import { validPomodoroMinutes } from "./pomodoro-data.js";

export function PomodoroPanel({ enabled, busy, output }: { enabled: boolean; busy: boolean; output: string }) {
  const [minutes, setMinutes] = useState("25");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<PomodoroStatus | null>(null);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!enabled || !window.runloom.pomodoro) return;
    let cancelled = false;
    const refresh = async () => {
      if (inFlight.current) return;
      const request = revision.current;
      try {
        const result = await window.runloom.pomodoro!("status");
        if (!cancelled && request === revision.current) { if (wasRunning.current && result.status.state !== "running") setNotice("专注已结束"); wasRunning.current = result.status.state === "running"; setStatus(result.status); setError(null); setNow(Date.now()); }
      } catch { if (!cancelled && request === revision.current) { setStatus(null); setError("暂时无法读取计时状态，请稍后重试。"); } }
    };
    void refresh();
    const poll = window.setInterval(() => void refresh(), 5000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.clearInterval(poll); window.clearInterval(tick); window.removeEventListener("focus", refresh); };
  }, [enabled, output]);
  async function command(action: "start" | "cancel") {
    if (inFlight.current || busy || !enabled) return;
    inFlight.current = true; revision.current++; setPending(true); setError(null);
    try {
      if (!window.runloom.pomodoro) throw new Error("请加载当前版本后再使用番茄钟");
      const result = await window.runloom.pomodoro(action, Number(minutes));
      wasRunning.current = result.status.state === "running"; setStatus(result.status); setNow(Date.now());
      setNotice(result.outcome === "cancelled" ? "已取消计时" : result.outcome === "not_running" ? "当前没有计时" : result.outcome === "already_running" ? "正在专注，原计时保持不变" : "已开始专注");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作结果未确认，请稍后查看状态。"); setStatus(null); }
    finally { inFlight.current = false; setPending(false); }
  }
  const remaining = status?.state === "running" ? Math.max(0, Math.ceil((Date.parse(status.endsAt) - now) / 1000)) : 0;
  return <section className="focus-page">
    <div className="focus-intro"><h2>留一段时间，只做一件事。</h2><p>设置时长，开始专注。</p></div>
    {!enabled ? <p role="status">番茄钟未启用，请在设置中开启。</p> : <>
      <div className="focus-clock" role="timer" aria-label="剩余专注时间">{status?.state === "running" ? `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}` : status ? "准备好了吗？" : "正在读取…"}</div>
      <p role="status">{status?.state === "running" ? remaining > 0 ? "专注中" : "正在确认计时结束…" : notice || "当前没有计时"}</p>
      <form className="focus-controls" onSubmit={event => { event.preventDefault(); if (validPomodoroMinutes(minutes)) void command("start"); }}>
        <label htmlFor="focus-minutes">专注时长</label>
        <div className="focus-duration"><input id="focus-minutes" type="number" min="1" max="180" value={minutes} disabled={busy || pending || status?.state === "running"} onChange={event => setMinutes(event.target.value)} /><span>分钟</span></div>
        <div className="focus-actions">{status?.state === "running" ? <button type="button" className="ghost" disabled={busy || pending} onClick={() => void command("cancel")}>取消计时</button> : <button type="submit" disabled={busy || pending || !status || !validPomodoroMinutes(minutes)}>开始专注</button>}</div>
      </form>
      {busy ? <p className="hint">助手正在处理消息，结束后可操作计时。</p> : null}
      <details className="focus-help"><summary>退出应用后会怎样？</summary><p>开启常驻模式后，退出桌面仍可计时。未开启时，完整退出应用会结束计时。常驻服务退出或异常停止后，计时不会恢复。</p></details>
    </>}
    {error ? <p role="alert" className="error">{error}</p> : null}
  </section>;
}
