import React, { type ReactNode } from "react";

/** The one path-list layout: each row is a path plus its own controls. */
export function SettingPaths({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="setting-paths" {...(label ? { role: "group", "aria-label": label } : {})}>{children}</div>;
}

/**
 * The one save layout for a path or permission page: optional list action on the
 * left, unsaved state beside the save button, failure directly below.
 */
export function SettingSaveBar({ changed, unsaved, error, save, secondary }: {
  changed: boolean;
  unsaved: string;
  error: string | null;
  save: { label: string; disabled: boolean; onSave: () => void };
  secondary?: ReactNode;
}) {
  return <>
    <div className="setting-save-bar">
      {secondary}
      {changed ? <span className="setting-save-state" role="status">{unsaved}</span> : null}
      <button disabled={save.disabled} onClick={save.onSave}>{save.label}</button>
    </div>
    {error ? <p role="alert" className="error">{error}</p> : null}
  </>;
}
