import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { JsonlAgentStore } from "@aisdk-agent/core";
import { createRssSubscriptionStore, rssItemKey, RSS_TASK_PROMPT } from "./rss-subscriptions.js";
import { createRssDigestWorker } from "./rss-digest.js";
import { createTaskStore } from "./task-store.js";
import { createScheduledDemoModel, createTaskWorkerAgent, parseTaskWorkerArgs } from "./task-worker-entry.js";
import { runTaskWorker } from "./task-worker.js";
import type { FeedReadResult } from "./feed-read.js";
import { readFeed } from "./feed-read.js";

const item = (id: string) => ({ id, title: `Title ${id}`, url: `https://example.com/${id}`, summary: "Feed-only summary", publishedAt: null });
function feed(ids: string[]): FeedReadResult {
  return { ok: true, value: { requestedUrl: "https://example.com/feed", finalUrl: "https://example.com/feed", fetchedAt: "2026-10-03T01:00:00Z", format: "rss2", feedTitle: "Example", items: ids.map(item), truncated: false } };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-rss-")));
  let now = Date.parse("2026-10-03T00:00:00Z");
  const tasks = createTaskStore(root, { now: () => now });
  const store = createRssSubscriptionStore(root);
  let v = await store.update({ action: "add", expectedRevision: 1, name: "Example", url: "https://example.com/feed" }, tasks);
  assert(v.ok);
  v = await store.update({ action: "schedule", expectedRevision: v.value.revision, recurrence: { kind: "daily", time: "01:00", utcOffset: "+00:00" } }, tasks);
  assert(v.ok);
  return { root, tasks, store, advance: (ms = 86400000) => { now += ms; }, claim: async () => { now += 86400000; const c = await tasks.claimNextDue(); assert(c.ok && c.value); return c.value; } };
}

it("empty RSS batch completes durably without model or notification, including restart accounting", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const digest = createRssDigestWorker(f.root, f.tasks, { enabled: true, fetch: async () => feed([]) });
  try {
    f.advance();
    await runTaskWorker({ store: f.tasks, signal: controller.signal, runtime: { run: async () => { throw new Error("empty feed must not call a model"); } },
      prepareTask: digest.prepare, recoverPreparedTasks: digest.recover, settlePreparedTask: digest.settle,
      notify: async () => { throw new Error("empty feed must stay quiet"); }, onTaskFinished: () => controller.abort() });
    const list = await f.tasks.list({ inbox: true }); assert(list.ok && list.value.tasks.length === 1);
    const result = await createTaskStore(f.root).get(list.value.tasks[0]!.id); assert(result.ok);
    assert.equal(result.value.status, "completed"); assert.equal(result.value.runId, null);
    assert.equal(result.value.execution, "deterministic"); assert.equal(result.value.notification, null);
    assert.match(result.value.resultText!, /没有新条目/);
    const persisted = await f.store.read(); assert.equal(persisted.pending, null); assert.equal(persisted.sources[0]!.initialized, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("RSS identities prefer feed ID, then URL, then title/date; ordinary prompts grant nothing", () => {
  assert.equal(rssItemKey(item("a")), rssItemKey({ ...item("a"), title: "changed", url: "https://example.com/changed" }));
  assert.equal(rssItemKey({ ...item("a"), id: null }), rssItemKey({ ...item("a"), id: null, summary: "changed" }));
  assert.notEqual(rssItemKey({ ...item("a"), id: null, url: null }), rssItemKey({ ...item("b"), id: null, url: null }));
  assert.equal(parseTaskWorkerArgs(["--workspace", "/tmp", "--rss"]).rss, true);
  assert.throws(() => parseTaskWorkerArgs(["--workspace", "/tmp", "--rss", "--rss"]));
});

it("first baseline, no repeat, new item, restart and delivery-before-dedupe", async () => {
  const f = await fixture();
  let calls = 0;
  let ids = ["a", "b", "c", "d", "e", "f"];
  const worker = () => createRssDigestWorker(f.root, f.tasks, { enabled: true, fetch: async () => { calls++; return feed(ids); } });
  try {
    const task = await f.claim();
    const first = await worker().prepare(task, new AbortController().signal);
    assert(first);
    assert.equal((await f.store.read()).sources[0]!.seen.length, 0);
    assert.match(first.formatResult("summary"), /Title a/);
    assert.doesNotMatch(first.formatResult("summary"), /Title f/);
    assert.match(first.formatResult("summary"), /首次订阅/);
    // Persisted outcome followed by worker startup: no model replay or loss.
    assert((await f.tasks.recordRunId(task.id, "run-a")).ok);
    const outcome = { status: "completed" as const, runId: "run-a", resultText: first.formatResult("summary") };
    assert((await f.tasks.recordOutcome(task.id, outcome)).ok);
    assert((await f.tasks.finish(task.id, outcome)).ok);
    await worker().recover();
    assert.equal((await f.store.read()).sources[0]!.seen.length, 6);
    const second = await f.claim();
    const empty = await worker().prepare(second, new AbortController().signal);
    assert(empty);
    assert.match(empty.formatResult("INVENTED"), /没有新条目/);
    assert.doesNotMatch(empty.formatResult("INVENTED"), /INVENTED/);
    assert((await f.tasks.finish(second.id, { status: "completed", runId: "run-b", resultText: empty.formatResult("") })).ok);
    await worker().recover();
    ids = ["g", ...ids];
    const third = await f.claim();
    const fresh = await worker().prepare(third, new AbortController().signal);
    assert(fresh);
    assert.match(fresh.formatResult("summary"), /Title g/);
    assert.doesNotMatch(fresh.formatResult("summary"), /Title a/);
    assert.equal(calls, 3);
    // Crashed generation does not swallow g; next occurrence can fetch it again.
    assert((await f.tasks.interruptRunning()).ok);
    await worker().recover();
    assert.equal((await f.store.read()).sources[0]!.seen.length, 6);
    const fourth = await f.claim();
    assert.match((await worker().prepare(fourth, new AbortController().signal))!.formatResult(""), /Title g/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("partial failure remains visible, failed feeds do not initialize; all-failed advances nothing", async () => {
  const f = await fixture();
  try {
    const v = await f.store.get(); assert(v.ok);
    assert((await f.store.update({ action: "add", expectedRevision: v.value.revision, name: "Broken", url: "https://example.org/feed" }, f.tasks)).ok);
    const task = await f.claim();
    const worker = createRssDigestWorker(f.root, f.tasks, { enabled: true, fetch: async url => url.includes("example.org") ? { ok: false, error: { code: "INVALID_FEED", message: "bad" } } : feed(["a"]) });
    const prepared = await worker.prepare(task, new AbortController().signal); assert(prepared);
    assert.match(prepared.formatResult(""), /抓取失败：INVALID\\_FEED/);
    assert((await f.tasks.finish(task.id, { status: "completed", runId: "partial-run", resultText: prepared.formatResult("") })).ok);
    await worker.recover();
    const d = await f.store.read();
    assert.equal(d.sources[0]!.initialized, true);
    assert.equal(d.sources[1]!.initialized, false);
    const next = await f.claim();
    const failed = createRssDigestWorker(f.root, f.tasks, { enabled: true, fetch: async () => ({ ok: false, error: { code: "INVALID_FEED", message: "bad" } }) });
    await assert.rejects(failed.prepare(next, new AbortController().signal), /All enabled/);
    assert.deepEqual((await f.store.read()).sources, d.sources);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("authorization is explicit, series-bound, revocable, and URLs are public; stale edits fail", async () => {
  const f = await fixture(); let calls = 0;
  try {
    const task = await f.claim();
    const fetch = async () => { calls++; return feed(["a"]); };
    await assert.rejects(createRssDigestWorker(f.root, f.tasks, { enabled: false, fetch }).prepare(task, new AbortController().signal), /--rss/);
    const worker = createRssDigestWorker(f.root, f.tasks, { enabled: true, fetch });
    await assert.rejects(worker.prepare({ ...task, recurringTaskId: "foreign" }, new AbortController().signal), /exact enabled/);
    assert.equal(await worker.prepare({ ...task, prompt: "please collect RSS" }, new AbortController().signal), undefined);
    assert.equal(calls, 0);
    const v = await f.store.get(); assert(v.ok);
    assert(!(await f.store.update({ action: "add", expectedRevision: v.value.revision, name: "private", url: "http://127.0.0.1/feed" }, f.tasks)).ok);
    assert((await f.store.update({ action: "enabled", expectedRevision: v.value.revision, enabled: false }, f.tasks)).ok);
    assert(!(await f.store.update({ action: "enabled", expectedRevision: v.value.revision, enabled: true }, f.tasks)).ok);
    await assert.rejects(worker.prepare(task, new AbortController().signal), /exact enabled/);
    assert.equal(calls, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("bad RSS files and symlinks fail honestly; reads do not create storage", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rss-invalid-")));
  try {
    const store = createRssSubscriptionStore(root);
    assert((await store.get()).ok);
    await assert.rejects(readFile(join(root, ".runloom/rss.json")), { code: "ENOENT" });
    const tasks = createTaskStore(root);
    assert((await store.update({ action: "add", expectedRevision: 1, name: "Example", url: "https://example.com/feed" }, tasks)).ok);
    await writeFile(join(root, ".runloom/rss.json"), "broken");
    assert(!(await store.get()).ok);
    await rm(join(root, ".runloom/rss.json"));
    await writeFile(join(root, "outside.json"), "{}");
    await symlink(join(root, "outside.json"), join(root, ".runloom/rss.json"));
    assert(!(await store.get()).ok);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("worker executes one no-tool RSS Run and persists authoritative manifest before dedupe", async () => {
  const f = await fixture();
  const agent = createTaskWorkerAgent({ modelAlias: "mock", model: createScheduledDemoModel(), store: new JsonlAgentStore({ directory: join(f.root, "transcripts") }) });
  try {
    f.advance();
    const rss = createRssDigestWorker(f.root, f.tasks, { enabled: true, fetch: async () => feed(["a"]) });
    const stop = new AbortController();
    await runTaskWorker({ store: f.tasks, runtime: agent.runtime, signal: stop.signal,
      prepareTask: rss.prepare, recoverPreparedTasks: rss.recover, settlePreparedTask: rss.settle,
      onTaskFinished: task => { assert.match(task.resultText!, /Title a/); stop.abort(); },
    });
    const d = await f.store.read();
    assert.equal(d.pending, null);
    assert.equal(d.sources[0]!.seen.length, 1);
    const inbox = await f.tasks.list({ inbox: true }); assert(inbox.ok);
    assert.equal(inbox.value.tasks[0]!.status, "completed");
    const task = await f.tasks.get(inbox.value.tasks[0]!.id); assert(task.ok);
    assert.equal(task.value.attempts.length, 1);
    assert.match(task.value.resultText!, /未核实原文/);
  } finally { agent.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

it("revocation during a fetch stops the next request and never stages stale authorization", async () => {
  const f = await fixture(); let calls = 0;
  try {
    let v = await f.store.get(f.tasks); assert(v.ok);
    assert((await f.store.update({ action: "add", expectedRevision: v.value.revision, name: "Second", url: "https://example.org/feed" }, f.tasks)).ok);
    const task = await f.claim();
    const rss = createRssDigestWorker(f.root, f.tasks, { enabled: true, fetch: async () => {
      calls++;
      v = await f.store.get(f.tasks); assert(v.ok);
      assert((await f.store.update({ action: "enabled", expectedRevision: v.value.revision, enabled: false }, f.tasks)).ok);
      return feed(["a"]);
    } });
    await assert.rejects(rss.prepare(task, new AbortController().signal), /authorization changed/);
    assert.equal(calls, 1);
    const d = await f.store.read();
    assert.equal(d.pending, null);
    assert.equal(d.sources[0]!.seen.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("scheduled safe-retry reuses the frozen batch without fetching twice", async () => {
  const f = await fixture(); let fetches = 0;
  try {
    const task = await f.claim();
    const worker = () => createRssDigestWorker(f.root, f.tasks, { enabled: true, fetch: async () => { fetches++; return feed(["a"]); } });
    const before = await worker().prepare(task, new AbortController().signal); assert(before);
    const retried = await f.tasks.retry(task.id, { runId: null, error: { code: "MODEL_TIMEOUT", message: "timeout" }, nextRunAt: "2026-10-04T00:00:01Z" }); assert(retried.ok);
    f.advance(1000);
    const claimed = await f.tasks.claimNextDue(); assert(claimed.ok && claimed.value);
    const next = claimed.value;
    assert.equal(next.id, task.id);
    const again = await worker().prepare(next, new AbortController().signal); assert(again);
    assert.equal(again.prompt, before.prompt);
    assert.equal(fetches, 1);
    assert.equal((await f.store.read()).sources[0]!.seen.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("real feed parser/transport bounds reach digest; no article requests or fabricated no-new summary", async () => {
  const f = await fixture(); let requests = 0;
  try {
    const task = await f.claim();
    const rss = createRssDigestWorker(f.root, f.tasks, { enabled: true, fetch: (url, signal) => readFeed({ url, limit: 20 }, {
      signal, resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async () => { requests++; return new Response(`<rss version="2.0"><channel>${Array.from({ length: 21 }, (_, i) => `<item><guid>${i}</guid><title>News ${i}</title><link>https://example.com/${i}</link></item>`).join("")}</channel></rss>`, { headers: { "content-type": "text/xml" } }); },
    }) });
    const p = await rss.prepare(task, new AbortController().signal); assert(p);
    assert.match(p.formatResult(""), /读取窗口已截断/);
    assert.match(p.formatResult(""), /News 4/);
    assert.doesNotMatch(p.formatResult(""), /News 5/);
    assert.equal(requests, 1);
    assert.equal((await f.store.read()).pending!.commits[0]!.keys.length, 20);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
