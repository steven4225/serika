import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { JsonlAgentStore } from "@aisdk-agent/core";
import { acquireFlock } from "./flock.js";

it("an active Run blocks physical compaction in another process, without blocking its own save or restoring authority", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-active-compact-"));
  const threadId = "active", path = join(directory, `${createHash("sha256").update(threadId).digest("hex")}.jsonl`);
  const store = new JsonlAgentStore({ directory, snapshotCleanupThresholdBytes: 1,
    acquireTranscriptLock: path => acquireFlock(`${path}.append.lock`) });
  const at = new Date(0).toISOString();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await store.save(threadId, [{ id: "u1", role: "user", parts: [{ type: "text", text: "old source" }] }]);
    await store.create({ id: "run", threadId, agentId: "agent", agentVersion: "1", status: "created", version: 0, createdAt: at, updatedAt: at });
    const before = await readFile(path);
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { JsonlAgentStore } from '@aisdk-agent/core';
      import { acquireFlock } from ${JSON.stringify(new URL("./flock.js", import.meta.url).href)};
      const store = new JsonlAgentStore({ directory: ${JSON.stringify(directory)}, snapshotCleanupThresholdBytes: 1,
        acquireTranscriptLock: path => acquireFlock(path + '.append.lock') });
      process.stdout.write('attempting\\n');
      await store.compactThread(${JSON.stringify(threadId)});
      process.stdout.write('finished\\n');
    `], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "";
    child.stdout!.on("data", chunk => { output += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const done = new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", code => code === 0 ? resolve() : reject(new Error(`compactor ${code}: ${stderr}`)));
    });
    void done.catch(() => undefined);
    await new Promise<void>(resolve => child!.stdout!.once("data", () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(output, "attempting\n"); assert.deepEqual(await readFile(path), before);
    const next = [{ id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "old source" }] },
      { id: "u2", role: "user" as const, parts: [{ type: "text" as const, text: "new source" }] }];
    await store.save(threadId, next);
    await store.transition("run", 0, "cancelled");
    await done;
    const reopened = new JsonlAgentStore({ directory });
    assert.deepEqual(await reopened.getMessages(threadId), next);
    assert.equal(await reopened.getRun("run"), undefined, "physical cleanup restores no Run or approval");
  } finally {
    const run = await store.getRun("run");
    if (run && run.status === "created") await store.transition("run", run.version, "cancelled");
    if (child?.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

it("cross-process append and snapshot cleanup share one lock without losing summaries or latest messages", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-transcript-lock-"));
  const path = join(directory, `${createHash("sha256").update("thread").digest("hex")}.jsonl`);
  const store = new JsonlAgentStore({ directory });
  const messages = [{ id: "user-source", role: "user" as const, parts: [{ type: "text" as const, text: "完整来源".repeat(400) }] }];
  const children: ReturnType<typeof spawn>[] = [];
  let lease: Awaited<ReturnType<typeof acquireFlock>> | undefined;
  try {
    // Reproduce accumulated legacy full snapshots. New v3 saves deliberately
    // do not recreate this growth, so seeding through save would miss cleanup.
    for (let i = 0; i < 4; i++) await appendFile(path, JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: "thread", messages }) + "\n");
    const before = await readFile(path);
    lease = await acquireFlock(`${path}.append.lock`);
    const start = (action: string) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { JsonlAgentStore } from '@aisdk-agent/core';
        import { acquireFlock } from ${JSON.stringify(new URL("./flock.js", import.meta.url).href)};
        const store = new JsonlAgentStore({ directory: ${JSON.stringify(directory)}, snapshotCleanupThresholdBytes: 1,
          acquireTranscriptLock: path => acquireFlock(path + '.append.lock') });
        process.stdout.write('attempting\\n');
        ${action}
      `], { cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let errors = ""; child.stderr!.on("data", chunk => { errors += String(chunk); });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", () => resolve()); child.once("error", reject);
        child.once("close", code => reject(new Error(`child exited before ready (${code}): ${errors}`)));
      });
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error(`child ${code}: ${errors}`)));
      });
      void done.catch(() => undefined);
      return { ready, done };
    };
    const writer = start(`await store.save('thread', ${JSON.stringify([...messages, { id: "new-user", role: "user", parts: [{ type: "text", text: "新内容" }] }])});`);
    const summarizer = start("await store.appendContextCompaction({ v: 2, type: 'thread.context.compacted', threadId: 'thread', id: 'must-survive', summary: { text: '已有摘要' } });");
    await Promise.all([writer.ready, summarizer.ready]);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(await readFile(path), before, "neither process may rewrite/append while the lock is owned");
    await lease.release(); lease = undefined;
    await Promise.all([writer.done, summarizer.done]);
    const reopened = new JsonlAgentStore({ directory });
    assert.equal((await reopened.getMessages("thread")).at(-1)?.id, "new-user");
    assert.equal((await reopened.getContextCompactions("thread"))[0]?.id, "must-survive");
    assert.ok((await readFile(path)).byteLength < before.byteLength);
  } finally {
    await lease?.release();
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
