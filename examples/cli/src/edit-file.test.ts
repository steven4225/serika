import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  EDIT_FILE_MAX_BYTES,
  createEditFileTool,
  editFileInWorkspace,
  type EditFileResult,
} from "./edit-file.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-edit-file-"));
  directories.push(directory);
  return directory;
}

function code(result: EditFileResult): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("editFileInWorkspace", () => {
  it("replaces one literal occurrence and preserves exact text", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "config.txt"), "port=3000\r\nname=app", "utf8");

    const result = await editFileInWorkspace(directory, {
      path: "./config.txt",
      oldText: "port=3000\r\n",
      newText: "port=4000\r\n",
    });
    assert.deepEqual(result, {
      ok: true,
      path: "config.txt",
      bytes: Buffer.byteLength("port=4000\r\nname=app"),
      sha256: createHash("sha256").update("port=4000\r\nname=app").digest("hex"),
    });
    assert.equal(await readFile(join(directory, "config.txt"), "utf8"), "port=4000\r\nname=app");
  });

  it("requires a non-empty unique match, including overlapping matches", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "text.txt"), "aaa", "utf8");

    assert.equal(code(await editFileInWorkspace(directory, { path: "text.txt", oldText: "", newText: "x" })), "INVALID_OLD_TEXT");
    assert.equal(code(await editFileInWorkspace(directory, { path: "text.txt", oldText: "b", newText: "x" })), "TEXT_NOT_FOUND");
    assert.equal(code(await editFileInWorkspace(directory, { path: "text.txt", oldText: "aa", newText: "x" })), "AMBIGUOUS_MATCH");
    await writeFile(join(directory, "repeat.txt"), "a-a-a", "utf8");
    assert.equal(code(await editFileInWorkspace(directory, { path: "repeat.txt", oldText: "a", newText: "x" })), "AMBIGUOUS_MATCH");
  });

  it("accepts empty replacement and enforces the UTF-8 byte limit", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "text.txt"), "hello 🌍", "utf8");
    const deleted = await editFileInWorkspace(directory, {
      path: "text.txt",
      oldText: " 🌍",
      newText: "",
    });
    assert.equal(deleted.ok, true);
    assert.equal(await readFile(join(directory, "text.txt"), "utf8"), "hello");

    await writeFile(join(directory, "large.txt"), "a", "utf8");
    const tooLarge = await editFileInWorkspace(directory, {
      path: "large.txt",
      oldText: "a",
      newText: "x".repeat(EDIT_FILE_MAX_BYTES + 1),
    });
    assert.equal(code(tooLarge), "FILE_TOO_LARGE");
    assert.equal(await readFile(join(directory, "large.txt"), "utf8"), "a");
  });

  it("rejects invalid text and workspace paths", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "text.txt"), "hello", "utf8");
    assert.equal(code(await editFileInWorkspace(directory, { path: "text.txt", oldText: "\0", newText: "x" })), "NOT_TEXT");
    assert.equal(code(await editFileInWorkspace(directory, { path: "text.txt", oldText: "hello", newText: "\ud800" })), "NOT_TEXT");
    assert.equal(code(await editFileInWorkspace(directory, { path: "missing.txt", oldText: "a", newText: "b" })), "FILE_NOT_FOUND");
    assert.equal(code(await editFileInWorkspace(directory, { path: "../outside.txt", oldText: "a", newText: "b" })), "PATH_OUTSIDE_WORKSPACE");
    assert.equal(code(await editFileInWorkspace(directory, { path: "", oldText: "a", newText: "b" })), "INVALID_PATH");
  });

  it("preserves the original permission bits", async () => {
    const directory = await workspace();
    const path = join(directory, "mode.txt");
    await writeFile(path, "before", { mode: 0o640 });
    await import("node:fs/promises").then(({ chmod }) => chmod(path, 0o640));
    const before = (await stat(path)).mode & 0o7777;
    const result = await editFileInWorkspace(directory, { path: "mode.txt", oldText: "before", newText: "after" });
    assert.equal(result.ok, true);
    assert.equal((await stat(path)).mode & 0o7777, before);
  });

  it("leaves no temporary file after an already-aborted edit", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "text.txt"), "before", "utf8");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      editFileInWorkspace(directory, { path: "text.txt", oldText: "before", newText: "after" }, controller.signal),
      /cancelled/,
    );
    assert.deepEqual(await readdir(directory), ["text.txt"]);
    assert.equal(await readFile(join(directory, "text.txt"), "utf8"), "before");
  });
});

describe("createEditFileTool", () => {
  it("exposes the frozen input and output contract", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "text.txt"), "hello", "utf8");
    const editFile = createEditFileTool(directory);
    assert.ok(editFile.execute);
    assert.deepEqual(
      await editFile.execute(
        { path: "text.txt", oldText: "hello", newText: "world" },
        { toolCallId: "call-edit-file", messages: [], context: {} },
      ),
      { ok: true, path: "text.txt", bytes: 5, sha256: createHash("sha256").update("world").digest("hex") },
    );
  });
});
