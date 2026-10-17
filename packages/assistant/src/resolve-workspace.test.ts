import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveWorkspace } from "./resolve-workspace.js";

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
