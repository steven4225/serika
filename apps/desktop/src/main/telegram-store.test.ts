import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { TelegramStore, telegramCapacity, type TelegramData } from "./telegram-store.js";

for (const boundary of ["archive", "archive-directory", "archive-parent", "active-journal"] as const) {
  it(`${boundary} persistence failure retains input, offset and unresolved records, freezes admission and permits explicit recovery`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "serika-channel-archive-fault-")));
    try {
      const directory = join(root, "private"), path = join(directory, "telegram.json");
      await mkdir(directory, { mode: 0o700 });
      const data: TelegramData = { version: 1, workspace: root, enabled: true, botId: 100, offset: 1024,
        owner: { userId: 42, chatId: 42, name: "owner", threadId: "telegram" }, routes: [], deliveries: [],
        inputs: Array.from({ length: 1024 }, (_, n) => ({ key: `42:${n}`, updateId: n, text: "private original",
          state: n === 0 ? "finished" : n === 1 ? "received" : n === 2 ? "reserved" : n === 3 ? "bound" : "unknown", runId: `run-${n}`, taskId: null })) };
      await writeFile(path, JSON.stringify(data), { mode: 0o600 });
      const before = await readFile(path), store = new TelegramStore(path, root); await store.load();
      const originalOpen = fs.promises.open, originalRename = fs.promises.rename;
      const archiveDirectory = join(directory, "telegram-archive", "inputs");
      const fault = boundary !== "active-journal"
        ? t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
          if (boundary === "archive" && String(args[0]).includes("telegram-archive")) throw new Error("archive unavailable");
          if (boundary === "archive-parent" && args[0] === dirname(archiveDirectory)) throw Object.assign(new Error("archive parent disappeared"), { code: "ENOENT" });
          const handle = await originalOpen(...args);
          if (boundary === "archive-directory" && args[0] === archiveDirectory) t.mock.method(handle, "sync", async () => { throw new Error("archive directory sync failed"); });
          return handle;
        })
        : t.mock.method(fs.promises, "rename", async (...args: Parameters<typeof originalRename>) => {
          if (args[1] === path) throw new Error("journal replacement failed");
          return originalRename(...args);
        });
      syncBuiltinESMExports();
      const append = (next: TelegramData) => { next.inputs.push({ key: "42:new", updateId: 1024, text: "new", state: "received", runId: null, taskId: null }); next.offset = 1025; };
      try { await assert.rejects(store.update(append)); }
      finally { fault.mock.restore(); syncBuiltinESMExports(); }
      assert.deepEqual(await readFile(path), before);
      assert.deepEqual(store.snapshot(), data);
      await assert.rejects(store.update(append), /停止接收/);
      const reopened = new TelegramStore(path, root); await reopened.load();
      assert.deepEqual(reopened.snapshot(), data);
      assert.equal(await reopened.hasInput("42:new"), false);
      let archiveDirectoryOpens = 0;
      const recovery = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
        if (args[0] === archiveDirectory) archiveDirectoryOpens++;
        return originalOpen(...args);
      });
      syncBuiltinESMExports();
      try { await reopened.update(append); }
      finally { recovery.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(archiveDirectoryOpens, 1, "including preexisting archives, directory acknowledgement precedes pruning");
      assert.equal(reopened.snapshot().offset, 1025);
      assert.equal(reopened.snapshot().inputs.length, 1024);
      assert.equal(await reopened.hasInput("42:0"), true, "finished source remains a dedupe marker after safe archival");
      for (const [index, state] of [[1, "received"], [2, "reserved"], [3, "bound"], [4, "unknown"]] as const) {
        assert.equal(reopened.snapshot().inputs.find(x => x.key === `42:${index}`)?.state, state);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

it("full legacy journals retain unresolved effects, archive terminal records and admit new messages after reopen", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-channel-retention-")));
  try {
    const directory = join(root, "private"), path = join(directory, "telegram.json");
    await mkdir(directory, { mode: 0o700 });
    const data: TelegramData = { version: 1, workspace: root, enabled: false, botId: null, offset: 2000, owner: null, routes: [],
      inputs: Array.from({ length: 1024 }, (_, n) => ({ key: `42:${n}`, updateId: n, text: "old", state: n === 0 ? "unknown" : "finished", runId: `run-${n}`, taskId: null })),
      deliveries: Array.from({ length: 2048 }, (_, n) => ({ key: `result:${n}`, chatId: 42, text: "result", state: n === 0 ? "unknown" : n === 1 ? "failed" : "submitted", messageId: n + 1 })) };
    data.inputs[1]!.reminderReceipts = [{ toolCallId: "saved", text: "private reminder readback" }];
    await writeFile(path, JSON.stringify(data), { mode: 0o600 });
    const store = new TelegramStore(path, root); await store.load();
    assert.equal(telegramCapacity(store.snapshot()).blocked, false, "terminal records can make room even at the count cap");
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
    const sourceMarker = await readFile(join(directory, "telegram-archive", "inputs", createHash("sha256").update("42:1").digest("hex") + ".json"), "utf8");
    assert.ok(!sourceMarker.includes("private reminder readback"));
    assert.equal(JSON.parse(sourceMarker).reminderReceipts, undefined, "archives keep dedupe metadata, not reminder body copies");
    const marker = JSON.parse(await readFile(join(directory, "telegram-archive", "deliveries", createHash("sha256").update("result:2").digest("hex") + ".json"), "utf8"));
    assert.equal(marker.text, undefined); assert.equal(marker.messageId, 3);
    assert(!await reopened.hasInput("never")); assert(!await reopened.hasDelivery("never"));
    await reopened.update(next => next.deliveries.push({ key: "fresh", chatId: 42, text: "new", state: "pending", messageId: null }));
    assert.equal(reopened.snapshot().deliveries.at(-1)?.key, "fresh");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("at the hard cap even a single explicitly reviewed unknown delivery can be archived to admit a new result", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-channel-reviewed-cap-")));
  try {
    const store = new TelegramStore(join(root, "private", "telegram.json"), root); await store.load();
    await store.update(data => { data.deliveries = Array.from({ length: 2048 }, (_, n) => ({ key: `result:${n}`, chatId: 42, text: "private body", state: "unknown", messageId: null })); });
    await store.update(data => { data.deliveries[0]!.reviewReport = "已人工处理，保持未知"; });
    await store.update(data => data.deliveries.push({ key: "new", chatId: 42, text: "new", state: "pending", messageId: null }));
    assert.equal(store.snapshot().deliveries.length, 2048);
    assert.equal(store.snapshot().deliveries.find(x => x.key === "result:1")?.state, "unknown");
    const reopened = new TelegramStore(store.path, root); await reopened.load();
    assert(await reopened.hasDelivery("result:0"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("unresolved capacity is rejected, never silently pruned", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-channel-unresolved-")));
  try {
    const store = new TelegramStore(join(root, "private", "telegram.json"), root); await store.load();
    await store.update(data => { data.inputs = Array.from({ length: 1024 }, (_, n) => ({ key: `${n}`, updateId: n, text: "review", state: "unknown", runId: "run", taskId: null })); });
    assert.equal(telegramCapacity(store.snapshot()).blocked, true);
    await assert.rejects(store.update(data => data.inputs.push({ key: "new", updateId: 1024, text: "new", state: "received", runId: null, taskId: null })), /已满/);
    assert.equal(store.snapshot().inputs.length, 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("multipart delivery archives retain per-part receipts but not another copy of private bodies", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-channel-parts-archive-")));
  try {
    const store = new TelegramStore(join(root, 'private', 'telegram.json'), root); await store.load();
    await store.update(data => { data.deliveries = Array.from({ length: 1025 }, (_, n) => ({ key: `result:${n}`, chatId: 42,
      text: 'private body', state: 'submitted', messageId: n + 1,
      parts: [{ text: '<b>private rendered body</b>', state: 'submitted', messageId: n + 1 }] })); });
    const archive = join(root, 'private', 'telegram-archive', 'deliveries', createHash('sha256').update('result:0').digest('hex') + '.json');
    const text = await readFile(archive, 'utf8');
    assert.ok(!text.includes('private'));
    assert.deepEqual(JSON.parse(text).parts, [{ state: 'submitted', messageId: 1 }]);
    const reopened = new TelegramStore(store.path, root); await reopened.load();
    assert.ok(await reopened.hasDelivery('result:0'));
    assert.equal(reopened.snapshot().version, 2, 'old binaries cannot interpret multipart retries as legacy single sends');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("inconsistent multipart retry state fails closed before persistence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-channel-parts-invalid-")));
  try {
    const store = new TelegramStore(join(root, 'private', 'telegram.json'), root); await store.load();
    await assert.rejects(store.update(data => data.deliveries.push({ key: 'result:bad', chatId: 42, text: 'body', state: 'failed', messageId: null,
      parts: [{ text: 'unknown must not be retried', state: 'unknown', messageId: null }] })), /无效/);
    assert.equal(store.snapshot().deliveries.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
