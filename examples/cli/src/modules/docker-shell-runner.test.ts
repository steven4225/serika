import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assertDockerShellSandboxAvailable,
  buildDockerRunArguments,
  executeDockerShellCommand,
  type DockerShellSandboxConfig,
} from "./docker-shell-runner.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const sandbox: DockerShellSandboxConfig = {
  backend: "docker",
  image: "node:22-bookworm-slim",
  readablePaths: ["package.json", "src"],
  writablePaths: ["reports"],
};

describe("buildDockerRunArguments", () => {
  it("builds an isolated argv with explicit mounts and no host-shell interpolation", () => {
    const args = buildDockerRunArguments(
      "/tmp/runloom-workspace",
      {
        command: "printf 'hello world' && touch reports/result.txt",
        cwd: "src",
      },
      sandbox,
      "runloom-shell-test",
    );

    assert.deepEqual(args.slice(0, 16), [
      "run",
      "--rm",
      "--pull",
      "never",
      "--name",
      "runloom-shell-test",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
    ]);
    assert.ok(args.includes("2g"));
    assert.ok(args.includes("--cpus"));
    assert.ok(args.includes("--tmpfs"));
    assert.ok(args.includes("/tmp:rw,size=64m"));
    assert.ok(args.includes("/workspace:rw,size=64m"));
    assert.ok(
      args.includes(
        "type=bind,src=/tmp/runloom-workspace/package.json,dst=/workspace/package.json,readonly",
      ),
    );
    assert.ok(
      args.includes(
        "type=bind,src=/tmp/runloom-workspace/src,dst=/workspace/src,readonly",
      ),
    );
    assert.ok(
      args.includes(
        "type=bind,src=/tmp/runloom-workspace/reports,dst=/workspace/reports",
      ),
    );
    assert.equal(args.at(-4), sandbox.image);
    assert.equal(args.at(-3), "/bin/sh");
    assert.equal(args.at(-2), "-lc");
    assert.equal(
      args.at(-1),
      "cd '/workspace/src' && printf 'hello world' && touch reports/result.txt",
    );
    assert.equal(args.includes("--env"), false);
    assert.equal(args.includes("--privileged"), false);
  });
});

describe("assertDockerShellSandboxAvailable", () => {
  it("fails before TUI startup when the Docker executable is unavailable", async () => {
    await assert.rejects(
      assertDockerShellSandboxAvailable(
        sandbox,
        "/runloom/docker-does-not-exist",
      ),
      /Docker sandbox unavailable/i,
    );
  });
});

describe("executeDockerShellCommand", () => {
  it("fails closed when Docker is unavailable instead of using the host shell", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-docker-shell-"));
    directories.push(workspaceRoot);
    await mkdir(join(workspaceRoot, "reports"));

    const result = await executeDockerShellCommand(
      workspaceRoot,
      { command: "touch reports/should-not-run.txt" },
      { ...sandbox, readablePaths: [], writablePaths: ["reports"] },
      new AbortController().signal,
      {
        timeoutMs: 100,
        maxOutputBytes: 1024,
        dockerExecutable: "/runloom/docker-does-not-exist",
      },
    );

    assert.equal(result.ok, false);
    if (result.ok) {
      throw new Error("expected sandbox failure");
    }
    assert.equal(result.error.code, "SANDBOX_UNAVAILABLE");
    assert.match(result.error.message, /Unable to run Docker sandbox/i);
    await assert.rejects(access(join(workspaceRoot, "reports/should-not-run.txt")));
  });
});
