import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  LIST_DIRECTORY_MAX_ENTRIES,
  createListDirectoryTool,
  listDirectoryFromWorkspace,
  type ListDirectoryResult,
} from "./list-directory.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-list-directory-"));
  directories.push(directory);
  return directory;
}

function errorCode(result: ListDirectoryResult): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("listDirectoryFromWorkspace", () => {
  it("lists one level of real entries, including hidden files and node_modules, by name", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "nested"));
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, ".hidden"), "hidden");
    await writeFile(join(directory, "file.txt"), "content");
    await symlink(join(directory, "file.txt"), join(directory, "file-link"));
    await writeFile(join(directory, "nested", "child.txt"), "child");

    assert.deepEqual(await listDirectoryFromWorkspace(directory), {
      ok: true,
      path: ".",
      entries: [
        { name: ".hidden", type: "file" },
        { name: "file-link", type: "symlink" },
        { name: "file.txt", type: "file" },
        { name: "nested", type: "directory" },
        { name: "node_modules", type: "directory" },
      ],
      truncated: false,
    });
  });

  it("normalizes a requested directory to a workspace-relative path", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "docs"));
    await writeFile(join(directory, "docs", "README.md"), "hello");

    assert.deepEqual(
      await listDirectoryFromWorkspace(directory, "./docs/../docs"),
      {
        ok: true,
        path: "docs",
        entries: [{ name: "README.md", type: "file" }],
        truncated: false,
      },
    );
  });

  it("caps sorted entries at 200 and reports truncation", async () => {
    const directory = await workspace();
    await Promise.all(
      Array.from({ length: LIST_DIRECTORY_MAX_ENTRIES + 1 }, (_, index) =>
        writeFile(join(directory, `item-${String(index).padStart(3, "0")}.txt`), "x"),
      ),
    );

    const result = await listDirectoryFromWorkspace(directory);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.entries.length, LIST_DIRECTORY_MAX_ENTRIES);
      assert.deepEqual(result.entries[0], { name: "item-000.txt", type: "file" });
      assert.deepEqual(result.entries.at(-1), {
        name: "item-199.txt",
        type: "file",
      });
      assert.equal(result.truncated, true);
    }
  });

  it("rejects invalid and outside paths, missing paths, files, and symlink components", async () => {
    const directory = await workspace();
    const sibling = await mkdtemp(join(tmpdir(), "runloom-list-directory-sibling-"));
    directories.push(sibling);
    await mkdir(join(directory, "real-dir"));
    await writeFile(join(directory, "file.txt"), "content");
    await symlink(join(directory, "real-dir"), join(directory, "dir-link"));

    assert.equal(errorCode(await listDirectoryFromWorkspace(directory, "")), "INVALID_PATH");
    assert.equal(
      errorCode(await listDirectoryFromWorkspace(directory, "bad\0path")),
      "INVALID_PATH",
    );
    assert.equal(
      errorCode(await listDirectoryFromWorkspace(directory, resolve(directory, "real-dir"))),
      "INVALID_PATH",
    );
    assert.equal(
      errorCode(
        await listDirectoryFromWorkspace(
          directory,
          `../${sibling.slice(sibling.lastIndexOf("/") + 1)}`,
        ),
      ),
      "PATH_OUTSIDE_WORKSPACE",
    );
    assert.equal(
      errorCode(await listDirectoryFromWorkspace(directory, "missing")),
      "PATH_NOT_FOUND",
    );
    assert.equal(
      errorCode(await listDirectoryFromWorkspace(directory, "file.txt")),
      "NOT_DIRECTORY",
    );
    assert.equal(
      errorCode(await listDirectoryFromWorkspace(directory, "dir-link")),
      "SYMLINK_NOT_ALLOWED",
    );
  });

  it("propagates an already-aborted signal", async () => {
    const directory = await workspace();
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await assert.rejects(
      listDirectoryFromWorkspace(directory, ".", controller.signal),
      /stop/,
    );
  });
});

describe("createListDirectoryTool", () => {
  it("exposes the optional path input and structured output contract", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "file.txt"), "hello");
    const listDirectory = createListDirectoryTool(directory);

    assert.deepEqual(
      await listDirectory.execute!({}, {
        toolCallId: "call-list-directory",
        messages: [],
        context: {},
      }),
      {
        ok: true,
        path: ".",
        entries: [{ name: "file.txt", type: "file" }],
        truncated: false,
      },
    );
  });
});
