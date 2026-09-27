import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { createRuntimeApp, PRIMARY_AGENT_ID } from "./app.js";
import { createDemoModel } from "./demo-model.js";

function capture(): { output: PassThrough; text(): string } {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer | string) => {
    text += chunk.toString();
  });
  return { output, text: () => text };
}

describe("createRuntimeApp", () => {
  it("assembles the demo runtime without TUI surfaces and runs one turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-app-demo-"));
    const { output } = capture();
    const app = await createRuntimeApp({
      args: [directory],
      modelAlias: "mock",
      model: createDemoModel(),
      output,
      env: {},
      cwd: directory,
    });
    try {
      assert.equal(app.tuiMode, false);
      assert.equal(app.agentId, PRIMARY_AGENT_ID);
      assert.equal(app.threadId, "demo-thread");
      assert.equal(app.directory, directory);
      assert.equal(app.toolConfirmation, undefined);
      assert.equal(app.commands, undefined);
      assert.equal(app.compaction, undefined);
      assert.equal(app.resume, undefined);
      assert.equal(app.autoConsolidationAgentId, undefined);

      const handle = await app.runtime.run({
        agentId: app.agentId,
        threadId: app.threadId,
        messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "What is 20 + 22?" }] }],
      });
      for await (const _event of handle.events) {
        // drain
      }
      const result = await handle.result;
      assert.equal(result.status, "completed");
      const committed = await app.store.getMessages(app.threadId);
      assert.equal(committed[0]?.id, "user-1");
    } finally {
      app.dispose();
      app.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("assembles TUI surfaces from an explicit config and writes command output to the given stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-app-tui-"));
    const configDirectory = join(root, "config");
    const transcripts = join(root, "transcripts");
    await mkdir(configDirectory, { recursive: true });
    await mkdir(transcripts, { recursive: true });
    const configPath = join(configDirectory, "runloom.json");
    await writeFile(configPath, JSON.stringify({ version: 1, modules: {} }), "utf8");
    const { output, text } = capture();
    const app = await createRuntimeApp({
      args: ["--tui", transcripts, "--thread", "app-test", "--config", configPath],
      modelAlias: "mock",
      model: createDemoModel(),
      output,
      env: {},
      cwd: root,
    });
    try {
      assert.equal(app.tuiMode, true);
      assert.equal(app.threadId, "app-test");
      assert.equal(app.directory, transcripts);
      assert.equal(app.workspaceRoot, undefined);
      assert.ok(app.toolConfirmation);
      assert.ok(app.commands);
      assert.deepEqual(
        [...app.commands.keys()].sort(),
        ["history", "home", "modules", "permissions"],
      );
      assert.equal(app.compaction, undefined);
      assert.equal(app.resume, undefined);

      await app.commands.get("modules")!.execute("");
      assert.match(text(), /\[modules\]/);
      assert.match(text(), /checkpoint: disabled/);
      assert.doesNotMatch(text(), /Allow this call\? \[y\/n\]/);
    } finally {
      app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
