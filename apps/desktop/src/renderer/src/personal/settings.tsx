import React, { useEffect, useRef, useState, type ReactNode } from "react";
import type { ContextBudgetConfig } from "@serika/assistant";
import type { AppInfo } from "../../../shared/ui-contract.js";
import type { ResidentServiceState } from "../../../shared/resident-service.js";
import { PageHeader } from "./page-header.js";
import { NavigationRows, RowGroup } from "./settings-rows.js";
import { BuildIdentityPanel } from "../build-identity-panel.js";
import { BackupPanel } from "../backup-panel.js";
import { ResidentServicePanel } from "../resident-service-panel.js";
import { DailyAutomation } from "../daily-automation-panel.js";
import { readWhenHostReady, settingsBackTarget, settingsCopy, SETTINGS_CONNECTION_ROWS, SETTINGS_OTHER_ROWS, takeHostRead, type HostReadResult, type SettingsListTarget, type SettingsRoute } from "./settings-model.js";

export function SettingsFrame({ route, onBack, children }: { route: SettingsRoute; onBack: () => void; children: ReactNode }) {
  const copy = settingsCopy(route);
  const back = settingsBackTarget(route);
  return <div className="personal-settings">
    <PageHeader title={copy.title} description={copy.description} back={{ label: back === "hand" ? "回到手札" : "返回设置", onBack }} />
    {children}
  </div>;
}

export function SettingsHome({ info, busy, onOpen }: {
  info: AppInfo | null;
  busy: boolean;
  onOpen: (route: SettingsListTarget) => void;
}) {
  return <>
    <h2 className="settings-section">能力与连接</h2>
    <NavigationRows rows={SETTINGS_CONNECTION_ROWS} onOpen={onOpen} />
    <h2 className="settings-section">其他</h2>
    <NavigationRows rows={SETTINGS_OTHER_ROWS} onOpen={onOpen} />
  </>;
}

export function SettingsGeneral({ appearance, busy, onAppearance }: { appearance: "dark" | "light"; busy: boolean; onAppearance: () => void }) {
  return <section className="settings-detail" aria-label="通用">
    <RowGroup>
      <div className="settings-row" role="group"><span className="settings-row-copy"><strong>外观</strong><small>{appearance === "dark" ? "深色" : "浅色"}</small></span>
        <button type="button" className="ghost" aria-label={appearance === "dark" ? "切换为浅色外观" : "切换为深色外观"} onClick={onAppearance}>{appearance === "dark" ? "浅色" : "深色"}</button>
      </div>
    </RowGroup>
  </section>;
}

export function ResidentSettings({ busy }: { busy: boolean }) {
  const [resident, setResident] = useState<ResidentServiceState | null>(null);
  const available = typeof window !== "undefined" && !!window.runloom.residentStatus && !!window.runloom.setResidentEnabled;
  const refresh = async () => {
    if (!window.runloom.residentStatus) throw new Error("当前版本未接通常驻服务");
    const value = await window.runloom.residentStatus();
    setResident(value);
    return value;
  };
  useEffect(() => { if (available) void refresh().catch(() => undefined); }, [available]);
  if (!available) return <p className="settings-note">退出桌面后继续工作未配置。</p>;
  return <ResidentServicePanel status={resident} busy={busy} refresh={refresh} setEnabled={async enabled => {
    const value = await window.runloom.setResidentEnabled!(enabled);
    setResident(value);
    return value;
  }} />;
}

export function SettingsNotifications({ enabled, busy }: { enabled: boolean; busy: boolean }) {
  return <section className="settings-detail" aria-label="通知">
    <DailyAutomation enabled={enabled} busy={busy} />
    <ResidentSettings busy={busy} />
  </section>;
}

const SHORTCUTS = [
  ["搜索", "⌘K 或 Ctrl+K"],
  ["发送", "Enter"],
  ["换行", "Shift + Enter"],
  ["显示或隐藏窗口", "⌥Space"],
  ["返回上一级", "Esc"],
  ["收起侧栏", "未配置快捷键"],
] as const;

export function SettingsShortcuts() {
  return <ul className="settings-shortcuts" aria-label="快捷键">
    {SHORTCUTS.map(([name, binding]) => <li key={name}><strong>{name}</strong><span>{binding}</span></li>)}
  </ul>;
}

export function SettingsAbout({ info, busy }: { info: AppInfo; busy: boolean }) {
  return <section className="settings-detail" aria-label="关于">
    <BuildIdentityPanel info={info.build} />
    <BackupPanel busy={busy} />
  </section>;
}
