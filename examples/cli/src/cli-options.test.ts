import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseTuiArgs, resolveWorkspace } from "./cli-options.js";

describe("parseTuiArgs", () => {
  it("parses the optional transcript directory, thread, workspace, and modules", () => {
    assert.deepEqual(
      parseTuiArgs([
        "--",
        "./transcript",
        "--thread",
        "demo",
        "--workspace",
        "./project",
        "--auto-consolidate",
        "--todoist",
      ]),
      {
        directory: "./transcript",
        threadId: "demo",
        workspace: "./project",
        autoConsolidate: true,
        todoistEnabled: true,
      },
    );
  });

  it("defaults optional capabilities to off", () => {
    assert.equal(parseTuiArgs([]).autoConsolidate, undefined);
    assert.equal(parseTuiArgs([]).todoistEnabled, undefined);
    assert.equal(parseTuiArgs(["--workspace", "./project"]).autoConsolidate, undefined);
    assert.equal(parseTuiArgs(["--todoist"]).todoistEnabled, true);
  });

  it("parses config alongside the transcript directory and thread", () => {
    assert.deepEqual(
      parseTuiArgs([
        "./transcript",
        "--thread",
        "daily-plan",
        "--config",
        "./runloom.json",
      ]),
      {
        directory: "./transcript",
        threadId: "daily-plan",
        configPath: "./runloom.json",
      },
    );
  });

  it("leaves workspace dependency validation to the resolved configuration", () => {
    assert.deepEqual(parseTuiArgs(["--auto-consolidate"]), {
      autoConsolidate: true,
    });
  });

  it("rejects a missing workspace value", () => {
    assert.throws(
      () => parseTuiArgs(["--workspace"]),
      /--workspace requires a directory/,
    );
    assert.throws(
      () => parseTuiArgs(["--workspace", "--thread", "demo"]),
      /--workspace requires a directory/,
    );
  });

  it("rejects unknown options and duplicate positional directories", () => {
    assert.throws(
      () => parseTuiArgs(["--unknown"]),
      /Unknown TUI option: --unknown/,
    );
    assert.throws(
      () => parseTuiArgs(["one", "two"]),
      /at most one transcript directory/,
    );
  });

  it("rejects duplicate workspace options", () => {
    assert.throws(
      () => parseTuiArgs(["--workspace", "one", "--workspace", "two"]),
      /at most one --workspace option/,
    );
  });

  it("rejects a missing or duplicate config path", () => {
    assert.throws(
      () => parseTuiArgs(["--config"]),
      /--config requires a file path/,
    );
    assert.throws(
      () => parseTuiArgs(["--config", "--thread", "demo"]),
      /--config requires a file path/,
    );
    assert.throws(
      () => parseTuiArgs(["--config", "one.json", "--config", "two.json"]),
      /at most one --config option/,
    );
  });

  it("rejects config together with module selection flags", () => {
    assert.throws(
      () => parseTuiArgs(["--config", "runloom.json", "--workspace", "project"]),
      /--config cannot be combined with --workspace/,
    );
    assert.throws(
      () => parseTuiArgs(["--config", "runloom.json", "--todoist"]),
      /--config cannot be combined with --todoist/,
    );
    assert.throws(
      () => parseTuiArgs(["--config", "runloom.json", "--auto-consolidate"]),
      /--config cannot be combined with --auto-consolidate/,
    );
  });
});

describe("resolveWorkspace", () => {
  it("returns the real absolute path for a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-workspace-"));
    const workspace = join(root, "project");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "hello");

    assert.equal(await resolveWorkspace("project", root), await realpath(workspace));
  });

  it("rejects missing paths and regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-workspace-"));
    await writeFile(join(root, "file.txt"), "hello");

    await assert.rejects(
      resolveWorkspace("missing", root),
      /Workspace does not exist: missing/,
    );
    await assert.rejects(
      resolveWorkspace("file.txt", root),
      /Workspace is not a directory: file.txt/,
    );
  });
});
