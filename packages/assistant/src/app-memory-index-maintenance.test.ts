import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createMemoryStore } from "./memory-store.js";

async function fixture(onEmbed?: (texts: readonly string[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "memory-idle-index-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: {
    memory: { enabled: true, semantic: { enabled: true } },
  } }));
  const memory = createMemoryStore(workspace);
  for (let index = 0; index < 45; index++) assert.ok((await memory.add({ text: `有效事实 ${index}` })).ok);
  assert.ok((await memory.add({ text: "foreign secret", scope: { kind: "thread", threadId: "other" } })).ok);
  assert.ok((await memory.add({ text: "disabled secret", enabled: false })).ok);
  const batches: string[][] = [];
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "current", "--config", config],
    modelAlias: "fixture", model: new MockLanguageModelV3({ doGenerate: async () => assert.fail("No model Run for maintenance") }),
    output, env: {}, cwd: root, memoryEmbedding: { modelId: "fixture/index", embed: async texts => {
      batches.push([...texts]); await onEmbed?.(texts); return texts.map(() => [1, 0]);
    } } });
  return { app, memory, batches, cleanup: async () => { app.dispose(); output.destroy(); await rm(root, { recursive: true, force: true }); } };
}

test("idle host maintenance completes the current eligible index without fake queries or repeated ready calls", async () => {
  const f = await fixture();
  try {
    assert.ok(f.app.maintainMemoryIndex, "semantic-enabled apps expose host-owned bounded maintenance");
    await f.app.maintainMemoryIndex(new AbortController().signal);
    assert.deepEqual(f.batches.map(batch => batch.length), [20, 20, 5]);
    assert.equal(f.batches.flat().length, 45);
    assert.ok(f.batches.flat().every(text => text.startsWith("有效事实")));
    await f.app.maintainMemoryIndex(new AbortController().signal);
    assert.equal(f.batches.length, 3, "already indexed facts must not be sent again");
    assert.ok((await f.memory.add({ text: "新增事实" })).ok);
    await f.app.maintainMemoryIndex(new AbortController().signal);
    assert.deepEqual(f.batches[3], ["新增事实"]);
  } finally { await f.cleanup(); }
});

test("each maintenance slice rereads formal revisions before sending the next batch", async () => {
  let afterFirst: (() => Promise<void>) | undefined;
  const f = await fixture(async () => { const effect = afterFirst; afterFirst = undefined; await effect?.(); });
  try {
    afterFirst = async () => { assert.ok((await f.memory.add({ text: "维护期间新增" })).ok); };
    assert.ok(f.app.maintainMemoryIndex);
    await f.app.maintainMemoryIndex(new AbortController().signal);
    assert.equal(f.batches.flat().filter(text => text === "维护期间新增").length, 1);
    assert.equal(f.batches.flat().length, 46);
  } finally { await f.cleanup(); }
});

test("failed maintenance stops after one batch without retrying or pretending ready", async () => {
  const f = await fixture(async () => { throw Error("fixture provider failure"); });
  try {
    assert.ok(f.app.maintainMemoryIndex);
    await assert.rejects(f.app.maintainMemoryIndex(new AbortController().signal), /索引/);
    assert.equal(f.batches.length, 1);
  } finally { await f.cleanup(); }
});

for (const cancellation of ["caller", "dispose"] as const) test(`${cancellation} cancellation stops host maintenance before the next slice`, async () => {
  const operation = new AbortController();
  let cancel: (() => void) | undefined;
  const f = await fixture(async () => { cancel?.(); });
  try {
    cancel = cancellation === "caller" ? () => operation.abort(new DOMException("Foreground priority", "AbortError"))
      : () => f.app.dispose();
    assert.ok(f.app.maintainMemoryIndex);
    await assert.rejects(f.app.maintainMemoryIndex(operation.signal), { name: "AbortError" });
    assert.equal(f.batches.length, 1);
    assert.equal(f.batches[0]!.length, 20);
    if (cancellation === "dispose") {
      await assert.rejects(f.app.maintainMemoryIndex(new AbortController().signal), { name: "AbortError" });
      assert.equal(f.batches.length, 1, "disposed app never dispatches another batch");
    }
  } finally { await f.cleanup(); }
});
