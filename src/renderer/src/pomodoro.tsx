import { useRef, useState } from "react";
import { pomodoroReplies, validPomodoroMinutes } from "./pomodoro-data.js";

export function PomodoroPanel({ enabled, busy, output }: { enabled: boolean; busy: boolean; output: string }) {
  const [minutes, setMinutes] = useState("25");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const replies = pomodoroReplies(output);
  async function command(action: "start" | "status" | "cancel") {
    if (inFlight.current || busy || !enabled) return;
    inFlight.current = true;
    setPending(true); setError(null);
    try {
      const result = await window.runloom.command(`/pomodoro ${action}${action === "start" ? ` ${minutes}` : ""}`);
      if (!result.ok) setError(result.reason === "failed" ? result.message : `未执行：${result.reason}`);
    } catch { setError("未收到命令结果，请查询状态核对，不会自动重发。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <section className="focus-page">
    <div className="focus-intro"><h2>留一段时间，只做一件事。</h2><p>默认 25 分钟。开始、查询和取消直接使用现有番茄钟，不需要模型回复。</p></div>
    {!enabled ? <div className="focus-unavailable">本次未启用番茄钟。请在配置中启用 pomodoro 并重启；这里不会自动改配置。</div> : null}
    <form className="focus-controls" onSubmit={event => { event.preventDefault(); if (validPomodoroMinutes(minutes)) void command("start"); }}>
      <label htmlFor="focus-minutes">专注时长</label>
      <div className="focus-duration"><input id="focus-minutes" type="number" min="1" max="180" step="1" value={minutes} disabled={!enabled || busy || pending} onChange={event => setMinutes(event.target.value)} /><span>分钟</span></div>
      <p className="hint">1–180 分钟。已有计时不会被重复开始重置。</p>
      <div className="focus-actions"><button type="submit" disabled={!enabled || busy || pending || !validPomodoroMinutes(minutes)}>开始专注</button><button className="ghost" type="button" disabled={!enabled || busy || pending} onClick={() => void command("status")}>查询剩余时间</button><button className="ghost" type="button" disabled={!enabled || busy || pending} onClick={() => void command("cancel")}>取消计时</button></div>
    </form>
    {busy ? <p className="hint">助手正在处理任务，结束后可操作番茄钟。</p> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
    <div className="focus-replies" role="log" aria-label="番茄钟回执"><h3>最近回执</h3>{replies.length ? replies.map((reply, index) => <p key={`${index}-${reply}`}>{reply}</p>) : <p className="hint">尚无回执。查询可获得后端当时的剩余时间；这里不显示推算的倒计时。</p>}</div>
    <p className="hint">计时只属于当前进程，退出应用不会继续，也不跨重启恢复。完成回执不等于系统通知已送达。</p>
  </section>;
}
