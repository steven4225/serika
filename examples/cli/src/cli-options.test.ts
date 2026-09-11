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

  it("requires a workspace when automatic consolidation is enabled", () => {
    assert.throws(
      () => parseTuiArgs(["--auto-consolidate"]),
      /--auto-consolidate requires --workspace/,
    );
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
