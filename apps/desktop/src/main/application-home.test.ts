import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createTaskStore } from "@serika/assistant";
import { createMemoryStore } from "@serika/assistant/testing";
import { DesktopRuntime } from "./desktop-runtime.js";
import { TelegramStore } from "./telegram-store.js";
import { resolveResidentPaths } from "./resident-service.js";

it("isolates two homes sharing a project without aliases; changing project preserves Thread and disables the old grant", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-a2-home-")));
  const project = join(root, "project"), otherProject = join(root, "other-project");
  const firstHome = join(root, "first"), secondHome = join(root, "second");
  await mkdir(project); await mkdir(otherProject);
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls++;
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "reply" }, { type: "text-delta", id: "reply", delta: "offline reply" }, { type: "text-end", id: "reply" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      } },
    ] }) };
  } });
  const options = (applicationHome: string) => ({ applicationHome, cwd: root, env: { RUNLOOM_WORKSPACE: project }, modelAlias: "mock", model, send() {} });
  let first: DesktopRuntime | undefined, second: DesktopRuntime | undefined;
  try {
    first = await DesktopRuntime.create(options(firstHome));
    second = await DesktopRuntime.create(options(secondHome));
    const identity = first.info();
    assert.notEqual(identity.threadId, second.info().threadId);
    assert.ok(identity.directory.startsWith(join(firstHome, "transcripts")));
    const paths1 = resolveResidentPaths(firstHome, 501), paths2 = resolveResidentPaths(secondHome, 501);
    assert.notEqual(paths1.socketPath, paths2.socketPath);
    assert.notEqual(paths1.identityPath, paths2.identityPath);
    assert.equal(paths1.stateDirectory, join(firstHome, "resident"));
    const channel = new TelegramStore(join(paths1.stateDirectory, "telegram.json"), firstHome);
    await channel.load(); await channel.update(data => { data.offset = 5; });
    await assert.rejects(readFile(join(paths2.stateDirectory, "telegram.json")), { code: "ENOENT" });
    assert.ok((await createMemoryStore(join(firstHome, "data/memory.json")).add({ text: "first home only" })).ok);
    const secondMemory = await second.current.listMemories();
    assert.ok(secondMemory.ok); assert.deepEqual(secondMemory.value.entries, []);
    const tasks = createTaskStore(join(firstHome, "data/tasks.json"));
    assert.ok((await tasks.create({ prompt: "first reminder", runAt: new Date(Date.now() + 60_000).toISOString() })).ok);
    const secondTasks = await createTaskStore(join(secondHome, "data/tasks.json")).list();
    assert.ok(secondTasks.ok); assert.deepEqual(secondTasks.value.tasks, []);
    assert.ok((await first.current.run("keep this original user message", { memoryConsolidation: "exclude" })).ok);
    const deadline = Date.now() + 5_000;
    while (first.current.snapshot().state.kind !== "idle") {
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));
    }
    await first.setAutonomyEnabled({ enabled: true, expectedEnabled: false });
    assert.equal(first.info().autonomy?.enabled, true);
    await first.shutdown(); first = undefined;
    const configPath = join(firstHome, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.authorizedDirectory = otherProject;
    await writeFile(configPath, JSON.stringify(config));
    first = await DesktopRuntime.create({ ...options(firstHome), env: {} });
    assert.equal(first.info().workspaceRoot, otherProject);
    const reopenedChannel = new TelegramStore(channel.path, firstHome); await reopenedChannel.load();
    assert.equal(reopenedChannel.snapshot().offset, 5);
    await assert.rejects(new TelegramStore(channel.path, secondHome).load(), /状态无效/);
    assert.equal(first.info().threadId, identity.threadId);
    assert.equal(first.info().directory, identity.directory);
    assert.equal(first.info().autonomy?.enabled, false);
    assert.ok((await first.current.history()).some(message => message.role === "user" && JSON.stringify(message.parts).includes("keep this original user message")));
    assert.equal(calls, 1, "restart and project selection do not invoke a model");
    assert.deepEqual(await readdir(project), []);
    assert.deepEqual(await readdir(otherProject), []);
  } finally {
    await first?.shutdown(); await second?.shutdown(); await rm(root, { recursive: true, force: true });
  }
});
