import { useState } from "react";
import type { AppInfo, DirectoryAuthorization } from "../../shared/ui-contract.js";
import { SettingPaths, SettingSaveBar } from "./setting-paths.js";

/** The single place that grants file and sandbox Shell access to absolute directories. */
export function DirectorySettings({ info, busy }: { info: AppInfo; busy: boolean }) {
  const [directories, setDirectories] = useState<DirectoryAuthorization[]>(() => info.authorizedDirectories.map(item => ({ ...item })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = busy || saving || !!info.runtimeRecovery || !info.configPath || typeof window === "undefined" || !window.runloom.setAuthorizedDirectories;
  const changed = JSON.stringify(directories) !== JSON.stringify(info.authorizedDirectories);
  const apply = async () => {
    setSaving(true); setError(null);
    try { await window.runloom.setAuthorizedDirectories!({ directories, expectedDirectories: info.authorizedDirectories }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <section className="setting-block" aria-label="持久目录授权">
    <strong>持久目录授权</strong>
    <p>文件工具与沙箱 Shell 使用同一份目录列表。嵌套目录采用最深层权限，受保护的控制文件始终不可修改。</p>
    <p className="hint">保存后立即应用于下一次请求，重启后保留。文件和沙箱命令只覆盖这里列出的绝对目录。要多给一个目录，添加路径并保存；单次工具批准不能扩大目录，也不会改到别的位置。</p>
    <SettingPaths label="已授权目录">
      {directories.length === 0 ? <p className="hint">未授权任何目录。</p> : null}
      {directories.map((item, index) => <div className="setting-path-row" key={index}>
        <input aria-label={`目录 ${index + 1} 路径`} placeholder="绝对目录路径" value={item.path} disabled={locked} onChange={event => setDirectories(current => current.map((entry, position) => position === index ? { ...entry, path: event.target.value } : entry))} />
        <select aria-label={`目录 ${index + 1} 权限`} value={item.access} disabled={locked} onChange={event => { const access = event.target.value === "read" ? "read" : "readwrite"; setDirectories(current => current.map((entry, position) => position === index ? { ...entry, access } : entry)); }}><option value="read">读</option><option value="readwrite">读写</option></select>
        <button className="ghost" disabled={locked} aria-label={`删除目录 ${index + 1}`} onClick={() => setDirectories(current => current.filter((_, position) => position !== index))}>删除</button>
      </div>)}
    </SettingPaths>
    <SettingSaveBar changed={changed} unsaved="有未保存的目录更改。" error={error}
      secondary={<button className="ghost" disabled={locked} onClick={() => setDirectories(current => [...current, { path: "", access: "read" }])}>添加目录</button>}
      save={{ label: saving ? "正在应用…" : "保存目录授权", disabled: locked || !changed, onSave: () => void apply() }} />
  </section>;
}
