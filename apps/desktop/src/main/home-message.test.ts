import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { formatHome } from "@serika/assistant";
import { DesktopRuntime } from "./desktop-runtime.js";
import type { MainToRenderer } from "../shared/ui-contract.js";

// v2 pilot step 3: the panel receives the structured Home; the CLI text of the same snapshot still reaches the output log.
it("sends a cleared then a structured Home, and records the same snapshot's CLI text as output", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-home-")));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json"); await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { checkpoint: { enabled: true }, task: { enabled: true } } }));
  const events: MainToRenderer[] = [];
  const model = new MockLanguageModelV3({ doStream: async () => { throw new Error("Home must not call a model"); } });
  const host = await DesktopRuntime.create({ applicationHome: join(root, "profile"), cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", model, send: message => events.push(message) });
  try {
    events.length = 0;
    assert.equal((await host.current.home()).ok, true);
    const homes = events.filter(event => event.type === "home");
    assert.equal(homes.length, 2);
    assert.equal(homes[0]!.snapshot, null);
    const snapshot = homes[1]!.snapshot!;
    assert.deepEqual(snapshot.sections.map(section => section.kind), ["checkpoint", "git", "tasks"]);
    assert.deepEqual(snapshot.entries, ["/modules", "/resume", "/task inbox"]);
    const output = events.flatMap(event => event.type === "output" ? [event.text] : []).join("");
    assert.ok(output.includes(`\n${formatHome(snapshot)}\n`));
  } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
});
