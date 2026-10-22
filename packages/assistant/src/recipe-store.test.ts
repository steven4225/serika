import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { RecipeStore, recipeHash } from "./recipe-store.js";
import { createModuleHost, type ToolPermissionFacts } from "./module-host.js";
import { createRecipeModule } from "./modules/recipe-module.js";
import { createExecutionRecordStore } from "./execution-record-store.js";

const signal = () => new AbortController().signal;
const definition = { id: "summary", description: "Summary", command: "printf summary", cwd: "." };
const proof = { threadId: "thread", runId: "run", toolCallId: "test" };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-recipes-")));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  return { root, workspace, store: new RecipeStore(workspace, join(workspace, ".runloom/recipes.json")) };
}
it("recipe CAS serializes competing processes/instances and retains bounded prior tested versions", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.store.list(signal()), []);
    const results = await Promise.allSettled([f.store.save(definition, proof, 0, signal()), new RecipeStore(f.workspace, join(f.workspace, ".runloom/recipes.json")).save(definition, proof, 0, signal())]);
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    for (let i = 2; i <= 8; i++) await f.store.save({ ...definition, command: `printf v${i}` }, proof, i - 1, signal());
    await assert.rejects(f.store.save({ ...definition, command: "printf ninth" }, proof, 8, signal()), /history is full/);
    const list = await f.store.list(signal()); assert.equal(list[0]!.revision, 8); assert.equal(list[0]!.versions.length, 8);
    await assert.rejects(f.store.change(definition.id, 7, "disable", undefined, signal()), /revision changed/);
    await assert.rejects(f.store.change(definition.id, 8, "rollback", "f".repeat(64), signal()), /previously tested/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("recipe reads fail closed on symlinks, corruption and command/hash tampering without overwriting data", async () => {
  for (const mode of ["symlink-directory", "symlink-file", "tamper", "corrupt"] as const) {
    const f = await fixture();
    try {
      const directory = join(f.workspace, ".runloom"), file = join(directory, "recipes.json");
      if (mode === "symlink-directory") await symlink(f.root, directory);
      else {
        await f.store.save(definition, proof, 0, signal());
        if (mode === "symlink-file") { await rm(file); await writeFile(join(f.root, "foreign.json"), "{}"); await symlink(join(f.root, "foreign.json"), file); }
        else if (mode === "tamper") { const data = JSON.parse(await readFile(file, "utf8")); data.recipes[0].versions[0].command = "printf forged"; await writeFile(file, JSON.stringify(data)); }
        else await writeFile(file, "{corrupt");
      }
      await assert.rejects(f.store.list(signal()), /catalog|storage/);
      await assert.rejects(f.store.save(definition, proof, 0, signal()));
      if (mode === "corrupt") assert.equal(await readFile(file, "utf8"), "{corrupt");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
it("recipe execution is non-idempotent and a disabled/stale recipe cannot dispatch; listing never executes", async () => {
  const f = await fixture();
  try {
    const saved = await f.store.save({ ...definition, command: "touch dispatched" }, proof, 0, signal());
    const host = createModuleHost([createRecipeModule({ store: f.store, records: createExecutionRecordStore(f.root), threadId: "thread", currentRun: () => undefined, shell: {} })], { notify() {} });
    const run = host.tools.find(item => item.metadata.name === "recipe_run")!;
    assert.equal(run.metadata.idempotent, false); assert.equal(run.metadata.risk, "external_side_effect");
    const execute = async (name: string, input: unknown, abortSignal = signal()) => host.tools.find(item => item.metadata.name === name)!.tool.execute!(input as never, { toolCallId: "tool", messages: [], context: undefined, abortSignal });
    assert.equal((await execute("recipe_run", { id: definition.id, expectedHash: recipeHash(definition) }) as { ok: boolean }).ok, false);
    await f.store.change(definition.id, saved.revision, "disable", undefined, signal());
    assert.equal((await execute("recipe_run", { id: definition.id, expectedHash: saved.activeHash }) as { ok: boolean }).ok, false);
    await execute("recipe_list", {});
    await assert.rejects(readFile(join(f.workspace, "dispatched")), { code: "ENOENT" });
    const abort = new AbortController(); abort.abort(new Error("cancelled"));
    await assert.rejects(execute("recipe_run", { id: definition.id, expectedHash: saved.activeHash }, abort.signal), /cancelled/);
    host.dispose();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
it("recipe commit failure before rename leaves old data; after rename remains unknown and never auto-retries", async t => {
  for (const boundary of ["file", "directory"] as const) {
    const f = await fixture();
    try {
      await f.store.save(definition, proof, 0, signal());
      const file = join(f.workspace, ".runloom/recipes.json"), before = await readFile(file);
      const probe = await open(file, "r"), prototype = Object.getPrototypeOf(probe), original = prototype.sync;
      await probe.close();
      const injected = t.mock.method(prototype, "sync", async function(this: typeof probe) {
        if ((await this.stat()).isDirectory() === (boundary === "directory")) throw new Error("sync fault");
        return original.call(this);
      });
      await assert.rejects(f.store.change(definition.id, 1, "disable", undefined, signal()), boundary === "directory" ? /acknowledgement uncertain/ : /sync fault/);
      injected.mock.restore();
      if (boundary === "file") assert.deepEqual(await readFile(file), before);
      else {
        await assert.rejects(f.store.change(definition.id, 2, "enable", undefined, signal()), /uncertain/);
        assert.equal((await new RecipeStore(f.workspace, join(f.workspace, ".runloom/recipes.json")).list(signal()))[0]!.enabled, false);
      }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
it("recipe tools are never remembered and their cards show the exact recipe version", async () => {
  const f = await fixture();
  try {
    const saved = await f.store.save(definition, proof, 0, signal());
    const facts = (sandboxed: boolean) => createModuleHost([createRecipeModule({ store: f.store, records: createExecutionRecordStore(f.root),
      threadId: "thread", currentRun: () => undefined,
      shell: sandboxed ? { sandbox: { backend: "docker", image: "img", readablePaths: [], writablePaths: [] } } : {} })], { notify() {} }).toolPermissions;
    const host = facts(false);
    assert.deepEqual([...host.keys()], ["recipe_list", "recipe_save", "recipe_manage", "recipe_run"]);
    for (const declared of host.values()) assert.equal(declared.defaults?.remember, "never");
    const card = (toolName: string, input: unknown, sandboxed = false) => facts(sandboxed).get(toolName)!.confirmation!(
      { toolName, input, toolCallId: "call", signal: signal() } as Parameters<NonNullable<ToolPermissionFacts["confirmation"]>>[0]);
    const runCard = `\n运行命令配方：summary\nSummary\n命令：printf summary\n目录：.\n版本：${saved.activeHash}\n`;
    assert.equal(await card("recipe_run", { id: "summary", expectedHash: saved.activeHash }),
      `${runCard}这会运行主机命令，工作目录不是系统隔离。\n仅批准这次执行；配方不授予持久权限，外部脚本和依赖不随版本冻结。Allow this call? [y/n] `);
    assert.equal(await card("recipe_run", { id: "summary", expectedHash: saved.activeHash }, true),
      `${runCard}沿用当前 Docker 沙箱配置。\n仅批准这次执行；配方不授予持久权限，外部脚本和依赖不随版本冻结。Allow this call? [y/n] `);
    assert.equal(await card("recipe_run", { id: "summary", expectedHash: "f".repeat(64) }),
      "\n配方已变化、停用或无法读取。本次不能执行，请取消并重新查看。Allow this call? [y/n] ");
    assert.equal(await card("recipe_manage", { id: "summary", action: "disable" }),
      `\n停用命令配方：summary\nSummary\n命令：printf summary\n目录：.\n版本：${saved.activeHash}\n不会执行命令或授予权限，也不撤销过去已发生的操作。Allow this call? [y/n] `);
    assert.equal(card("recipe_save", { id: "summary", command: "printf summary", cwd: "." }),
      "\n登记命令配方：summary\n命令：printf summary\n目录：.\n程序会核对本轮真实测试回执。不会执行配方、安装工具或授予后续权限。Allow this call? [y/n] ");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
