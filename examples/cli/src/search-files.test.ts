import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { READ_FILE_MAX_BYTES } from "./read-file.js";
import {
  createSearchFilesTool,
  searchFilesInWorkspace,
  type SearchFilesResult,
} from "./search-files.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-search-files-"));
  directories.push(directory);
  return directory;
}

function errorCode(result: SearchFilesResult): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("searchFilesInWorkspace", () => {
  it("searches case-sensitive literals in sorted depth-first order with one match per LF or CRLF line", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "a-dir"));
    await writeFile(join(directory, "b.txt"), "needle\nneedle needle\n");
    await writeFile(join(directory, "a-dir", "a.txt"), "x\r\nneedle\r\n");
    await writeFile(join(directory, "a-dir", "z.txt"), "Needle\n");

    assert.deepEqual(await searchFilesInWorkspace(directory, "needle"), {
      ok: true,
      matches: [
        { path: "a-dir/a.txt", line: 2, text: "needle" },
        { path: "b.txt", line: 1, text: "needle" },
        { path: "b.txt", line: 2, text: "needle needle" },
      ],
      truncated: false,
    });
  });

  it("skips excluded paths, non-files, oversized data, invalid UTF-8, and NUL-containing files", async () => {
    const directory = await workspace();
    await mkdir(join(directory, ".hidden"));
    await mkdir(join(directory, "node_modules"));
    await mkdir(join(directory, "folder"));
    await writeFile(join(directory, ".hidden", "secret.txt"), "needle");
    await writeFile(join(directory, "node_modules", "dependency.txt"), "needle");
    await writeFile(join(directory, "good.txt"), "needle");
    await writeFile(join(directory, "large.txt"), Buffer.alloc(READ_FILE_MAX_BYTES + 1, 0x61));
    await writeFile(join(directory, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(directory, "nul.txt"), Buffer.from("needle\0"));
    await symlink(join(directory, "good.txt"), join(directory, "link.txt"));

    assert.deepEqual(await searchFilesInWorkspace(directory, "needle"), {
      ok: true,
      matches: [{ path: "good.txt", line: 1, text: "needle" }],
      truncated: false,
    });
  });

  it("returns frozen failures for invalid queries and explicit invalid search roots", async () => {
    const directory = await workspace();
    await mkdir(join(directory, ".hidden"));
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "file.txt"), "needle");
    await symlink(join(directory, "file.txt"), join(directory, "link"));

    assert.equal(errorCode(await searchFilesInWorkspace(directory, "")), "INVALID_QUERY");
    assert.equal(errorCode(await searchFilesInWorkspace(directory, "a\nb")), "INVALID_QUERY");
    assert.equal(errorCode(await searchFilesInWorkspace(directory, "a\0b")), "INVALID_QUERY");
    assert.equal(errorCode(await searchFilesInWorkspace(directory, "needle", ".hidden")), "INVALID_PATH");
    assert.equal(errorCode(await searchFilesInWorkspace(directory, "needle", "node_modules")), "INVALID_PATH");
    assert.equal(errorCode(await searchFilesInWorkspace(directory, "needle", "link")), "SYMLINK_NOT_ALLOWED");
    assert.equal(errorCode(await searchFilesInWorkspace(directory, "needle", "file.txt")), "NOT_DIRECTORY");
    assert.equal(errorCode(await searchFilesInWorkspace(directory, "needle", "missing")), "PATH_NOT_FOUND");
    assert.equal(errorCode(await searchFilesInWorkspace(directory, "needle", "../outside")), "PATH_OUTSIDE_WORKSPACE");
  });

  it("propagates an already-aborted signal", async () => {
    const directory = await workspace();
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await assert.rejects(
      searchFilesInWorkspace(directory, "needle", ".", controller.signal),
      /stop/,
    );
  });

  it("stops at the match budget and counts excluded entries toward traversal", async () => {
    const directory = await workspace();
    for (let index = 0; index < 100; index += 1) {
      await writeFile(join(directory, `${String(index).padStart(3, "0")}.txt`), "needle");
    }
    const matchLimited = await searchFilesInWorkspace(directory, "needle");
    assert.equal(matchLimited.ok, true);
    if (matchLimited.ok) {
      assert.equal(matchLimited.matches.length, 100);
      assert.equal(matchLimited.truncated, true);
    }

    const entryDirectory = await workspace();
    for (let index = 0; index < 1_000; index += 1) {
      await writeFile(join(entryDirectory, `${String(index).padStart(4, "0")}.txt`), "no match");
    }
    await mkdir(join(entryDirectory, ".ignored"));
    const exact = await searchFilesInWorkspace(entryDirectory, "needle");
    assert.deepEqual(exact, { ok: true, matches: [], truncated: true });
    await writeFile(join(entryDirectory, "zzzz.txt"), "no match");
    const overflow = await searchFilesInWorkspace(entryDirectory, "needle");
    assert.equal(overflow.ok, true);
    if (overflow.ok) assert.equal(overflow.truncated, true);
  });

  it("keeps the serialized UTF-8 success result within the shared 64 KiB limit", async () => {
    const directory = await workspace();
    const longLine = `needle ${"x".repeat(40_000)}`;
    await writeFile(join(directory, "one.txt"), longLine);
    await writeFile(join(directory, "two.txt"), longLine);

    const result = await searchFilesInWorkspace(directory, "needle");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.truncated, true);
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= READ_FILE_MAX_BYTES);
    }
  });

  it("rejects a match whose non-truncated result envelope would exceed 64 KiB", async () => {
    const directory = await workspace();
    const emptyMatchBytes = Buffer.byteLength(
      JSON.stringify({
        ok: true,
        matches: [{ path: "one.txt", line: 1, text: "" }],
        truncated: true,
      }),
      "utf8",
    );
    const longLine = `needle${"x".repeat(READ_FILE_MAX_BYTES - emptyMatchBytes - "needle".length)}`;
    assert.equal(
      Buffer.byteLength(
        JSON.stringify({
          ok: true,
          matches: [{ path: "one.txt", line: 1, text: longLine }],
          truncated: true,
        }),
        "utf8",
      ),
      READ_FILE_MAX_BYTES,
    );
    await writeFile(join(directory, "one.txt"), longLine);

    const result = await searchFilesInWorkspace(directory, "needle");
    assert.deepEqual(result, { ok: true, matches: [], truncated: true });
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= READ_FILE_MAX_BYTES);
  });
});

describe("createSearchFilesTool", () => {
  it("exposes the frozen input and output contract", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "file.txt"), "needle");
    const searchFiles = createSearchFilesTool(directory);

    assert.deepEqual(await searchFiles.execute!({ query: "needle" }, {
      toolCallId: "call-search-files",
      messages: [],
      context: {},
    }), {
      ok: true,
      matches: [{ path: "file.txt", line: 1, text: "needle" }],
      truncated: false,
    });
  });
});
