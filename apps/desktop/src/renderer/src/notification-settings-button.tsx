import React, { useState } from "react";

/** This opens settings only; no authorization, notification retry or task execution. */
export function NotificationSettingsButton() {
  const [notice, setNotice] = useState("");
  const open = async () => {
    try {
      const result = await window.runloom.openNotificationSettings?.();
      setNotice(result?.message ?? "请手动进入系统设置 → 通知 → Serika 通知。");
    } catch { setNotice("未能打开系统设置。请手动进入系统设置 → 通知 → Serika 通知。"); }
  };
  return <span className="notification-settings-entry">
    <button type="button" className="ghost" onClick={() => void open()}>打开系统通知设置</button>
    {notice ? <span role="status">{notice}</span> : null}
  </span>;
}
