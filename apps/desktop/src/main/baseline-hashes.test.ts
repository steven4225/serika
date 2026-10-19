import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { exportBackup } from "./backup.js";
import { ConversationDraftStore } from "./conversation-draft-store.js";
import { TelegramStore, type TelegramData } from "./telegram-store.js";

/**
 * v2 pilot baseline (docs/v2-pilot/hashes.md, pending.md A.1): golden samples for the desktop's
 * persisted hashes that docs/v2-pilot/hashes.md listed without one. Each value is read from the
 * file the store writes, through its public API, so the product code is unchanged. Changing any of
 * them breaks data that already exists. Regenerate only for an explicitly confirmed format change:
 * SERIKA_UPDATE_BASELINE_SNAPSHOT=1 pnpm --filter @serika/desktop test
 */

const snapshotFile = fileURLToPath(new URL("./__baseline__/desktop-hashes.json", import.meta.url));

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-baseline-desktop-hash-")));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function samples(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  out["conversation draft scope key"] = await withRoot(async root => {
    const store = new ConversationDraftStore(join(root, "userData"));
    await store.saveDraft({ workspaceRoot: "/fixed/work", directory: "/fixed/work", threadId: "thread-a" }, { text: "草稿", excludeFromMemory: false });
    await store.flush();
    const registry = JSON.parse(await readFile(store.path, "utf8")) as { conversations: Record<string, unknown> };
    return Object.keys(registry.conversations).join(",");
  });
  out["telegram archive file name"] = await withRoot(async root => {
    // A full legacy journal: the next write archives the oldest terminal inputs under telegram-archive/inputs.
    const directory = join(root, "private"), path = join(directory, "telegram.json");
    await mkdir(directory, { mode: 0o700 });
    const data: TelegramData = { version: 1, workspace: root, enabled: false, botId: null, offset: 2000, owner: null, routes: [], deliveries: [],
      inputs: Array.from({ length: 1024 }, (_, n) => ({ key: `42:${n}`, updateId: n, text: "old", state: "finished", runId: `run-${n}`, taskId: null })) };
    await writeFile(path, JSON.stringify(data), { mode: 0o600 });
    const store = new TelegramStore(path, root);
    await store.load();
    await store.update(next => { next.inputs.push({ key: "42:new", updateId: 2000, text: "new", state: "received", runId: null, taskId: null }); next.offset = 2001; });
    const archived = join(directory, "telegram-archive", "inputs");
    for (const name of (await readdir(archived)).sort()) {
      if ((JSON.parse(await readFile(join(archived, name), "utf8")) as { key: string }).key === "42:0") return name;
    }
    return "(not archived)";
  });
  out["backup entry sha256"] = await withRoot(async root => {
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".runloom"), { recursive: true });
    await writeFile(join(workspace, ".runloom", "memory.json"), JSON.stringify({ version: 1, entries: [{ id: "saved", text: "saved memory", enabled: true }] }));
    const destination = join(root, "backup.serika");
    await exportBackup({ workspace, threads: [], destination });
    const archive = JSON.parse(gunzipSync(await readFile(destination)).toString("utf8")) as { entries: Array<{ path: string; sha256: string }> };
    return archive.entries.map(entry => `${entry.path}=${entry.sha256}`).join(",");
  });
  return out;
}

describe("v2 pilot baseline: desktop persisted hash golden samples", () => {
  it("matches __baseline__/desktop-hashes.json", async () => {
    const actual = JSON.stringify(await samples(), null, 2) + "\n";
    if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(snapshotFile, actual);
    assert.equal(actual, await readFile(snapshotFile, "utf8"));
  });
});
