import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { TelegramStore, type TelegramData } from "./telegram-store.js";

it("full legacy journals retain unresolved effects, archive terminal records and admit new messages after reopen", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-channel-retention-")));
  try {
    const directory = join(root, "private"), path = join(directory, "telegram.json");
    await mkdir(directory, { mode: 0o700 });
    const data: TelegramData = { version: 1, workspace: root, enabled: false, botId: null, offset: 2000, owner: null, routes: [],
      inputs: Array.from({ length: 1024 }, (_, n) => ({ key: `42:${n}`, updateId: n, text: "old", state: n === 0 ? "unknown" : "finished", runId: `run-${n}`, taskId: null })),
      deliveries: Array.from({ length: 2048 }, (_, n) => ({ key: `result:${n}`, chatId: 42, text: "result", state: n === 0 ? "unknown" : n === 1 ? "failed" : "submitted", messageId: n + 1 })) };
    await writeFile(path, JSON.stringify(data), { mode: 0o600 });
    const store = new TelegramStore(path, root); await store.load();
    await store.update(next => { next.inputs.push({ key: "42:new", updateId: 2000, text: "new", state: "received", runId: null, taskId: null }); next.offset = 2001; });
    assert.equal(store.snapshot().inputs.length, 130);
    assert.equal(store.snapshot().deliveries.length, 258);
    assert.equal(store.snapshot().inputs.find(x => x.key === "42:0")?.state, "unknown");
    assert.equal(store.snapshot().deliveries.find(x => x.key === "result:0")?.state, "unknown");
    assert.equal(store.snapshot().deliveries.find(x => x.key === "result:1")?.state, "failed");
    const reopened = new TelegramStore(path, root); await reopened.load();
    assert(await reopened.hasInput("42:1")); assert(await reopened.hasDelivery("result:2"));
    assert(!reopened.snapshot().inputs.some(x => x.key === "42:1"));
    assert(!reopened.snapshot().deliveries.some(x => x.key === "result:2"));
    assert(!await reopened.hasInput("never")); assert(!await reopened.hasDelivery("never"));
    await reopened.update(next => next.deliveries.push({ key: "fresh", chatId: 42, text: "new", state: "pending", messageId: null }));
    assert.equal(reopened.snapshot().deliveries.at(-1)?.key, "fresh");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("unresolved capacity is rejected, never silently pruned", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-channel-unresolved-")));
  try {
    const store = new TelegramStore(join(root, "private", "telegram.json"), root); await store.load();
    await store.update(data => { data.inputs = Array.from({ length: 1024 }, (_, n) => ({ key: `${n}`, updateId: n, text: "review", state: "unknown", runId: "run", taskId: null })); });
    await assert.rejects(store.update(data => data.inputs.push({ key: "new", updateId: 1024, text: "new", state: "received", runId: null, taskId: null })), /已满/);
    assert.equal(store.snapshot().inputs.length, 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});
