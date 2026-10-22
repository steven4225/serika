import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createTaskWorkerService } from "./task-worker-service.js";

it("service explicitly records external Skill config without copying its body or credentials", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-skill-service-")));
  let registered = false;
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const configPath = join(root, "config.json"); await writeFile(configPath, '{"private":"never-copy-config-body"}');
    const workerEntryPath = join(root, "worker.js"); await writeFile(workerEntryPath, "");
    const service = createTaskWorkerService({ applicationHome: workspace, workspace, configPath, nodePath: await realpath(process.execPath), workerEntryPath, workingDirectory: root, launchAgentsDirectory: join(root, "LaunchAgents"), uid: 501, platform: "darwin", runner: async (_file, args) => {
      if (args[0] === "bootstrap") registered = true;
      return { exitCode: args[0] === "print" && !registered ? 113 : 0, stdout: "", stderr: "" };
    } });
    await service.enable();
    const plist = await readFile(service.plistPath, "utf8");
    assert.ok(plist.includes(`<string>--config</string><string>${configPath}</string>`));
    assert.doesNotMatch(plist, /never-copy-config-body/);
    assert.equal((await service.enable()).registered, true, "same pinned worker options are idempotent");
    const original = plist;
    await writeFile(service.plistPath, plist.replace(`<string>--config</string><string>${configPath}</string>`, ""));
    await assert.rejects(service.enable(), /options differ/);
    assert.equal(await readFile(service.plistPath, "utf8"), original.replace(`<string>--config</string><string>${configPath}</string>`, ""), "mismatched service is never silently rewritten");
    assert.throws(() => createTaskWorkerService({ applicationHome: workspace, workspace, configPath: join(workspace, "config.json"), nodePath: process.execPath, workerEntryPath, workingDirectory: root, launchAgentsDirectory: root, uid: 501 }), /outside workspace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("service only installs explicitly, keeps secrets external, and reports actual launchctl state", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-service-")));
  let registered = false;
  const calls: string[][] = [];
  try {
    await writeFile(join(root, "worker.js"), "");
    await writeFile(join(root, "credentials.env"), "TEST_SECRET=do-not-copy-me");
    const service = createTaskWorkerService({ applicationHome: root, workspace: root, nodePath: await realpath(process.execPath), workerEntryPath: join(root, "worker.js"), workingDirectory: root, launchAgentsDirectory: join(root, "LaunchAgents"), uid: 501, envFile: join(root, "credentials.env"), safeRetry: true, notify: true, notificationHelperPath: await realpath(process.execPath), platform: "darwin", runner: async (_file, args) => {
      calls.push(args);
      if (args[0] === "bootstrap") registered = true;
      if (args[0] === "bootout") registered = false;
      return { exitCode: args[0] === "print" && !registered ? 113 : 0, stdout: registered ? "state = running\n pid = 345\n" : "", stderr: "" };
    } });
    assert.equal(calls.length, 0);
    assert.equal((await service.status()).registered, false);
    const running = await service.enable();
    assert.equal(running.running, true);
    assert.equal(running.pid, 345);
    const plist = await readFile(service.plistPath, "utf8");
    assert.match(plist, /--env-file=/);
    assert.match(plist, /--safe-retry/);
    assert.match(plist, /--notification-helper/);
    assert.doesNotMatch(plist, /EnvironmentVariables/);
    assert.doesNotMatch(plist, /do-not-copy-me/);
    assert.equal((await service.disable()).registered, false);
    await assert.rejects(readFile(service.plistPath), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("service rejects unsupported platform, relative paths and symlink install targets", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-service-")));
  const options = { applicationHome: root, workspace: root, nodePath: await realpath(process.execPath), workerEntryPath: join(root, "worker.js"), workingDirectory: root, launchAgentsDirectory: join(root, "LaunchAgents"), uid: 501 };
  try {
    await writeFile(options.workerEntryPath, "");
    assert.throws(() => createTaskWorkerService({ ...options, applicationHome: root, workspace: "relative" }));
    assert.throws(() => createTaskWorkerService({ ...options, notify: true, notificationHelperPath: join(root, "helper") }), /outside workspace/);
    await assert.rejects(createTaskWorkerService({ ...options, platform: "linux" }).enable(), /macOS/);
    await symlink(root, options.launchAgentsDirectory);
    await assert.rejects(createTaskWorkerService({ ...options, platform: "darwin", runner: async () => ({ exitCode: 113, stdout: "", stderr: "" }) }).enable(), /symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("missing executable inputs and uncertain launchctl status never install or delete a service", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-service-")));
  const options = { applicationHome: root, workspace: root, nodePath: await realpath(process.execPath), workerEntryPath: join(root, "missing.js"), workingDirectory: root, launchAgentsDirectory: join(root, "LaunchAgents"), uid: 501, platform: "darwin" as const };
  const calls: string[][] = [];
  const runner = async (_file: string, args: string[]) => {
    calls.push(args);
    return { exitCode: 1, stdout: "", stderr: "permission denied" };
  };
  try {
    const service = createTaskWorkerService({ ...options, runner });
    await assert.rejects(service.enable(), { code: "ENOENT" });
    assert.equal(calls.length, 0);
    await writeFile(options.workerEntryPath, "");
    await assert.rejects(service.enable(), /Cannot establish/);
    await assert.rejects(readFile(service.plistPath), { code: "ENOENT" });
    await assert.rejects(service.disable(), /Cannot establish/);
    assert.ok(calls.every((args) => args[0] === "print"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("service stop waits for actual launchd disappearance before deleting its definition", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-stop-publication-")));
  let prints = 0;
  try {
    const service = createTaskWorkerService({ applicationHome: root, workspace: root, nodePath: await realpath(process.execPath),
      workerEntryPath: join(root, "worker.js"), workingDirectory: root, launchAgentsDirectory: root, uid: 501,
      platform: "darwin", runner: async (_file, args) => {
        if (args[0] === "bootout") return { exitCode: 0, stdout: "", stderr: "" };
        prints++;
        return { exitCode: prints <= 2 ? 0 : 113, stdout: prints <= 2 ? "pid = 123\n" : "", stderr: "" };
      } });
    await writeFile(service.plistPath, "test definition");
    assert.equal((await service.disable()).registered, false);
    assert.equal(prints, 3, "initial status, still publishing, then actually absent");
    await assert.rejects(readFile(service.plistPath), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
