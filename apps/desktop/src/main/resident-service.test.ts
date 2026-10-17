import assert from "node:assert/strict";
import { it } from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResidentService, ensureResidentSocketDirectory, resolveResidentPaths } from "./resident-service.js";
import type { ServiceCommandRunner } from "@serika/assistant";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-resident-service-")));
  const workspace = join(root, "workspace");
  const hostEntry = join(root, "resident-host.js");
  const identityPath = join(root, "startup.json");
  const envFile = join(root, "host.env");
  await mkdir(workspace);
  await writeFile(hostEntry, "// fixture");
  await writeFile(identityPath, '{"version":1}');
  await writeFile(envFile, "RUNLOOM_MODEL=mock\nCOMMAND_CODE_API_KEY=PRIVATE_SECRET\n", { mode: 0o600 });
  const node = await realpath(process.execPath);
  const options = { home: root, workspace, hostEntry, identityPath, platform: "darwin" as const,
    env: { RUNLOOM_HOST_NODE: node, RUNLOOM_HOST_ENV_FILE: envFile } };
  const paths = resolveResidentPaths(root, workspace);
  const args = [node, `--env-file=${envFile}`, hostEntry, "--identity", identityPath, "--socket", paths.socketPath];
  const loaded = `pid = 123\narguments = {\n${args.join("\n")}\n}\n`;
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
    await rm(paths.socketDirectory, { recursive: true, force: true });
  };
  return { root, options, paths, args, loaded, envFile, cleanup };
}

it("status never registers a service, and incomplete credentials cannot silently copy foreground secrets", async () => {
  let calls = 0;
  const service = createResidentService({ home: "/private/tmp/example-home", workspace: "/private/tmp/example-workspace",
    hostEntry: "/private/tmp/host.js", identityPath: "/private/tmp/startup.json", platform: "darwin",
    env: { COMMAND_CODE_API_KEY: "FOREGROUND_SECRET" }, runner: async (_file, args) => {
      calls++; assert.equal(args[0], "print"); return { exitCode: 113, stdout: "", stderr: "" };
    } });
  const status = await service.status();
  assert.equal(status.ok, true); assert.equal(status.registered, false); assert.equal(status.compatible, false);
  assert.match(status.message ?? "", /不会复制/);
  assert.equal((await service.enable()).ok, false);
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(status), /FOREGROUND_SECRET/);
});

it("explicit enable uses one trusted external env file and never writes credentials or replaces a registered host", async () => {
  const f = await fixture();
  let registered = false;
  let plist = "";
  const commands: string[] = [];
  try {
    const runner: ServiceCommandRunner = async (_file, args) => {
      commands.push(args[0]!);
      if (args[0] === "bootstrap") {
        plist = await readFile(args[2]!, "utf8"); registered = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: registered ? 0 : 113, stdout: registered ? f.loaded : "", stderr: "PRIVATE_SECRET" };
    };
    const service = createResidentService({ ...f.options, runner });
    assert.equal((await service.status()).registered, false);
    assert.equal(commands.includes("bootstrap"), false);
    const result = await service.enable();
    assert.equal(result.ok, true); assert.equal(result.registered, true); assert.equal(result.compatible, true);
    assert.match(plist, /--env-file=/);
    assert.doesNotMatch(plist, /PRIVATE_SECRET|EnvironmentVariables|task-worker/);
    assert.equal((await lstat(service.plistPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.paths.socketDirectory)).mode & 0o777, 0o700);
    assert.equal((await service.enable()).ok, true);
    assert.equal(commands.filter(cmd => cmd === "bootstrap").length, 1);
  } finally { await f.cleanup(); }
});

it("registered mismatched host is inspectable and stoppable but cannot be silently upgraded", async () => {
  const f = await fixture();
  const commands: string[] = [];
  let registered = true;
  try {
    const service = createResidentService({ ...f.options, runner: async (_file, args) => {
      commands.push(args[0]!);
      if (args[0] === "bootout") { registered = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      return { exitCode: registered ? 0 : 113, stdout: registered ? f.loaded.replace(f.args[2]!, "/other/entry.js") : "", stderr: "" };
    } });
    const state = await service.status();
    assert.equal(state.registered, true); assert.equal(state.compatible, false);
    assert.equal((await service.enable()).ok, false);
    assert.equal(commands.includes("bootstrap"), false);
    assert.equal((await service.disable()).ok, true);
    assert.equal(commands.includes("bootout"), true);
  } finally { await f.cleanup(); }
});

it("disable verifies absence before removing only its own plist and preserves history and task-worker definition", async () => {
  const f = await fixture();
  let registered = true;
  let printsAfterStop = 0;
  let stopping = false;
  try {
    const service = createResidentService({ ...f.options, runner: async (_file, args) => {
      if (args[0] === "bootout") { stopping = true; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (stopping && ++printsAfterStop > 1) registered = false;
      return { exitCode: registered ? 0 : 113, stdout: registered ? f.loaded : "", stderr: "" };
    } });
    await mkdir(join(f.root, "Library/LaunchAgents"), { recursive: true });
    await writeFile(service.plistPath, "definition");
    const worker = join(f.root, "Library/LaunchAgents/dev.runloom.task-worker.fixture.plist");
    const history = join(f.options.workspace, "history.jsonl");
    await writeFile(worker, "worker"); await writeFile(history, "history");
    const after = await service.disable();
    assert.equal(after.ok, true); assert.equal(after.registered, false);
    assert.equal(printsAfterStop, 2);
    await assert.rejects(readFile(service.plistPath), { code: "ENOENT" });
    assert.equal(await readFile(worker, "utf8"), "worker"); assert.equal(await readFile(history, "utf8"), "history");
  } finally { await f.cleanup(); }
});

it("ambiguous launchctl failure never claims absence or removes the service definition", async () => {
  const f = await fixture();
  try {
    const service = createResidentService({ ...f.options, runner: async () => ({ exitCode: 1, stdout: "PRIVATE_SECRET", stderr: "PRIVATE_SECRET" }) });
    await mkdir(join(f.root, "Library/LaunchAgents"), { recursive: true });
    await writeFile(service.plistPath, "keep");
    const state = await service.disable();
    assert.equal(state.ok, false);
    assert.equal(await readFile(service.plistPath, "utf8"), "keep");
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE_SECRET/);
  } finally { await f.cleanup(); }
});

it("rejects public or workspace credential files and symlink socket parents before registration", async () => {
  const f = await fixture();
  let bootstrap = false;
  const runner: ServiceCommandRunner = async (_file, args) => { bootstrap ||= args[0] === "bootstrap"; return { exitCode: 113, stdout: "", stderr: "" }; };
  try {
    await chmod(f.envFile, 0o644);
    assert.equal((await createResidentService({ ...f.options, runner }).enable()).ok, false);
    await chmod(f.envFile, 0o600);
    const workspaceEnv = join(f.options.workspace, "keys.env");
    await writeFile(workspaceEnv, "RUNLOOM_MODEL=mock\n", { mode: 0o600 });
    assert.equal((await createResidentService({ ...f.options, env: { ...f.options.env, RUNLOOM_HOST_ENV_FILE: workspaceEnv }, runner }).enable()).ok, false);
    await mkdir(f.paths.socketRoot, { recursive: true, mode: 0o700 });
    await symlink(f.root, f.paths.socketDirectory);
    assert.equal((await createResidentService({ ...f.options, runner }).enable()).ok, false);
    assert.equal(bootstrap, false);
  } finally { await f.cleanup(); }
});

it("private socket paths stay short and repeated preparation preserves ownership and mode", async () => {
  const f = await fixture();
  try {
    assert.ok(Buffer.byteLength(f.paths.socketPath) < 104);
    await ensureResidentSocketDirectory(f.paths); await ensureResidentSocketDirectory(f.paths);
    assert.equal((await lstat(f.paths.socketDirectory)).mode & 0o777, 0o700);
  } finally { await f.cleanup(); }
});
