import { useState } from "react";
import type { AppInfo } from "../../shared/ui-contract.js";
import { SettingPaths, SettingSaveBar } from "./setting-paths.js";

/** Chooses the project directory. File access still comes from the directory authorization page. */
export function ProjectSelection({ info, busy }: { info: AppInfo; busy: boolean }) {
  const [directory, setDirectory] = useState(info.project?.directory ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = busy || saving || !!info.runtimeRecovery || typeof window === "undefined" || !window.runloom.selectProject;
  const changed = directory.trim() !== (info.project?.directory ?? "");
  const apply = async () => {
    setSaving(true); setError(null);
    try { await window.runloom.selectProject!(directory.trim() || null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return <section className="setting-block" aria-label="当前项目">
    <strong>当前项目</strong>
    <p>{info.project ? `${info.project.name} · ${info.project.directory}` : "无项目"}</p>
    <p className="hint">按选中目录的最近 Git 根识别，普通文件夹直接作为项目。移动项目后请按提示离线重绑。文件访问仍使用目录授权。</p>
    <SettingPaths>
      <div className="setting-path-row">
        <input aria-label="项目目录" placeholder="绝对目录路径，留空表示无项目" value={directory} disabled={locked} onChange={event => setDirectory(event.target.value)} />
      </div>
    </SettingPaths>
    <SettingSaveBar changed={changed} unsaved="有未保存的项目更改。" error={error}
      save={{ label: saving ? "正在切换…" : "选择项目", disabled: locked || !changed, onSave: () => void apply() }} />
  </section>;
}
