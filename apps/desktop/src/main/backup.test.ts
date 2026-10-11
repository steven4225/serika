import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { createTaskStore, TASK_FILE_NAME } from "@aisdk-agent/example-cli/dist/task-store.js";
import { createExecutionRecordStore } from "@aisdk-agent/example-cli/dist/execution-record-store.js";
import { exportBackup, restoreBackup, previewBackup } from "./backup.js";
import { acquireFlock, tryAcquireFlock } from "@aisdk-agent/example-cli/dist/flock.js";
import { JsonlAgentStore } from "@aisdk-agent/core";
import { inspectThread } from "./thread-history.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-backup-unit-")));
  const workspace = join(root, "workspace"), transcripts = join(root, "transcripts"), destination = join(root, "saved.serika-backup");
  await mkdir(join(workspace, ".runloom"), { recursive: true }); await mkdir(transcripts);
  const record = (threadId: string, text: string) => JSON.stringify({ v: 1, threadId, type: "thread.messages.committed", messages: [{ id: "user", role: "user", parts: [{ type: "text", text }] }] });
  const compact = JSON.stringify({ v: 2, type: "thread.context.compacted", threadId: "daily", id: "summary", summary: { text: "saved compact summary" } });
  await writeFile(join(transcripts, `${digest("daily")}.jsonl`), record("daily", "old") + "\n" + compact + "\n" + record("daily", "latest") + "\n{" );
  await writeFile(join(transcripts, `${digest("foreign")}.jsonl`), record("foreign", "PRIVATE-FOREIGN") + "\n");
  await writeFile(join(workspace, ".env"), "API_KEY=PRIVATE-CONFIG");
  await writeFile(join(workspace, "project.txt"), "PROJECT-FILE");
  await writeFile(join(workspace, ".runloom", "memory.json"), JSON.stringify({ version: 1, entries: [{ id: "saved", text: "saved memory", enabled: true }] }));
  const records = createExecutionRecordStore(transcripts);
  for (const threadId of ["daily", "foreign"]) {
    await records.startRun({ runId: `run-${threadId}`, threadId, phase: "primary", startedAt: new Date(0).toISOString() });
  }
  return { root, workspace, transcripts, destination, threads: [{ threadId: "daily", transcriptDirectory: transcripts }] };
}

it("backup only registered assistant data; restoration is an offline copy with schedules and notifications disabled", async () => {
  const f = await fixture();
  try {
    let now = Date.parse("2026-10-10T00:00:00Z");
    const tasks = createTaskStore(f.workspace, { now: () => now });
    const future = await tasks.create({ prompt: "future", runAt: "2026-10-12T00:00:00Z" }); assert(future.ok);
    const running = await tasks.create({ prompt: "pending outcome", runAt: "2026-10-10T00:01:00Z" }); assert(running.ok);
    const recurring = await tasks.createRecurring({ prompt: "recurring", recurrence: { kind: "daily", time: "08:00", utcOffset: "+08:00" } }); assert(recurring.ok);
    now += 60_000;
    const claim = await tasks.claimNextDue(); assert(claim.ok && claim.value?.id === running.value.id);
    assert((await tasks.recordRunId(running.value.id, "saved-run")).ok);
    assert((await tasks.recordOutcome(running.value.id, { status: "completed", runId: "saved-run", resultText: "persisted", notification: true })).ok);
    const original = await readFile(join(f.workspace, TASK_FILE_NAME));
    const saved = await exportBackup(f);
    assert.equal(saved.threads, 1);
    const archive = JSON.parse(gunzipSync(await readFile(f.destination)).toString());
    const serialized = JSON.stringify(archive);
    for (const excluded of ["PRIVATE-FOREIGN", "PRIVATE-CONFIG", "PROJECT-FILE", "run-foreign"]) assert(!serialized.includes(excluded));
    assert(serialized.includes("run-daily"));
    assert(serialized.includes("saved compact summary"), "v2 context summaries survive alongside the latest v1 transcript");
    const restored = await restoreBackup(f.destination, f.root);
    assert.notEqual(restored.path, f.workspace);
    const history = await inspectThread({ threadId: "daily", transcriptDirectory: restored.transcriptDirectory });
    assert.equal(history.messageCount, 1); assert.equal(history.preview, "latest"); assert.equal(history.error, undefined);
    const recovered = createTaskStore(join(restored.path, "workspace"), { now: () => Date.parse("2026-10-20T00:00:00Z") });
    const one = await recovered.get(future.value.id); assert(one.ok && one.value.status === "cancelled");
    const interrupted = await recovered.get(running.value.id); assert(interrupted.ok && interrupted.value.status === "interrupted");
    assert.equal(interrupted.value.pendingOutcome, null); assert.equal(interrupted.value.retryAt, null); assert.equal(interrupted.value.notification, null);
    const series = await recovered.getRecurring(recurring.value.id); assert(series.ok && series.value?.recurringTask.status === "paused");
    const noDispatch = await recovered.claimNextDue(); assert(noDispatch.ok && noDispatch.value === null);
    assert.deepEqual(await readFile(join(f.workspace, TASK_FILE_NAME)), original);
    assert(!await readdir(restored.path).then(names => names.includes("config.json")));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("backup lock placeholders stay empty and reusable, never enter the archive, and are not unlinked", async () => {
  const f = await fixture();
  try {
    await exportBackup(f);
    const lockPath = join(f.workspace, ".runloom", "memory.json.lock");
    const before = await lstat(lockPath);
    assert.equal(before.size, 0);
    const archive = JSON.parse(gunzipSync(await readFile(f.destination)).toString()) as { entries: Array<{ path: string }> };
    assert.ok(archive.entries.every(entry => !entry.path.includes(".lock")));
    const lock = await tryAcquireFlock(lockPath);
    assert.ok(lock, "export releases the held lock, not the stable inode");
    const destination = join(f.root, "saved-again.serika-backup");
    try {
      await assert.rejects(exportBackup({ ...f, destination }), /数据正在写入/);
      await assert.rejects(readFile(destination), { code: "ENOENT" });
    } finally { await lock.release(); }
    await exportBackup({ ...f, destination });
    const after = await lstat(lockPath);
    assert.equal(after.ino, before.ino, "deleting the pathname would split concurrent lock ownership");
    assert.equal(after.dev, before.dev);
    assert.equal(after.size, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("export rejects existing destinations, symlinked data, inside-workspace ..names, and known credentials in text", async () => {
  const f = await fixture();
  try {
    await assert.rejects(exportBackup({ ...f, destination: join(f.workspace, "..not-outside") }), /工作区之外/);
    await assert.rejects(exportBackup({ ...f, knownSecrets: ["saved memory"] }), /凭据/);
    await assert.rejects(readFile(f.destination), { code: "ENOENT" });
    await exportBackup(f); const saved = await readFile(f.destination);
    await assert.rejects(exportBackup(f), /已存在/); assert.deepEqual(await readFile(f.destination), saved);
    await rm(join(f.workspace, ".runloom", "memory.json"));
    await symlink(join(f.workspace, ".env"), join(f.workspace, ".runloom", "memory.json"));
    await assert.rejects(exportBackup({ ...f, destination: join(f.root, "unsafe.backup") }));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("export rejects a legacy invalid v1 compaction instead of creating an unrestorable backup", async () => {
  const f = await fixture();
  try {
    const path = join(f.transcripts, `${digest("daily")}.jsonl`);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"v":2,"type":"thread.context.compacted"', '"v":1,"type":"thread.context.compacted"'));
    await assert.rejects(exportBackup(f), /对话记录无效/);
    await assert.rejects(readFile(f.destination), { code: "ENOENT" });
    assert.equal(await readFile(path, "utf8"), text.replace('"v":2,"type":"thread.context.compacted"', '"v":1,"type":"thread.context.compacted"'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("bad hashes, path traversal and mismatched transcript ownership fail before a recovery directory exists", async () => {
  const f = await fixture();
  try {
    await exportBackup(f);
    const archive = JSON.parse(gunzipSync(await readFile(f.destination)).toString());
    const entriesBefore = await readdir(f.root);
    for (const kind of ["hash", "path", "identity"]) {
      const changed = structuredClone(archive);
      if (kind === "hash") changed.entries[0].sha256 = "bad";
      else if (kind === "path") changed.entries[0].path = "../escaped.json";
      else {
        const entry = changed.entries.find((e: { path: string }) => e.path.endsWith(".jsonl"));
        entry.text = entry.text.replace('"threadId":"daily"', '"threadId":"foreign"'); entry.sha256 = digest(entry.text);
      }
      await writeFile(f.destination, gzipSync(JSON.stringify(changed)));
      await assert.rejects(restoreBackup(f.destination, f.root));
      assert.deepEqual(await readdir(f.root), entriesBefore);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const name of ["memory.json", "checkpoint.json", "work-tasks.json", "dreaming.json", "tasks.json", "rss.json", "receipt", "messages", "date"] as const) {
  it(`rejects invalid ${name} even with a matching hash before preview or recovery writes`, async () => {
    const f = await fixture();
    try {
      await exportBackup(f);
      const archive = JSON.parse(gunzipSync(await readFile(f.destination)).toString());
      if (name === "date") archive.createdAt = "not-a-date";
      else if (name === "receipt") {
        const entry = archive.entries.find((e: { path: string }) => e.path.startsWith("receipts/"));
        entry.text = JSON.stringify({ version: 1, runs: [{ threadId: "daily", runId: "bad", status: "completed" }] });
        entry.sha256 = digest(entry.text);
      } else if (name === "messages") {
        const entry = archive.entries.find((e: { path: string }) => e.path.endsWith(".jsonl"));
        entry.text = JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: "daily", messages: [null] }) + "\n";
        entry.sha256 = digest(entry.text);
      } else {
        archive.entries = archive.entries.filter((e: { path: string }) => e.path !== `workspace/.runloom/${name}`);
        const text = JSON.stringify({ version: 4, bogus: "hash alone does not prove readable data" });
        archive.entries.push({ path: `workspace/.runloom/${name}`, text, sha256: digest(text) });
      }
      await writeFile(f.destination, gzipSync(JSON.stringify(archive)));
      const before = await readdir(f.root), bytes = await readFile(f.destination);
      await assert.rejects(previewBackup(f.destination));
      await assert.rejects(restoreBackup(f.destination, f.root));
      assert.deepEqual(await readdir(f.root), before, "validation happens before creating any recovery directory");
      assert.deepEqual(await readFile(f.destination), bytes);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

it("refuses corrupt sources instead of exporting a backup that only fails when opened", async () => {
  const f = await fixture();
  try {
    const path = join(f.workspace, ".runloom", "memory.json");
    await writeFile(path, JSON.stringify({ version: 4, entries: "invalid" }));
    const bytes = await readFile(path);
    await assert.rejects(exportBackup(f));
    await assert.rejects(readFile(f.destination), { code: "ENOENT" });
    assert.deepEqual(await readFile(path), bytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("uses the same complete archive validation at export, including legacy messages and duplicate Thread identities", async () => {
  const f = await fixture();
  try {
    await assert.rejects(exportBackup({ ...f, threads: [...f.threads, ...f.threads] }), /清单无效/);
    const path = join(f.transcripts, `${digest("daily")}.jsonl`);
    await writeFile(path, JSON.stringify({ v: 1, threadId: "daily", type: "thread.messages.committed", messages: [null] }) + "\n");
    const bytes = await readFile(path);
    await assert.rejects(exportBackup(f), /对话归属或类型无效/);
    await assert.rejects(readFile(f.destination), { code: "ENOENT" });
    assert.deepEqual(await readFile(path), bytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("rejects valid JSON that exceeds the original Store read limit before preview or recovery writes", async () => {
  const f = await fixture();
  try {
    await exportBackup(f);
    const archive = JSON.parse(gunzipSync(await readFile(f.destination)).toString());
    const text = JSON.stringify({ schemaVersion: 1, current: null, history: [] }) + " ".repeat(128 * 1024);
    archive.entries.push({ path: "workspace/.runloom/checkpoint.json", text, sha256: digest(text) });
    await writeFile(f.destination, gzipSync(JSON.stringify(archive)));
    const before = await readdir(f.root);
    await assert.rejects(previewBackup(f.destination), /读取限额/);
    await assert.rejects(restoreBackup(f.destination, f.root), /读取限额/);
    assert.deepEqual(await readdir(f.root), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("rejects short configured credentials in assistant text rather than silently exporting them", async () => {
  const f = await fixture();
  try {
    const path = join(f.workspace, ".runloom", "memory.json");
    await writeFile(path, JSON.stringify({ version: 1, entries: [{ id: "saved", text: "短凭据 k!3x", enabled: true }] }));
    await assert.rejects(exportBackup({ ...f, knownSecrets: ["k!3x"] }), /凭据/);
    await assert.rejects(readFile(f.destination), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("refuses a busy writer without partial export; preview is read-only and a changed archive cannot be restored", async () => {
  const f = await fixture();
  let lock: Awaited<ReturnType<typeof acquireFlock>> | undefined;
  try {
    lock = await acquireFlock(join(f.workspace, ".runloom", "memory.json.lock"));
    await assert.rejects(exportBackup(f), /正在写入/);
    await assert.rejects(readFile(f.destination), { code: "ENOENT" });
    await lock.release(); lock = undefined;
    await exportBackup(f);
    const files = await readdir(f.root), bytes = await readFile(f.destination);
    const preview = await previewBackup(f.destination);
    assert.equal(preview.threads, 1); assert(preview.stores.includes("memory.json"));
    assert.deepEqual(await readdir(f.root), files);
    const changed = JSON.parse(gunzipSync(bytes).toString()); changed.createdAt = "2026-10-11T00:00:00Z";
    await writeFile(f.destination, gzipSync(JSON.stringify(changed)));
    await assert.rejects(restoreBackup(f.destination, f.root, preview.fingerprint), /预览后已变化/);
    assert.deepEqual(await readdir(f.root), files);
  } finally { await lock?.release(); await rm(f.root, { recursive: true, force: true }); }
});

it("exports a v3 delta chain as a self-contained backup and continues it after restore", async () => {
  const f = await fixture();
  try {
    const store = new JsonlAgentStore({ directory: f.transcripts });
    const previous = await store.getMessages("daily");
    const next = [...previous, { id: "new", role: "user" as const, parts: [{ type: "text" as const, text: "新的已提交消息" }] }];
    await store.save("daily", next);
    await exportBackup(f);
    const restored = await restoreBackup(f.destination, f.root);
    const reopened = new JsonlAgentStore({ directory: restored.transcriptDirectory });
    assert.deepEqual(await reopened.getMessages("daily"), next);
    await reopened.save("daily", [...next, { id: "after", role: "assistant", parts: [{ type: "text", text: "恢复后继续" }] }]);
    assert.equal((await inspectThread({ threadId: "daily", transcriptDirectory: restored.transcriptDirectory })).messageCount, 3);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
