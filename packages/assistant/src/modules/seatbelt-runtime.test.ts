import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveSeatbeltRuntime } from "./seatbelt-runtime.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-runtime-test-")));
  const file = async (path: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, "fixture"); await chmod(path, 0o700); return path; };
  const first = await file(join(root, "Cellar/node/first/bin/node")), next = await file(join(root, "Cellar/node/upgrade/bin/node"));
  for (const binary of [first, next]) await file(join(dirname(dirname(binary)), "lib/libnode.dylib"));
  const library = await file(join(root, "Cellar/dependency/upgrade/lib/loaded.dylib"));
  const git = await file(join(root, "bin/git")); await symlink(first, join(root, "bin/node"));
  await mkdir(join(root, "opt")); await symlink(dirname(library), join(root, "opt/lib"));
  const options = { home: join(root, "H"), protectedPaths: [join(root, "sensitive")], searchPath: join(root, "bin"),
    probe: async ({ binary }: { binary: string }) => ({ loadedImages: [binary, library, ...(binary.endsWith("/node") ? [join(dirname(dirname(binary)), "lib/libnode.dylib")] : []), "/usr/lib/libSystem.B.dylib"], linkedLibraries: [join(root, "opt/lib/loaded.dylib")] }) };
  return { root, first, next, library, git, options };
}

test("startup discovery follows a Node upgrade and only grants actual loaded library directories", async () => {
  const f = await fixture();
  try {
    const before = await resolveSeatbeltRuntime(f.options); assert.equal(before.node, f.first); assert.equal(before.git, f.git);
    assert.deepEqual(before.libraryDirectories, [dirname(f.library), join(dirname(dirname(f.first)), "lib"), join(f.root, "opt/lib")]);
    await unlink(join(f.root, "bin/node")); await symlink(f.next, join(f.root, "bin/node"));
    const after = await resolveSeatbeltRuntime(f.options); assert.equal(after.node, f.next); assert.equal(after.git, f.git);
    assert.deepEqual(after.libraryDirectories, [dirname(f.library), join(dirname(dirname(f.next)), "lib"), join(f.root, "opt/lib")]);
    assert.ok(!JSON.stringify(after).includes("/first/"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("missing discovery and protected executable, library or config directories fail closed", async () => {
  const f = await fixture();
  try {
    await assert.rejects(resolveSeatbeltRuntime({ ...f.options, searchPath: join(f.root, "absent") }), /runtime missing/);
    await assert.rejects(resolveSeatbeltRuntime({ ...f.options, probe: async () => ({ loadedImages: [], linkedLibraries: [] }) }), /discovery failed/);
    await assert.rejects(resolveSeatbeltRuntime({ ...f.options, probe: async () => { throw new Error("probe unavailable"); } }), /probe unavailable/);
    await assert.rejects(resolveSeatbeltRuntime({ ...f.options, protectedPaths: [dirname(f.first)] }), /Protected/);
    await assert.rejects(resolveSeatbeltRuntime({ ...f.options, protectedPaths: [dirname(f.library)] }), /Protected/);
    await assert.rejects(resolveSeatbeltRuntime({ ...f.options, configPath: join(dirname(f.library), "trusted.json") }), /Protected/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
