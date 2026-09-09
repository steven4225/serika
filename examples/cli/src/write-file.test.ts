import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  WRITE_FILE_MAX_BYTES,
  createWriteFileTool,
  writeFileToWorkspace,
  type WriteFileResult,
} from "./write-file.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-write-file-"));
  directories.push(directory);
  return directory;
}

function errorCode(result: WriteFileResult): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("writeFileToWorkspace", () => {
  it("creates an empty and a UTF-8 file and reports normalized bytes", async () => {
    const directory = await workspace();
    const content = "标题\nhello 🌍\n";

    assert.deepEqual(await writeFileToWorkspace(directory, "./docs.txt", content), {
      ok: true,
      path: "docs.txt",
      bytes: Buffer.byteLength(content),
    });
    assert.deepEqual(await readFile(join(directory, "docs.txt"), "utf8"), content);

    assert.deepEqual(await writeFileToWorkspace(directory, "empty.txt", ""), {
      ok: true,
      path: "empty.txt",
      bytes: 0,
    });
  });

  it("does not overwrite an existing file or directory", async () => {
    const directory = await workspace();
    await fsWriteFile(join(directory, "file.txt"), "original");
    await mkdir(join(directory, "folder"));

    assert.equal(errorCode(await writeFileToWorkspace(directory, "file.txt", "new")), "FILE_EXISTS");
    assert.equal(await readFile(join(directory, "file.txt"), "utf8"), "original");
    assert.equal(errorCode(await writeFileToWorkspace(directory, ".", "new")), "NOT_REGULAR_FILE");
    assert.equal(errorCode(await writeFileToWorkspace(directory, "folder", "new")), "NOT_REGULAR_FILE");
  });

  it("requires an existing directory parent and rejects symlink components", async () => {
    const directory = await workspace();
    await fsWriteFile(join(directory, "parent-file"), "file");
    await mkdir(join(directory, "real"));
    await symlink(join(directory, "real"), join(directory, "link"));

    assert.equal(errorCode(await writeFileToWorkspace(directory, "missing/file.txt", "x")), "PARENT_NOT_FOUND");
    assert.equal(errorCode(await writeFileToWorkspace(directory, "parent-file/file.txt", "x")), "NOT_DIRECTORY");
    assert.equal(errorCode(await writeFileToWorkspace(directory, "link/file.txt", "x")), "SYMLINK_NOT_ALLOWED");
  });

  it("rejects absolute, outside, NUL, NUL-content, lone-surrogate, and oversized inputs", async () => {
    const directory = await workspace();

    assert.equal(errorCode(await writeFileToWorkspace(directory, "", "x")), "INVALID_PATH");
    assert.equal(errorCode(await writeFileToWorkspace(directory, "bad\0path", "x")), "INVALID_PATH");
    assert.equal(errorCode(await writeFileToWorkspace(directory, resolve(directory, "file.txt"), "x")), "INVALID_PATH");
    assert.equal(errorCode(await writeFileToWorkspace(directory, "../outside.txt", "x")), "PATH_OUTSIDE_WORKSPACE");
    assert.equal(errorCode(await writeFileToWorkspace(directory, "nul.txt", "a\0b")), "NOT_TEXT");
    assert.equal(errorCode(await writeFileToWorkspace(directory, "surrogate.txt", "\ud800")), "NOT_TEXT");
    assert.equal(
      errorCode(
        await writeFileToWorkspace(
          directory,
          "large.txt",
          "a".repeat(WRITE_FILE_MAX_BYTES + 1),
        ),
      ),
      "FILE_TOO_LARGE",
    );
  });

  it("propagates an already-aborted signal without creating a file", async () => {
    const directory = await workspace();
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);

    await assert.rejects(
      writeFileToWorkspace(directory, "file.txt", "content", controller.signal),
      reason,
    );
    await assert.rejects(readFile(join(directory, "file.txt")), { code: "ENOENT" });
  });
});

describe("createWriteFileTool", () => {
  it("exposes the frozen input and structured output contract", async () => {
    const directory = await workspace();
    const writeFile = createWriteFileTool(directory);

    assert.deepEqual(
      await writeFile.execute!(
        { path: "file.txt", content: "hello" },
        { toolCallId: "call-write-file", messages: [], context: {} },
      ),
      { ok: true, path: "file.txt", bytes: 5 },
    );
  });
});
