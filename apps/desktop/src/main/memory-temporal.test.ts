import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createDemoModel } from "@serika/assistant";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";

it("temporal desktop IPC previews without writes, preserves history and requires explicit restore choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-temporal-bridge-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true } } }));
  const output = new TeeOutput(() => {});
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "a", configPath: join(root, "config.json") }, modelAlias: "mock", model: createDemoModel(), output, env: {}, cwd: root });
  const controller = createAssistantController(app); output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, () => {});
  controller.subscribe(event => { if (event.type === "approval") controller.confirm({ approvalId: event.approval.approvalId, decision: "deny" }); });
  try {
    const added = await app.memoryStore!.add({ text: "复盘：先结论，再两条步骤", kind: "preference" }); assert.ok(added.ok); if (!added.ok) return;
    const id = added.entry.id;
    const history = await bridge.getMemoryHistory({ id }); assert.ok(history.ok); if (!history.ok) return;
    const assertion = history.value.assertions[0]!;
    const before = await readFile(join(workspace, ".runloom/memory.json"), "utf8");
    const proposed = await bridge.previewMemoryAction({ id, expectedRevision: 1, operation: "correct", text: "复盘：先结论，再三条步骤" });
    assert.ok(proposed.ok && proposed.value.proposedAssertion?.text.includes("三条"));
    assert.equal(await readFile(join(workspace, ".runloom/memory.json"), "utf8"), before);
    assert.ok(!(await bridge.previewMemoryAction({ id, expectedRevision: 1, operation: "correct", text: "伪造", sources: [{ kind: "manual" }] } as never)).ok);
    const applied = await bridge.applyMemoryAction({ id, expectedRevision: 1, operation: "correct", text: "复盘：先结论，再三条步骤" }); assert.ok(applied.ok && applied.value?.revision === 2);
    const stale = await bridge.applyMemoryAction({ id, expectedRevision: 1, operation: "delete" }); assert.ok(!stale.ok && stale.error.code === "MEMORY_REVISION_CONFLICT");
    const disabled = await bridge.applyMemoryAction({ id, expectedRevision: 2, operation: "metadata", status: "disabled" }); assert.ok(disabled.ok && disabled.value?.status === "disabled");
    assert.ok(!(await bridge.previewMemoryAction({ id, expectedRevision: 3, operation: "restore", targetAssertionId: assertion.assertionId })).ok);
    const restored = await bridge.applyMemoryAction({ id, expectedRevision: 3, operation: "restore", targetAssertionId: assertion.assertionId, status: "active", expiresAt: null });
    assert.ok(restored.ok && restored.value?.revision === 4 && restored.value.text.includes("两条"));
    const maintained = await bridge.getMemoryMaintenance(); assert.ok(maintained.ok && maintained.value.stored === 1 && maintained.value.consolidation.state === "off");
    assert.equal((await controller.listRuns()).length, 0);
    const deleted = await bridge.applyMemoryAction({ id, expectedRevision: 4, operation: "delete" }); assert.ok(deleted.ok && deleted.value === null);
    assert.ok(!(await bridge.getMemoryHistory({ id })).ok);
    assert.ok(!(await bridge.applyMemoryAction({ id, expectedRevision: 4, operation: "restore", targetAssertionId: assertion.assertionId, status: "active", expiresAt: null })).ok);
  } finally { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it("desktop exclusion reaches the Controller's persistent ordinary-message metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-exclude-bridge-"));
  const output = new TeeOutput(() => {});
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "exclude" }, modelAlias: "mock", model: createDemoModel(), output, env: {}, cwd: root });
  const controller = createAssistantController(app); output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, () => {});
  controller.subscribe(event => { if (event.type === "approval") controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" }); });
  try {
    const done = new Promise<void>(resolve => { const stop = controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { stop(); resolve(); } }); });
    const started = await bridge.run("请算 1+2", { memoryConsolidation: "exclude" }); assert.ok(started.ok);
    await done;
    const messages = await app.store.getMessages(app.threadId);
    assert.ok(messages.some(message => message.role === "user" && (message.metadata as Record<string, unknown>)?.memoryConsolidation === "exclude"));
  } finally { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
});
