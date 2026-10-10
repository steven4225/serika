import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { JsonlAgentStore } from "@aisdk-agent/core";
import { acquireFlock } from "./flock.js";

it("cross-process append and snapshot cleanup share one lock without losing summaries or latest messages", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-transcript-lock-"));
  const path = join(directory, `${createHash("sha256").update("thread").digest("hex")}.jsonl`);
  const store = new JsonlAgentStore({ directory });
  const messages = [{ id: "user-source", role: "user" as const, parts: [{ type: "text" as const, text: "完整来源".repeat(400) }] }];
  const children: ReturnType<typeof spawn>[] = [];
  let lease: Awaited<ReturnType<typeof acquireFlock>> | undefined;
  try {
    for (let i = 0; i < 4; i++) await store.save("thread", messages);
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
