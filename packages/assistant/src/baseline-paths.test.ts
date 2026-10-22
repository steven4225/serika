import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { assistantDataPaths } from "./data-paths.js";
import { createRuntimeApp } from "./app.js";
import { createDemoModel } from "./demo-model.js";
import { EXECUTION_RECORD_FILE } from "./execution-record-store.js";
import { DESKTOP_FRONTMOST_FILE } from "./task-notification-presentation.js";
import { TASK_WORKER_HEALTH_FILE } from "./task-worker-health.js";

/**
 * v2 pilot step 1 baseline (docs/v2-pilot/paths.md): the data paths Serika
 * creates today. Paths below reflect the approved a2 home layout.
 * Regenerate only for an explicitly confirmed path change:
 * SERIKA_UPDATE_BASELINE_SNAPSHOT=1 node --test packages/assistant/dist/baseline-paths.test.js
 */

const PATH_CONSTANTS = {
  ...Object.fromEntries(Object.entries(assistantDataPaths("/H/data")).map(([name, path]) => [name, path.slice(1)])), EXECUTION_RECORD_FILE, DESKTOP_FRONTMOST_FILE, TASK_WORKER_HEALTH_FILE,
};

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.map(entry => `${relative(root, join(entry.parentPath, entry.name))}${entry.isDirectory() ? "/" : ""}`).sort();
}

async function assembledTree(modules: Record<string, unknown>, explicitDirectory: boolean): Promise<string[]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-baseline-paths-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules }));
  const app = await createRuntimeApp({
    ...(explicitDirectory ? { directory: join(root, "transcripts") } : {}),
    assistant: { dataDirectory: join(root, "data"), threadId: "baseline", configPath },
    modelAlias: "mock", model: createDemoModel(), demoTools: true, output: new PassThrough().resume(), env: {}, cwd: root,
  });
  try {
    const unsubscribe = app.toolConfirmation?.subscribePending(pending => {
      if (pending) app.toolConfirmation!.resolveApproval({ approvalId: pending.approvalId, decision: "allow" });
    });
    const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Please add 2 and 3" }] }] });
    assert.equal((await handle.result).status, "completed");
    unsubscribe?.();
    const lines = (await tree(root)).map(path => `root/${path}`);
    if (!explicitDirectory) {
      assert.ok(app.directory.startsWith(join(tmpdir(), "runloom-tui-")), "an omitted directory is a runloom-tui- temp dir");
      lines.push(...(await tree(app.directory)).map(path => `<tmp>/runloom-tui-*/${path}`));
      await rm(app.directory, { recursive: true, force: true });
    }
    return lines;
  } finally {
    app.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

describe("v2 pilot baseline: data paths", () => {
  it("path constants, an assembled workspace and the demo temp dir match __baseline__/paths.txt", async () => {
    const sections = [
      "# path constants", ...Object.entries(PATH_CONSTANTS).map(([name, value]) => `${name} = ${value}`),
      "", "# full assembly after one Run (explicit transcript directory)",
      ...await assembledTree({ "read-file": { enabled: true }, memory: { enabled: true }, checkpoint: { enabled: true },
        task: { enabled: true }, shell: { enabled: true }, pomodoro: { enabled: true } }, true),
      "", "# minimal assembly after one Run (omitted transcript directory)",
      ...await assembledTree({}, false),
    ];
    const actual = sections.join("\n") + "\n";
    const file = fileURLToPath(new URL("../src/__baseline__/paths.txt", import.meta.url));
    if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(file, actual);
    assert.equal(actual, await readFile(file, "utf8"));
  });
});
