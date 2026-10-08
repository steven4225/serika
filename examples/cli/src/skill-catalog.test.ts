import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createBuiltinSkill,
  loadSkillPackages,
  skillAgentDefinition,
  SKILL_INSTRUCTIONS_MAX_BYTES,
  SKILL_MANIFEST_MAX_BYTES,
  SKILL_PACKAGE_MAX_COUNT,
} from "./skill-catalog.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-skill-catalog-")));
  const workspace = join(root, "workspace");
  const directory = join(root, "trusted-skill");
  await Promise.all([mkdir(workspace), mkdir(directory)]);
  const manifest = { version: 1, id: "summarize", description: "Summarize supplied text", kind: "text" };
  await writeFile(join(directory, "skill.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "SKILL.md"), "Summarize only the supplied text.");
  return { root, workspace, directory, manifest, registration: { id: manifest.id, directory },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("Skill catalog", () => {
  it("loads an explicitly registered text package without tools or inherited context", async () => {
    const f = await fixture();
    try {
      const [skill] = await loadSkillPackages([f.registration], f.workspace);
      assert.ok(skill);
      assert.equal(skill.id, "summarize");
      assert.equal(skill.agentId, "skill:summarize");
      assert.equal(skill.description, f.manifest.description);
      assert.equal(skill.instructions, "Summarize only the supplied text.");
      assert.match(skill.hash, /^[a-f0-9]{64}$/);
      assert.deepEqual(skill.tools, []);
      const agent = skillAgentDefinition(skill, "test-model");
      assert.equal(agent.id, skill.agentId);
      assert.equal(agent.version, skill.hash);
      assert.equal(agent.model, "test-model");
      assert.equal(agent.instructions, skill.instructions);
      assert.deepEqual(agent.tools, []);
      assert.equal("contextSchema" in agent, false);
      assert.ok(Object.isFrozen(skill) && Object.isFrozen(skill.tools) && Object.isFrozen(skill.limits));
      agent.limits.maxSteps = 1;
      assert.equal(skill.limits.maxSteps, 4);
    } finally { await f.cleanup(); }
  });

  it("wraps builtin memory instructions with only the existing prepare/stage tools", () => {
    const skill = createBuiltinSkill({ id: "memory-consolidate", description: "Host memory consolidation",
      kind: "memory-consolidate", instructions: "Use committed sources; host owns finalization.", agentId: "memory-consolidator" });
    assert.equal(skill.agentId, "memory-consolidator");
    assert.deepEqual(skill.tools, ["memory_prepare_consolidation", "memory_stage_candidates"]);
    assert.deepEqual(skill.limits, { maxSteps: 3, totalTimeoutMs: 120_000, stepTimeoutMs: 30_000 });
    assert.equal(skillAgentDefinition(skill, "test").contextSchema, undefined);
  });

  it("loads memory packages but does not permit tool or step-budget escalation", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.directory, "skill.json"), JSON.stringify({ ...f.manifest, kind: "memory-consolidate" }));
      const [skill] = await loadSkillPackages([f.registration], f.workspace);
      assert.deepEqual(skill?.tools, ["memory_prepare_consolidation", "memory_stage_candidates"]);
      for (const override of [
        { tools: ["memory_prepare_consolidation", "memory_add"] },
        { tools: ["shell_exec"] },
        { tools: ["memory_stage_candidates", "memory_stage_candidates"] },
        { limits: { maxSteps: 4 } },
      ]) {
        await writeFile(join(f.directory, "skill.json"), JSON.stringify({ ...f.manifest, kind: "memory-consolidate", ...override }));
        await assert.rejects(loadSkillPackages([f.registration], f.workspace), /cannot request additional tools|cannot exceed 3/);
      }
    } finally { await f.cleanup(); }
  });

  it("rejects text tool requests and unknown manifest fields instead of granting capabilities", async () => {
    const f = await fixture();
    try {
      for (const override of [{ tools: ["read_file"] }, { context: "workspace" }, { scripts: ["run.sh"] }, { kind: "shell" }]) {
        await writeFile(join(f.directory, "skill.json"), JSON.stringify({ ...f.manifest, ...override }));
        await assert.rejects(loadSkillPackages([f.registration], f.workspace));
      }
      await writeFile(join(f.directory, "skill.json"), '{"version": 1,');
      await assert.rejects(loadSkillPackages([f.registration], f.workspace), /Cannot load Skill summarize/);
    } finally { await f.cleanup(); }
  });

  it("binds exact instruction bytes and normalized manifest metadata into a deterministic hash", async () => {
    const f = await fixture();
    try {
      const [original] = await loadSkillPackages([f.registration], f.workspace);
      assert.ok(original);
      await writeFile(join(f.directory, "skill.json"), JSON.stringify({ kind: "text", description: f.manifest.description,
        id: "summarize", version: 1, tools: [], limits: { stepTimeoutMs: 30_000, maxSteps: 4, totalTimeoutMs: 120_000 } }, null, 2));
      const [reformatted] = await loadSkillPackages([{ ...f.registration, expectedHash: original.hash }], f.workspace);
      assert.equal(reformatted?.hash, original.hash);
      await writeFile(join(f.directory, "SKILL.md"), original.instructions + "\nChanged instruction.");
      await assert.rejects(loadSkillPackages([{ ...f.registration, expectedHash: original.hash }], f.workspace), /Skill hash mismatch: expected .* received/);
      const [changed] = await loadSkillPackages([f.registration], f.workspace);
      assert.notEqual(changed?.hash, original.hash);
      await writeFile(join(f.directory, "SKILL.md"), original.instructions);
      await writeFile(join(f.directory, "skill.json"), JSON.stringify({ ...f.manifest, description: "Changed description" }));
      await assert.rejects(loadSkillPackages([{ ...f.registration, expectedHash: original.hash }], f.workspace), /Skill hash mismatch/);
    } finally { await f.cleanup(); }
  });

  it("rejects relative registration paths, duplicate registrations and mismatched manifest ids", async () => {
    const f = await fixture();
    try {
      await assert.rejects(loadSkillPackages([{ id: "summarize", directory: "trusted-skill" }], f.workspace), /absolute path/);
      await assert.rejects(loadSkillPackages([f.registration, f.registration], f.workspace), /Duplicate Skill id/);
      await assert.rejects(loadSkillPackages([{ ...f.registration, id: "different" }], f.workspace), /does not match registered id/);
      await assert.rejects(loadSkillPackages([{ ...f.registration, expectedHash: "not-a-hash" }], f.workspace), /SHA-256/);
    } finally { await f.cleanup(); }
  });

  it("rejects workspace packages, symlink packages and paths resolving into a workspace", async () => {
    const f = await fixture();
    try {
      const internal = join(f.workspace, "skill");
      await mkdir(internal);
      await assert.rejects(loadSkillPackages([{ ...f.registration, directory: internal }], f.workspace), /outside the workspace/);
      const link = join(f.root, "skill-link");
      await symlink(f.directory, link, "dir");
      await assert.rejects(loadSkillPackages([{ ...f.registration, directory: link }], f.workspace), /non-symlink directory/);
      const workspaceLink = join(f.root, "workspace-link");
      await symlink(f.workspace, workspaceLink, "dir");
      await assert.rejects(loadSkillPackages([{ ...f.registration, directory: join(workspaceLink, "skill") }], f.workspace), /outside the workspace/);
      // Workspace's own aliases cannot evade the canonical containment test.
      await assert.rejects(loadSkillPackages([{ ...f.registration, directory: internal }], workspaceLink), /outside the workspace/);
    } finally { await f.cleanup(); }
  });

  it("rejects symlink instruction and manifest files", async () => {
    for (const name of ["SKILL.md", "skill.json"]) {
      const f = await fixture();
      try {
        const content = name === "SKILL.md" ? "Instructions" : JSON.stringify(f.manifest);
        const target = join(f.root, `actual-${name}`);
        await writeFile(target, content);
        await rm(join(f.directory, name));
        await symlink(target, join(f.directory, name));
        await assert.rejects(loadSkillPackages([f.registration], f.workspace), /regular non-symlink file/);
      } finally { await f.cleanup(); }
    }
  });

  it("bounds loaded packages and both file sizes, and rejects invalid UTF-8 or empty instructions", async () => {
    const f = await fixture();
    try {
      await assert.rejects(loadSkillPackages(Array.from({ length: SKILL_PACKAGE_MAX_COUNT + 1 }, (_, i) =>
        ({ id: `skill-${i}`, directory: f.directory })), f.workspace));
      await writeFile(join(f.directory, "SKILL.md"), "x".repeat(SKILL_INSTRUCTIONS_MAX_BYTES + 1));
      await assert.rejects(loadSkillPackages([f.registration], f.workspace), /exceeds/);
      await writeFile(join(f.directory, "SKILL.md"), Buffer.from([0xff]));
      await assert.rejects(loadSkillPackages([f.registration], f.workspace), /encoded data/);
      await writeFile(join(f.directory, "SKILL.md"), " \n ");
      await assert.rejects(loadSkillPackages([f.registration], f.workspace), /nonempty/);
      await writeFile(join(f.directory, "SKILL.md"), "Valid instructions.");
      await writeFile(join(f.directory, "skill.json"), " ".repeat(SKILL_MANIFEST_MAX_BYTES + 1));
      await assert.rejects(loadSkillPackages([f.registration], f.workspace), /exceeds/);
    } finally { await f.cleanup(); }
  });

  it("never discovers workspace skills or reads scripts/assets and accepts an empty catalog", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.directory, "assets"));
      await writeFile(join(f.directory, "run.sh"), "exit 1\n");
      await symlink("/does-not-exist", join(f.directory, "assets", "unreadable"));
      const loaded = await loadSkillPackages([f.registration], f.workspace);
      assert.equal(loaded.length, 1);
      assert.deepEqual(await loadSkillPackages([], "/does-not-exist"), []);
    } finally { await f.cleanup(); }
  });

  it("normalizes builtin and external metadata equally and allows only bounded limits", () => {
    const input = { id: "text-skill", description: "Test text", kind: "text" as const, instructions: "Do the task." };
    const skill = createBuiltinSkill(input);
    assert.equal(createBuiltinSkill({ ...input, tools: [], limits: { maxSteps: 4 } }).hash, skill.hash);
    assert.notEqual(createBuiltinSkill({ ...input, limits: { maxSteps: 1 } }).hash, skill.hash);
    assert.throws(() => createBuiltinSkill({ ...input, tools: ["memory_stage_candidates"] }), /additional tools/);
    assert.throws(() => createBuiltinSkill({ ...input, limits: { totalTimeoutMs: 120_001 } }));
    assert.throws(() => createBuiltinSkill({ ...input, agentId: " " }), /agentId/);
  });
});
