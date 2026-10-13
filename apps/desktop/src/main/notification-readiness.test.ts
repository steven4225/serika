import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createNotificationReadiness, openSystemNotificationSettings } from "./notification-readiness.js";

it("notification settings opens only the fixed OS pane, never grants consent or runs tasks", async () => {
  const urls: string[] = [];
  const result = await openSystemNotificationSettings(async url => { urls.push(url); }, "darwin");
  assert.equal(result.ok, true);
  assert.deepEqual(urls, ["x-apple.systempreferences:com.apple.Notifications-Settings.extension"]);
  assert.equal((await openSystemNotificationSettings(async () => { throw new Error("secret internal error"); }, "darwin")).ok, false);
  assert.equal((await openSystemNotificationSettings(async url => { urls.push(url); }, "linux")).ok, false);
  assert.equal(urls.length, 1);
});

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-notification-ready-")));
  const path = join(root, "helper");
  await writeFile(path, "fixture");
  await chmod(path, 0o700);
  return { root, path, cleanup: () => rm(root, { recursive: true, force: true }) };
};

it("notification status only diagnoses and requires explicit recognized authorization, not exit success", async () => {
  const file = await fixture();
  try {
    const expected = [["not requested yet", 3, "not_requested"], ["denied", 3, "denied"], ["authorized", 0, "authorized"], ["authorized", 3, "unknown"], ["unrecognized", 0, "unknown"]] as const;
    for (const [authorization, exitCode, state] of expected) {
      const readiness = createNotificationReadiness({ workspace: undefined, env: { RUNLOOM_NOTIFICATION_HELPER: file.path }, platform: "darwin", runner: async (path, args) => {
        assert.equal(path, file.path); assert.deepEqual(args, ["-diagnose"]);
        return { exitCode, stdout: `Sensitive fixture\n  authorization       ${authorization}\n`, stderr: "SECRET_FIXTURE" };
      } });
      const result = await readiness.status();
      assert.equal(result.authorization, state); assert.equal(result.helperConfigured, true);
      assert.doesNotMatch(JSON.stringify(result), /Sensitive fixture|SECRET_FIXTURE/);
    }
  } finally { await file.cleanup(); }
});

it("missing, relative, workspace-owned, nonexecutable helpers and unsupported platforms never invoke a command", async () => {
  const file = await fixture();
  let commands = 0;
  try {
    const options = { workspace: undefined, platform: "darwin" as const, runner: async () => { commands++; return { exitCode: 0, stdout: "", stderr: "" }; } };
    for (const path of [undefined, "./helper", file.root, `${file.path}\n`, join(file.root, "missing")]) {
      const readiness = createNotificationReadiness({ ...options, env: path === undefined ? {} : { RUNLOOM_NOTIFICATION_HELPER: path } });
      assert.equal((await readiness.status()).helperConfigured, false);
      assert.equal((await readiness.test()).ok, false);
    }
    const workspaceOwned = createNotificationReadiness({ ...options, workspace: file.root, env: { RUNLOOM_NOTIFICATION_HELPER: file.path } });
    assert.equal((await workspaceOwned.test()).ok, false);
    const alias = join(file.root, "alias"); await symlink(process.execPath, alias);
    assert.equal((await createNotificationReadiness({ ...options, workspace: file.root, env: { RUNLOOM_NOTIFICATION_HELPER: alias } }).test()).ok, false);
    await chmod(file.path, 0o600);
    assert.equal((await createNotificationReadiness({ ...options, env: { RUNLOOM_NOTIFICATION_HELPER: file.path } }).test()).ok, false);
    assert.equal((await createNotificationReadiness({ ...options, platform: "linux", env: { RUNLOOM_NOTIFICATION_HELPER: process.execPath } }).test()).ok, false);
    assert.equal(commands, 0);
  } finally { await file.cleanup(); }
});

it("test notification has fixed nonsecret argv, serializes clicks, never approves OS consent and reports submission only", async () => {
  const file = await fixture();
  try {
    let finish!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    let invoked!: () => void;
    const started = new Promise<void>(resolve => { invoked = resolve; });
    let commands = 0;
    const readiness = createNotificationReadiness({ workspace: undefined, env: { RUNLOOM_NOTIFICATION_HELPER: file.path, COMMAND_CODE_API_KEY: "SECRET_FIXTURE" }, platform: "darwin", runner: async (_path, args) => {
      commands++;
      assert.deepEqual(args, ["-request-authorization", "-title", "Serika", "-message", "通知测试：看到此消息说明系统已显示通知。此测试不会执行任务。"]);
      invoked(); return new Promise(resolve => { finish = resolve; });
    } });
    const first = readiness.test(); await started;
    assert.equal((await readiness.test()).ok, false);
    assert.equal((await readiness.status()).authorization, "unknown");
    assert.equal(commands, 1);
    finish({ exitCode: 0, stdout: "SECRET_FIXTURE", stderr: "" });
    const result = await first;
    assert.equal(result.ok, true); assert.match(result.message, /不代表已经看到/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET_FIXTURE/);
  } finally { await file.cleanup(); }
});

it("notification denial, uncertain exit and helper errors are not successful submission and do not leak output", async () => {
  const file = await fixture();
  try {
    for (const exitCode of [3, 1, null]) {
      const readiness = createNotificationReadiness({ workspace: undefined, env: { RUNLOOM_NOTIFICATION_HELPER: file.path }, platform: "darwin", runner: async () => ({ exitCode, stdout: "SECRET_FIXTURE", stderr: "SECRET_FIXTURE" }) });
      const result = await readiness.test(); assert.equal(result.ok, false); assert.doesNotMatch(result.message, /SECRET_FIXTURE/);
    }
    const readiness = createNotificationReadiness({ workspace: undefined, env: { RUNLOOM_NOTIFICATION_HELPER: file.path }, platform: "darwin", runner: async () => { throw new Error("SECRET_FIXTURE"); } });
    assert.equal((await readiness.status()).authorization, "unknown");
    assert.doesNotMatch(JSON.stringify(await readiness.test()), /SECRET_FIXTURE/);
  } finally { await file.cleanup(); }
});
