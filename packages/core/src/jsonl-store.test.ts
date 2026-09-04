import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { UIMessage } from "ai";
import { JsonlAgentStore } from "./jsonl-store.js";

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

    assert.deepEqual(await store.getMessages("thread-1"), transcript("complete"));
    await store.save("thread-1", transcript("after-recovery"));
    assert.deepEqual(
      await store.getMessages("thread-1"),
      transcript("after-recovery"),
    );
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
