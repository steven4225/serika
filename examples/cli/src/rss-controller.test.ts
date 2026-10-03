import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { createScheduledDemoModel } from "./task-worker-entry.js";

it("Controller RSS requests are workspace-bound, read-only when querying, revision-checked and idle-only", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rss-controller-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace, modules: { task: { enabled: true } } }));
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "rss-test", "--config", join(root, "config.json")], modelAlias: "mock", model: createScheduledDemoModel(), output: new PassThrough(), cwd: root, env: {} });
  const controller = createAssistantController(app);
  try {
    assert((await controller.getRssSubscriptions()).ok);
    assert((await controller.getRssInbox()).ok);
    await assert.rejects(readFile(join(workspace, ".runloom/rss.json")), { code: "ENOENT" });
    const added = await controller.updateRssSubscriptions({ action: "add", expectedRevision: 1, name: "Example", url: "https://example.com/feed" }); assert(added.ok);
    const foreign = await controller.updateRssSubscriptions({ action: "add", expectedRevision: added.value.revision, name: "Foreign", url: "https://example.org/feed", workspace: "/outside" } as never);
    assert(!foreign.ok);
    const pending = controller.updateRssSubscriptions({ action: "source-enabled", expectedRevision: added.value.revision, id: added.value.sources[0]!.id, enabled: false });
    const busy = await controller.updateRssSubscriptions({ action: "remove", expectedRevision: added.value.revision, id: added.value.sources[0]!.id });
    assert(!busy.ok && busy.error.code === "BUSY");
    assert((await pending).ok);
    const stale = await controller.updateRssSubscriptions({ action: "remove", expectedRevision: added.value.revision, id: added.value.sources[0]!.id });
    assert(!stale.ok && stale.error.code === "RSS_CONFLICT");
    const acknowledging = controller.acknowledgeRssResult("foreign-task");
    assert.equal(controller.getSnapshot().state.kind, "command");
    const overlapping = await controller.updateRssSubscriptions({ action: "remove", expectedRevision: added.value.revision, id: added.value.sources[0]!.id });
    assert(!overlapping.ok && overlapping.error.code === "BUSY");
    assert(!(await acknowledging).ok);
    assert.equal(controller.getSnapshot().state.kind, "idle");
    assert.equal(controller.getSnapshot().lastPrimaryResult, null);
    assert.equal((await controller.getHistory()).length, 0);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
});
