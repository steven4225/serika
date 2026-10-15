import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp, type RuntimeApp } from "./app.js";
import { MEMORY_SKILL_ID } from "./automation-execution.js";
import { SKILL_INSTRUCTIONS_MAX_BYTES } from "./skill-catalog.js";

// Exercise the actual production descriptor, not a shortened fixture or a
// separately copied prompt. Startup must remain usable before any model call.
for (const writePolicy of ["automatic", "review"] as const) {
  test(`memory ${writePolicy} startup keeps its production Skill inside the existing instruction budget`, async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-instruction-budget-"));
    let app: RuntimeApp | undefined;
    const output = new PassThrough(); output.resume();
    try {
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const config = join(root, "config.json");
      await writeFile(config, JSON.stringify({ version: 1, workspace, modules: {
        memory: { enabled: true, autoConsolidate: true, writePolicy },
      } }));
      const model = new MockLanguageModelV3({ doStream: async () => assert.fail("Construction must not invoke a model") });
      app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "instruction-budget", "--config", config],
        modelAlias: "fixture/no-network", model, output, env: {}, cwd: root });
      const skill = app.automation?.getSkill(MEMORY_SKILL_ID);
      assert.ok(skill, "Automatic consolidation must register its real memory Skill");
      const bytes = Buffer.byteLength(skill.instructions, "utf8");
      assert.ok(bytes > 0 && bytes <= SKILL_INSTRUCTIONS_MAX_BYTES,
        `${writePolicy} memory instructions are ${bytes} bytes; existing limit is ${SKILL_INSTRUCTIONS_MAX_BYTES}`);
      assert.equal(skill.tools.length, 0, "Host extraction must stay tool-free");
      assert.equal(SKILL_INSTRUCTIONS_MAX_BYTES, 16_384, "Do not weaken the production limit to accommodate prompt growth");
    } finally {
      app?.dispose(); output.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });
}
