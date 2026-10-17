import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import { createReadFileModule } from "./read-file-module.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("createReadFileModule", () => {
  it("registers read_file with its existing metadata and reads through the registered tool", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-read-file-module-"));
    directories.push(workspaceRoot);
    await writeFile(join(workspaceRoot, "notes.txt"), "hello", "utf8");

    const tools: RegisteredTool[] = [];
    const commands = new Map<string, { name: string; execute(args: string): void }>();
    const notifications: string[] = [];
    createReadFileModule(workspaceRoot).setup({
      registerTool: (tool) => tools.push(tool),
      registerCommand: (command) => commands.set(command.name, command),
      notify: (message) => notifications.push(message),
    });

    assert.deepEqual(tools[0]?.metadata, {
      name: "read_file",
      version: "1",
      risk: "read",
      timeoutMs: 1_000,
      idempotent: true,
    });
    assert.deepEqual(
      tools.map(({ metadata }) => metadata.name),
      ["read_file", "list_directory", "search_files", "write_file", "edit_file"],
    );
    assert.deepEqual(tools.slice(3).map(({ metadata }) => metadata), [
      {
        name: "write_file",
        version: "1",
        risk: "write",
        timeoutMs: 1_000,
        idempotent: false,
      },
      {
        name: "edit_file",
        version: "1",
        risk: "write",
        timeoutMs: 1_000,
        idempotent: false,
      },
    ]);
    const readFile = tools[0]?.tool;
    assert.ok(readFile?.execute);
    const result = await readFile.execute(
      { path: "notes.txt" },
      { toolCallId: "call-read-file", messages: [], context: {} },
    );
    assert.deepEqual(result, {
      ok: true,
      path: "notes.txt",
      content: "hello",
      bytes: 5,
    });
  });

  it("notifies the workspace for /workspace and usage for arguments", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-read-file-module-"));
    directories.push(workspaceRoot);

    const notifications: string[] = [];
    const commands = new Map<string, { name: string; execute(args: string): void }>();
    createReadFileModule(workspaceRoot).setup({
      registerTool: () => {},
      registerCommand: (command) => commands.set(command.name, command),
      notify: (message) => notifications.push(message),
    });

    const workspace = commands.get("workspace");
    assert.ok(workspace);
    workspace.execute("");
    workspace.execute("unexpected");
    assert.deepEqual(notifications, [workspaceRoot, "Usage: /workspace"]);
  });
});
