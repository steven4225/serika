import { createTestDirectoryAccess } from "./testing.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  READ_FILE_MAX_BYTES,
  createReadFileTool,
  readFileFromWorkspace,
  type ReadFileResult,
} from "./read-file.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-read-file-"));
  directories.push(directory);
  return directory;
}

async function read(directory: string, path: string, signal?: AbortSignal) {
  return readFileFromWorkspace(directory, path, signal);
}

function errorCode(result: ReadFileResult): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("readFileFromWorkspace", () => {
  it("preserves a UTF-8 BOM so readback content matches the actual bytes", async () => {
    const directory = await workspace();
    const content = "\ufeff标题\n";
    await writeFile(join(directory, "bom.md"), content);
    assert.deepEqual(await read(directory, "bom.md"), { ok: true, path: "bom.md", content, bytes: Buffer.byteLength(content) });
  });
  it("reads real UTF-8 text and reports bytes and normalized relative path", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "docs"));
    const content = "标题\nhello 🌍\n";
    await writeFile(join(directory, "docs", "README.md"), content, "utf8");

    assert.deepEqual(await read(directory, "./docs/../docs/README.md"), {
      ok: true,
      path: "docs/README.md",
      content,
      bytes: Buffer.byteLength(content),
    });
  });

  it("allows an empty file and exactly 64 KiB", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "empty.txt"), "");
    await writeFile(
      join(directory, "exact.txt"),
      Buffer.alloc(READ_FILE_MAX_BYTES, 0x61),
    );

    const empty = await read(directory, "empty.txt");
    assert.deepEqual(empty, { ok: true, path: "empty.txt", content: "", bytes: 0 });

    const exact = await read(directory, "exact.txt");
    assert.equal(exact.ok, true);
    if (exact.ok) {
      assert.equal(exact.bytes, READ_FILE_MAX_BYTES);
      assert.equal(exact.content.length, READ_FILE_MAX_BYTES);
    }
  });

  it("rejects the first byte beyond the 64 KiB limit", async () => {
    const directory = await workspace();
    await writeFile(
      join(directory, "too-large.txt"),
      Buffer.alloc(READ_FILE_MAX_BYTES + 1, 0x61),
    );

    assert.deepEqual(await read(directory, "too-large.txt"), {
      ok: false,
      error: {
        code: "FILE_TOO_LARGE",
        message: `File exceeds the ${READ_FILE_MAX_BYTES}-byte limit`,
      },
    });
  });

  it("rejects invalid UTF-8 and NUL-containing files", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "invalid.bin"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(directory, "nul.txt"), Buffer.from("hello\0world"));

    assert.equal(errorCode(await read(directory, "invalid.bin")), "NOT_TEXT");
    assert.equal(errorCode(await read(directory, "nul.txt")), "NOT_TEXT");
  });

  it("rejects absolute, empty, NUL, and outside paths", async () => {
    const directory = await workspace();
    const sibling = await mkdtemp(join(tmpdir(), "runloom-read-file-sibling-"));
    directories.push(sibling);
    await writeFile(join(sibling, "secret.txt"), "secret");

    assert.equal(errorCode(await read(directory, "")), "INVALID_PATH");
    assert.equal(
      errorCode(await read(directory, "bad\0path.txt")),
      "INVALID_PATH",
    );
    assert.equal(
      errorCode(await read(directory, resolve(directory, "inside.txt"))),
      "INVALID_PATH",
    );
    assert.equal(
      errorCode(
        await read(directory, "../runloom-read-file-sibling-does-not-match/secret.txt"),
      ),
      "PATH_OUTSIDE_WORKSPACE",
    );
    assert.equal(
      errorCode(
        await read(directory, `../${sibling.slice(sibling.lastIndexOf("/") + 1)}/secret.txt`),
      ),
      "PATH_OUTSIDE_WORKSPACE",
    );
  });

  it("uses path components for containment instead of a string prefix", async () => {
    const directory = await workspace();
    const sibling = `${directory}-sibling`;
    await mkdir(sibling);
    directories.push(sibling);
    await writeFile(join(sibling, "secret.txt"), "secret");

    assert.equal(
      errorCode(
        await read(directory, `../${sibling.slice(sibling.lastIndexOf("/") + 1)}/secret.txt`),
      ),
      "PATH_OUTSIDE_WORKSPACE",
    );
  });

  it("rejects missing files, directories, and every symlink component", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "real-dir"));
    await writeFile(join(directory, "real-dir", "file.txt"), "content");
    await symlink(join(directory, "real-dir", "file.txt"), join(directory, "file-link"));
    await symlink(join(directory, "real-dir"), join(directory, "dir-link"));
    await symlink(join(directory, "missing.txt"), join(directory, "dangling-link"));

    assert.equal(errorCode(await read(directory, "missing.txt")), "FILE_NOT_FOUND");
    assert.equal(errorCode(await read(directory, "real-dir")), "NOT_REGULAR_FILE");
    assert.equal(errorCode(await read(directory, "file-link")), "SYMLINK_NOT_ALLOWED");
    assert.equal(
      errorCode(await read(directory, "dir-link/file.txt")),
      "SYMLINK_NOT_ALLOWED",
    );
    assert.equal(
      errorCode(await read(directory, "dangling-link")),
      "SYMLINK_NOT_ALLOWED",
    );
  });

  it("propagates an already-aborted signal instead of returning READ_FAILED", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "file.txt"), "content");
    const controller = new AbortController();
    const reason = new Error("stop now");
    controller.abort(reason);

    await assert.rejects(read(directory, "file.txt", controller.signal), reason);
  });
});

describe("createReadFileTool", () => {
  it("exposes the authorized input and structured output contract", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "file.txt"), "hello");
    const readFile = createReadFileTool(createTestDirectoryAccess(directory));

    assert.deepEqual(
      await readFile.execute!({ path: "file.txt" }, {
        toolCallId: "call-read-file",
        messages: [],
        context: {},
      }),
      { ok: true, path: "file.txt", content: "hello", bytes: 5 },
    );
  });
});
