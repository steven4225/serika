import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { createMemoryStore, WorkspaceMemoryStoreImpl } from "./memory-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-commit-"));
  directories.push(root);
  return { root, file: join(root, ".runloom/memory.json"), store: createMemoryStore(root) };
}
const options = { boundThreadId: "commit-thread", now: new Date("2026-10-04T00:00:00Z") };
async function pending(store: ReturnType<typeof createMemoryStore>) {
  const batch = await store.commitCandidateBatch({
    batchId: "commit-batch", originThreadId: options.boundThreadId,
    expectedCursor: null, nextCursor: null,
    candidates: [{
      change: { operation: "add", text: "keep commit evidence", scope: { kind: "workspace" }, expiresAt: null },
      source: { kind: "conversation", threadId: options.boundThreadId, messageId: "committed-user", quote: "keep commit evidence" },
      reason: "explicit user statement",
    }],
  }, undefined, options);
  if (!batch.ok) assert.fail(batch.error.message);
  return { candidateId: batch.value.candidateIds[0]!, expectedCandidateRevision: 1, decision: "accept" as const };
}

it("pre-rename cancellation preserves legacy bytes and does not leave a temporary file", async () => {
  const { root, file } = await fixture();
  await mkdir(join(root, ".runloom"));
  const original = '{ "version":1, "entries":[{"id":"old","text":"original","enabled":true}] }';
  await writeFile(file, original);
  const abort = new AbortController();
  const store = new WorkspaceMemoryStoreImpl(root, phase => {
    assert.equal(phase, "before-rename");
    abort.abort(new Error("cancel before commit"));
  });
  await assert.rejects(store.add({ text: "new" }, abort.signal, options), /cancel before commit/);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal((await readdir(join(root, ".runloom"))).some(name => name.endsWith(".tmp")), false);
});

it("post-rename acknowledgement failure reports uncertainty while the complete receipt can be replayed", async () => {
  const { root, file, store } = await fixture();
  const request = await pending(store);
  const failing = new WorkspaceMemoryStoreImpl(root, phase => {
    if (phase === "after-rename") throw new Error("lost durability acknowledgement");
  });
  const result = await failing.resolveCandidate(request, undefined, options);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "MEMORY_COMMIT_UNCERTAIN");
  const committed = await readFile(file, "utf8");
  const document = JSON.parse(committed);
  assert.equal(document.entries.length, 1);
  assert.equal(document.candidates[0].status, "accepted");
  assert.equal(document.candidates[0].appliedResult.memoryId, document.entries[0].id);
  const replay = await createMemoryStore(root).resolveCandidate(request, undefined, options);
  if (!replay.ok) assert.fail(replay.error.message);
  assert.equal(replay.value.replayed, true);
  assert.equal(await readFile(file, "utf8"), committed);
});

it("cancellation after rename finishes the durability acknowledgement rather than claiming no write", async () => {
  const { root, store } = await fixture();
  const initial = await store.add({ text: "before" }, undefined, options);
  if (!initial.ok) assert.fail(initial.error.message);
  const abort = new AbortController();
  const writer = new WorkspaceMemoryStoreImpl(root, phase => {
    if (phase === "after-rename") abort.abort(new Error("cancel after commit"));
  });
  const result = await writer.update(initial.entry.id, { text: "after", expectedRevision: 1 }, abort.signal, options);
  if (!result.ok) assert.fail(result.error.message);
  assert.equal(result.entry.revision, 2);
  assert.equal(result.entry.text, "after");
});

for (const boundary of ["before-rename", "after-rename"] as const) {
  it(`survives a real child SIGKILL at ${boundary} without a partial acceptance`, { timeout: 15_000 }, async () => {
    const { root, file, store } = await fixture();
    const request = await pending(store);
    const original = await readFile(file, "utf8");
    const moduleUrl = new URL("./memory-store.js", import.meta.url).href;
    const script = `
      import { WorkspaceMemoryStoreImpl } from ${JSON.stringify(moduleUrl)};
      process.on("message", () => {});
      const store = new WorkspaceMemoryStoreImpl(${JSON.stringify(root)}, async phase => {
        if (phase !== ${JSON.stringify(boundary)}) return;
        process.send({ phase });
        await new Promise(() => {});
      });
      const result = await store.resolveCandidate(${JSON.stringify(request)}, undefined, {
        boundThreadId: ${JSON.stringify(options.boundThreadId)}, now: new Date(${JSON.stringify(options.now.toISOString())})
      });
      process.send({ unexpectedResult: result });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    const exited = once(child, "exit");
    try {
      const reached = await Promise.race([
        once(child, "message").then(([message]) => message as { phase?: string }),
        exited.then(([code, signal]) => { throw new Error(`child exited before barrier: ${code}/${signal}: ${stderr}`); }),
      ]);
      assert.equal(reached.phase, boundary);
      child.kill("SIGKILL");
      const [code, signal] = await exited;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      const after = await readFile(file, "utf8");
      const document = JSON.parse(after);
      if (boundary === "before-rename") {
        assert.equal(after, original);
        assert.equal(document.entries.length, 0);
        assert.equal(document.candidates[0].status, "pending");
        // An explicit later decision can acquire the released production flock.
        const rejected = await createMemoryStore(root).resolveCandidate({ ...request, decision: "reject" }, undefined, options);
        assert.equal(rejected.ok, true);
      } else {
        assert.equal(document.entries.length, 1);
        assert.equal(document.entries[0].assertions.length, 1);
        assert.equal(document.candidates[0].status, "accepted");
        assert.equal(document.candidates[0].appliedResult.memoryId, document.entries[0].id);
        const replay = await createMemoryStore(root).resolveCandidate(request, undefined, options);
        if (!replay.ok) assert.fail(replay.error.message);
        assert.equal(replay.value.replayed, true);
        assert.equal(await readFile(file, "utf8"), after);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
}
