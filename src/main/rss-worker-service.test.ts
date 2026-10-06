import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopRssWorker } from "./rss-worker-service.js";

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
    const compatible = createDesktopRssWorker({ ...options, runner: async () => ({ exitCode: 0, stdout: "pid = 123\n--notify\n--rss\n--todoist\n", stderr: "" }) });
    assert.equal((await compatible.automationStatus()).todoistPlanningAvailable, false, "token must be in trusted worker env file, not only desktop env");
  } finally { await rm(root, { recursive: true, force: true }); }
});
