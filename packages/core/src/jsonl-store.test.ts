import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { UIMessage } from "ai";
import { JsonlAgentStore } from "./jsonl-store.js";
import { encodeTranscriptUpdate, MAX_TRANSCRIPT_RECORD_BYTES } from "./transcript-codec.js";
import type { ThreadContextCompactionRecord } from "./store.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-jsonl-"));
  directories.push(directory);
  return directory;
}

function transcript(text: string): UIMessage[] {
  return [
    { id: "user-1", role: "user", parts: [{ type: "text", text: "prompt" }] },
    { id: "assistant-1", role: "assistant", parts: [{ type: "text", text }] },
  ];
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonlAgentStore", () => {
  it("reuses a read-only snapshot and decodes only appended records, invalidating on replacement", async (t) => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    const messages = transcript("old history ".repeat(30_000));
    await store.save("thread-1", messages);
    await store.getMessages("thread-1");
    const [fileName] = await readdir(directory);
    const path = join(directory, fileName!);
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.read;
    await probe.close();
    let bytes = 0;
    t.mock.method(prototype, "read", async function (this: typeof probe, ...args: unknown[]) {
      const result = await original.apply(this, args);
      bytes += result.bytesRead;
      return result;
    });
    assert.deepEqual(await store.getMessages("thread-1"), messages);
    assert.equal(bytes, 0, "unchanged history must not be rescanned");
    const next = [...messages, { id: "u2", role: "user" as const, parts: [{ type: "text" as const, text: "new suffix" }] }];
    const delta = encodeTranscriptUpdate("thread-1", messages, next).join("");
    await appendFile(path, delta);
    assert.deepEqual(await store.getMessages("thread-1"), next);
    assert.equal(bytes, Buffer.byteLength(delta), "only the new delta is read");
    const replacement = transcript("replacement");
    await writeFile(`${path}.replacement`, encodeTranscriptUpdate("thread-1", [], replacement).join(""));
    await rename(`${path}.replacement`, path);
    assert.deepEqual(await store.getMessages("thread-1"), replacement);
  });

  it("holds the append lease for the whole Run and releases it only at a terminal transition", async () => {
    const directory = await temporaryDirectory();
    let held = false, claims = 0;
    const store = new JsonlAgentStore({ directory, acquireTranscriptLock: async () => {
      assert.equal(held, false); held = true; claims++;
      return { release: async () => { held = false; } };
    } });
    const at = new Date(0).toISOString();
    await store.create({ id: "run", threadId: "thread-1", agentId: "agent", agentVersion: "1", status: "created", version: 0, createdAt: at, updatedAt: at });
    assert.equal(held, true, "physical cleanup cannot enter while a Run owns its transcript");
    await store.transition("run", 0, "running");
    await assert.rejects(store.compactThread("thread-1"), /active Run/);
    await store.appendContextCompaction({ v: 2, type: "thread.context.compacted", threadId: "thread-1" });
    await store.save("thread-1", transcript("same Run save"));
    assert.equal(claims, 1, "the owning Run reuses its lease for internal writes");
    assert.equal(held, true);
    await store.transition("run", 1, "completed");
    assert.equal(held, false);
  });

  it("resumes pending chunk transactions and Unicode EOF lines without treating them as committed sources", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    const original = transcript("committed");
    await store.save("thread-1", original);
    const [name] = await readdir(directory), path = join(directory, name!);
    const next = transcript("新内容🙂".repeat(40_000));
    const lines = encodeTranscriptUpdate("thread-1", original, next);
    await appendFile(path, lines[0]!);
    assert.deepEqual(await store.getMessages("thread-1"), original);
    assert.deepEqual(await store.getMessages("thread-1"), original);
    await appendFile(path, lines.slice(1).join(""));
    assert.deepEqual(await store.getMessages("thread-1"), next);
    const legacy = Buffer.from(JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: "thread-1", messages: transcript("完整🙂来源") }) + "\n");
    const split = legacy.indexOf(Buffer.from("🙂")) + 1;
    await appendFile(path, legacy.subarray(0, split));
    assert.deepEqual(await store.getMessages("thread-1"), next);
    await appendFile(path, legacy.subarray(split));
    assert.deepEqual(await store.getMessages("thread-1"), transcript("完整🙂来源"));
    await writeFile(path, encodeTranscriptUpdate("thread-1", [], original).join(""));
    assert.deepEqual(await store.getMessages("thread-1"), original, "truncation resets offsets and pending chunks");
    const damaged = encodeTranscriptUpdate("thread-1", [], transcript("tampered"));
    const commit = JSON.parse(damaged.at(-1)!); commit.payloadHash = "wrong";
    damaged[damaged.length - 1] = JSON.stringify(commit) + "\n";
    await appendFile(path, damaged.join(""));
    await assert.rejects(store.getMessages("thread-1"), /corrupt/);
  });

  it("cleans redundant snapshots under a host lock without changing message sources or opaque companions", async () => {
    const directory = await temporaryDirectory();
    let held = false, claims = 0;
    const store = new JsonlAgentStore({ directory, snapshotCleanupThresholdBytes: 512,
      acquireTranscriptLock: async () => {
        assert.equal(held, false); held = true; claims++;
        return { release: async () => { held = false; } };
      },
    });
    const compact: ThreadContextCompactionRecord = { v: 2, type: "thread.context.compacted", threadId: "thread-1", id: "prefix", summary: { text: "原始摘要" } };
    const messages = transcript("内容".repeat(500));
    await store.save("thread-1", messages);
    await store.appendContextCompaction(compact);
    const [fileName] = await readdir(directory); const path = join(directory, fileName!);
    const future = { v: 7, type: "future.record", payload: "保留未知数据" };
    await appendFile(path, `${JSON.stringify(future)}\n`);
    for (let i = 0; i < 6; i++) await store.save("thread-1", messages);
    const before = await stat(path);
    const reopened = new JsonlAgentStore({ directory });
    assert.deepEqual(await reopened.getMessages("thread-1"), messages);
    assert.deepEqual(await reopened.getContextCompactions("thread-1"), [compact]);
    const raw = await readFile(path, "utf8");
    assert.ok(raw.includes(JSON.stringify(future)));
    assert.ok(before.size < Buffer.byteLength(JSON.stringify(messages)) * 4, "disk size follows current data, not number of saves");
    assert.equal(claims, 8); assert.equal(held, false);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs, "reopening is read-only");
  });

  it("does not replace snapshots without a cross-process host lock or erase a corrupt history during cleanup", async () => {
    const directory = await temporaryDirectory();
    const unprotected = new JsonlAgentStore({ directory, snapshotCleanupThresholdBytes: 1 });
    await unprotected.save("thread-1", transcript("first"));
    await unprotected.save("thread-1", transcript("latest"));
    const [fileName] = await readdir(directory); const path = join(directory, fileName!);
    assert.equal((await readFile(path, "utf8")).trimEnd().split("\n").filter(line => JSON.parse(line).type === "thread.messages.committed").length, 2);
    await appendFile(path, "not-json\n");
    const before = await readFile(path);
    const protectedStore = new JsonlAgentStore({ directory, snapshotCleanupThresholdBytes: 1,
      acquireTranscriptLock: async () => ({ release: async () => undefined }),
    });
    await assert.rejects(protectedStore.save("thread-1", transcript("do not mask corruption")), /corrupt/);
    assert.deepEqual(await readFile(path), before);
  });

  it("skips an over-capacity checkpoint without blocking continuation or deleting logical messages", async (t) => {
    const directory = await temporaryDirectory();
    const messages = transcript("checkpoint size boundary");
    const store = new JsonlAgentStore({ directory, snapshotCleanupThresholdBytes: 1,
      acquireTranscriptLock: async () => ({ release: async () => undefined }) });
    await store.save("thread-1", messages);
    const [name] = await readdir(directory), path = join(directory, name!);
    const before = await readFile(path);
    const serialized = JSON.stringify(messages), original = Buffer.byteLength;
    // Exercise the 128 MiB logical-checkpoint boundary without allocating a
    // >128 MiB test conversation. Large real legacy records have separate tests.
    const injected = t.mock.method(Buffer, "byteLength", (value: Parameters<typeof original>[0], encoding?: BufferEncoding) =>
      value === serialized ? MAX_TRANSCRIPT_RECORD_BYTES + 1 : original(value, encoding));
    const at = new Date(0).toISOString();
    try {
      await store.compactThread("thread-1");
      await store.create({ id: "run", threadId: "thread-1", agentId: "agent", agentVersion: "1", status: "created", version: 0, createdAt: at, updatedAt: at });
    } finally { injected.mock.restore(); }
    assert.deepEqual(await readFile(path), before);
    const next = [...messages, { id: "next", role: "user" as const, parts: [{ type: "text" as const, text: "continue" }] }];
    await store.save("thread-1", next);
    await store.transition("run", 0, "completed");
    assert.deepEqual(await new JsonlAgentStore({ directory }).getMessages("thread-1"), next);
  });

  it("reports unconfirmed append sync as uncertain and freezes writes until reopen", async (t) => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    const probe = await open(join(directory, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe); await probe.close();
    const injected = t.mock.method(prototype, "sync", async () => { throw new Error("sync fault"); });
    await assert.rejects(store.save("thread-1", transcript("written but unacknowledged")), error => error instanceof Error && "data" in error && (error.data as { code: string }).code === "STORAGE_COMMIT_UNCERTAIN");
    injected.mock.restore();
    await assert.rejects(store.save("thread-1", transcript("must not retry")), /restart/);
    const at = new Date(0).toISOString();
    await assert.rejects(store.create({ id: "blocked-run", threadId: "thread-1", agentId: "agent", agentVersion: "1", status: "created", version: 0, createdAt: at, updatedAt: at }), /restart/);
    assert.equal(await store.getRun("blocked-run"), undefined, "unprotected stores must also stop Run admission");
    const reopened = new JsonlAgentStore({ directory });
    assert.deepEqual(await reopened.getMessages("thread-1"), transcript("written but unacknowledged"));
  });

  it("freezes Run admission after a pre-append repair failure, retaining committed messages", async (t) => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    const messages = transcript("committed");
    await store.save("thread-1", messages);
    const [name] = await readdir(directory);
    const path = join(directory, name!);
    await appendFile(path, "pending tail");
    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe); await probe.close();
    const injected = t.mock.method(prototype, "truncate", async () => { throw new Error("repair failed"); });
    await assert.rejects(store.save("thread-1", transcript("not written")), error => error instanceof Error && "data" in error && (error.data as { code: string }).code === "STORAGE_WRITE_FAILED");
    injected.mock.restore();
    await assert.rejects(store.save("thread-1", transcript("must not retry")), /restart/);
    const at = new Date(0).toISOString();
    await assert.rejects(store.create({ id: "blocked-run", threadId: "thread-1", agentId: "agent", agentVersion: "1", status: "created", version: 0, createdAt: at, updatedAt: at }), /restart/);
    assert.deepEqual(await store.getMessages("thread-1"), messages);
    assert.deepEqual(await new JsonlAgentStore({ directory }).getMessages("thread-1"), messages);
  });

  it("treats a close failure after append as uncertain rather than acknowledging or admitting another Run", async (t) => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    await store.save("thread-1", transcript("before"));
    const [name] = await readdir(directory);
    const path = join(directory, name!);
    const originalOpen = fs.promises.open;
    const injected = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (args[0] === path && typeof args[1] === "number" && args[1] & fs.constants.O_APPEND) {
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          await close();
          throw new Error("close acknowledgement failed");
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(store.save("thread-1", transcript("after")), error => error instanceof Error && "data" in error && (error.data as { code: string }).code === "STORAGE_COMMIT_UNCERTAIN");
    } finally { injected.mock.restore(); syncBuiltinESMExports(); }
    await assert.rejects(store.save("thread-1", transcript("no retry")), /restart/);
    assert.deepEqual(await new JsonlAgentStore({ directory }).getMessages("thread-1"), transcript("after"));
  });

  it("persists opaque context-compaction records without changing transcripts", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    const messages = transcript("latest");
    const record: ThreadContextCompactionRecord = {
      v: 2,
      type: "thread.context.compacted",
      threadId: "thread-1",
      id: "compact-1",
      firstKeptMessageIndex: 1,
      summary: {
        goal: "keep working",
        actions: ["read_file"],
      },
    };

    await store.save("thread-1", messages);
    await store.appendContextCompaction(record);

    assert.deepEqual(await store.getMessages("thread-1"), messages);
    assert.deepEqual(await store.getContextCompactions("thread-1"), [record]);

    const reopened = new JsonlAgentStore({ directory });
    assert.deepEqual(
      await reopened.getContextCompactions("thread-1"),
      [record],
    );
    assert.deepEqual(await reopened.getMessages("thread-1"), messages);
  });

  it("skips unknown v2 record types when reading compaction records", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    await store.save("thread-1", transcript("known"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    await appendFile(
      join(directory, fileName),
      `${JSON.stringify({ v: 2, type: "future.record", threadId: "thread-1" })}\n`,
      "utf8",
    );

    assert.deepEqual(await store.getMessages("thread-1"), transcript("known"));
    assert.deepEqual(await store.getContextCompactions("thread-1"), []);
  });

  it("skips malformed opaque compaction records while retaining transcript reads", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    await store.save("thread-1", transcript("known"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    await appendFile(
      join(directory, fileName),
      `${JSON.stringify({
        v: 1,
        type: "thread.context.compacted",
        threadId: 42,
        summary: { ignored: true },
      })}\n`,
      "utf8",
    );

    assert.deepEqual(await store.getMessages("thread-1"), transcript("known"));
    assert.deepEqual(await store.getContextCompactions("thread-1"), []);
  });

  it("restores the latest committed transcript after reopen", async () => {
    const directory = await temporaryDirectory();
    const first = new JsonlAgentStore({ directory });
    await first.create({
      id: "run-1",
      threadId: "thread-1",
      agentId: "agent-1",
      agentVersion: "1",
      status: "created",
      version: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    await first.append({
      id: "event-1",
      type: "run.started",
      occurredAt: new Date(0).toISOString(),
      runId: "run-1",
      threadId: "thread-1",
      sequence: 1,
      data: { agentId: "agent-1", agentVersion: "1" },
    });
    await first.save("thread-1", transcript("first"));
    await first.save("thread-1", transcript("latest"));

    const reopened = new JsonlAgentStore({ directory });
    assert.deepEqual(await reopened.getMessages("thread-1"), transcript("latest"));
    assert.equal(await reopened.getRun("run-1"), undefined);
    assert.deepEqual(await reopened.list("run-1"), []);
  });

  it("ignores a truncated final line", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    await store.save("thread-1", transcript("complete"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    await appendFile(join(directory, fileName), '{"v":1,"type":', "utf8");

    const beforeRead = await readFile(join(directory, fileName));
    assert.deepEqual(await store.getMessages("thread-1"), transcript("complete"));
    assert.deepEqual(await store.getContextCompactions("thread-1"), []);
    assert.deepEqual(await readFile(join(directory, fileName)), beforeRead);
    await store.save("thread-1", transcript("after-recovery"));
    assert.deepEqual(
      await store.getMessages("thread-1"),
      transcript("after-recovery"),
    );
  });

  it("does not truncate a writer's pending bytes during read-only queries", async () => {
    const directory = await temporaryDirectory();
    const writer = new JsonlAgentStore({ directory });
    const reader = new JsonlAgentStore({ directory });
    await writer.save("thread-1", transcript("first"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    const path = join(directory, fileName);
    const pending = JSON.stringify({
      v: 1,
      type: "thread.messages.committed",
      threadId: "thread-1",
      messages: transcript("写入未完成"),
    });
    const split = Math.floor(pending.length / 2);
    await appendFile(path, pending.slice(0, split), "utf8");
    const pendingBytes = await readFile(path);

    assert.deepEqual(await reader.getMessages("thread-1"), transcript("first"));
    assert.deepEqual(await reader.getContextCompactions("thread-1"), []);
    assert.deepEqual(await readFile(path), pendingBytes);

    await appendFile(path, `${pending.slice(split)}\n`, "utf8");
    assert.deepEqual(await reader.getMessages("thread-1"), transcript("写入未完成"));
  });

  it("commits even complete JSON only at newline and repairs it before a new append", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    await store.save("thread-1", transcript("committed"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    const path = join(directory, fileName);
    await appendFile(path, JSON.stringify({
      v: 1,
      type: "thread.messages.committed",
      threadId: "thread-1",
      messages: transcript("uncommitted"),
    }), "utf8");
    const beforeRead = await readFile(path);
    const reopened = new JsonlAgentStore({ directory });
    assert.deepEqual(await reopened.getMessages("thread-1"), transcript("committed"));
    assert.deepEqual(await readFile(path), beforeRead);

    await reopened.save("thread-1", transcript("newly committed"));
    assert.deepEqual(await reopened.getMessages("thread-1"), transcript("newly committed"));
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    assert.equal(lines.filter(line => JSON.parse(line).type === "thread.messages.committed").length, 2);
    assert.ok(lines.every((line) => JSON.parse(line).v === 3));
  });

  it("does not expose a complete compaction tail before its newline", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    await store.save("thread-1", transcript("known"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    const path = join(directory, fileName);
    const record: ThreadContextCompactionRecord = {
      v: 2,
      type: "thread.context.compacted",
      threadId: "thread-1",
      id: "uncommitted-compaction",
    };
    await appendFile(path, JSON.stringify(record), "utf8");
    const beforeRead = await readFile(path);
    assert.deepEqual(await store.getContextCompactions("thread-1"), []);
    assert.deepEqual(await readFile(path), beforeRead);
    await appendFile(path, "\n", "utf8");
    assert.deepEqual(await store.getContextCompactions("thread-1"), [record]);
  });

  it("serializes recovery, snapshot and compaction appends across store instances", async () => {
    const directory = await temporaryDirectory();
    const first = new JsonlAgentStore({ directory });
    const second = new JsonlAgentStore({ directory: join(directory, ".") });
    await first.save("thread-1", transcript("committed"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    const path = join(directory, fileName);
    await appendFile(path, '{"partial":"尾巴', "utf8");
    const records: ThreadContextCompactionRecord[] = [];
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 20; index += 1) {
      const record: ThreadContextCompactionRecord = {
        v: 2,
        type: "thread.context.compacted",
        threadId: "thread-1",
        id: `compaction-${index}`,
      };
      records.push(record);
      writes.push(first.save("thread-1", transcript(`snapshot-${index}`)));
      writes.push(second.appendContextCompaction(record));
    }
    // The read participates in the same queue, so it sees every earlier append.
    const observedMessages = second.getMessages("thread-1");
    await Promise.all(writes);
    assert.deepEqual(await observedMessages, transcript("snapshot-19"));
    assert.deepEqual(await first.getContextCompactions("thread-1"), records);
    const content = await readFile(path, "utf8");
    assert.ok(content.endsWith("\n"));
    assert.equal(content.trimEnd().split("\n").filter(line => JSON.parse(line).type === "thread.messages.committed").length, 21);
  });

  it("repairs a large UTF-8 pending tail when appending a compaction", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    await store.save("thread-1", transcript("已提交内容"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    const path = join(directory, fileName);
    const committedBytes = await readFile(path);
    await appendFile(path, `{"partial":"${"未完成".repeat(4_000)}`, "utf8");
    const record: ThreadContextCompactionRecord = {
      v: 2,
      type: "thread.context.compacted",
      threadId: "thread-1",
      id: "after-tail-repair",
    };
    await store.appendContextCompaction(record);
    assert.deepEqual(await store.getMessages("thread-1"), transcript("已提交内容"));
    assert.deepEqual(await store.getContextCompactions("thread-1"), [record]);
    assert.deepEqual(
      (await readFile(path)).subarray(0, committedBytes.length),
      committedBytes,
    );
  });

  it("recovers a first torn record without inventing a committed snapshot", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    // Reuse the opaque filename for another fresh directory containing no
    // committed newline yet, as when a process exits during its first append.
    await store.save("thread-1", transcript("filename source"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    const recoveredDirectory = await temporaryDirectory();
    const path = join(recoveredDirectory, fileName);
    await appendFile(path, '{"v":1,"type":', "utf8");
    const reopened = new JsonlAgentStore({ directory: recoveredDirectory });
    assert.deepEqual(await reopened.getMessages("thread-1"), []);
    assert.deepEqual(await reopened.getContextCompactions("thread-1"), []);
    assert.equal(await readFile(path, "utf8"), '{"v":1,"type":');
    await reopened.save("thread-1", transcript("first commit"));
    assert.deepEqual(await reopened.getMessages("thread-1"), transcript("first commit"));
    assert.equal((await readFile(path, "utf8")).trimEnd().split("\n").filter(line => JSON.parse(line).type === "thread.messages.committed").length, 1);
  });

  it("skips unknown record versions", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    await store.save("thread-1", transcript("known"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    await appendFile(
      join(directory, fileName),
      `${JSON.stringify({ v: 2, type: "future.record" })}\n`,
      "utf8",
    );

    assert.deepEqual(await store.getMessages("thread-1"), transcript("known"));
  });

  it("rejects corruption before the final line", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlAgentStore({ directory });
    await store.save("thread-1", transcript("first"));
    const [fileName] = await readdir(directory);
    assert.ok(fileName);
    await appendFile(join(directory, fileName), "not-json\n", "utf8");
    await assert.rejects(store.save("thread-1", transcript("later")), /corrupt/);

    await assert.rejects(
      store.getMessages("thread-1"),
      (error: unknown) =>
        error instanceof Error &&
        "data" in error &&
        (error as { data?: { code?: string } }).data?.code ===
          "STORAGE_CORRUPT",
    );
  });

  it("keeps a >16 MiB conversation in bounded delta records and appends only new material", async () => {
    const directory = await temporaryDirectory(), store = new JsonlAgentStore({ directory });
    const messages = transcript("中文🙂".repeat(1_800_000));
    await store.save("thread-1", messages);
    const path = join(directory, (await readdir(directory))[0]!);
    const before = (await stat(path)).size;
    assert.ok(before > 16 * 1024 * 1024);
    const next = [...messages, { id: "u2", role: "user" as const, parts: [{ type: "text" as const, text: "继续早期计划" }] }];
    await store.save("thread-1", next);
    assert.ok((await stat(path)).size - before < 2048, "the unchanged large prefix is not saved twice");
    assert.ok((await readFile(path, "utf8")).split("\n").every(line => Buffer.byteLength(line) < 270_000));
    assert.deepEqual(await new JsonlAgentStore({ directory }).getMessages("thread-1"), next);
  });

  it("ignores a complete but uncommitted chunk group, and detects committed checksum/base corruption", async () => {
    const directory = await temporaryDirectory(), store = new JsonlAgentStore({ directory });
    const previous = transcript("before"), next = transcript("after");
    await store.save("thread-1", previous);
    const path = join(directory, (await readdir(directory))[0]!);
    const update = encodeTranscriptUpdate("thread-1", previous, next);
    await appendFile(path, update.slice(0, -1).join(""));
    const beforeRead = await readFile(path);
    assert.deepEqual(await store.getMessages("thread-1"), previous);
    assert.deepEqual(await readFile(path), beforeRead);
    await appendFile(path, update.at(-1)!);
    assert.deepEqual(await store.getMessages("thread-1"), next);
    const corrupt = encodeTranscriptUpdate("thread-1", next, transcript("bad"));
    const commit = JSON.parse(corrupt.at(-1)!); commit.baseHash = "wrong";
    await appendFile(path, corrupt.slice(0, -1).join("") + JSON.stringify(commit) + "\n");
    await assert.rejects(store.getMessages("thread-1"), /corrupt/);
    await assert.rejects(store.save("thread-1", transcript("no overwrite")), /corrupt/);
  });
});

it("exclusion companions survive append, locked cleanup and reopen; corrupt exclusions fail model reads closed", async () => {
  const directory = await temporaryDirectory();
  const options = { directory, snapshotCleanupThresholdBytes: 1, acquireTranscriptLock: async () => ({ release: async () => undefined }) };
  const store = new JsonlAgentStore(options), messages = transcript("secret reply");
  await store.save("t", messages);
  await store.excludeMessage({ threadId: "t", messageId: "assistant-1", at: "2026-10-21T00:00:00Z", reason: "privacy" });
  const rawBefore = await store.getMessages("t");
  await store.save("t", [...messages, { id: "next", role: "user", parts: [{ type: "text", text: "next" }] }]);
  const reopened = new JsonlAgentStore(options);
  assert.deepEqual((await reopened.getMessages("t")).slice(0, 2), rawBefore);
  assert.equal((await reopened.getTranscriptExclusions("t")).length, 1);
  assert.doesNotMatch(JSON.stringify(await reopened.getModelMessages("t")), /secret reply/);
  const filename = (await readdir(directory)).find(name => name.endsWith(".jsonl"))!;
  await appendFile(join(directory, filename), JSON.stringify({ v: 2, type: "thread.message.excluded", threadId: "t", messageId: "user-1", at: "bad", reason: "privacy" }) + "\n");
  await assert.rejects(reopened.getModelMessages("t"), /corrupt/);
});
