import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildNotificationHelper } from "./build-notification-helper.mjs";

test("native command validates the worker protocol without sending notifications or requesting permission", { skip: process.platform !== "darwin" }, async () => {
  const built = await buildNotificationHelper(fileURLToPath(new URL("..", import.meta.url)));
  const link = `serika://task-result/task_1?workspace=${"a".repeat(64)}`;
  for (const args of [
    ["-title", "Serika", "-message", "fixture"],
    ["-request-authorization", "-title", "Serika", "-message", "fixture"],
    ["-title", "Serika", "-message", "fixture", "-group", link, "-open", link],
  ]) assert.equal(execFileSync(built.executable, ["-validate", ...args], { encoding: "utf8" }).trim(), "valid");
  for (const args of [
    ["-message", "fixture", "-execute", "touch /tmp/not-authorized"],
    ["-message", "fixture", "-message", "duplicate"],
    ["-message", "fixture", "-open", "https://example.com"],
    ["-message", "fixture", "-open", link],
    ["-request-authorization", "-message", "fixture", "-group", link, "-open", link],
    ["-message", "fixture", "-group", `${link}\n`, "-open", `${link}\n`],
    ["-diagnose", "-message", "fixture"],
  ]) assert.equal(spawnSync(built.executable, ["-validate", ...args]).status, 2);
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", built.bundle]);
});
