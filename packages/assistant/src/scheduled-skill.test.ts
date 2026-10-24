import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createTaskStore, validateTaskArrangement, type TaskRecord } from "./task-store.js";
import { loadScheduledSkillAutomation, prepareScheduledSkillTask } from "./scheduled-skill.js";
import { scheduleRegisteredSkill } from "./automation-scheduling.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-scheduled-skill-")));
  const workspace = join(root, "workspace");
  const directory = join(root, "brief");
  const configPath = join(root, "config.json");
  await mkdir(workspace); await mkdir(directory);
  await writeFile(join(directory, "SKILL.md"), "Summarize the supplied text. No external facts.");
  await writeFile(join(directory, "skill.json"), JSON.stringify({ version: 1, id: "brief", kind: "text", description: "Brief", tools: [] }));
  await writeFile(configPath, JSON.stringify({ version: 1, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: {}, automation: { skills: [{ id: "brief", directory }], hooks: [] } }));
  return { root, workspace, directory, configPath };
}

it("desktop scheduling operation ID survives real scheduling validation and Store reopen", async () => {
  const f = await fixture();
  try {
    const automation = await loadScheduledSkillAutomation({ configPath: f.configPath, directory: f.workspace });
    const skill = automation.getSkill("brief")!;
    const input = { id: skill.id, expectedHash: skill.hash, input: "review", runAt: "2099-01-01T00:00:00Z", operationId: "schedule-replay" };
    const first = await scheduleRegisteredSkill({ automation, store: createTaskStore(join(f.workspace, ".runloom/tasks.json")), input, signal: new AbortController().signal });
    const replay = await scheduleRegisteredSkill({ automation, store: createTaskStore(join(f.workspace, ".runloom/tasks.json")), input, signal: new AbortController().signal });
    assert.ok(first.ok && replay.ok); assert.equal(first.value.task!.id, replay.value.task!.id);
    const list = await createTaskStore(join(f.workspace, ".runloom/tasks.json")).list(); assert.ok(list.ok); assert.equal(list.value.tasks.length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("scheduled Skill declaration pins exact id/hash, survives recurring/list projection, and rejects forged privileges", async () => {
  const f = await fixture();
  try {
    const automation = await loadScheduledSkillAutomation({ configPath: f.configPath, directory: f.workspace });
    const skill = automation.getSkill("brief")!;
    const arrangement = { kind: "skill", source: "none", notification: "always", declarationVersion: 1, skillId: skill.id, skillHash: skill.hash } as const;
    assert.deepEqual(validateTaskArrangement(arrangement), arrangement);
    assert.throws(() => validateTaskArrangement({ ...arrangement, skillHash: "newest" }));
    assert.throws(() => validateTaskArrangement({ ...arrangement, source: "todoist-planning" }));
    assert.throws(() => validateTaskArrangement({ ...arrangement, tools: ["shell_exec"] }));
    const store = createTaskStore(join(f.workspace, ".runloom/tasks.json"));
    const result = await store.create({ prompt: "A short brief", runAt: "2099-01-01T00:00:00Z", arrangement });
    assert.ok(result.ok);
    const recurring = await store.createRecurring({ prompt: "Daily brief", recurrence: { kind: "daily", time: "08:00", utcOffset: "+08:00" }, arrangement });
    assert.ok(recurring.ok);
    const list = await store.list(); assert.ok(list.ok);
    assert.deepEqual(list.value.tasks[0]?.arrangement, arrangement);
    const recurringList = await store.listRecurring(); assert.ok(recurringList.ok);
    assert.deepEqual(recurringList.value.recurringTasks[0]?.arrangement, arrangement);
    assert.equal((await store.create({ prompt: "中".repeat(1366), runAt: "2099-01-01T00:00:00Z", arrangement })).ok, false);
    assert.equal((await store.create({ prompt: "brief", runAt: "2099-01-01T00:00:00Z", arrangement, tools: ["shell_exec"] } as never)).ok, false);
    const path = join(f.workspace, ".runloom/tasks.json");
    const doc = JSON.parse(await readFile(path, "utf8"));
    doc.tasks[0].prompt = "x".repeat(4097);
    await writeFile(path, JSON.stringify(doc));
    const corrupt = await store.list(); assert.equal(corrupt.ok, false);
    if (!corrupt.ok) assert.equal(corrupt.error.code, "TASK_FILE_INVALID");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("worker shares pinned preparation, rejects changed packages, config mismatch and unconfigured invocation without a Run", async () => {
  const f = await fixture();
  try {
    const automation = await loadScheduledSkillAutomation({ configPath: f.configPath, directory: f.workspace });
    const skill = automation.getSkill("brief")!;
    const task = { prompt: "Input only", arrangement: { kind: "skill", source: "none", notification: "always", declarationVersion: 1, skillId: skill.id, skillHash: skill.hash } } as TaskRecord;
    const prepared = await prepareScheduledSkillTask(automation, task);
    assert.equal(prepared.agentId, "skill:brief");
    assert.deepEqual(prepared.message?.metadata, { source: "automation-skill", memoryConsolidation: "exclude" });
    await assert.rejects(prepareScheduledSkillTask(undefined, task), { code: "SKILL_UNAVAILABLE" });
    await writeFile(join(f.directory, "SKILL.md"), "A different instruction");
    await assert.rejects(prepareScheduledSkillTask(automation, task), { code: "SKILL_CHANGED" });
    const other = join(f.root, "other"); await mkdir(other);
    await assert.rejects(loadScheduledSkillAutomation({ configPath: f.configPath, directory: other }), /exactly match/);
    const insideConfig = join(f.workspace, "config.json"); await writeFile(insideConfig, await readFile(f.configPath));
    await assert.rejects(loadScheduledSkillAutomation({ configPath: insideConfig, directory: f.workspace }), /outside workspace/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("shared memory packages are not exposed to scheduled invocation", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "skill.json"), JSON.stringify({ version: 1, id: "brief", kind: "memory-consolidate", description: "Memory" }));
    const automation = await loadScheduledSkillAutomation({ configPath: f.configPath, directory: f.workspace });
    assert.equal(automation.getSkill("brief"), undefined);
    await assert.rejects(prepareScheduledSkillTask(automation, { prompt: "save", arrangement: { kind: "skill", source: "none", notification: "always", declarationVersion: 1, skillId: "brief", skillHash: "a".repeat(64) } } as TaskRecord), { code: "SKILL_UNAVAILABLE" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("worker resolves relative workspace from config directory without opening unrelated module executables", async () => {
  const f = await fixture();
  try {
    await writeFile(f.configPath, JSON.stringify({ version: 1, authorizedDirectories: [{ path: "workspace", access: "readwrite" }], modules: {
      computer: { enabled: true, executable: "/not-installed/cua-driver", allowedBundleIds: ["com.apple.TextEdit"] },
    }, automation: { skills: [{ id: "brief", directory: f.directory }], hooks: [] } }));
    const automation = await loadScheduledSkillAutomation({ configPath: f.configPath, directory: f.workspace });
    assert.equal(automation.skills[0]?.id, "brief");
    const aliasDirectory = join(f.root, "alias"); await mkdir(aliasDirectory);
    const aliasWorkspace = join(aliasDirectory, "workspace"); await mkdir(aliasWorkspace);
    const aliasConfig = join(aliasDirectory, "config.json"); await symlink(f.configPath, aliasConfig);
    const viaAlias = await loadScheduledSkillAutomation({ configPath: aliasConfig, directory: aliasWorkspace });
    assert.equal(viaAlias.skills[0]?.id, "brief", "workspace base matches the foreground explicit config path, not the symlink target directory");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
