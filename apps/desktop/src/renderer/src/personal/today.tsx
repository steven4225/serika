import { EntryCardContent } from "./entry-card.js";
import React, { useEffect, useState } from "react";
import type { AppInfo } from "../../../shared/ui-contract.js";
import type { WorkTask } from "../../../shared/work-tasks.js";
import {
  buildTodayBrief,
  visibleBriefCards,
  type BriefAction,
  type BriefBody,
  type BriefCard,
  type TodayBriefFeeds,
  type TodayBriefModel,
} from "./today-brief.js";

export interface TodayPanelProps {
  info: AppInfo | null;
  tasks: readonly WorkTask[];
  tasksLoading: boolean;
  tasksError: string | null;
  pendingMemory: number;
  pendingMemoryError: string | null;
  /** Always mounted by App: one source for the badge and explicit review. */
  memoryReview?: React.ReactNode;
  feeds?: TodayBriefFeeds;
  now?: Date;
  continueDisabled?: boolean;
  onContinue: (target: BriefAction["target"]) => void;
  onPomodoro: () => void;
  onAutomation: () => void;
}

export function TodayPanel(props: TodayPanelProps) {
  const [liveNow, setLiveNow] = useState(() => new Date());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (props.now) return;
    const timer = window.setInterval(() => setLiveNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [props.now]);
  const brief = buildTodayBrief({
    now: props.now ?? liveNow,
    info: props.info,
    tasks: props.tasks,
    tasksLoading: props.tasksLoading,
    tasksError: props.tasksError,
    pendingMemory: props.memoryReview ? 0 : props.pendingMemory,
    pendingMemoryError: props.memoryReview ? null : props.pendingMemoryError,
    feeds: props.feeds ?? { reminders: [], remindersState: "ready", inbox: [], inboxState: "ready", worker: { ok: true, registered: false, running: false, rssEnabled: false }, workerState: "ready" },
  });
  return <div className="personal-today">
    {props.memoryReview}
    {brief.mode === "connecting" || brief.mode === "reading" ? <p className="today-task-message" role="status">{brief.message}</p> : null}
    {brief.mode === "empty" && brief.next ? <section className="today-card today-empty" aria-label="下一次简报">
      <p className="today-section-stamp">{brief.next.when}</p>
      <h2>{brief.next.name}</h2>
      <p>到了这个时段，这里会汇总当时的任务、提醒和连接状态。现在还没有可汇总的内容。</p>
      {brief.emptyLead ? <p>{brief.emptyLead}</p> : null}
    </section> : null}
    {brief.status ? <StatusCard card={brief.status} disabled={props.continueDisabled === true} onContinue={props.onContinue} /> : null}
    {brief.sections.map(section => {
      const open = expanded[section.key] === true;
      const shown = visibleBriefCards(section.cards, open);
      return <section className="today-section" key={section.key} aria-labelledby={`brief-${section.key}`}>
        <p className="today-section-stamp">{section.when}</p>
        <h2 id={`brief-${section.key}`}>{section.name}</h2>
        <div className="today-brief-list">
          {shown.map(card => <BriefCardView key={card.key} card={card} disabled={props.continueDisabled === true} onContinue={props.onContinue} />)}
        </div>
        {section.cards.length > shown.length || open && section.cards.length > 3 ? <button type="button" className="today-expand" aria-expanded={open} onClick={() => setExpanded(current => ({ ...current, [section.key]: !open }))}>{open ? "收起" : "展开更多"}</button> : null}
      </section>;
    })}
    <div className="today-quiet-links">
      <button type="button" className="personal-entry-card" onClick={props.onAutomation}><EntryCardContent title="查看我的提醒" description="查看提醒安排和已经收到的结果。" /></button>
      <button type="button" className="personal-entry-card" onClick={props.onPomodoro}><EntryCardContent title="打开番茄钟" description="开始专注计时，或查看当前进度。" /></button>
    </div>
  </div>;
}

function StatusCard({ card, disabled, onContinue }: { card: NonNullable<TodayBriefModel["status"]>; disabled: boolean; onContinue: TodayPanelProps["onContinue"] }) {
  return <section className="today-card today-status" aria-label={card.title}>
    <p className="today-eyebrow">{card.eyebrow}</p>
    <h3>{card.title}</h3>
    <p>{card.body}</p>
    {card.risk ? <p className="today-risk" role="note">{card.risk}</p> : null}
    {card.action ? <Actions actions={[card.action]} disabled={disabled} onContinue={onContinue} /> : null}
  </section>;
}

function BriefCardView({ card, disabled, onContinue }: { card: BriefCard; disabled: boolean; onContinue: TodayPanelProps["onContinue"] }) {
  const direction = card.actions.some(action => action.tone === "direction");
  return <article className="today-card today-brief-card">
    <p className="today-eyebrow">{card.eyebrow}</p>
    <h3>{card.title}</h3>
    <Body body={card.body} />
    {card.risk ? <p className="today-risk" role="note">{card.risk}</p> : null}
    <Actions actions={card.actions} direction={direction} disabled={disabled} onContinue={onContinue} />
  </article>;
}

function Body({ body }: { body: BriefBody }) {
  switch (body.kind) {
    case "kpis":
      return <>
        {body.lead ? <p className="today-lead">{body.lead}</p> : null}
        <div className="today-task-counts" aria-label="当前会话已加载任务的状态">
          {body.cells.map(cell => <div key={cell.label}><span>{cell.label}</span><strong>{cell.value}</strong><small>{cell.note}</small></div>)}
        </div>
        {body.notes.map(note => <p className="today-scope-note" key={note}>{note}</p>)}
      </>;
    case "groups":
      return <>
        {body.groups.map(group => <div className="today-group" key={group.title}>
          <h4>{group.title}</h4>
          <ul>{group.lines.map(line => <li key={line}>{line}</li>)}</ul>
        </div>)}
        {body.more ? <p className="today-scope-note">{body.more}</p> : null}
      </>;
    case "quote":
      return <>
        {body.note ? <p className="today-lead">{body.note}</p> : null}
        <blockquote className="today-quote">{body.text}</blockquote>
      </>;
    case "text":
      return <p>{body.text}</p>;
    default: {
      const unreachable: never = body;
      return unreachable;
    }
  }
}

function Actions({ actions, direction = false, disabled, onContinue }: { actions: readonly BriefAction[]; direction?: boolean; disabled: boolean; onContinue: TodayPanelProps["onContinue"] }) {
  if (actions.length === 0) return null;
  return <div className={direction ? "today-directions" : "today-actions"} role={direction ? "group" : undefined} aria-label={direction ? "选择方向" : undefined}>
    {actions.map(action => <button type="button" key={action.label} className={action.tone === "direction" ? "today-direction-chip" : action.tone === "primary" ? "today-chat-button" : "today-secondary-button"} disabled={disabled} onClick={() => onContinue(action.target)}>{action.label}</button>)}
  </div>;
}
