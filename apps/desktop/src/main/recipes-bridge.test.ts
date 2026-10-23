import { dirname } from "node:path";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createDemoModel } from "@serika/assistant";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";

it("desktop manages recipes through idle Controller ports, without Runs, tools or forged sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-import-bridge-")); await mkdir(join(root, "workspace"));
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, authorizedDirectory: "./workspace", modules: { memory: { enabled: true }, shell: { enabled: true } } }));
  const output = new TeeOutput(() => {});
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(dirname(join(root, "config.json")), "workspace/.runloom"), threadId: "import-thread", configPath: join(root, "config.json") }, modelAlias: "mock", model: createDemoModel(), output, env: {}, cwd: root });
  const controller = createAssistantController(app); output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, () => {});
  try {
    const recipe = await app.recipes!.save({ id: "summary", description: "Tested summary", command: "true", cwd: "." }, { threadId: app.threadId, runId: "test", toolCallId: "shell-test" }, 0, new AbortController().signal);
    const listed = await bridge.listRecipes(); assert.ok(listed.ok); assert.equal(listed.value.length, 1);
    assert.equal((await bridge.changeRecipe({ id: recipe.id, expectedRevision: 1, action: "disable", command: "rm anything" } as never)).ok, false);
    const disabled = await bridge.changeRecipe({ id: recipe.id, expectedRevision: 1, action: "disable" }); assert.ok(disabled.ok); assert.equal(disabled.value.enabled, false);
    assert.equal((await bridge.changeRecipe({ id: recipe.id, expectedRevision: 1, action: "enable" })).ok, false, "stale CAS rejected");
    await assert.rejects(app.recipes!.get(recipe.id, recipe.activeHash, new AbortController().signal), /disabled/);
    assert.equal((await controller.runs.list()).length, 0);
    assert.equal(controller.getSnapshot().state.kind, "idle");
  } finally { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
});
