import { useState } from "react";
import type { AppInfo } from "../../shared/ui-contract.js";

/** Trusted local autonomy for the current workspace. Capability switches stay separate. */
export function AutonomySetting({ info, busy }: { info: AppInfo; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!info.autonomy || typeof window === "undefined" || !window.runloom.setAutonomyEnabled) return null;
  const enabled = info.autonomy.enabled;
  const apply = async () => {
    setSaving(true); setError(null);
    try {
      await window.runloom.setAutonomyEnabled!({ enabled: !enabled, expectedEnabled: enabled });
      setConfirming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const locked = busy || saving || !!info.runtimeRecovery || !info.autonomy.directory;
  return <section className="setting-block" aria-label="本机自主执行">
    <strong>本机自主执行 · {enabled ? "已开启" : "已关闭"}</strong>
    <p>桌面聊天与任务可连续操作授权目录；自主命令使用 macOS Seatbelt，无需逐条确认。Telegram 和后台任务不继承此授权。</p>
    <small>当前工作区：{info.autonomy.directory ?? "未选择"}</small>
    {confirming ? <div className="capability-confirm" role="group" aria-label="确认自主执行变更">
      <strong>{enabled ? "关闭本机自主执行？" : "信任此工作区并开启本机自主执行？"}</strong>
      <p>Seatbelt 默认断网，仅读写授权目录和私密临时目录可写，运行时依赖只读，敏感路径不可访问。后端不可用会拒绝执行。需要联网或不支持的命令，请关闭自主执行，改用按工作目录批准一次后沿用的 host Shell。</p>
      <p>授权重启后仍有效，直到关闭。仅空闲时可更改；执行中可先停止。Telegram 和后台任务不继承此授权，其他工具保留原权限。</p>
      <p>开启后每轮最多 128 步、30 分钟，单条命令最长 10 分钟。未启用的工具不会自动开启。</p>
      <div className="actions"><button disabled={locked} onClick={() => void apply()}>{saving ? "正在应用…" : enabled ? "关闭并恢复按目录确认" : "信任并开启"}</button><button className="ghost" disabled={saving} onClick={() => setConfirming(false)}>取消</button></div>
    </div> : <div className="actions"><button className="ghost" disabled={locked} onClick={() => { setConfirming(true); setError(null); }}>{enabled ? "关闭自主执行" : "开启自主执行"}</button></div>}
    {busy ? <p className="hint">执行结束或停止后才能更改授权。</p> : null}
    {error ? <p role="alert" className="error">{error}</p> : null}
  </section>;
}
