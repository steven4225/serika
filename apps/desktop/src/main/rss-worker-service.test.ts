import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, writeFile, rm, realpath, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopRssWorker } from "./rss-worker-service.js";
import { resolveTuiModuleConfig } from "@serika/example-cli";
import { acquireFlock } from "@serika/example-cli";
import { createTaskWorkerHealthWriter } from "@serika/example-cli/testing";
import { TASK_WORKER_LOCK_FILE_NAME } from "@serika/example-cli/testing";

it("Demo: worker startup evidence belongs to the loaded PID and held lock, not an old heartbeat", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-worker-version-")));
  const workspace = join(root, "workspace"), envFile = join(root, "worker.env"), entry = join(root, "worker.js");
  await mkdir(workspace); await writeFile(envFile, "RUNLOOM_MODEL=mock\n"); await writeFile(entry, "// fixture");
  const lock = await acquireFlock(join(workspace, TASK_WORKER_LOCK_FILE_NAME));
  const startedAt = "2026-10-10T00:00:00.000Z";
  const calls: string[][] = [];
  const args = [await realpath(process.execPath), `--env-file=${envFile}`, entry, "--workspace", workspace, "--notify", "--rss"];
  const worker = createDesktopRssWorker({ workspace, home: root, workerEntry: entry, platform: "darwin",
    env: { RUNLOOM_WORKER_NODE: process.execPath, RUNLOOM_WORKER_ENV_FILE: envFile },
    runner: async (_file, arguments_) => { calls.push(arguments_); return { exitCode: 0,
      stdout: `pid = 123\narguments = {\n${args.join("\n")}\n}\n`, stderr: "" }; } });
  try {
    await createTaskWorkerHealthWriter(workspace, { pid: 123, now: () => new Date(startedAt) }).heartbeat();
    const live = await worker.status(); assert.ok(live.ok);
    assert.equal(live.processStartedAt, startedAt);
    assert.equal((await worker.automationStatus()).ready, true);
    await createTaskWorkerHealthWriter(workspace, { pid: 456, now: () => new Date(startedAt) }).heartbeat();
    const foreign = await worker.status(); assert.ok(foreign.ok); assert.equal(foreign.processStartedAt, null);
    assert.equal((await worker.automationStatus()).ready, false, "launchd running alone is not ready");
    await lock.release();
    await createTaskWorkerHealthWriter(workspace, { pid: 123, now: () => new Date(startedAt) }).heartbeat();
    const stale = await worker.status(); assert.ok(stale.ok); assert.equal(stale.processStartedAt, null);
    assert.ok(calls.every(call => call[0] === "print"), "diagnostics cannot start/stop the service");
  } finally { await lock.release(); await rm(root, { recursive: true, force: true }); }
});

it("desktop service never starts implicitly, rejects IPC paths/options and requires trusted credential-file paths", async () => {
  const worker = createDesktopRssWorker({ workspace: "/private/tmp/test", home: "/private/tmp/home", env: { COMMAND_CODE_API_KEY: "SECRET_FIXTURE" }, workerEntry: "/private/tmp/entry.js", platform: "darwin" });
  const invalid = await worker.setEnabled({ enabled: true, nodePath: "/untrusted" });
  assert(!invalid.ok);
  const status = await worker.status(); assert(!status.ok);
  assert.match(status.message, /RUNLOOM_WORKER_NODE/);
  assert.doesNotMatch(status.message, /SECRET_FIXTURE/);
  const enabled = await worker.setEnabled(true); assert(!enabled.ok);
  assert.match(enabled.message, /不会把当前进程密钥复制/);
});

it("desktop worker status distinguishes registration from configured notification and exact helper routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-service-notify-"));
  const envFile = join(root, "worker.env");
  await writeFile(envFile, "RUNLOOM_MODEL=mock\n");
  const helper = await realpath(process.execPath);
  try {
    for (const [stdout, exitCode, notifyEnabled, notificationRoutingEnabled] of [
      ["", 113, false, false],
      ["pid = 123\n--rss\n", 0, false, false],
      ["pid = 123\n--notify\n", 0, true, false],
      ["pid = 123\n--notify\n--notification-helper\n/unexpected/helper\n", 0, true, false],
      [`pid = 123\n--notify\n--notification-helper\n${helper}\n`, 0, true, true],
    ] as const) {
      const worker = createDesktopRssWorker({ workspace: root, home: root, workerEntry: join(root, "entry.js"), platform: "darwin",
        env: { RUNLOOM_WORKER_NODE: process.execPath, RUNLOOM_WORKER_ENV_FILE: envFile, RUNLOOM_NOTIFICATION_HELPER: helper },
        runner: async () => ({ stdout, exitCode, stderr: "SECRET_FIXTURE" }) });
      const result = await worker.status();
      if (!result.ok) throw new Error(result.message);
      assert.equal(result.ok, true);
      assert.equal(result.notifyEnabled, notifyEnabled);
      assert.equal(result.notificationRoutingEnabled, notificationRoutingEnabled);
      assert.doesNotMatch(JSON.stringify(result), /SECRET_FIXTURE/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("arrangement readiness never upgrades an incompatible registered service or assumes desktop credentials reach worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-service-ready-"));
  const envFile = join(root, "worker.env");
  await writeFile(envFile, "RUNLOOM_MODEL=mock\n");
  let commands = 0;
  try {
    const options = { workspace: root, home: root, workerEntry: join(root, "entry.js"), platform: "darwin" as const,
      env: { RUNLOOM_WORKER_NODE: process.execPath, RUNLOOM_WORKER_ENV_FILE: envFile, TODOIST_API_TOKEN: "DESKTOP_ONLY_FIXTURE" }, todoist: true };
    const incompatible = createDesktopRssWorker({ ...options, runner: async () => {
      commands++; return { exitCode: 0, stdout: "pid = 123\n--rss\n", stderr: "" };
    } });
    const status = await incompatible.automationStatus();
    assert.equal(status.available, false); assert.equal(status.registered, true);
    assert.match(status.message ?? "", /未配置通知/);
    const result = await incompatible.enableArrangement();
    assert.equal(result.enabled, false);
    assert.equal(commands, 2, "no bootstrap or replacement for registered incompatible service");
    const desktopTokenOnly = createDesktopRssWorker({ ...options, runner: async () => ({ exitCode: 0, stdout: "pid = 123\n--notify\n--rss\n--todoist\n", stderr: "" }) });
    assert.equal((await desktopTokenOnly.automationStatus()).todoistPlanningAvailable, false, "token must be in trusted worker env file, not only desktop env");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects an already registered service bound to another config without replacing it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-skill-service-")));
  const envFile = join(root, "worker.env");
  const configPath = join(root, "config.json");
  await writeFile(envFile, "RUNLOOM_MODEL=mock\n");
  await writeFile(configPath, "{}");
  const calls: string[][] = [];
  try {
    const worker = createDesktopRssWorker({ workspace: join(root, "workspace"), configPath, home: root, workerEntry: join(root, "entry.js"), platform: "darwin",
      env: { RUNLOOM_WORKER_NODE: process.execPath, RUNLOOM_WORKER_ENV_FILE: envFile },
      runner: async (_file, args) => { calls.push(args); return { exitCode: 0, stdout: "pid = 123\n--notify\n--rss\n--config\n/another/config.json\n", stderr: "" }; } });
    const status = await worker.automationStatus();
    assert.equal(status.available, false);
    assert.match(status.message ?? "", /配置不一致/);
    assert.equal((await worker.enableArrangement()).enabled, false);
    assert.equal((await worker.setEnabled(true)).ok, false);
    assert.equal(calls.every(args => args[0] === "print"), true, "do not bootstrap, bootout or write replacement plist");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not canonicalize a symlink config and accidentally start another relative workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-service-config-link-")));
  const originalDirectory = join(root, "original");
  const entryDirectory = join(root, "entry");
  const configPath = join(entryDirectory, "config.json");
  const workspace = join(entryDirectory, "workspace");
  const envFile = join(root, "worker.env");
  await mkdir(originalDirectory); await mkdir(entryDirectory); await mkdir(workspace);
  await writeFile(join(originalDirectory, "config.json"), JSON.stringify({ version: 1, workspace: "./workspace", modules: { task: { enabled: true } }, automation: { hooks: [] } }));
  await symlink(join(originalDirectory, "config.json"), configPath);
  await writeFile(envFile, "RUNLOOM_MODEL=mock\n");
  let calls = 0;
  try {
    const foreground = await resolveTuiModuleConfig({ configPath }, { cwd: root });
    assert.equal(foreground.configPath, configPath);
    assert.equal(foreground.workspaceRoot, workspace, "foreground workspace is relative to the explicit config directory");
    const worker = createDesktopRssWorker({ workspace, configPath, home: root, workerEntry: join(root, "entry.js"), platform: "darwin",
      env: { RUNLOOM_WORKER_NODE: process.execPath, RUNLOOM_WORKER_ENV_FILE: envFile },
      runner: async () => { calls++; return { exitCode: 113, stdout: "", stderr: "" }; } });
    const status = await worker.automationStatus();
    assert.equal(status.available, false);
    assert.match(status.message ?? "", /符号链接/);
    assert.equal((await worker.enableArrangement()).enabled, false);
    const result = await worker.setEnabled(true);
    assert.equal(result.ok, false);
    assert.equal(calls, 0, "reject before querying or registering launchd; never run another workspace");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("explicit service enable writes the same trusted config path into worker arguments", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-skill-service-config-")));
  const workspace = join(root, "workspace");
  const envFile = join(root, "worker.env");
  const configPath = join(root, "config.json");
  const entry = join(root, "worker.js");
  await mkdir(workspace);
  await writeFile(envFile, "RUNLOOM_MODEL=mock\n");
  await writeFile(configPath, "{}");
  await writeFile(entry, "// offline fixture");
  let registered = false;
  let plist = "";
  const nodePath = await realpath(process.execPath);
  const argumentsLines = [nodePath, `--env-file=${envFile}`, entry, "--workspace", workspace, "--config", configPath, "--notify", "--rss"];
  try {
    const worker = createDesktopRssWorker({ workspace, configPath, home: root, workerEntry: entry, platform: "darwin",
      env: { RUNLOOM_WORKER_NODE: process.execPath, RUNLOOM_WORKER_ENV_FILE: envFile },
      runner: async (_file, args) => {
        if (args[0] === "bootstrap") { plist = await readFile(args[2]!, "utf8"); registered = true; return { exitCode: 0, stdout: "", stderr: "" }; }
        return registered ? { exitCode: 0, stdout: `pid = 123\narguments = {\n${argumentsLines.join("\n")}\n}\n`, stderr: "" } : { exitCode: 113, stdout: "", stderr: "" };
      } });
    const result = await worker.setEnabled(true);
    if (!result.ok) throw new Error(result.message);
    assert.equal(result.registered, true);
    assert.match(plist, new RegExp(`<string>--config</string><string>${configPath}</string>`));
    assert.equal((await worker.automationStatus()).available, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("checks the loaded launchctl cache against exact trusted paths and RSS/Todoist flags", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-service-loaded-")));
  const workspace = join(root, "workspace");
  const envFile = join(root, "worker.env");
  const configPath = join(root, "config.json");
  const entry = join(root, "entry.js");
  const nodePath = await realpath(process.execPath);
  await writeFile(envFile, "RUNLOOM_MODEL=mock\nTODOIST_API_TOKEN=WORKER_ONLY_FIXTURE\n");
  await writeFile(configPath, "{}");
  const expected = [nodePath, `--env-file=${envFile}`, entry, "--workspace", workspace, "--config", configPath, "--notify", "--todoist", "--rss"];
  const different = (index: number, value: string) => expected.map((arg, i) => i === index ? value : arg);
  try {
    for (const args of [expected, different(0, "/other/node"), different(1, "--env-file=/other/key.env"), different(2, "/other/worker.js"),
      expected.filter(arg => arg !== "--rss"), expected.filter(arg => arg !== "--todoist"), [...expected, "--safe-retry"], [...expected, "--workspace-context"], [...expected, "--rss"]]) {
      const calls: string[] = [];
      const worker = createDesktopRssWorker({ workspace, configPath, home: root, workerEntry: entry, todoist: true, platform: "darwin",
        env: { RUNLOOM_WORKER_NODE: nodePath, RUNLOOM_WORKER_ENV_FILE: envFile },
        runner: async (_file, command) => { calls.push(command[0]!); return { exitCode: 0, stdout: `pid = 123\narguments = {\n${args.join("\n")}\n}\n`, stderr: "PRIVATE_FIXTURE" }; } });
      const status = await worker.automationStatus();
      assert.equal(status.registered, true);
      assert.equal(status.available, args === expected);
      assert.equal(status.todoistPlanningAvailable, args === expected);
      assert.doesNotMatch(JSON.stringify(status), /WORKER_ONLY_FIXTURE|PRIVATE_FIXTURE|\/other/);
      const displayed = await worker.status();
      if (!displayed.ok) throw new Error(displayed.message);
      assert.equal(displayed.setupReady, args === expected, "the page readiness must match the actual launchctl arguments, not just pid and notification flags");
      if (args !== expected) assert.match(displayed.configurationMessage ?? "", /先停用再启用/);
      assert.doesNotMatch(JSON.stringify(displayed), /WORKER_ONLY_FIXTURE|PRIVATE_FIXTURE|\/other/);
      if (args !== expected) {
        assert.equal((await worker.enableArrangement()).enabled, false);
        assert.equal((await worker.setEnabled(true)).ok, false);
      }
      assert.equal(calls.every(command => command === "print"), true, "status and mismatch admission do not change launchd");
    }
    const tokenAbsent = createDesktopRssWorker({ workspace, configPath, home: root, workerEntry: entry, todoist: false, platform: "darwin",
      env: { RUNLOOM_WORKER_NODE: nodePath, RUNLOOM_WORKER_ENV_FILE: envFile },
      runner: async () => ({ exitCode: 0, stdout: `arguments = {\n${expected.join("\n")}\n}\n`, stderr: "" }) });
    assert.equal((await tokenAbsent.automationStatus()).available, false, "an unexpected enabled Todoist flag is incompatible too");
  } finally { await rm(root, { recursive: true, force: true }); }
});
