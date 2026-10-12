import { constants } from "node:fs";
import { open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord } from "./task-store.js";
import { assertWorkerPathSafe, writeWorkerFileAtomic } from "./task-worker-service.js";

/** Short-lived hint that the desktop window is frontmost. Not task state. */
export const DESKTOP_FRONTMOST_FILE = ".runloom/desktop-frontmost.json";
const FRONTMOST_TTL_MS = 8_000;
const FRONTMOST_MAX_AHEAD_MS = 60_000;
const FRONTMOST_MAX_BYTES = 256;
const TITLE_MAX_CHARACTERS = 42;

function clipSentence(value: string): string | null {
  const flat = value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const characters = Array.from(flat);
  if (characters.length <= TITLE_MAX_CHARACTERS) return flat;
  return `${characters.slice(0, TITLE_MAX_CHARACTERS - 1).join("")}…`;
}

function completedTitle(task: TaskRecord): string {
  const kind = task.arrangement?.kind;
  if (kind === "reminder") {
    const source = task.resultText?.trim() ? task.resultText : task.prompt;
    return clipSentence(source) ?? "提醒时间到了";
  }
  switch (kind) {
    case "todoist-brief":
      return "Todoist 日报已保存";
    case "rss-digest":
      return "资讯检查已结束";
    case "skill":
      return "定时结果已保存";
    case undefined:
      return "定时结果已保存";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** Lock-screen title is one short sentence. Long results stay in the inbox. */
export function taskNotificationCopy(task: TaskRecord): { title: string; body: string } {
  switch (task.status) {
    case "completed":
      return {
        title: completedTitle(task),
        body: task.arrangement?.kind === "reminder" ? "提醒已到，详情在收件箱。" : "详情在收件箱。",
      };
    case "failed":
      return { title: "这次安排没有完成", body: "详情在收件箱，不会自动重做。" };
    case "interrupted":
      return { title: "安排中断，不会自动重做", body: "请回桌面核对。详情在收件箱。" };
    case "cancelled":
      return { title: "这次安排已取消", body: "详情在收件箱。" };
    case "scheduled":
    case "running":
      return { title: "有一条定时结果", body: "详情在收件箱。" };
    default: {
      const unreachable: never = task.status;
      return unreachable;
    }
  }
}

export async function writeDesktopFrontmost(workspace: string, focused: boolean, now = Date.now()): Promise<void> {
  const path = join(await realpath(workspace), DESKTOP_FRONTMOST_FILE);
  await assertWorkerPathSafe(path);
  if (!focused) {
    await rm(path, { force: true });
    return;
  }
  await writeWorkerFileAtomic(path, `${JSON.stringify({ until: now + FRONTMOST_TTL_MS })}\n`);
}

/** True only for a fresh hint. Missing, stale, or far-future files do not suppress a notification. */
export async function readDesktopFrontmost(workspace: string | undefined, now = Date.now()): Promise<boolean> {
  if (!workspace) return false;
  try {
    const path = join(await realpath(workspace), DESKTOP_FRONTMOST_FILE);
    await assertWorkerPathSafe(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > FRONTMOST_MAX_BYTES) return false;
      const parsed: unknown = JSON.parse(await file.readFile("utf8"));
      const until = typeof parsed === "object" && parsed !== null && "until" in parsed ? parsed.until : undefined;
      return typeof until === "number" && Number.isFinite(until) && until > now && until - now <= FRONTMOST_MAX_AHEAD_MS;
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}
