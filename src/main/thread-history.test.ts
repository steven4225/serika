import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { inspectThread } from "./thread-history.js";

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
