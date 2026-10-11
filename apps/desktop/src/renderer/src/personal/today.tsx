import React, { useEffect, useState } from "react";
import { ArrowUpRight, Bell, ChevronRight, Timer } from "lucide-react";
import type { AppInfo } from "../../../shared/ui-contract.js";
import type { WorkTask } from "../../../shared/work-tasks.js";
import { todayClock, todayMemorySummary, todayTaskSummary } from "./today-data.js";

export interface TodayPanelProps {
  info: AppInfo | null;
  tasks: readonly WorkTask[];
  tasksLoading: boolean;
  tasksError: string | null;
  pendingMemory: number;
  pendingMemoryError: string | null;
  onTasks: () => void;
  onMemory: () => void;
  onChat: () => void;
  onPomodoro: () => void;
  onAutomation: () => void;
}

export function TodayPanel(props: TodayPanelProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const clock = todayClock(now);
  const tasks = todayTaskSummary(props.info, props.tasks, props.tasksLoading, props.tasksError);
  return <div className="personal-today">
    <header className="today-welcome">
      <time className="today-clock" dateTime={now.toISOString()}>{clock.time} · 上海时间</time>
      <h1>欢迎回来</h1>
    </header>

    <section className="today-card today-greeting" aria-labelledby="today-greeting-title">
      <p className="today-date">{clock.date}</p>
      <h2 id="today-greeting-title">{clock.greeting}</h2>
      <p>把想做的事交给 Serika。<br />任务、记忆和提醒，都在这里。</p>
    </section>

    <section className="today-card today-tasks" aria-labelledby="today-tasks-title">
      <div className="today-card-heading">
        <h2 id="today-tasks-title">当前任务</h2>
        {props.info?.workTasks ? <button type="button" className="today-icon-link" onClick={props.onTasks} aria-label="查看当前会话的工作任务"><ArrowUpRight size={18} aria-hidden="true" /></button> : null}
      </div>
      {tasks.state === "ready" ? <>
        <div className="today-task-counts" aria-label="当前会话已加载任务的状态">
          <div><span>进行中</span><strong>{tasks.ongoing}</strong><small>待开始或继续</small></div>
          <div><span>待决定</span><strong>{tasks.awaiting}</strong><small>核对或验收</small></div>
          <div><span>已验收</span><strong>{tasks.completed}</strong><small>验收已通过</small></div>
        </div>
        <p className="today-scope-note">仅当前会话已加载的任务，不含其他会话。</p>
        {tasks.current ? <button type="button" className="today-current-task" onClick={props.onTasks}>
          <span><small>{tasks.currentStatus}</small><strong>{tasks.current.goal}</strong></span>
          <ChevronRight size={18} aria-hidden="true" />
        </button> : <p className="today-task-empty">{props.tasks.length ? "当前没有待推进的任务。" : "还没有工作任务。普通对话照常使用，需要执行并验收时再创建任务。"}</p>}
      </> : <p className={`today-task-message${tasks.state === "failed" ? " today-failure" : ""}`} role={tasks.state === "failed" ? "alert" : undefined}>{tasks.message}</p>}
      <button type="button" className="today-chat-button" onClick={props.onChat}>聊聊下一步</button>
    </section>

    <section className="today-memory" aria-labelledby="today-memory-title">
      <div className="today-card-heading"><h2 id="today-memory-title">记忆</h2><button type="button" className="today-text-link" onClick={props.onMemory}>查看<ChevronRight size={15} aria-hidden="true" /></button></div>
      <p className={props.pendingMemoryError && props.info?.memory.enabled ? "today-failure" : undefined}>{todayMemorySummary(props.info, props.pendingMemory, props.pendingMemoryError)}</p>
    </section>

    <div className="today-routines">
      <button type="button" onClick={props.onPomodoro}><Timer size={19} aria-hidden="true" /><span><strong>留一段专注时间</strong><small>打开番茄钟</small></span><ChevronRight size={15} aria-hidden="true" /></button>
      <button type="button" onClick={props.onAutomation}><Bell size={19} aria-hidden="true" /><span><strong>别让小事被忘记</strong><small>查看提醒与定时任务</small></span><ChevronRight size={15} aria-hidden="true" /></button>
    </div>
  </div>;
}
