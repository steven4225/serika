import React, { useEffect, useRef, useState } from "react";
import type { AutomationScheduleAction } from "@aisdk-agent/example-cli/dist/automation-scheduling.js";
import type { WorkTask } from "../../../shared/work-tasks.js";
import { humanFacingTitle } from "../../../shared/human-title.js";
import { reminderClock, type ReminderDisplayRow } from "../reminder-copy.js";
import { createSavedTaskNoticeReader } from "../../../shared/saved-task-result.js";
import { Clock, Plus } from "lucide-react";
import {
  SCHEDULE_TEMPLATES,
  TASK_EXAMPLE_PROMPTS,
  groupTaskRows,
  inboxReturnTitle,
  planTaskContinueHandoff,
  planTaskCreateHandoff,
  scheduledTaskRows,
  taskArtifactCards,
  taskProgressLines,
  taskReturnLabel,
  taskWhenLabel,
  workTaskRows,
  type ScheduledTaskRow,
  type TaskComposerHandoff,
} from "./tasks-model.js";

export interface TasksPageProps {
  tasksEnabled: boolean;
  tasks: readonly WorkTask[];
  openedTask: WorkTask | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  now?: Date;
  opening?: boolean;
  segment: "tasks" | "scheduled";
  reminders: readonly ScheduledTaskRow[];
  reminderOther: number;
  remindersLoading: boolean;
  remindersError: string;
  openedReminder: ScheduledTaskRow | null;
  pendingCancel: ScheduledTaskRow | null;
  onSegment: (segment: "tasks" | "scheduled") => void;
  onOpenTask: (id: string) => void;
  onOpenReminder: (id: string) => void;
  onBack: () => void;
  onCreate: (handoff: TaskComposerHandoff) => void;
  onContinue: (handoff: TaskComposerHandoff) => void;
  onCancelReminder: (row: ScheduledTaskRow) => void;
  onConfirmCancel: () => void;
  onDismissCancel: () => void;
  onOpenSettings: () => void;
  advanced: React.ReactNode;
}

export function TasksPage(props: TasksPageProps) {
  const now = props.now ?? new Date();
  const clock = reminderClock(now);
  const detail = props.segment === "tasks" ? props.openedTask : props.openedReminder;
  if (props.opening && props.segment === "tasks" && !props.openedTask) {
    return <div className="personal-tasks"><p className="task-note" role="status">正在读取这件任务…</p><button type="button" className="ghost" onClick={props.onBack}>返回任务列表</button></div>;
  }
  return <div className="personal-tasks">
    {props.segment === "tasks" && props.openedTask ? <WorkTaskThread task={props.openedTask} now={now} busy={props.busy} advanced={props.advanced} onBack={props.onBack} onContinue={props.onContinue} /> : null}
    {props.segment === "scheduled" && props.openedReminder ? <ReminderThread row={props.openedReminder} now={now} busy={props.busy} pendingCancel={props.pendingCancel} onBack={props.onBack} onContinue={props.onContinue} onCancel={props.onCancelReminder} onConfirmCancel={props.onConfirmCancel} onDismissCancel={props.onDismissCancel} /> : null}
    {detail ? null : <>
      <header className="task-topbar">
        <h1>任务</h1>
        <button type="button" className="task-create" disabled={props.busy} onClick={() => props.onCreate(planTaskCreateHandoff())}>＋ 创建任务</button>
      </header>
      <div className="task-segments" role="tablist" aria-label="任务类型">
        <button type="button" role="tab" aria-selected={props.segment === "tasks"} onClick={() => props.onSegment("tasks")}>任务</button>
        <button type="button" role="tab" aria-selected={props.segment === "scheduled"} onClick={() => props.onSegment("scheduled")}><Clock size={15} aria-hidden="true" />定时任务</button>
      </div>
      {props.segment === "tasks" ? <WorkTaskList {...props} now={now} /> : <ScheduledTaskList {...props} now={now} clock={clock} />}
    </>}
  </div>;
}

function WorkTaskList(props: TasksPageProps & { now: Date }) {
  const groups = groupTaskRows(workTaskRows(props.tasks), props.now);
  return <>
    {!props.tasksEnabled ? <p className="task-note">工作任务还没启用。你仍然可以直接说想做什么。</p> : null}
    {props.loading ? <p className="task-note" role="status">正在读取任务…</p> : null}
    {props.error ? <p className="task-warning" role="alert">{props.error}。读取失败不代表没有任务。</p> : null}
    {!props.loading && !props.error && props.tasksEnabled && groups.length === 0 ? <p className="task-note">还没有任务。点右上角，用对话说你想做成什么。</p> : null}
    {groups.map(group => <section className="task-group" key={group.bucket} aria-label={group.bucket}>
      <h2>{group.bucket}</h2>
      {group.items.map(item => <button type="button" className="task-row" key={item.key} disabled={props.busy} onClick={() => props.onOpenTask(item.key)}><span>{item.title}</span></button>)}
    </section>)}
    <div className="task-examples" aria-label="对话式创建示例">
      {TASK_EXAMPLE_PROMPTS.map(example => <button type="button" key={example.label} disabled={props.busy} onClick={() => props.onCreate(planTaskCreateHandoff(example.prompt))}>{example.label}</button>)}
    </div>
  </>;
}

function ScheduledTaskList(props: TasksPageProps & { now: Date; clock: ReturnType<typeof reminderClock> }) {
  const groups = groupTaskRows(props.reminders, props.now);
  const empty = !props.remindersLoading && !props.remindersError && props.reminders.length === 0;
  return <>
    {props.remindersLoading ? <p className="task-note" role="status">正在读取提醒…</p> : null}
    {props.remindersError ? <p className="task-warning" role="alert">{props.remindersError}。读取失败不代表没有提醒。</p> : null}
    {groups.map(group => <section className="task-group" key={group.bucket} aria-label={group.bucket}>
      <h2>{group.bucket}</h2>
      {group.items.map(item => <button type="button" className="task-row" key={`${item.kind}:${item.id}`} disabled={props.busy} onClick={() => props.onOpenReminder(item.id)}><span>{item.title}</span><small>{item.when} · {item.status}</small></button>)}
    </section>)}
    {props.reminderOther > 0 ? <p className="task-note">另有 {props.reminderOther} 条其他定时安排。<button type="button" className="ghost" onClick={props.onOpenSettings}>在设置里查看</button></p> : null}
    {empty || props.remindersError ? <section className="task-template-list" aria-label="为你推荐">
      <h2>为你推荐</h2>
      {SCHEDULE_TEMPLATES.map(template => <div className="task-template" key={template.id}>
        <div className="task-template-copy"><strong>{template.title}</strong><span>{template.blurb}</span></div>
        <button type="button" className="task-template-add" aria-label={`用「${template.title}」开始`} disabled={props.busy} onClick={() => props.onCreate(planTaskCreateHandoff(template.prompt))}><Plus size={16} aria-hidden="true" /></button>
      </div>)}
    </section> : null}
  </>;
}

function WorkTaskThread({ task, now, busy, advanced, onBack, onContinue }: {
  task: WorkTask;
  now: Date;
  busy: boolean;
  advanced: React.ReactNode;
  onBack: () => void;
  onContinue: (handoff: TaskComposerHandoff) => void;
}) {
  const [draft, setDraft] = useState("");
  const title = humanFacingTitle(task.goal, "未命名任务");
  const clock = reminderClock(now);
  const lines = taskProgressLines(task);
  const artifacts = taskArtifactCards(task);
  const status = lines[0] ?? "状态待核对";
  return <section className="task-thread" aria-label={title}>
    <header className="task-thread-heading">
      <button type="button" className="task-back" aria-label="返回任务列表" onClick={onBack}>‹</button>
      <div className="task-thread-copy"><h1>{title}</h1><p className="task-thread-meta">{status} · {taskWhenLabel(task.updatedAt, now, clock)}</p></div>
    </header>
    <div className="task-thread-log">
      {lines.slice(1).map(line => <article className="task-bubble" key={line}><p>{line}</p></article>)}
      {artifacts.map(card => <article className="task-artifact-card" key={card.path}><strong>{card.label}</strong><p><code>{card.path}</code></p></article>)}
    </div>
    <form className="task-thread-compose" onSubmit={event => { event.preventDefault(); onContinue(planTaskContinueHandoff(task, draft)); }}>
      <input aria-label="和 Serika 聊这件任务" placeholder="和 Serika 聊这件任务" value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="submit" disabled={busy}>继续</button>
    </form>
    {advanced ? <details className="task-advanced"><summary>验收与核对</summary>{advanced}</details> : null}
    <details className="technical-id"><summary>编号</summary><code>{task.id}</code></details>
  </section>;
}

function ReminderThread({ row, now, busy, pendingCancel, onBack, onContinue, onCancel, onConfirmCancel, onDismissCancel }: {
  row: ScheduledTaskRow;
  now: Date;
  busy: boolean;
  pendingCancel: ScheduledTaskRow | null;
  onBack: () => void;
  onContinue: (handoff: TaskComposerHandoff) => void;
  onCancel: (row: ScheduledTaskRow) => void;
  onConfirmCancel: () => void;
  onDismissCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const clock = reminderClock(now);
  const when = row.at ? taskWhenLabel(row.at, now, clock) : row.when;
  return <section className="task-thread" aria-label={row.title}>
    <header className="task-thread-heading">
      <button type="button" className="task-back" aria-label="返回定时任务" onClick={onBack}>‹</button>
      <div className="task-thread-copy"><h1>{row.title}</h1><p className="task-thread-meta">{when} · {row.status}</p></div>
    </header>
    <article className="task-bubble"><p>{row.when}</p><p>{row.status}。保存或改期之后才会生效，这不代表已经提醒到你。</p></article>
    {row.canCancel ? <button type="button" className="ghost" disabled={busy} onClick={() => onCancel(row)}>取消提醒…</button> : null}
    {pendingCancel && pendingCancel.id === row.id ? <div className="task-bubble" role="group" aria-label="取消提醒确认">
      <strong>取消「{pendingCancel.title}」？</strong>
      <p>只停止以后的提醒，不会撤回已经弹出的通知，也不会重做已经发生的结果。</p>
      <div className="task-examples">
        <button type="button" disabled={busy} onClick={onConfirmCancel}>确认取消</button>
        <button type="button" disabled={busy} onClick={onDismissCancel}>先不要</button>
      </div>
    </div> : null}
    <form className="task-thread-compose" onSubmit={event => {
      event.preventDefault();
      const text = draft.trim() || `我想调整「${row.title}」。先确认新的时间。确认之前不要说已经改好。`;
      onContinue({ mode: "chat", taskId: null, text, policy: "replace" });
    }}>
      <input aria-label="和 Serika 聊这件提醒" placeholder="和 Serika 聊这件提醒" value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="submit" disabled={busy}>继续</button>
    </form>
    <details className="technical-id"><summary>编号</summary><code>{row.id}</code></details>
  </section>;
}

export function TaskReturnChipView({ label, onContinue }: { label: string; onContinue: () => void }) {
  return <button type="button" className="task-return-chip" onClick={onContinue}>{label}</button>;
}

/** Unread terminal inbox result, shown in the main chat. Viewing it does not acknowledge or rerun. */
export function TaskReturnChip({ enabled, refreshSequence, onContinue }: {
  enabled: boolean;
  refreshSequence: number;
  onContinue: (title: string) => void;
}) {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { setTitle(null); return; }
    const reader = createSavedTaskNoticeReader(window.runloom, task => {
      setTitle(task ? inboxReturnTitle(task) : null);
    }, () => { /* The saved-task banner already reports a read failure. The chip stays hidden. */ });
    const refresh = () => { if (!document.hidden) void reader.refresh(); };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { reader.dispose(); window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [enabled, refreshSequence]);
  if (!title) return null;
  const label = taskReturnLabel(title);
  return <TaskReturnChipView label={label} onContinue={() => onContinue(title)} />;
}

export function TasksHome({
  tasksEnabled, tasks, selected, loading, error, busy, focused, workspaceReady, refreshToken, identity, formRequest,
  onSelect, onCreate, onContinue, onOpenSettings, advancedForm, advancedDetail,
}: {
  tasksEnabled: boolean;
  tasks: readonly WorkTask[];
  selected: WorkTask | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  focused: boolean;
  workspaceReady: boolean;
  refreshToken: number;
  identity: string;
  formRequest: number;
  onSelect: (id: string) => void;
  onCreate: (handoff: TaskComposerHandoff) => void;
  onContinue: (handoff: TaskComposerHandoff) => void;
  onOpenSettings: () => void;
  advancedForm: React.ReactNode;
  advancedDetail: React.ReactNode;
}) {
  const [segment, setSegment] = useState<"tasks" | "scheduled">("tasks");
  const [openedTaskId, setOpenedTaskId] = useState<string | null>(null);
  const [openedReminderId, setOpenedReminderId] = useState<string | null>(null);
  const [reminders, setReminders] = useState<ScheduledTaskRow[]>([]);
  const [reminderOther, setReminderOther] = useState(0);
  const [remindersLoading, setRemindersLoading] = useState(false);
  const [remindersError, setRemindersError] = useState("");
  const [pendingCancel, setPendingCancel] = useState<ScheduledTaskRow | null>(null);
  const [working, setWorking] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const seenForm = useRef(0);
  const generation = useRef(0);
  const context = useRef(identity);
  context.current = identity;
  const focusApplied = useRef(false);
  useEffect(() => {
    if (!focused) { focusApplied.current = false; return; }
    if (!focusApplied.current && selected) { focusApplied.current = true; setOpenedTaskId(selected.id); }
  }, [focused, selected]);
  useEffect(() => {
    if (formRequest > seenForm.current) { seenForm.current = formRequest; setShowForm(true); }
  }, [formRequest]);
  const reload = async () => {
    const request = ++generation.current;
    const captured = context.current;
    if (!workspaceReady) { setReminders([]); setReminderOther(0); setRemindersError(""); setRemindersLoading(false); return; }
    setRemindersLoading(true);
    setRemindersError("");
    try {
      const result = await window.runloom.getAutomationOverview();
      if (captured !== context.current || request !== generation.current) return;
      if (!result.ok) { setReminders([]); setReminderOther(0); setRemindersError("提醒读取失败，不代表没有提醒。"); return; }
      const view = scheduledTaskRows(result.value, reminderClock());
      setReminders(view.rows);
      setReminderOther(view.other);
    } catch {
      if (captured === context.current && request === generation.current) { setReminders([]); setReminderOther(0); setRemindersError("提醒读取失败，不代表没有提醒。"); }
    } finally {
      if (captured === context.current && request === generation.current) setRemindersLoading(false);
    }
  };
  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [workspaceReady, identity, refreshToken]);
  const confirmCancel = async () => {
    if (!pendingCancel || busy || working) return;
    const action: AutomationScheduleAction = { id: pendingCancel.id, kind: pendingCancel.kind === "once" ? "once" : "recurring", action: "cancel" };
    const captured = context.current;
    setWorking(true);
    setRemindersError("");
    try {
      const result = await window.runloom.changeAutomationSchedule(action);
      if (captured !== context.current) return;
      if (!result.ok) setRemindersError("取消结果未确认，请刷新核对；不会自动重试。");
      else { setPendingCancel(null); await reload(); }
    } catch {
      if (captured === context.current) setRemindersError("取消结果未确认，请刷新核对；不会自动重试。");
    } finally {
      if (captured === context.current) setWorking(false);
    }
  };
  const openedTask = openedTaskId && selected?.id === openedTaskId ? selected : null;
  const openingTask = segment === "tasks" && openedTaskId !== null && openedTask === null;
  return showForm ? <div className="personal-tasks">
    <button type="button" className="task-back" onClick={() => setShowForm(false)}>返回任务列表</button>
    {advancedForm}
  </div> : <TasksPage
    tasksEnabled={tasksEnabled} tasks={tasks} openedTask={openedTask} opening={openingTask} loading={loading} error={error} busy={busy || working}
    segment={segment} reminders={reminders} reminderOther={reminderOther} remindersLoading={remindersLoading} remindersError={remindersError}
    openedReminder={reminders.find(row => row.id === openedReminderId) ?? null} pendingCancel={pendingCancel}
    onSegment={next => { setSegment(next); setOpenedTaskId(null); setOpenedReminderId(null); }}
    onOpenTask={id => { setOpenedTaskId(id); onSelect(id); }}
    onOpenReminder={setOpenedReminderId}
    onBack={() => { setOpenedTaskId(null); setOpenedReminderId(null); setPendingCancel(null); }}
    onCreate={onCreate} onContinue={onContinue}
    onCancelReminder={setPendingCancel} onConfirmCancel={() => void confirmCancel()} onDismissCancel={() => setPendingCancel(null)}
    onOpenSettings={onOpenSettings}
    advanced={openedTask ? advancedDetail : null}
  />;
}
