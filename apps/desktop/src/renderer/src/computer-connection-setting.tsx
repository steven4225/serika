import React, { useState } from "react";
import type { AppInfo, ComputerConnectionCheck, ComputerConnectionView } from "../../shared/ui-contract.js";

export function ComputerConnectionSetting({ info, busy }: { info: AppInfo; busy: boolean }) {
  const [view, setView] = useState<ComputerConnectionView | null>(null);
  const [path, setPath] = useState("");
  const [bundleIds, setBundleIds] = useState("");
  const [drivers, setDrivers] = useState<string[]>([]);
  const [health, setHealth] = useState<ComputerConnectionCheck | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (typeof window === "undefined" || !window.runloom.getComputerConnection || !window.runloom.findComputerDrivers || !window.runloom.checkComputerConnection || !window.runloom.saveComputerConnection) return null;
  const locked = busy || working || !!info.runtimeRecovery;
  const perform = async (operation: () => Promise<void>) => {
    setWorking(true); setError(null);
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  };
  const load = async () => {
    const current = await window.runloom.getComputerConnection!();
    setView(current); setPath(current.executable); setBundleIds(current.allowedBundleIds.join("\n")); setHealth(null);
  };
  return <section className="capability-confirm" aria-label="电脑控制连接">
    <strong>连接电脑控制驱动</strong>
    <p>选择已安装的 Cua Driver，并明确填写允许控制的应用 Bundle ID。驱动必须在授权目录之外。桌面和 Telegram 的每次观察与操作都需要确认，且不可记住。</p>
    <p className="hint">不会安装驱动、启动服务或申请 macOS 权限。连接检查只读取运行应用列表。桌面和 TG 的连接检查及已授权应用观察免逐条确认，未授权应用直接拒绝；操作每次确认且不可记住。系统辅助功能权限需在 macOS 中由你设置。</p>
    <button className="ghost" disabled={locked} onClick={() => void perform(load)}>{view ? "刷新连接设置" : "设置连接"}</button>
    {view ? <>
      <label>驱动程序绝对路径<input disabled={locked} value={path} onChange={event => { setPath(event.target.value); setHealth(null); }} /></label>
      <button className="ghost" disabled={locked} onClick={() => void perform(async () => { setDrivers(await window.runloom.findComputerDrivers!()); })}>查找已安装驱动</button>
      {drivers.length ? <select aria-label="已安装驱动" disabled={locked} value="" onChange={event => { setPath(event.target.value); setHealth(null); }}><option value="">选择程序</option>{drivers.map(driver => <option key={driver} value={driver}>{driver}</option>)}</select> : null}
      <button className="ghost" disabled={locked || !path} onClick={() => void perform(async () => { setHealth(await window.runloom.checkComputerConnection!(path)); })}>确认检查连接与运行应用</button>
      {health ? <div role="status">{health.ok ? <><p>连接可达；辅助功能权限尚未检查。</p><p>运行应用：{health.apps.join("、") || "无"}</p></> : <p>{health.error.message}</p>}</div> : null}
      <label>允许控制的应用 Bundle ID（每行一个，最多 16 个）<textarea disabled={locked} value={bundleIds} onChange={event => setBundleIds(event.target.value)} placeholder="com.apple.TextEdit" /></label>
      <button disabled={locked || !path || !bundleIds.trim()} onClick={() => void perform(async () => {
        await window.runloom.saveComputerConnection!({ enabled: true, executable: path, allowedBundleIds: bundleIds.split(/\s+/).filter(Boolean), expectedRevision: view.revision }); await load();
      })}>确认允许这些应用并启用</button>
      {view.enabled ? <button className="ghost" disabled={locked} onClick={() => void perform(async () => {
        await window.runloom.saveComputerConnection!({ enabled: false, executable: view.executable, allowedBundleIds: view.allowedBundleIds, expectedRevision: view.revision }); await load();
      })}>停用电脑控制</button> : null}
    </> : null}
    {working ? <p role="status">正在处理连接设置…</p> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
  </section>;
}
