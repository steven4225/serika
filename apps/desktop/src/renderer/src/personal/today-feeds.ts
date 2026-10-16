import { useEffect, useState } from "react";
import type { AutomationResult } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import type { AutomationOverview } from "@aisdk-agent/example-cli/dist/automation-scheduling.js";
import type { TaskListV3 } from "@aisdk-agent/example-cli/dist/task-store.js";
import type { RssWorkerResponse } from "../../../shared/ui-contract.js";
import { humanFacingTitle } from "../../../shared/human-title.js";
import { createTaskNoticeDismissals } from "../../../shared/saved-task-result.js";
import { localWhen, reminderClock, scheduleStatusLabel } from "../reminder-copy.js";
import { checkingFeeds, hiddenFeeds, type TodayBriefFeeds, type TodayFeedInbox, type TodayFeedReminder } from "./today-brief.js";

function eyebrow(kind: string | undefined): string {
  switch (kind) {
    case "reminder": return "提醒";
    case "todoist-brief": return "日报";
    case "rss-digest": return "资讯";
    case "skill": return "定时";
    default: return "定时";
  }
}

function subject(value: string | null | undefined, fallback: string): string {
  return humanFacingTitle(value, fallback);
}

/** Read-only projection of the existing automation overview. No ids are copied through. */
export function projectReminderFeeds(overview: AutomationOverview, now: Date): TodayFeedReminder[] {
  const clock = reminderClock(now);
  const reminders: TodayFeedReminder[] = [];
  for (const task of overview.scheduled) {
    if (task.status !== "scheduled" && task.status !== "running") continue;
    reminders.push({
      eyebrow: eyebrow(task.arrangement?.kind),
      subject: subject(task.promptPreview, "即将到来的安排"),
      whenLabel: localWhen(task.runAt, clock),
      at: task.runAt,
      status: scheduleStatusLabel(task.status, task.runAt, now, task.arrangement?.kind),
    });
  }
  for (const task of overview.recurring) {
    if (task.status === "cancelled") continue;
    reminders.push({
      eyebrow: eyebrow(task.arrangement?.kind),
      subject: subject(task.promptPreview, "重复安排"),
      whenLabel: task.nextRunAt ? localWhen(task.nextRunAt, clock) : "下次时间未定",
      at: task.nextRunAt,
      status: scheduleStatusLabel(task.status, task.nextRunAt, now, task.arrangement?.kind),
    });
  }
  return reminders;
}

/**
 * Inbox summaries do not carry notification state. Leave it null so a brief
 * cannot describe foreground omission as a submitted notification.
 */
export function projectInboxFeeds(list: TaskListV3, now: Date, isDismissed = (_task: TaskListV3["tasks"][number]) => false): TodayFeedInbox[] {
  return list.tasks.filter(task => task.acknowledgedAt === null && task.status !== "cancelled" && !isDismissed(task)).slice(0, 6).map(task => ({
    eyebrow: eyebrow(task.arrangement?.kind),
    subject: subject(task.resultPreview || task.promptPreview, "定时结果"),
    at: task.finishedAt ?? task.runAt,
    status: scheduleStatusLabel(task.status, task.runAt, now, task.arrangement?.kind),
    attention: task.status === "failed" || task.status === "interrupted",
    notification: null,
  }));
}

export interface TodayFeedApi {
  getAutomationOverview?: () => Promise<AutomationResult<AutomationOverview>>;
  getTaskInbox?: () => Promise<AutomationResult<TaskListV3>>;
  rssWorkerStatus?: () => Promise<RssWorkerResponse>;
}

function optional<T>(load: (() => Promise<T>) | undefined): Promise<T | null> {
  if (!load) return Promise.resolve(null);
  return load().catch(() => null);
}

export async function loadTodayBriefFeeds(api: TodayFeedApi, now = new Date(), isDismissed?: (task: TaskListV3["tasks"][number]) => boolean): Promise<TodayBriefFeeds> {
  const [overview, inbox, worker] = await Promise.all([
    optional(api.getAutomationOverview),
    optional(api.getTaskInbox),
    optional(api.rssWorkerStatus),
  ]);
  const reminders = overview?.ok ? projectReminderFeeds(overview.value, now) : [];
  const inboxItems = inbox?.ok ? projectInboxFeeds(inbox.value, now, isDismissed) : [];
  const workerValue: RssWorkerResponse | null = worker ?? (api.rssWorkerStatus ? { ok: false, message: "" } : null);
  return {
    reminders,
    remindersState: overview?.ok ? "ready" : "failed",
    inbox: inboxItems,
    inboxState: inbox?.ok ? "ready" : "failed",
    worker: workerValue,
    workerState: "ready",
  };
}

export function useTodayBriefFeeds(enabled: boolean, refreshToken: number, workspaceRoot?: string | null): TodayBriefFeeds {
  const [feeds, setFeeds] = useState<TodayBriefFeeds>(enabled ? checkingFeeds : hiddenFeeds);
  useEffect(() => {
    if (!enabled) {
      setFeeds(hiddenFeeds);
      return;
    }
    let active = true;
    setFeeds(checkingFeeds);
    const api = typeof window === "undefined" ? {} : window.runloom;
    const dismissals = workspaceRoot ? createTaskNoticeDismissals({
      getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value),
    }, workspaceRoot) : null;
    void loadTodayBriefFeeds(api, new Date(), dismissals?.has).then(next => { if (active) setFeeds(next); });
    return () => { active = false; };
  }, [enabled, refreshToken, workspaceRoot]);
  return feeds;
}
