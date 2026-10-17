import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { createRuntimeApp } from "@serika/example-cli/dist/app.js";
import { createAssistantController } from "@serika/example-cli/dist/assistant-controller.js";
import { createDemoModel } from "@serika/example-cli/dist/demo-model.js";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";
import type { MemoryImportConfirm } from "@serika/example-cli/dist/memory-import.js";

it("desktop imports and manages recipes through idle Controller ports, without Runs, tools or forged sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-import-bridge-")); await mkdir(join(root, "workspace"));
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace: "./workspace", modules: { memory: { enabled: true }, shell: { enabled: true } } }));
  const output = new TeeOutput(() => {});
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "import-thread", "--config", join(root, "config.json")], modelAlias: "mock", model: createDemoModel(), output, env: {}, cwd: root });
  const controller = createAssistantController(app); output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, () => {});
  try {
    const entries = [{ text: "Manual imported preference", kind: "preference" as const }];
    assert.equal((await bridge.previewMemoryImport([{ ...entries[0]!, scope: { kind: "thread", threadId: "other" } }] as never)).ok, false);
    const preview = await bridge.previewMemoryImport(entries); assert.ok(preview.ok);
    const input: MemoryImportConfirm = { entries, snapshot: preview.value.snapshot, operationId: "desktop-import" };
    const result = await bridge.confirmMemoryImport(input); assert.ok(result.ok);
    assert.deepEqual(await bridge.getMemoryImportReceipt(input.operationId), result);
    const memory = await bridge.getMemory(result.value.items[0]!.id); assert.ok(memory.ok);
    assert.deepEqual(memory.value.source, { kind: "manual" });
    assert.deepEqual(memory.value.scope, { kind: "workspace" });
    const recipe = await app.recipes!.save({ id: "summary", description: "Tested summary", command: "true", cwd: "." }, { threadId: app.threadId, runId: "test", toolCallId: "shell-test" }, 0, new AbortController().signal);
    const listed = await bridge.listRecipes(); assert.ok(listed.ok); assert.equal(listed.value.length, 1);
    assert.equal((await bridge.changeRecipe({ id: recipe.id, expectedRevision: 1, action: "disable", command: "rm anything" } as never)).ok, false);
    const disabled = await bridge.changeRecipe({ id: recipe.id, expectedRevision: 1, action: "disable" }); assert.ok(disabled.ok); assert.equal(disabled.value.enabled, false);
    assert.equal((await bridge.changeRecipe({ id: recipe.id, expectedRevision: 1, action: "enable" })).ok, false, "stale CAS rejected");
    await assert.rejects(app.recipes!.get(recipe.id, recipe.activeHash, new AbortController().signal), /disabled/);
    assert.equal((await controller.listRuns()).length, 0);
    assert.equal(controller.getSnapshot().state.kind, "idle");
  } finally { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
});
