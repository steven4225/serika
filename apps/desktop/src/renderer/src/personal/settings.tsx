import React, { useEffect, useRef, useState, type ReactNode } from "react";
import type { ContextBudgetConfig } from "@serika/example-cli/dist/context-budget.js";
import type { AppInfo } from "../../../shared/ui-contract.js";
import type { ResidentServiceState } from "../../../shared/resident-service.js";
import { Icon } from "../icons.js";
import { BuildIdentityPanel } from "../build-identity-panel.js";
import { BackupPanel } from "../backup-panel.js";
import { ResidentServicePanel } from "../resident-service-panel.js";
import { DailyAutomation } from "../daily-automation-panel.js";
import {
  applyThinkingChoice,
  readWhenHostReady,
  settingsBackTarget,
  settingsCopy,
  SETTINGS_CONNECTION_ROWS,
  SETTINGS_OTHER_ROWS,
  takeHostRead,
  thinkingChoiceForBudget,
  type HostReadResult,
  type SettingsListTarget,
  type SettingsRoute,
  type ThinkingChoice,
} from "./settings-model.js";

async function readContextBudget(): Promise<HostReadResult<ContextBudgetConfig>> {
  const readDiagnostics = window.runloom.getContextDiagnostics;
  if (!readDiagnostics) return { ok: false, retry: false };
  const result = await readDiagnostics();
  if (!result.ok) return { ok: false, retry: true };
  return { ok: true, value: result.value.budget };
}

export function SettingsFrame({ route, onBack, children }: { route: SettingsRoute; onBack: () => void; children: ReactNode }) {
  const copy = settingsCopy(route);
  const back = settingsBackTarget(route);
  return <div className="personal-settings">
    <header className="settings-push-header">
      <button type="button" className="settings-back" aria-label={back === "hand" ? "回到手札" : "返回设置"} onClick={onBack}><Icon name="chevron" size={16} style={{ transform: "rotate(180deg)" }} /></button>
      <div><h1>{copy.title}</h1><p>{copy.description}</p></div>
    </header>
    {children}
  </div>;
}

export function SettingsHome({ info, busy, onOpen }: {
  info: AppInfo | null;
  busy: boolean;
  onOpen: (route: SettingsListTarget) => void;
}) {
  return <>
    <h2 className="settings-section">模式</h2>
    <ThinkingModes busy={busy} hostReady={info !== null} />
    <p className="settings-note">选择 Serika 的思考方式。</p>
    <h2 className="settings-section">能力与连接</h2>
    <SettingsRows rows={SETTINGS_CONNECTION_ROWS} onOpen={onOpen} />
    <h2 className="settings-section">其他</h2>
    <SettingsRows rows={SETTINGS_OTHER_ROWS} onOpen={onOpen} />
  </>;
}

function SettingsRows<Route extends SettingsRoute>({ rows, onOpen }: {
  rows: readonly { route: Route; title: string; description: string }[];
  onOpen: (route: Route) => void;
}) {
  return <div className="settings-group">
    {rows.map(row => {
      return <button type="button" className="settings-row" key={row.route} onClick={() => onOpen(row.route)}>
        <span className="settings-row-copy"><strong>{row.title}</strong><small>{row.description}</small></span>
        <Icon name="chevron" size={16} />
      </button>;
    })}
  </div>;
}

export function ThinkingModeCards({ current, disabled, onChoose }: { current: ThinkingChoice | "unconfigured"; disabled: boolean; onChoose: (choice: ThinkingChoice) => void }) {
  return <div className="settings-modes" role="radiogroup" aria-label="思考方式">
    {([
      ["balanced", "平衡", "自动按日常场景管理上下文，使用当前配置的模型。"],
      ["performance", "性能", "固定使用长任务窗口，沿用当前配置的模型。"],
    ] as const).map(([id, title, description]) => <button type="button" className="settings-mode" role="radio" key={id} aria-checked={current === id} disabled={disabled} onClick={() => { if (applyThinkingChoice(current, id)) onChoose(id); }}>
      <strong>{title}</strong><span>{description}</span><i className="settings-mode-mark" aria-hidden="true" />
    </button>)}
  </div>;
}

function ThinkingModes({ busy, hostReady }: { busy: boolean; hostReady: boolean }) {
  const [budget, setBudget] = useState<ContextBudgetConfig | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "missing">("loading");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const hostReadyRef = useRef(hostReady);
  hostReadyRef.current = hostReady;
  const load = () => {
    const id = ++request.current;
    return readWhenHostReady({
      hostReady: () => hostReadyRef.current && request.current === id,
      isCurrent: () => request.current === id,
      read: readContextBudget,
    }).then(outcome => {
      const accepted = takeHostRead(id, request.current, outcome);
      if (!accepted) return;
      if (accepted.status === "unavailable") { setBudget(null); setPhase("missing"); return; }
      setBudget(accepted.value);
      setPhase("ready");
    });
  };
  useEffect(() => {
    if (!hostReady) setPhase("loading");
    void load();
    return () => { request.current += 1; };
  }, [hostReady]);
  const current = phase === "ready" ? thinkingChoiceForBudget(budget?.mode) : "unconfigured";
  const selectable = phase === "ready" && !!budget && !busy && !pending && typeof window !== "undefined" && !!window.runloom.setContextMode;
  const choose = async (choice: ThinkingChoice) => {
    const mode = applyThinkingChoice(current, choice);
    if (!mode || !budget || !window.runloom.setContextMode) return;
    setPending(true); setError(null);
    try {
      await window.runloom.setContextMode({ mode, expectedBudget: budget });
      await load();
    } catch (cause) { setError(`模式未确认生效：${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setPending(false); }
  };
  return <>
    <ThinkingModeCards current={current} disabled={!selectable} onChoose={choice => void choose(choice)} />
    {phase === "missing" ? <p className="settings-note" role="status">思考方式未报告／未配置。</p> : null}
    {pending ? <p className="settings-note" role="status">正在保存思考方式…</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </>;
}

export function SettingsGeneral({ appearance, busy, onAppearance }: { appearance: "dark" | "light"; busy: boolean; onAppearance: () => void }) {
  return <section className="settings-detail" aria-label="通用">
    <div className="settings-group">
      <div className="settings-row" role="group"><span className="settings-row-copy"><strong>外观</strong><small>{appearance === "dark" ? "深色" : "浅色"}</small></span>
        <button type="button" className="ghost" aria-label={appearance === "dark" ? "切换为浅色外观" : "切换为深色外观"} onClick={onAppearance}>{appearance === "dark" ? "浅色" : "深色"}</button>
      </div>
    </div>
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
