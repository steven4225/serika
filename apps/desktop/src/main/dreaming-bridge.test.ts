import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { IPC } from "../shared/ui-contract.js";

async function idle(host: DesktopRuntime) {
  const deadline = Date.now() + 5000;
  while (host.current.snapshot().state.kind !== "idle") {
    if (Date.now() > deadline) throw new Error("Desktop dreaming did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

it("wires only named dreaming actions through IPC with no renderer source path", async () => {
  const main = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const preload = await readFile(new URL("../preload/index.ts", import.meta.url), "utf8");
  for (const [method, endpoint] of [["getDreamingOverview", "dreamingOverview"], ["dream", "dream"], ["changeLearnedSkill", "learnedSkillChange"], ["getLearnedSkillReferences", "learnedSkillReferences"]]) {
    assert.match(preload, new RegExp(`${method}:.*ipcRenderer\\.invoke\\(IPC\\.${endpoint}`));
    assert.match(main, new RegExp(`ipcMain\\.handle\\(IPC\\.${endpoint},.*host\\.current\\.${method}\\(`));
  }
  assert.match(preload, /setDreamingEnabled:.*ipcRenderer\.invoke\(IPC\.dreamingEnabled, input\)/);
  assert.match(main, /ipcMain\.handle\(IPC\.dreamingEnabled,.*host\.setDreamingEnabled\(input\)/);
  assert.notEqual(IPC.dream, IPC.runSkill);
});

it("keeps dreaming opt-in, persists user toggle across real runtime reload, and never calls a model for empty experience", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-dreaming-bridge-"));
  let calls = 0;
  const options = { cwd: root, userData: join(root, "profile"), env: {}, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => { calls++; throw new Error("No model call expected"); } }), send: () => {} };
  let host = await DesktopRuntime.create(options);
  try {
    const initial = host.info();
    const disabled = await host.current.getDreamingOverview();
    assert.equal(disabled.ok && disabled.value.enabled, false);
    assert.equal((await host.current.dream()).ok, false);
    await host.setDreamingEnabled({ enabled: true, expectedEnabled: false });
    assert.equal(host.info().threadId, initial.threadId); assert.equal(host.info().directory, initial.directory);
    const enabled = await host.current.getDreamingOverview();
    assert.equal(enabled.ok && enabled.value.enabled, true);
    assert.equal(enabled.ok && enabled.value.pendingExperiences, 0);
    assert.equal((await host.current.dream()).ok, false);
    assert.equal(host.current.getLearnedSkillReferences(), null);
    await host.shutdown(); host = await DesktopRuntime.create(options);
    const reopened = await host.current.getDreamingOverview();
    assert.equal(reopened.ok && reopened.value.enabled, true);
    await idle(host);
    await host.setDreamingEnabled({ enabled: false, expectedEnabled: true });
    assert.equal((await host.current.getDreamingOverview()).ok, true);
    const metadata = join(host.info().workspaceRoot!, ".runloom");
    await mkdir(metadata, { recursive: true });
    await writeFile(join(metadata, "dreaming.json"), "broken");
    const broken = await host.current.getDreamingOverview();
    assert.equal(broken.ok, false, "a corrupt learning file must not become an empty Skill list");
    if (!broken.ok) assert.equal(broken.error.code, "DREAMING_FILE_INVALID");
    assert.equal(calls, 0);
  } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
});
