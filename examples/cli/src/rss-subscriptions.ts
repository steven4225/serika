import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { acquireFlock } from "./flock.js";
import { assertWorkerPathSafe, writeWorkerFileAtomic } from "./task-worker-service.js";
import { validatePublicWebUrl } from "./web-fetch.js";
import type { FeedItem } from "./feed-read.js";
import { createTaskStore, RSS_DIGEST_TASK_PROMPT, type TaskStore } from "./task-store.js";
import type { Recurrence } from "./recurrence.js";

export const RSS_TASK_PROMPT = RSS_DIGEST_TASK_PROMPT;
const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(100),
  url: z.string().max(2048).refine(v => validatePublicWebUrl(v) !== null),
  enabled: z.boolean(), initialized: z.boolean(), seen: z.array(keySchema).max(4096),
}).strict();
const batchSchema = z.object({
  taskId: z.string().min(1), prompt: z.string().max(20000), manifest: z.string().max(100000), hasItems: z.boolean(),
  hasErrors: z.boolean().optional(),
  commits: z.array(z.object({ sourceId: z.string().uuid(), url: z.string(), keys: z.array(keySchema).max(20) }).strict()).max(8),
}).strict();
const documentSchema = z.object({
  version: z.literal(1), revision: z.number().int().positive(),
  sources: z.array(sourceSchema).max(8),
  scheduleId: z.string().min(1).nullable(), enabled: z.boolean(),
  pending: batchSchema.nullable(),
}).strict().superRefine((d, ctx) => {
  if (new Set(d.sources.map(s => s.id)).size !== d.sources.length ||
      new Set(d.sources.map(s => s.url)).size !== d.sources.length ||
      d.sources.some(s => new Set(s.seen).size !== s.seen.length) ||
      (d.enabled && d.scheduleId === null)) ctx.addIssue({ code: "custom", message: "Invalid subscription identities or schedule" });
});
export type RssDocument = z.infer<typeof documentSchema>;
export type RssBatch = z.infer<typeof batchSchema>;
export type RssView = {
  revision: number; enabled: boolean; scheduleId: string | null;
  schedule?: { recurrence: Recurrence; status: string; nextRunAt: string | null };
  sources: { id: string; name: string; url: string; enabled: boolean; initialized: boolean; seenCount: number }[];
};
export type RssResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export type RssInbox = { truncated: boolean; tasks: { id: string; status: string; finishedAt: string | null; text: string; textTruncated: boolean }[] };
export type RssAction =
  | { action: "add"; expectedRevision: number; name: string; url: string }
  | { action: "source-enabled"; expectedRevision: number; id: string; enabled: boolean }
  | { action: "remove"; expectedRevision: number; id: string }
  | { action: "schedule"; expectedRevision: number; recurrence: Recurrence }
  | { action: "enabled"; expectedRevision: number; enabled: boolean };
const revision = z.number().int().positive();
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), expectedRevision: revision, name: sourceSchema.shape.name, url: sourceSchema.shape.url }).strict(),
  z.object({ action: z.literal("source-enabled"), expectedRevision: revision, id: z.string().uuid(), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("remove"), expectedRevision: revision, id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("schedule"), expectedRevision: revision, recurrence: z.unknown() }).strict(),
  z.object({ action: z.literal("enabled"), expectedRevision: revision, enabled: z.boolean() }).strict(),
]);
export class RssError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function rssFailure(error: unknown): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: error instanceof RssError ? error.code : "RSS_STORE_FAILED", message: error instanceof Error ? error.message : String(error) } };
}
export function rssItemKey(item: FeedItem): string {
  // Source-scoped, stable identity. Same-ID edits are not a new article.
  return createHash("sha256").update(item.id ? `id:${item.id}` : item.url ? `url:${item.url}` : `fallback:${item.title}\n${item.publishedAt ?? ""}`).digest("hex");
}
function view(d: RssDocument): RssView {
  return { revision: d.revision, enabled: d.enabled, scheduleId: d.scheduleId,
    sources: d.sources.map(({ seen, ...s }) => ({ ...s, seenCount: seen.length })) };
}

export function createRssSubscriptionStore(workspace: string) {
  const path = join(workspace, ".runloom/rss.json");
  const lockPath = path + ".lock";
  async function read(): Promise<RssDocument> {
    await assertWorkerPathSafe(path);
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 1, sources: [], enabled: false, scheduleId: null, pending: null };
      throw e;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new RssError("RSS_FILE_INVALID", "RSS store must be a regular file <= 1 MiB");
      const parsed = documentSchema.safeParse(JSON.parse(await file.readFile("utf8")));
      if (!parsed.success) throw new RssError("RSS_FILE_INVALID", "Invalid RSS subscription document");
      return parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) throw new RssError("RSS_FILE_INVALID", "Invalid RSS JSON");
      throw error;
    } finally { await file.close(); }
  }
  async function mutate<T>(fn: (d: RssDocument) => Promise<T> | T): Promise<T> {
    await assertWorkerPathSafe(lockPath);
    const lock = await acquireFlock(lockPath);
    try {
      const d = await read();
      const result = await fn(d);
      d.revision++;
      documentSchema.parse(d);
      const text = JSON.stringify(d, null, 2) + "\n";
      if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new RssError("RSS_CAPACITY", "RSS document exceeds 1 MiB; no dedupe keys discarded");
      await writeWorkerFileAtomic(path, text);
      return result;
    } finally { await lock.release(); }
  }
  return {
    read,
    async get(tasks: TaskStore = createTaskStore(workspace)): Promise<RssResult<RssView>> {
      try {
        const d = await read();
        const result = view(d);
        if (d.scheduleId) {
          const detail = await tasks.getRecurring(d.scheduleId);
          if (!detail.ok) return detail;
          const s = detail.value.recurringTask;
          result.schedule = { recurrence: s.recurrence, status: s.status, nextRunAt: s.nextRunAt };
        }
        return { ok: true, value: result };
      } catch (e) { return rssFailure(e); }
    },
    async update(input: RssAction, tasks: TaskStore = createTaskStore(workspace)): Promise<RssResult<RssView>> {
      try {
        const parsed = actionSchema.safeParse(input);
        if (!parsed.success) throw new RssError("INVALID_INPUT", "Invalid RSS action");
        const action = parsed.data;
        await mutate(async d => {
          if (d.revision !== action.expectedRevision) throw new RssError("RSS_CONFLICT", "Subscriptions changed; reload before confirming");
          if (action.action === "add") {
            const url = validatePublicWebUrl(action.url)!;
            if (d.sources.length >= 8 || d.sources.some(s => s.url === url)) throw new RssError("INVALID_INPUT", "At most 8 distinct sources are allowed");
            d.sources.push({ id: randomUUID(), name: action.name, url, enabled: true, initialized: false, seen: [] });
          } else if (action.action === "source-enabled" || action.action === "remove") {
            const source = d.sources.find(s => s.id === action.id);
            if (!source) throw new RssError("RSS_NOT_FOUND", "Subscription not found");
            if (action.action === "remove") d.sources = d.sources.filter(s => s.id !== action.id);
            else source.enabled = action.enabled;
          } else if (action.action === "schedule") {
            if (d.scheduleId !== null) throw new RssError("INVALID_INPUT", "A schedule already exists; pause/resume it instead");
            if (!d.sources.some(s => s.enabled)) throw new RssError("INVALID_INPUT", "Add an enabled subscription first");
            const created = await tasks.createRecurring({ prompt: RSS_TASK_PROMPT, recurrence: action.recurrence as Recurrence,
              arrangement: { kind: "rss-digest", source: "existing-rss-binding", notification: "new-items", declarationVersion: 1 } });
            if (!created.ok) throw new RssError(created.error.code, created.error.message);
            d.scheduleId = created.value.id;
            d.enabled = true;
          } else {
            if (!d.scheduleId) throw new RssError("INVALID_INPUT", "Create a schedule first");
            // Revocation is stored below; the worker rechecks before each fetch.
            const changed = action.enabled ? await tasks.resumeRecurring(d.scheduleId) : await tasks.pauseRecurring(d.scheduleId);
            if (!changed.ok) throw new RssError(changed.error.code, changed.error.message);
            d.enabled = action.enabled;
          }
        });
        return this.get(tasks);
      } catch (e) { return rssFailure(e); }
    },
    async stage(batch: RssBatch, expectedRevision: number): Promise<void> {
      await mutate(d => {
        if (d.revision !== expectedRevision || !d.enabled) throw new RssError("RSS_CONFLICT", "Authorization changed while fetching; no dedupe advanced");
        if (d.pending !== null) throw new RssError("RSS_BATCH_PENDING", "Previous batch must be settled first");
        for (const c of batch.commits) {
          const s = d.sources.find(s => s.id === c.sourceId && s.url === c.url);
          if (!s || new Set([...s.seen, ...c.keys]).size > 4096) throw new RssError("RSS_CAPACITY", "Dedupe capacity reached; no keys discarded");
        }
        d.pending = batch;
      });
    },
    async settle(taskId: string, completed: boolean): Promise<void> {
      await mutate(d => {
        if (d.pending?.taskId !== taskId) throw new RssError("RSS_CONFLICT", "Batch no longer belongs to this task");
        if (completed) for (const c of d.pending.commits) {
          const s = d.sources.find(s => s.id === c.sourceId && s.url === c.url);
          if (s) { s.seen = [...new Set([...s.seen, ...c.keys])]; s.initialized = true; }
        }
        d.pending = null;
      });
    },
  };
}
