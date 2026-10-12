export const PERSONAL_SPLIT_KEY = "serika:personal-chat-fraction";
export const PERSONAL_SIDEBAR_KEY = "serika:personal-sidebar";
export const PERSONAL_COMPACT_BREAKPOINT = 906;

const DEFAULT_CHAT_FRACTION = 0.5;
const MIN_CHAT_FRACTION = 0.3;
const MAX_CHAT_FRACTION = 0.7;
const RIGHT_OUTER_GAP = 6;
const MIN_CHAT_WIDTH = 420;
const MIN_DASHBOARD_WIDTH = 480;

/** Single-column windows do not consume the saved split preference. */
export function clampChatFraction(width: number, requested: number): number {
  if (!Number.isFinite(width) || width < PERSONAL_COMPACT_BREAKPOINT) return DEFAULT_CHAT_FRACTION;
  const availableWidth = width - RIGHT_OUTER_GAP;
  const minimum = Math.max(MIN_CHAT_FRACTION, MIN_CHAT_WIDTH / availableWidth);
  const maximum = Math.min(MAX_CHAT_FRACTION, 1 - MIN_DASHBOARD_WIDTH / availableWidth);
  const fraction = Number.isFinite(requested) ? requested : DEFAULT_CHAT_FRACTION;
  return Math.max(minimum, Math.min(maximum, fraction));
}

export function loadChatFraction(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_CHAT_FRACTION;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_CHAT_FRACTION;
  return Math.max(MIN_CHAT_FRACTION, Math.min(MAX_CHAT_FRACTION, parsed));
}

/** Missing or unknown values keep the dashboard open. Only an explicit collapse hides it. */
export function loadSidebarOpen(raw: string | null): boolean {
  return raw !== "collapsed";
}

export type PersonalPill = "手札" | "任务" | "记忆" | "serika" | "设置";

/** Top pills are 手札, tasks, memory and the persona. Reminders stay a 手札 destination. */
export function dashboardTabForDetail(detail: string): PersonalPill | null {
  if (detail === "pomodoro") return "手札";
  if (detail === "tasks") return "任务";
  if (detail === "memory") return "记忆";
  if (detail === "persona") return "serika";
  if (detail === "settings" || ["modules", "records", "context", "home"].includes(detail)) return "设置";
  return null;
}
