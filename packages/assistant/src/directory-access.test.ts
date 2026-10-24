import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { configuredDirectoryAccess, DirectoryAccess, type DirectoryAuthorization } from "./directory-access.js";
import { resolveTuiModuleConfig } from "./tui-module-config.js";
import { createReadFileModule } from "./modules/read-file-module.js";
import { createModuleHost } from "./module-host.js";
import { SeatbeltShellRunner } from "./modules/seatbelt-shell-runner.js";

it("b2 applies deepest directory permissions, protected controls, selection and revocation to real file tools", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-b2-files-")));
  try {
    const a = join(root, "a"), b = join(root, "b"), ro = join(a, "read"), rw = join(ro, "write"), h = join(a, "H"), driver = join(a, "driver");
    for (const path of [rw, b, h, join(a, ".git/hooks")]) await mkdir(path, { recursive: true });
    await writeFile(join(root, "outside"), "secret"); await writeFile(join(h, "config.json"), "trusted"); await writeFile(driver, "trusted");
    await mkdir(join(a, ".ssh")); await writeFile(join(a, ".ssh/sentinel"), "credential");
    await writeFile(join(a, ".git/config"), "trusted"); await writeFile(join(h, "env"), "credential");
    await symlink(root, join(a, "link")); await link(join(root, "outside"), join(a, "hard"));
    let directories: readonly DirectoryAuthorization[] = [{ path: a, access: "readwrite" }, { path: ro, access: "read" }, { path: rw, access: "readwrite" }, { path: b, access: "readwrite" }];
    const access = new DirectoryAccess({ load: async () => directories, protectedPaths: [h, driver], credentialPaths: [join(h, "env")] });
    const host = createModuleHost([createReadFileModule(access)], { notify() {} });
    const rows: Record<string, unknown> = {};
    const call = async (name: string, path: string, directory?: string) => {
      const registered = host.tools.find(item => item.metadata.name === name)!;
      const result = await registered.tool.execute!({ path, ...(directory ? { directory } : {}), content: "new", oldText: "trusted", newText: "changed" }, { toolCallId: "b2", messages: [], context: {} });
      assert.ok(result && typeof result === "object" && "ok" in result);
      if (result.ok) return "ok";
      assert.ok("error" in result && result.error && typeof result.error === "object" && "code" in result.error);
      return result.error.code;
    };
    rows["b2/read-only"] = await call("write_file", join(ro, "denied")); assert.equal(rows["b2/read-only"], "READ_ONLY_DIRECTORY");
    rows["b2/deep-write"] = await call("write_file", join(rw, "allowed")); assert.equal(rows["b2/deep-write"], "ok");
    for (const [name, path] of [["absolute", join(root, "outside")], ["traversal", "../outside"], ["symlink", "link/outside"], ["hardlink", "hard"]]) {
      rows[`b2/${name}`] = await call("read_file", path!, a); assert.notEqual(rows[`b2/${name}`], "ok");
    }
    for (const [name, path] of [["home-config", join(h, "config.json")], ["driver", driver]]) {
      rows[`b2/control/${name}`] = await call("edit_file", path!); assert.equal(rows[`b2/control/${name}`], "PROTECTED_PATH");
    }
    for (const path of [".git/config", ".git/hooks/pre-commit", ".env", "Serika.command"]) {
      rows[`b2/control/${path}`] = await call("write_file", path, a); assert.equal(rows[`b2/control/${path}`], "PROTECTED_PATH");
    }
    rows["b2/read/control"] = await call("read_file", ".git/config", a); assert.equal(rows["b2/read/control"], "ok");
    rows["b2/read/credential"] = await call("read_file", ".ssh/sentinel", a); assert.equal(rows["b2/read/credential"], "PROTECTED_PATH");
    const search = host.tools.find(item => item.metadata.name === "search_files")!;
    const found = await search.tool.execute!({ query: "credential", path: ".", directory: a }, { toolCallId: "b2-search", messages: [], context: {} });
    assert.deepEqual(found, { ok: true, matches: [], truncated: false, skippedOversize: 0 });
    rows["b2/ambiguous"] = await call("write_file", "chosen"); assert.equal(rows["b2/ambiguous"], "DIRECTORY_SELECTION_REQUIRED");
    rows["b2/selected"] = await call("write_file", "chosen", b); assert.equal(rows["b2/selected"], "ok");
    const project = join(b, "project"); await mkdir(project);
    rows["b2/project-base"] = await call("write_file", "chosen", project); assert.equal(rows["b2/project-base"], "ok");
    directories = directories.filter(item => item.path !== b);
    rows["b2/revoked"] = await call("write_file", "revoked", b); assert.equal(rows["b2/revoked"], "PATH_OUTSIDE_WORKSPACE");
    assert.equal(await readFile(join(h, "config.json"), "utf8"), "trusted"); assert.equal(await readFile(join(root, "outside"), "utf8"), "secret");
    const snapshot = JSON.parse(await readFile(new URL("../src/permission-boundary.snapshot.json", import.meta.url), "utf8"));
    if (process.env.SERIKA_B2_CAPTURE) await writeFile(process.env.SERIKA_B2_CAPTURE, JSON.stringify(rows, null, 2) + "\n");
    assert.deepEqual(rows, Object.fromEntries(Object.entries(snapshot).filter(([key]) => key.startsWith("b2/"))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("b2 native Seatbelt uses the same directory declarations and rejects boundary escapes and new hardlinks", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-b2-seatbelt-")));
  const a = join(root, "a"), ro = join(a, "read"), rw = join(ro, "write"), h = join(a, "H");
  try {
    for (const path of [rw, h, join(a, ".git/hooks")]) await mkdir(path, { recursive: true });
    const outside = join(root, "outside"); await writeFile(outside, "secret"); await symlink(root, join(a, "link"));
    await writeFile(join(h, "config.json"), "trusted");
    let directories: readonly DirectoryAuthorization[] = [{ path: a, access: "readwrite" }, { path: ro, access: "read" }, { path: rw, access: "readwrite" }];
    const access = new DirectoryAccess({ load: async () => directories, protectedPaths: [h] });
    const runner = new SeatbeltShellRunner({ home: h, directories: access, protectedPaths: [h] });
    const run = (command: string) => runner.execute({ directory: a, input: { command }, signal: new AbortController().signal,
      execution: { timeoutMs: 30_000, maxOutputBytes: 65_536, killGraceMs: 250 } });
    const allowed = await run("printf allowed > read/write/created"); assert.ok(allowed.ok, JSON.stringify(allowed)); assert.equal(allowed.exitCode, 0, allowed.output);
    for (const command of ["printf denied > read/denied", `cat '${outside}'`, "cat ../outside", "cat link/outside", "printf denied > H/config.json", "printf denied > .git/config", "printf denied > .git/config.worktree", "printf denied > .git/hooks/pre-commit", "printf denied > .env", "printf denied > Serika.command", "ln ../outside new-link", "ln H/config.json new-control-link", "ln read/write/created new-ordinary-link", "mv H moved"]) {
      const result = await run(command); assert.ok(result.ok, JSON.stringify(result)); assert.notEqual(result.exitCode, 0, command + ": " + result.output);
    }
    directories = []; const revoked = await run("printf denied > revoked"); assert.equal(revoked.ok, false);
    assert.equal(await readFile(outside, "utf8"), "secret"); assert.equal(await readFile(join(h, "config.json"), "utf8"), "trusted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("b2 reloads persistent grants before the next request and protects their configuration", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-b2-config-")));
  try {
    const configPath = join(root, "config.json"), workspace = join(root, "project"); await mkdir(workspace);
    const config = { version: 2, authorizedDirectories: [{ path: root, access: "readwrite" }], modules: { "read-file": { enabled: true } } };
    await writeFile(configPath, JSON.stringify(config));
    const assembly = { configPath, dataDirectory: join(root, "data") };
    const resolved = await resolveTuiModuleConfig(assembly, { cwd: root });
    const access = configuredDirectoryAccess({ assembly, config: resolved, cwd: root, home: root });
    assert.equal((await access.resolve({ path: configPath, write: true })).ok, false);
    assert.equal((await access.resolve({ path: join(workspace, "ordinary"), write: true })).ok, true);
    await writeFile(configPath, JSON.stringify({ ...config, authorizedDirectories: [] }));
    assert.deepEqual(await access.resolve({ path: join(workspace, "next"), write: true }), { ok: false, code: "PATH_OUTSIDE_WORKSPACE", message: "Path is outside authorized directories" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("b2 native Git can read controls and commit but cannot rewrite controls or read credentials", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-b2-git-")));
  const checks: { command: string; exitCode: number | null; output: string }[] = [];
  try {
    const home = join(root, "H"), repo = join(root, "repo"); await mkdir(home); await mkdir(repo);
    const git = (args: string[]) => execFileSync("/usr/bin/git", args, { cwd: repo, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    git(["init", "-q"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "maintenance.auto", "false"]); git(["config", "gc.auto", "0"]);
    await writeFile(join(repo, "tracked"), "first"); git(["add", "tracked"]); git(["commit", "-qm", "initial"]);
    await writeFile(join(repo, "tracked"), "changed");
    const directories = new DirectoryAccess({ load: async () => [{ path: repo, access: "readwrite" }], protectedPaths: [] });
    const runner = new SeatbeltShellRunner({ home, directories, protectedPaths: [] });
    for (const [command, allowed] of [
      ["git status --short", true], ["git log -1 --oneline", true], ["git diff -- tracked", true],
      ["git add tracked", true], ["git commit -qm changed", true],
      ["git config --local user.name Intruder", false], ["printf bad > .git/config.worktree", false], ["printf bad > .git/hooks/x", false],
      ["mv .git moved-git", false], ["cat .ssh/sentinel", false],
    ] satisfies [string, boolean][]) {
      if (command === "cat .ssh/sentinel") { await mkdir(join(repo, ".ssh")); await writeFile(join(repo, ".ssh/sentinel"), "test credential"); }
      const result = await runner.execute({ directory: repo, input: { command }, signal: new AbortController().signal,
        execution: { timeoutMs: 30_000, maxOutputBytes: 65_536, killGraceMs: 250 } });
      assert.ok(result.ok, JSON.stringify(result)); checks.push({ command, exitCode: result.exitCode, output: result.output });
      if (allowed) assert.equal(result.exitCode, 0, command + ": " + result.output);
      else assert.notEqual(result.exitCode, 0, command + ": " + result.output);
    }
    assert.equal(git(["log", "-1", "--format=%s"]).toString().trim(), "changed");
    assert.equal(git(["config", "--local", "user.name"]).toString().trim(), "Test");
    if (process.env.SERIKA_B2_NATIVE_CAPTURE) await writeFile(process.env.SERIKA_B2_NATIVE_CAPTURE, JSON.stringify({ runId: randomUUID(), platform: process.platform, checks }, null, 2) + "\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("b2 resolves Git controls from target ancestors including gitfile and commondir", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-b2-control-alias-")));
  try {
    const repo = join(root, "repo"), common = join(root, "common"), metadata = join(root, "metadata");
    await mkdir(repo); await mkdir(join(metadata, "hooks"), { recursive: true }); await mkdir(join(common, "objects"), { recursive: true });
    await writeFile(join(common, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(repo, ".git"), "gitdir: ../metadata\n");
    await writeFile(join(metadata, "commondir"), "../common\n");
    await writeFile(join(repo, "git-target"), "trusted");
    await symlink("../repo/git-target", join(metadata, "config"));
    const access = new DirectoryAccess({ load: async () => [{ path: root, access: "readwrite" }], protectedPaths: [] });
    assert.equal((await access.resolve({ path: join(repo, "git-target"), write: false })).ok, true);
    for (const path of [join(repo, "git-target"), join(metadata, "config.worktree"), join(metadata, "config.worktree.lock"), join(metadata, "hooks/x"), join(common, "config"), join(common, "hooks/x")]) {
      const result = await access.resolve({ path, write: true });
      assert.equal(result.ok, false, path); if (!result.ok) assert.equal(result.code, "PROTECTED_PATH");
    }
    const { gitControlsForTarget } = await import("./protected-paths.js");
    assert.ok((await gitControlsForTarget(join(repo, "file"))).includes(join(common, "hooks")));
    await rm(join(repo, ".git")); await mkdir(join(repo, ".git"));
    await mkdir(join(repo, ".git/worktrees/test"), { recursive: true });
    const nested = await access.resolve({ path: join(repo, ".git/worktrees/test/config.worktree"), write: true });
    assert.equal(nested.ok, false); if (!nested.ok) assert.equal(nested.code, "PROTECTED_PATH");
    const ordinary = await access.resolve({ path: join(repo, ".git/config.worktree"), write: true });
    assert.equal(ordinary.ok, false); if (!ordinary.ok) assert.equal(ordinary.code, "PROTECTED_PATH");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("b2 protects real nested submodule controls and preserves main repository config branch commits", { skip: process.platform !== "darwin" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-b2-submodules-")));
  const checks: { directory: string; command: string; exitCode: number | null; output: string }[] = [];
  try {
    const home = join(root, "H"), repo = join(root, "repo"), middle = join(root, "middle"), leaf = join(root, "leaf");
    await mkdir(home);
    const git = (cwd: string, args: string[]) => execFileSync("/usr/bin/git", args, { cwd,
      env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8" }).trim();
    const configure = (cwd: string) => {
      for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["maintenance.auto", "false"], ["gc.auto", "0"]]) git(cwd, ["config", key!, value!]);
    };
    for (const directory of [leaf, middle, repo]) {
      await mkdir(directory); git(directory, ["init", "-q"]); configure(directory);
      await writeFile(join(directory, "tracked"), "first"); git(directory, ["add", "tracked"]); git(directory, ["commit", "-qm", "initial"]);
    }
    git(middle, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", leaf, "libs/inner"]);
    git(middle, ["commit", "-qam", "add inner"]);
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "--name", "group/refs/heads/outer", middle, "deps/outer"]);
    git(repo, ["commit", "-qam", "add outer"]);
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "-q"]);
    const directories = new DirectoryAccess({ load: async () => [{ path: repo, access: "readwrite" }], protectedPaths: [] });
    const runner = new SeatbeltShellRunner({ home, directories, protectedPaths: [] });
    for (const directory of [join(repo, "deps/outer"), join(repo, "deps/outer/libs/inner")]) {
      configure(directory);
      const metadata = git(directory, ["rev-parse", "--absolute-git-dir"]), config = await readFile(join(metadata, "config"), "utf8");
      const run = async (command: string, allowed: boolean) => {
        const result = await runner.execute({ directory, input: { command }, signal: new AbortController().signal,
          execution: { timeoutMs: 30_000, maxOutputBytes: 65_536, killGraceMs: 250 } });
        assert.ok(result.ok, JSON.stringify(result)); checks.push({ directory, command, exitCode: result.exitCode, output: result.output });
        if (allowed) assert.equal(result.exitCode, 0, command + ": " + result.output);
        else assert.notEqual(result.exitCode, 0, command + ": " + result.output);
      };
      await run(`mv '${metadata}' '${metadata}-moved'`, false);
      await run("git config --local core.hooksPath /tmp/intruder", false);
      for (const name of ["config", "config.lock", "config.worktree", "config.worktree.lock", "hooks/x"]) {
        const path = join(metadata, name);
        await run(`printf bad > '${path}'`, false);
        const result = await directories.resolve({ path, write: true });
        assert.equal(result.ok, false, path); if (!result.ok) assert.equal(result.code, "PROTECTED_PATH");
      }
      assert.equal(await readFile(join(metadata, "config"), "utf8"), config);
      await assert.rejects(readFile(join(metadata, "hooks/x")), { code: "ENOENT" });
      assert.equal((await directories.resolve({ path: join(metadata, "config"), write: false })).ok, true);
      await run("git switch -c config", false);
      await run("git branch hooks", false);
      await writeFile(join(directory, "tracked"), "submodule changed");
      for (const command of ["git status --short", "git log -1 --oneline", "git diff -- tracked", "git switch -c b2-change", "git add tracked", "git commit -qm submodule-change"]) await run(command, true);
      assert.equal(git(directory, ["branch", "--show-current"]), "b2-change");
      assert.equal(git(directory, ["log", "-1", "--format=%s"]), "submodule-change");
    }
    const main = await runner.execute({ directory: repo, input: { command: "git switch -c config && printf main-change > tracked && git add tracked && git commit -qm main-config-branch" }, signal: new AbortController().signal,
      execution: { timeoutMs: 30_000, maxOutputBytes: 65_536, killGraceMs: 250 } });
    assert.ok(main.ok, JSON.stringify(main)); checks.push({ directory: repo, command: "git switch -c config && printf main-change > tracked && git add tracked && git commit -qm main-config-branch", exitCode: main.exitCode, output: main.output });
    assert.equal(main.exitCode, 0, main.output); assert.equal(git(repo, ["branch", "--show-current"]), "config");
    assert.equal(git(repo, ["log", "-1", "--format=%s"]), "main-config-branch");
    if (process.env.SERIKA_B2_SUBMODULE_CAPTURE) await writeFile(process.env.SERIKA_B2_SUBMODULE_CAPTURE,
      JSON.stringify({ runId: randomUUID(), platform: process.platform, realSubmoduleLevels: 2, checks }, null, 2) + "\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
