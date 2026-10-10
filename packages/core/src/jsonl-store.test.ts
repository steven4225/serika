import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { UIMessage } from "ai";
import { JsonlAgentStore } from "./jsonl-store.js";
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
    assert.equal((await readFile(path, "utf8")).trimEnd().split("\n").length, 2);
    await appendFile(path, "not-json\n");
    const before = await readFile(path);
    const protectedStore = new JsonlAgentStore({ directory, snapshotCleanupThresholdBytes: 1,
      acquireTranscriptLock: async () => ({ release: async () => undefined }),
    });
    await assert.rejects(protectedStore.save("thread-1", transcript("do not mask corruption")), /corrupt/);
    assert.deepEqual(await readFile(path), before);
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
    const reopened = new JsonlAgentStore({ directory });
    assert.deepEqual(await reopened.getMessages("thread-1"), transcript("written but unacknowledged"));
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
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => JSON.parse(line).type === "thread.messages.committed"));
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
    assert.equal(content.trimEnd().split("\n").length, 41);
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
    assert.equal((await readFile(path, "utf8")).trimEnd().split("\n").length, 1);
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
    await store.save("thread-1", transcript("later"));

    await assert.rejects(
      store.getMessages("thread-1"),
      (error: unknown) =>
        error instanceof Error &&
        "data" in error &&
        (error as { data?: { code?: string } }).data?.code ===
          "STORAGE_CORRUPT",
    );
  });
});
