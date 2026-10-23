import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";

it("an instance without an authorized directory cannot register file tools or enable a foreign grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-no-directory-")), configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, modules: { memory: { enabled: true } }, desktopAutonomy: { authorizedDirectory: root } }));
  const model = new MockLanguageModelV3({ doStream: async options => {
    assert.ok(options.tools?.every(tool => !["read_file", "write_file", "shell_exec"].includes(tool.name)));
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "unauthorized", toolName: "write_file", input: JSON.stringify({ path: "must-not-exist", content: "no" }) },
      { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined } } },
    ] }) };
  } });
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { configPath, dataDirectory: join(root, "data") },
    modelAlias: "scripted", model, output: new PassThrough(), cwd: root, env: {}, allowDesktopAutonomy: true });
  try {
    assert.equal(app.authorizedDirectory, undefined); assert.equal(app.desktopAutonomyEnabled, false);
    assert.equal(app.commands?.has("authorize"), false);
    const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId,
      messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "write" }] }] });
    assert.equal((await handle.result).status, "failed");
    await assert.rejects(readFile(join(root, "must-not-exist")), { code: "ENOENT" });
  } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
});
