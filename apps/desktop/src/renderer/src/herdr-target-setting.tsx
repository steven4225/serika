import React, { useState } from "react";
import type { AppInfo, HerdrPane, HerdrSession } from "../../shared/ui-contract.js";

export function HerdrTargetSetting({ info, busy }: { info: AppInfo; busy: boolean }) {
  const [sessions, setSessions] = useState<HerdrSession[]>([]);
  const [panes, setPanes] = useState<HerdrPane[]>([]);
  const [session, setSession] = useState("");
  const [paneId, setPaneId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (typeof window === "undefined" || !window.runloom.listHerdrSessions || !window.runloom.listHerdrPanes || !window.runloom.setHerdrTarget) return null;
  const locked = busy || loading || !!info.runtimeRecovery || !info.authorizedDirectory;
  const perform = async (action: () => Promise<void>) => {
    setLoading(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const pane = panes.find(item => item.paneId === paneId);
  return <section className="capability-confirm" aria-label="Herdr 终端目标">
    <strong>Herdr 终端目标</strong>
    <p>{info.terminalTarget ? `已选择：${info.terminalTarget.session} / ${info.terminalTarget.paneId}` : "尚未选择终端"}</p>
    <p className="hint">选择已运行的会话和终端。桌面和 Telegram 的结构化 get、read、wait 免逐条确认，每次先核对终端身份；不匹配就停下要求重选。prompt、input、stop 每次确认且不可记住。通用本机 CLI 仍每次确认。不会自动启动 Herdr，也不会使用聚焦终端。</p>
    <div className="actions">
      <button className="ghost" disabled={locked} onClick={() => void perform(async () => { setSession(""); setPaneId(""); setPanes([]); setSessions([]); setSessions(await window.runloom.listHerdrSessions!()); })}>查找会话</button>
      {info.terminalTarget ? <button className="ghost" disabled={locked} onClick={() => void perform(() => window.runloom.setHerdrTarget!({ target: null, expected: info.terminalTarget! }))}>解除目标</button> : null}
    </div>
    {sessions.length ? <label>会话<select aria-label="Herdr 会话" disabled={locked} value={session} onChange={event => {
      const name = event.target.value; setSession(name); setPaneId(""); setPanes([]);
      if (name) void perform(async () => { setPanes(await window.runloom.listHerdrPanes!(name)); });
    }}><option value="">请选择会话</option>{sessions.map(item => <option key={item.name} value={item.name} disabled={!item.running}>{item.name}{item.running ? "" : "（未运行）"}</option>)}</select></label> : null}
    {session && !loading ? <label>终端<select aria-label="Herdr 终端" disabled={locked} value={paneId} onChange={event => setPaneId(event.target.value)}>
      <option value="">请选择终端</option>{panes.map(item => <option key={item.paneId} value={item.paneId}>{item.paneId}{item.title ? ` · ${item.title}` : ""}</option>)}
    </select></label> : null}
    {pane ? <button disabled={locked} onClick={() => void perform(() => window.runloom.setHerdrTarget!({ target: { session, paneId: pane.paneId, terminalId: pane.terminalId }, expected: info.terminalTarget ?? null }))}>确认选择此终端</button> : null}
    {loading ? <p role="status">正在读取终端目标…</p> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
  </section>;
}
