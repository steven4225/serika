import { useEffect, useState } from "react";
import type { ComputerConnectionView, ComputerDriverSelection } from "../../shared/ui-contract.js";

export function ComputerConnectionSetting({ busy, unavailable, enabled }: { busy: boolean; unavailable: boolean; enabled: boolean }) {
  const [view, setView] = useState<ComputerConnectionView | null>(null);
  const [driver, setDriver] = useState<ComputerDriverSelection | null>(null);
  const [apps, setApps] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = typeof window !== "undefined" && !!window.runloom.getComputerConnection;
  useEffect(() => {
    if (!supported || unavailable || busy) return;
    let current = true;
    void window.runloom.getComputerConnection!().then(value => { if (current) setView(value); }, cause => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, [supported, unavailable, busy]);
  if (!supported) return null;
  const disabled = busy || unavailable || loading;
  const perform = async (action: () => Promise<void>) => {
    setLoading(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  return <section className="capability-confirm" aria-label="电脑控制接入">
    <strong>连接本机应用</strong>
    <p>1. 选择已安装的 Cua Driver。2. 查找并选择允许控制的应用。3. 保存后手动检查连接。</p>
    <p className="hint">驱动需安装在工作区外。查找和检查只读取运行中的应用列表，不读取窗口内容。安装驱动和授予 macOS 辅助功能权限需要你确认。</p>
    <p>当前驱动：<code>{view?.executable ?? "尚未配置"}</code></p>
    <p>允许控制：{view?.allowedBundleIds.join("、") || "尚未选择"}</p>
    <button className="ghost" disabled={disabled} onClick={() => void perform(async () => {
      const next = await window.runloom.chooseComputerDriver!();
      if (next) { setDriver(next); setApps(null); setSelected([]); }
    })}>选择已安装驱动</button>
    {driver ? <div>
      <p>已选择：<code>{driver.executable}</code></p>
      <button className="ghost" disabled={disabled} onClick={() => void perform(async () => { setApps(null); setSelected([]); setApps(await window.runloom.discoverComputerApps!(driver.token)); })}>查找运行中的应用</button>
      {apps ? <fieldset disabled={disabled}><legend>允许控制的应用（最多 16 个）</legend>
        {apps.length === 0 ? <p>未找到运行中的应用。请先打开目标应用，再查找。</p> : apps.map(id => <label key={id} style={{ display: "block" }}>
          <input type="checkbox" checked={selected.includes(id)} disabled={!selected.includes(id) && selected.length >= 16} onChange={event => setSelected(current => event.target.checked ? [...current, id] : current.filter(value => value !== id))} /> {id}
        </label>)}
      </fieldset> : null}
      {selected.length ? <div><p>保存后开启电脑控制，只允许上述 {selected.length} 个应用。观察和操作仍需逐次确认。</p>
        <button disabled={disabled} onClick={() => void perform(() => window.runloom.saveComputerConnection!({ token: driver.token, allowedBundleIds: selected }))}>保存并开启电脑控制</button>
      </div> : null}
    </div> : null}
    <hr />
    <strong>上次连接检查</strong>
    {view?.lastCheck ? <p role="status">{view.lastCheck.ok ? "驱动连接成功" : `连接检查失败（${view.lastCheck.errorCode ?? "原因未确认"}）`} · {new Date(view.lastCheck.checkedAt).toLocaleString()}<br />这是历史检查结果，不代表当前仍然在线。</p> : <p>当前配置尚无检查记录。</p>}
    <p className="hint">辅助功能权限：未检查。连接成功只证明驱动返回应用列表，实际观察或操作需要单独验证。</p>
    <button className="ghost" disabled={disabled || !enabled} onClick={() => void perform(async () => { setView(await window.runloom.checkComputerConnection!()); })}>检查连接并保存结果</button>
    {loading ? <p role="status">正在处理…</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}
