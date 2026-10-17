import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { discoverThreadDirectory, inspectThread } from "./thread-history.js";
import { readCommittedTranscriptLines, JsonlAgentStore } from "@serika/core";

it("refreshes a many-Thread history list without reparsing unchanged snapshots and invalidates only the changed entry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "serika-history-projection-"));
  try {
    const threads = Array.from({ length: 12 }, (_, index) => ({ threadId: `t${index}`, transcriptDirectory: directory }));
    const store = new JsonlAgentStore({ directory });
    for (const thread of threads) {
      await store.save(thread.threadId, [{ id: "u", role: "user", parts: [{ type: "text", text: `对话 ${thread.threadId}` }] }]);
      assert.equal((await inspectThread(thread)).messageCount, 1);
    }
    const original = JSON.parse;
    let parsed = 0;
    t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => { parsed++; return original(...args); });
    for (const thread of threads) assert.equal((await inspectThread(thread)).messageCount, 1);
    assert.equal(parsed, 0, "small list projections survive eviction of full transcript cache entries");
    await store.save(threads[0]!.threadId, [{ id: "u", role: "user", parts: [{ type: "text", text: "已变更的标题" }] }]);
    const changed = await inspectThread(threads[0]!);
    assert.equal(changed.title, "已变更的标题");
    const before = parsed;
    for (const thread of threads) await inspectThread(thread);
    assert.equal(parsed, before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("opens and searches a single >16 MiB legacy snapshot, then continues using small delta records without loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "serika-long-thread-"));
  try {
    const thread = { threadId: "long", transcriptDirectory: directory };
    const messages = [{ id: "early", role: "user" as const, parts: [{ type: "text" as const, text: "早期重要信息" + "a".repeat(17 * 1024 * 1024) }] }];
    const file = join(directory, createHash("sha256").update(thread.threadId).digest("hex") + ".jsonl");
    await writeFile(file, JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: thread.threadId, messages }) + "\n");
    const before = await stat(file);
    const old = await inspectThread(thread, "早期重要信息");
    assert.equal(old.error, undefined); assert.equal(old.matchesQuery, true); assert.equal(old.messageCount, 1);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    const store = new JsonlAgentStore({ directory });
    const next = [...messages, { id: "new", role: "user" as const, parts: [{ type: "text" as const, text: "继续" }] }];
    await store.save(thread.threadId, next);
    assert.ok((await stat(file)).size - before.size < 2048);
    assert.deepEqual(await new JsonlAgentStore({ directory }).getMessages(thread.threadId), next);
    const found = await discoverThreadDirectory(directory);
    assert.equal(found[0]?.messageCount, 2); assert.equal(found[0]?.error, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("an oversized incomplete tail cannot hide the preceding committed snapshot; a complete oversized record fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-oversized-tail-"));
  try {
    const thread = { threadId: "tail", transcriptDirectory: directory };
    const file = join(directory, createHash("sha256").update(thread.threadId).digest("hex") + ".jsonl");
    const complete = JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: thread.threadId,
      messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "已保存对话" }] }] }) + "\n";
    await writeFile(file, complete + "x".repeat(16 * 1024 * 1024 + 1));
    const before = await stat(file);
    const found = await inspectThread(thread);
    assert.equal(found.title, "已保存对话"); assert.equal(found.messageCount, 1); assert.match(found.error!, /未完成/);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    await writeFile(file, complete + "x".repeat(1025) + "\n");
    await assert.rejects(async () => { for await (const _ of readCommittedTranscriptLines(file, { maxLineBytes: 1024 })) { /* consume */ } }, /超过/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("reports transcript save time from disk without writing history or inventing activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-history-time-"));
  try {
    const thread = { threadId: "registered", transcriptDirectory: directory };
    assert.equal((await inspectThread(thread)).savedAt, undefined, "no file means no reported save time");
    const file = join(directory, `${createHash("sha256").update(thread.threadId).digest("hex")}.jsonl`);
    const content = JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: thread.threadId, messages: [{ role: "user", parts: [{ type: "text", text: "原有对话" }] }] }) + "\n";
    await writeFile(file, content);
    const before = await stat(file);
    const summary = await inspectThread(thread);
    assert.equal(summary.savedAt, before.mtime.toISOString());
    assert.equal(summary.title, "原有对话");
    assert.equal(await readFile(file, "utf8"), content);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("searches complete ordinary conversation text with bounded snippets, excluding tools, system and consolidation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-history-search-"));
  try {
    const thread = { threadId: "search", transcriptDirectory: directory };
    const file = join(directory, `${createHash("sha256").update(thread.threadId).digest("hex")}.jsonl`);
    const messages = [
      { role: "system", parts: [{ type: "text", text: "hidden system" }] },
      { role: "user", parts: [{ type: "text", text: "整理项目计划\n要求写在下一行" }] },
      { role: "assistant", parts: [{ type: "dynamic-tool", output: "hidden receipt" }] },
      { role: "assistant", parts: [{ type: "text", text: "很长的正文".repeat(500) + "香蕉项目下周交付" }] },
      { role: "user", metadata: { source: "auto-consolidation" }, parts: [{ type: "text", text: "hidden reflection" }] },
      { role: "assistant", parts: [{ type: "text", text: "hidden candidate" }] },
    ];
    const content = JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: thread.threadId, messages }) + "\n";
    await writeFile(file, content);
    const result = await inspectThread(thread, "香蕉项目");
    assert.equal(result.matchesQuery, true);
    assert.equal(result.title, "整理项目计划");
    assert.match(result.preview!, /香蕉项目/);
    assert.ok(result.preview!.length <= 162);
    for (const query of ["system", "receipt", "reflection", "candidate"]) assert.equal((await inspectThread(thread, query)).matchesQuery, false);
    assert.equal(await readFile(file, "utf8"), content, "search never writes the transcript");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("discovers and searches accumulated history over 16 MiB without altering bytes or accepting a pending tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-large-history-"));
  try {
    const thread = { threadId: "large-history", transcriptDirectory: directory };
    const file = join(directory, `${createHash("sha256").update(thread.threadId).digest("hex")}.jsonl`);
    const snapshot = (text: string) => JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: thread.threadId,
      messages: [{ id: "original-user", role: "user", parts: [{ type: "text", text }] }] }) + "\n";
    const content = snapshot("旧重复快照" + "x".repeat(64 * 1024)).repeat(260) +
      JSON.stringify({ v: 3, type: "future.record" }) + "\n" + snapshot("长期项目：下周交付") + '{"v":1,"messages":';
    await writeFile(file, content);
    const before = await stat(file); assert.ok(before.size > 16 * 1024 * 1024);
    const result = await inspectThread(thread, "下周交付");
    assert.equal(result.matchesQuery, true); assert.equal(result.title, "长期项目：下周交付");
    assert.equal(result.messageCount, 1); assert.match(result.error!, /未完成/);
    assert.equal((await discoverThreadDirectory(directory))[0]?.title, result.title);
    assert.equal(await readFile(file, "utf8"), content);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
