import assert from "node:assert/strict";
import { rm, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { IPC_FORWARDS, forwardChannel } from "../shared/ipc-forwards.js";

function pick(source: Record<string, number>, keys: string[]): Record<string, number | undefined> {
  return Object.fromEntries(keys.map(key => [key, source[key]]));
}

async function idle(host: DesktopRuntime) {
  const deadline = Date.now() + 5000;
  while (host.current.snapshot().state.kind !== "idle") {
    if (Date.now() > deadline) throw new Error("Desktop dreaming did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

it("wires only named dreaming actions through IPC with no renderer source path", () => {
  assert.deepEqual(pick(IPC_FORWARDS.current, ["getDreamingOverview", "dream", "changeLearnedSkill", "getLearnedSkillReferences"]),
    { getDreamingOverview: 0, dream: 0, changeLearnedSkill: 1, getLearnedSkillReferences: 0 });
  assert.notEqual(forwardChannel("current", "dream"), forwardChannel("current", "runSkill"));
});

it("keeps method extraction paused across reload and preserves corrupt-store diagnostics without a model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-dreaming-bridge-"));
  await mkdir(join(root, "project"));
  let calls = 0;
  const options = { cwd: root, applicationHome: join(root, "profile"), env: { RUNLOOM_WORKSPACE: join(root, "project") }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => { calls++; throw new Error("No model call expected"); } }), send: () => {} };
  let host = await DesktopRuntime.create(options);
  try {
    const initial = host.info();
    const disabled = await host.current.getDreamingOverview();
    assert.equal(disabled.ok && disabled.value.enabled, false);
    assert.equal((await host.current.dream()).ok, false);
    assert.equal(host.info().threadId, initial.threadId); assert.equal(host.info().directory, initial.directory);
    const enabled = await host.current.getDreamingOverview();
    assert.equal(enabled.ok && enabled.value.enabled, false);
    assert.equal(enabled.ok && enabled.value.pendingExperiences, 0);
    assert.equal((await host.current.dream()).ok, false);
    assert.equal(host.current.getLearnedSkillReferences(), null);
    await host.shutdown(); host = await DesktopRuntime.create(options);
    const reopened = await host.current.getDreamingOverview();
    assert.equal(reopened.ok && reopened.value.enabled, false);
    await idle(host);
    assert.equal((await host.current.getDreamingOverview()).ok, true);
    const metadata = join(root, "profile", "data");
    await mkdir(metadata, { recursive: true });
    await writeFile(join(metadata, "dreaming.json"), "broken");
    const broken = await host.current.getDreamingOverview();
    assert.equal(broken.ok, false, "a corrupt learning file must not become an empty Skill list");
    if (!broken.ok) assert.equal(broken.error.code, "DREAMING_FILE_INVALID");
    assert.equal(calls, 0);
  } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
});
