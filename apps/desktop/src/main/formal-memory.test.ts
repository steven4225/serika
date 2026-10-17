import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createDemoModel } from "@serika/assistant";
import { RuntimeBridge, TeeOutput, assistantEventToRenderer } from "./runtime-bridge.js";
import type { MainToRenderer } from "../shared/ui-contract.js";

it("formal Memory bridge edits actual current versions, validates IPC, preserves scope and requires reread after a conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-formal-bridge-"));
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace: "./workspace", modules: { memory: { enabled: true } } }));
  const messages: MainToRenderer[] = [];
  const output = new TeeOutput(message => messages.push(message));
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "bridge-a", configPath: join(root, "config.json") }, modelAlias: "mock", model: createDemoModel(), output, env: {}, cwd: root });
  const controller = createAssistantController(app); output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, message => messages.push(message));
  try {
    const entry = await app.memoryStore!.add({ text: "复盘先给结论" }); assert.ok(entry.ok); if (!entry.ok) return;
    const privateEntry = await app.memoryStore!.add({ text: "私有", scope: { kind: "thread", threadId: "other" } }); assert.ok(privateEntry.ok); if (!privateEntry.ok) return;
    assert.equal(bridge.info().memory.queryRewriteEnabled, false);
    const list = await bridge.listMemories(); assert.ok(list.ok); if (!list.ok) return;
    assert.equal(list.value.entries.length, 1);
    assert.ok(!(await bridge.getMemory(privateEntry.entry.id)).ok);
    for (const bad of [null, [], "string", { offset: -1 }, { limit: 100 }]) assert.ok(!(await bridge.listMemories(bad as never)).ok);
    assert.ok(!(await bridge.getMemory(null as never)).ok);
    assert.ok(!(await bridge.updateMemory({ id: entry.entry.id, expectedRevision: 1, pinned: true, scope: { kind: "workspace" } } as never)).ok);
    const pinned = await bridge.updateMemory({ id: entry.entry.id, expectedRevision: 1, pinned: true }); assert.ok(pinned.ok); if (!pinned.ok) return;
    assert.equal(pinned.value.revision, 2);
    const conflict = await bridge.updateMemory({ id: entry.entry.id, expectedRevision: 1, text: "覆盖" });
    assert.ok(!conflict.ok && conflict.error.code === "MEMORY_REVISION_CONFLICT");
    const reread = await bridge.getMemory(entry.entry.id); assert.ok(reread.ok && reread.value.text === "复盘先给结论");
    const disabled = await bridge.updateMemory({ id: entry.entry.id, expectedRevision: 2, status: "disabled" }); assert.ok(disabled.ok && disabled.value.status === "disabled");
    assert.ok(messages.some(message => message.type === "memory-updated" && message.reason === "write"));
    assert.equal((await controller.listRuns()).length, 0);
    assert.equal(bridge.getMemoryReferences(), null);
    assert.deepEqual(assistantEventToRenderer({ type: "memory-references-changed" }), { type: "memory-references-changed" });
  } finally { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
});
