import { formatLocalTaskTime, MODEL_TIME_ZONE } from "./task-instructions.js";

/** Capture at admission, not when a delayed consolidation happens to run. */
export function userMessageClock(now = new Date()): { sentAt: string; timeZone: string } {
  const timeZone = MODEL_TIME_ZONE;
  return { sentAt: formatLocalTaskTime(now, timeZone), timeZone };
}
