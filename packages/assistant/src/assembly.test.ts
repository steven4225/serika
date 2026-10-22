import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createRuntimeApp, type RuntimeApp } from "./app.js";
import { assertAssemblyCombination } from "./assembly.js";
import { createDemoModel } from "./demo-model.js";

async function ask(app: RuntimeApp, threadId: string, text: string): Promise<void> {
  const unsubscribe = app.toolConfirmation?.subscribePending(pending => {
    if (pending) app.toolConfirmation!.resolveApproval({ approvalId: pending.approvalId, decision: "allow" });
  });
  const handle = await app.runtime.run({
    agentId: app.agentId,
    threadId,
    messages: [{ id: `user-${text}`, role: "user", parts: [{ type: "text", text }] }],
  });
  const result = await handle.result;
  unsubscribe?.();
  assert.equal(result.status, "completed");
}

// A1: the assistant can be assembled twice in one process; every location is
// passed in, so the two instances share no transcripts or memory.
test("two assistants assembled in one process keep their data apart", async () => {
  const roots = await Promise.all([mkdtemp(join(tmpdir(), "serika-a1-a-")), mkdtemp(join(tmpdir(), "serika-a1-b-"))]);
  const apps: RuntimeApp[] = [];
  try {
    for (const root of roots) {
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true } } }));
      apps.push(await createRuntimeApp({
        directory: join(root, "transcripts"),
        assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "same-thread", configPath },
        modelAlias: "mock", model: createDemoModel(), demoTools: true,
        output: new PassThrough().resume(), env: {}, cwd: root,
      }));
    }
    const [first, second] = apps as [RuntimeApp, RuntimeApp];
    assert.notEqual(first.store, second.store);
    assert.notEqual(first.runtime, second.runtime);

    await ask(first, "same-thread", "Please add 2 and 3");
    assert.ok((await first.store.getMessages("same-thread")).length >= 2);
    assert.deepEqual(await second.store.getMessages("same-thread"), []);
    assert.deepEqual(await readdir(join(roots[1]!, "workspace")), []);
  } finally {
    for (const app of apps) app.dispose();
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
});

test("structured assembly rejects the same combinations as the CLI flags", () => {
  assert.doesNotThrow(() => assertAssemblyCombination({ configPath: "/c.json", threadId: "t" }));
  assert.doesNotThrow(() => assertAssemblyCombination({ workspace: "/w", todoistEnabled: true, autoConsolidate: true }));
  assert.throws(() => assertAssemblyCombination({ configPath: "/c.json", workspace: "/w" }), /--workspace/);
  assert.throws(() => assertAssemblyCombination({ configPath: "/c.json", todoistEnabled: true }), /--todoist/);
  assert.throws(() => assertAssemblyCombination({ configPath: "/c.json", autoConsolidate: true }), /--auto-consolidate/);
});

test("createRuntimeApp refuses a contradictory structured assembly before touching disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-a1-bad-"));
  try {
    await assert.rejects(createRuntimeApp({
      directory: join(root, "transcripts"),
      assistant: { dataDirectory: join(root, ".runloom"), configPath: join(root, "missing.json"), workspace: root },
      modelAlias: "mock", model: createDemoModel(), output: new PassThrough(), env: {}, cwd: root,
    }), /--config cannot be combined with module selection options/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
