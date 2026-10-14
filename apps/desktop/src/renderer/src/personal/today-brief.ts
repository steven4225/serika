import type { AppInfo, RssWorkerResponse } from "../../../shared/ui-contract.js";
import type { WorkTask } from "../../../shared/work-tasks.js";
import { humanFacingTitle } from "../../../shared/human-title.js";
import { selectCurrentTask, taskStatusLabels } from "../work-task-data.js";
import { todayTaskSummary } from "./today-data.js";

/**
 * Today brief is a projection of tasks, reminders, inbox results and worker
 * status the desktop already loaded. It does not schedule a brief or start a run.
 */

export const BRIEF_SUMMARY_LIMIT = 3;
const TIME_ZONE = "Asia/Shanghai";
const ACTIVE = new Set<WorkTask["status"]>(["ready", "running", "paused"]);
const DIRECTION = new Set<WorkTask["status"]>(["needs_review", "awaiting_acceptance"]);

export type BriefPeriod = "morning" | "evening";
export type BriefName = "晨间简报" | "晚间简报";
export type FeedState = "hidden" | "loading" | "ready" | "failed";
export type InboxNotification = "pending" | "submitted" | "failed" | "omitted";

export interface BriefContinueTarget {
  kind: "task" | "thread";
  threadId: string;
  taskId: string | null;
  /** Arms the existing task composer. It does not start a run. */
  compose: boolean;
  draft: string;
}

export interface BriefAction {
  label: string;
  tone: "primary" | "secondary" | "direction";
  target: BriefContinueTarget;
}

export type BriefBody =
  | { kind: "kpis"; lead: string | null; cells: { label: string; value: string; note: string }[]; notes: string[] }
  | { kind: "groups"; groups: { title: string; lines: string[] }[]; more: string | null }
  | { kind: "quote"; note: string | null; text: string }
  | { kind: "text"; text: string };

export interface BriefCard {
  key: string;
  eyebrow: string;
  title: string;
  at: string;
  body: BriefBody;
  risk: string | null;
  actions: BriefAction[];
}

export interface BriefSection {
  key: string;
  dayKey: string;
  period: BriefPeriod;
  when: string;
  name: BriefName;
  cards: BriefCard[];
}

export interface TodayStatusCard {
  eyebrow: string;
  title: string;
  body: string;
  risk: string | null;
  action: BriefAction | null;
}

export interface TodayBriefModel {
  mode: "connecting" | "reading" | "empty" | "stream";
  message: string | null;
  next: { when: string; name: BriefName } | null;
  status: TodayStatusCard | null;
  sections: BriefSection[];
  footer: string | null;
  /** Shown only in the empty brief, when this session has no work tasks. */
  emptyLead: string | null;
}

export interface TodayFeedReminder {
  eyebrow: string;
  subject: string;
  whenLabel: string;
  at: string | null;
  status: string;
}

export interface TodayFeedInbox {
  eyebrow: string;
  subject: string;
  at: string;
  status: string;
  attention: boolean;
  notification: InboxNotification | null;
}

export interface TodayBriefFeeds {
  reminders: readonly TodayFeedReminder[];
  remindersState: FeedState;
  inbox: readonly TodayFeedInbox[];
  inboxState: FeedState;
  worker: RssWorkerResponse | null;
  workerState: "hidden" | "checking" | "ready";
}

export interface TodayBriefInput {
  now: Date;
  info: AppInfo | null;
  tasks: readonly WorkTask[];
  tasksLoading: boolean;
  tasksError: string | null;
  pendingMemory: number;
  pendingMemoryError: string | null;
  feeds: TodayBriefFeeds;
}

export const hiddenFeeds: TodayBriefFeeds = {
  reminders: [], remindersState: "hidden", inbox: [], inboxState: "hidden", worker: null, workerState: "hidden",
};

export const checkingFeeds: TodayBriefFeeds = {
  reminders: [], remindersState: "loading", inbox: [], inboxState: "loading", worker: null, workerState: "checking",
};

const ORDINARY_CHAT = "普通对话照常使用，需要执行并验收时再创建任务。";

export function visibleBriefCards(cards: readonly BriefCard[], expanded: boolean): readonly BriefCard[] {
  if (expanded || cards.length <= BRIEF_SUMMARY_LIMIT) return cards;
  return cards.slice(0, BRIEF_SUMMARY_LIMIT);
}

/** Foreground omission and system submission stay different sentences. */
export function inboxNotificationNote(status: InboxNotification | null): string | null {
  switch (status) {
    case "omitted": return "当时窗口在前台，没有向系统提交通知。";
    case "submitted": return "已提交系统通知，不代表你已经看到。";
    case "failed": return "系统通知没有提交成功。";
    case "pending": return "系统通知还在等待提交。";
    case null: return null;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

export function nextBriefSlot(now: Date): { when: string; name: BriefName } {
  const hour = shanghaiParts(now).hour;
  if (hour < 8) return { when: "今天 8:00", name: "晨间简报" };
  if (hour < 20) return { when: "今天 20:00", name: "晚间简报" };
  return { when: "明天 8:00", name: "晨间简报" };
}

interface ShanghaiParts { hour: number; dayKey: string; stamp: string }

function shanghaiParts(date: Date): ShanghaiParts {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(date));
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const stamp = new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return { hour, dayKey, stamp };
}

function periodOf(hour: number): BriefPeriod {
  return hour < 12 ? "morning" : "evening";
}

function humanError(value: string | null | undefined, fallback: string): string {
  const cleaned = humanFacingTitle(value, "")
    .replace(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:：,，._\-#/]+|[\s:：,，._\-#/]+$/g, "")
    .trim();
  return cleaned || fallback;
}

function clip(value: string, max = 72): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : value;
}

function titleOf(value: string | null | undefined, fallback: string): string {
  return clip(humanFacingTitle(value, fallback));
}

interface Bucket { dayKey: string; period: BriefPeriod }

function bucketFor(at: Date, now: Date): Bucket | null {
  const item = shanghaiParts(at);
  const today = shanghaiParts(now);
  const yesterday = shanghaiParts(new Date(now.getTime() - 86_400_000));
  if (item.dayKey === today.dayKey || item.dayKey === yesterday.dayKey) return { dayKey: item.dayKey, period: periodOf(item.hour) };
  if (at.getTime() > now.getTime()) return { dayKey: today.dayKey, period: periodOf(item.hour) };
  return null;
}

function taskTarget(task: WorkTask, compose: boolean, draft: string): BriefContinueTarget {
  return { kind: "task", threadId: task.threadId, taskId: task.id, compose, draft };
}

function threadTarget(threadId: string, draft: string): BriefContinueTarget {
  return { kind: "thread", threadId, taskId: null, compose: false, draft };
}

function workerAttention(worker: RssWorkerResponse | null, state: TodayBriefFeeds["workerState"]): { attention: boolean; known: boolean; title: string; body: string; risk: string | null; draft: string } | null {
  const issue = (raw: string | undefined, fallback: string) => {
    const message = humanError(raw, fallback).replace(/\bpid\s*[:=]?\s*\d+\b/gi, "").trim();
    return /[\u4e00-\u9fff]/.test(message) ? message : fallback;
  };
  if (state === "hidden") return null;
  if (state === "checking") {
    return { attention: false, known: false, title: "正在查看后台", body: "还在确认关窗口之后提醒能不能执行。", risk: null, draft: "我想先确认后台提醒现在能不能依赖。" };
  }
  if (worker === null || !worker.ok) return { attention: true, known: true, title: "后台状态读取失败", body: worker && !worker.ok ? issue(worker.message, "请在设置 → 通知中刷新后台状态；读取失败不代表服务已停止。") : "尚未读到后台状态，请在设置 → 通知中刷新。", risk: "暂不能确认是否会到点执行；不要重复创建提醒。", draft: "请帮我核对后台状态读取失败的原因，不重复创建提醒。" };
  if (worker.setupReady === false) return { attention: true, known: true, title: "后台配置未就绪", body: issue(worker.configurationMessage, "后台配置与当前工作区不一致，请在设置 → 通知中核对。"), risk: "暂不能依赖到点提醒。", draft: "请帮我核对后台配置，不重复创建提醒。" };
  if (!worker.registered) {
    return { attention: true, known: true, title: "后台提醒还没开启", body: "关窗口之后不会执行提醒。安排可以先保存，但不会自己开始执行。", risk: null, draft: "后台提醒现在还没开启。先别把到点提醒当成已经会执行。" };
  }
  if (!worker.running) {
    return { attention: true, known: true, title: "后台已登记，但现在没在运行", body: "暂时不能依赖到点提醒。", risk: "到点不能保证执行。", draft: "后台提醒现在没在运行。先别把到点提醒当成已经会执行。" };
  }
  if (worker.notifyEnabled !== true) {
    return { attention: true, known: true, title: "后台在运行，通知还没确认", body: "进程在，不代表系统通知已经准备好，也不代表你已经收到。", risk: null, draft: "后台在运行，但通知还没确认。先别当成我已经收到提醒。" };
  }
  if (worker.notificationRoutingEnabled !== true) {
    return { attention: true, known: true, title: "后台在运行，点通知还没接上", body: "就算系统通知弹出来，点击也不会打开结果。", risk: null, draft: "后台提醒的通知点击还没接上。先别当成点开会回到结果。" };
  }
  return { attention: false, known: true, title: "后台提醒可用", body: "已配置系统通知。提交了通知也不代表你已经看到。", risk: null, draft: "我想确认后台提醒现在是可用的，但提交通知不等于我已经看到。" };
}

export function buildTodayBrief(input: TodayBriefInput): TodayBriefModel {
  const footer = ORDINARY_CHAT;
  const emptyLead = input.info?.workTasks && input.tasks.length === 0 && !input.tasksError ? "还没有工作任务。" : null;
  if (!input.info) return { mode: "connecting", message: "正在连接工作区…", next: null, status: null, sections: [], footer: null, emptyLead: null };
  if (input.tasksLoading) return { mode: "reading", message: "正在读取当前会话的任务…", next: null, status: null, sections: [], footer, emptyLead: null };
  const feedsPending = input.feeds.remindersState === "loading" || input.feeds.inboxState === "loading" || input.feeds.workerState === "checking";
  const threadId = input.info.threadId;
  const cards: { bucket: Bucket; rank: number; card: BriefCard }[] = [];
  let sequence = 0;
  const push = (at: Date, rank: number, card: Omit<BriefCard, "key" | "at">, keepCurrent = false) => {
    const bucket = bucketFor(at, input.now) ?? (keepCurrent ? { dayKey: shanghaiParts(input.now).dayKey, period: periodOf(shanghaiParts(input.now).hour) } : null);
    if (!bucket) return;
    cards.push({ bucket, rank, card: { ...card, key: `card-${sequence++}`, at: at.toISOString() } });
  };

  const summary = todayTaskSummary(input.info, input.tasks, false, input.tasksError);
  if (summary.state === "disabled") {
    push(input.now, 5, { eyebrow: "任务", title: "工作任务未启用", body: { kind: "text", text: summary.message }, risk: null, actions: threadId ? [{ label: "聊聊这个", tone: "primary", target: threadTarget(threadId, "工作任务还没启用。我们用普通对话继续，先不创建任务。") }] : [] }, true);
  } else if (summary.state === "failed") {
    push(input.now, 5, { eyebrow: "任务", title: "任务暂时读不出来", body: { kind: "text", text: humanError(summary.message, "任务读取失败。这不代表没有任务。") }, risk: "读取失败不代表没有任务。", actions: [] }, true);
  } else if (summary.state === "ready") {
    const active = input.tasks.filter(task => ACTIVE.has(task.status));
    const directed = input.tasks.filter(task => DIRECTION.has(task.status));
    const primary = selectCurrentTask(active);
    const newest = [...active, ...directed].map(task => Date.parse(task.updatedAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const at = newest === undefined ? input.now : new Date(newest);
    const notes = ["仅当前会话已加载的任务，不含其他会话。"];
    if (!primary && directed.length === 0) notes.unshift("当前没有待推进的任务。");
    else if (active.length > 1) notes.push(`另有 ${active.length - 1} 件也在进行。`);
    const actions: BriefAction[] = [];
    if (primary) {
      const name = titleOf(primary.goal, "当前任务");
      const compose = primary.status === "ready" || primary.status === "paused";
      actions.push(
        { label: "查看进度", tone: "primary", target: taskTarget(primary, compose, "") },
        { label: "聊聊这个", tone: "secondary", target: threadTarget(primary.threadId, `我想接着聊「${name}」。`) },
      );
    } else if (threadId && directed.length === 0 && input.tasks.length > 0) {
      const latest = [...input.tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
      if (latest) actions.push({ label: "聊聊这个", tone: "primary", target: threadTarget(latest.threadId, `我想接着看「${titleOf(latest.goal, "这件任务")}」。`) });
    }
    if (input.tasks.length > 0) {
      push(at, 1, {
        eyebrow: "当前任务",
        title: titleOf(primary?.goal ?? directed[0]?.goal ?? input.tasks[0]?.goal, "当前任务"),
        body: {
          kind: "kpis",
          lead: primary ? taskStatusLabels[primary.status] : null,
          cells: [
            { label: "进行中", value: String(summary.ongoing), note: "待开始或继续" },
            { label: "待决定", value: String(summary.awaiting), note: "核对或验收" },
            { label: "已验收", value: String(summary.completed), note: "验收已通过" },
          ],
          notes,
        },
        risk: directed.some(task => task.status === "needs_review") ? "有执行效果还没核对，不会自动重做。" : null,
        actions,
      }, true);
    }
    for (const task of directed) {
      const name = titleOf(task.goal, "有一件事等你定方向");
      const review = task.status === "needs_review";
      push(new Date(task.updatedAt), 0, {
        eyebrow: "待确认",
        title: name,
        body: {
          kind: "quote",
          note: taskStatusLabels[task.status],
          text: review ? "执行效果还不确定。你想先核对，还是先把情况讲清楚？" : "交付在等你定方向。选一条只会打开对话。",
        },
        risk: review ? "执行效果还没核对，不会自动重做。" : "选一个方向不会自动通过，也不会自动退回。",
        actions: review ? [
          { label: "先核对效果", tone: "direction", target: taskTarget(task, false, "先核对这件任务里还不确定的执行效果。不要自动重做，也不要当成已经成功。") },
          { label: "先讲情况", tone: "direction", target: taskTarget(task, false, "先把这件任务现在的情况讲清楚。先不要继续执行。") },
        ] : [
          { label: "按交付看", tone: "direction", target: taskTarget(task, false, "按这次交付来看这件任务。先不要自动验收。") },
          { label: "退回再改", tone: "direction", target: taskTarget(task, false, "这件任务先退回再改。先不要当成已经验收。") },
        ],
      }, true);
    }
  }

  if (input.feeds.remindersState === "failed") {
    push(input.now, 4, { eyebrow: "提醒", title: "提醒暂时读不出来", body: { kind: "text", text: "读取失败不代表没有提醒。" }, risk: "不要据此判断没有提醒，也不要重复创建。", actions: [] }, true);
  }
  const remindersByBucket = new Map<string, TodayFeedReminder[]>();
  for (const reminder of input.feeds.reminders) {
    if (reminder.status === "已取消") continue;
    const at = reminder.at && Number.isFinite(Date.parse(reminder.at)) ? new Date(reminder.at) : input.now;
    const urgent = /已到点|失败|中断/.test(reminder.status);
    const bucket = bucketFor(at, input.now) ?? (urgent ? { dayKey: shanghaiParts(input.now).dayKey, period: periodOf(shanghaiParts(input.now).hour) } : null);
    if (!bucket) continue;
    const key = `${bucket.dayKey}:${bucket.period}`;
    const list = remindersByBucket.get(key) ?? [];
    list.push(reminder);
    remindersByBucket.set(key, list);
  }
  for (const [key, list] of remindersByBucket) {
    const [dayKey, period] = key.split(":") as [string, BriefPeriod];
    const shown = list.slice(0, BRIEF_SUMMARY_LIMIT);
    const dated = list.map(item => item.at && Number.isFinite(Date.parse(item.at)) ? Date.parse(item.at) : input.now.getTime());
    const at = new Date(Math.max(...dated));
    const attention = list.some(item => /已到点|失败|中断/.test(item.status));
    cards.push({
      bucket: { dayKey, period },
      rank: 2,
      card: {
        key: `card-${sequence++}`,
        at: at.toISOString(),
        eyebrow: shown[0]?.eyebrow ?? "提醒",
        title: titleOf(shown[0]?.subject, "即将到来的安排"),
        body: {
          kind: "groups",
          groups: [{ title: "安排", lines: shown.map(item => `${titleOf(item.subject, "安排")} · ${item.whenLabel} · ${item.status}`) }],
          more: list.length > shown.length ? `还有 ${list.length - shown.length} 条，打开对话可以一起看。` : null,
        },
        risk: attention ? "有安排到点后还没有可靠结果。这不代表已经提醒到你。" : null,
        actions: threadId ? [{ label: "聊聊这个", tone: "primary", target: threadTarget(threadId, `我想接着看「${titleOf(shown[0]?.subject, "这条安排")}」。先别重复创建。`) }] : [],
      },
    });
  }

  if (input.feeds.inboxState === "failed") {
    push(input.now, 4, { eyebrow: "定时结果", title: "定时结果暂时读不出来", body: { kind: "text", text: "读取失败不代表没有结果，也不会当成已经成功。" }, risk: null, actions: [] }, true);
  }
  for (const item of input.feeds.inbox) {
    const at = Number.isFinite(Date.parse(item.at)) ? new Date(item.at) : input.now;
    const name = titleOf(item.subject, "定时结果");
    const note = inboxNotificationNote(item.notification);
    push(at, 3, {
      eyebrow: item.eyebrow || "定时结果",
      title: name,
      body: { kind: "text", text: [item.status, note].filter(Boolean).join(" ") },
      risk: item.attention ? "这次没有完成，不会自动重做。" : null,
      actions: threadId ? [{ label: "聊聊这个", tone: "primary", target: threadTarget(threadId, `我想接着看「${name}」的结果。先别把它当成已经送达。`) }] : [],
    });
  }

  if (input.pendingMemoryError) {
    push(input.now, 4, { eyebrow: "记忆", title: "记忆状态暂时看不清", body: { kind: "text", text: humanError(input.pendingMemoryError, "记忆状态读取失败。不能据此判断没有待确认的记忆。") }, risk: "不能据此判断没有待确认的记忆。", actions: [] }, true);
  } else if (input.pendingMemory > 0) {
    push(input.now, 4, {
      eyebrow: "记忆",
      title: "有记忆等你确认",
      body: { kind: "quote", note: null, text: `当前会话有 ${input.pendingMemory} 条记忆等你确认。` },
      risk: "确认之前不会写成正式记忆。",
      actions: [], // Explicit review belongs to the host card, never a model chat.
    }, true);
  }

  if (feedsPending && cards.length === 0 && summary.state !== "failed" && summary.state !== "disabled") {
    return { mode: "reading", message: "正在准备今天的简报…", next: null, status: null, sections: [], footer, emptyLead: null };
  }

  const grouped = new Map<string, { bucket: Bucket; cards: { rank: number; at: string; card: BriefCard }[] }>();
  for (const item of cards) {
    const key = `${item.bucket.dayKey}:${item.bucket.period}`;
    const group = grouped.get(key) ?? { bucket: item.bucket, cards: [] };
    group.cards.push({ rank: item.rank, at: item.card.at, card: item.card });
    grouped.set(key, group);
  }
  const yesterdayKey = shanghaiParts(new Date(input.now.getTime() - 86_400_000)).dayKey;
  const sections: BriefSection[] = [...grouped.values()].map(group => {
    const ordered = group.cards.slice().sort((a, b) => a.rank - b.rank || Date.parse(b.at) - Date.parse(a.at));
    const latest = ordered.map(item => Date.parse(item.at)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? input.now.getTime();
    const stamp = shanghaiParts(new Date(latest)).stamp;
    const when = group.bucket.dayKey === yesterdayKey ? `昨天 ${stamp}` : stamp;
    const name: BriefName = group.bucket.period === "morning" ? "晨间简报" : "晚间简报";
    return {
      key: `${group.bucket.dayKey}:${group.bucket.period}`,
      dayKey: group.bucket.dayKey,
      period: group.bucket.period,
      when,
      name,
      cards: ordered.map(item => item.card),
    };
  }).sort((a, b) => {
    const day = b.dayKey.localeCompare(a.dayKey);
    if (day !== 0) return day;
    return a.period === b.period ? 0 : a.period === "evening" ? -1 : 1;
  });

  const worker = workerAttention(input.feeds.worker, input.feeds.workerState);
  const statusAction = (draft: string): BriefAction | null => threadId ? { label: "聊聊这个", tone: "primary", target: threadTarget(threadId, draft) } : null;
  let status: TodayStatusCard | null = null;
  if (input.info.runtimeRecovery) {
    status = { eyebrow: "连接", title: "助手连接已停止", body: "修正配置后重新连接。不会重做旧任务，也不会把没完成的事说成已经成功。", risk: "不会自动重试。", action: statusAction("助手连接停了。先别把没做完的事当成已经成功。") };
  } else if (!input.info.workspaceRoot && sections.length === 0) {
    status = { eyebrow: "连接", title: "还没有工作区", body: "对话仍然可以使用。提醒和定时结果要有工作区之后才会出现在简报里。", risk: null, action: statusAction("还没有工作区。我们先用对话继续。") };
  } else if (worker && (worker.attention || sections.length === 0) && worker.known) {
    status = { eyebrow: "后台", title: worker.title, body: worker.body, risk: worker.risk, action: statusAction(worker.draft) };
  }

  if (sections.length === 0) {
    return { mode: "empty", message: null, next: nextBriefSlot(input.now), status, sections: [], footer, emptyLead };
  }
  return { mode: "stream", message: null, next: null, status, sections, footer, emptyLead: null };
}
