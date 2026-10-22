import { constants } from "node:fs";
import { open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertWorkerPathSafe, writeWorkerFileAtomic } from "./task-worker-service.js";

/** Short-lived hint that the desktop window is frontmost. Not task state. */
export const DESKTOP_FRONTMOST_FILE = "desktop-frontmost.json";
const FRONTMOST_TTL_MS = 8_000;
const FRONTMOST_MAX_AHEAD_MS = 60_000;
const FRONTMOST_MAX_BYTES = 256;

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
