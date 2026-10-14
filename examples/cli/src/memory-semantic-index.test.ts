import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, rm, realpath, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createServer } from "node:http";
import { LocalMemorySemanticIndex, MEMORY_SEMANTIC_WARMUP_BATCH, type MemoryEmbeddingPort } from "./memory-semantic-index.js";
import { retrieveMemories } from "./memory-retrieval.js";
import { createLocalMemoryEmbedder } from "./memory-embedding-client.js";
import type { MemoryEntry } from "./memory-store.js";

const now = new Date("2026-10-14T00:00:00Z");
const fact = (id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({ id, text, revision: 1, enabled: true, status: "active", scope: { kind: "workspace" }, ...extra });
const writing = fact("writing", "复盘先给结论。");
const vector = (text: string): number[] => text.includes("复盘") || text.includes("回顾") ? [1, 0, 0] : text.includes("Serika") ? [0, 1, 0] : [0, 0, 1];
async function fixture(fn: (file: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "semantic-index-test-")));
  try { await fn(join(directory, "index.json")); } finally { await rm(directory, { recursive: true, force: true }); }
}
const port = (calls: string[][] = [], modelId = "fixture-v1"): MemoryEmbeddingPort => ({ modelId, async embed(texts) { calls.push([...texts]); return texts.map(vector); } });

it("recalls fixture paraphrase, exact named facts and never unrelated below threshold", async () => fixture(async file => {
  const entries = [writing, fact("named", "Serika 使用 TypeScript")];
  const index = new LocalMemorySemanticIndex({ file, embedding: port() });
  const semanticHits = await index.search(entries, { query: "回顾应该怎么组织？", now });
  assert.deepEqual(semanticHits.map(hit => hit.id), ["writing"]);
  assert.deepEqual(retrieveMemories(entries, { query: "回顾应该怎么组织？", now, semanticHits }).entries.map(entry => entry.id), ["writing"]);
  assert.deepEqual((await index.search(entries, { query: "Serika", now })).map(hit => hit.id), ["named"]);
  assert.deepEqual(await index.search(entries, { query: "天气", now }), []);
}));

it("filters foreign threads and inactive/expired facts before sending embedding material", async () => fixture(async file => {
  const calls: string[][] = [];
  const entries = [writing, fact("private", "私密复盘", { scope: { kind: "thread", threadId: "secret" } }), fact("off", "停用复盘", { enabled: false }), fact("expired", "过期复盘", { expiresAt: "2020-01-01T00:00:00Z" }), fact("retracted", "撤回复盘", { temporalState: "retracted" })];
  const index = new LocalMemorySemanticIndex({ file, embedding: port(calls) });
  assert.deepEqual((await index.search(entries, { query: "回顾", now, threadId: "current" })).map(hit => hit.id), ["writing"]);
  assert.deepEqual(calls[0], [writing.text, "回顾"]);
}));

it("restart reuses fact vectors and refreshes changed revisions without storing fact text", async () => fixture(async file => {
  const calls: string[][] = [];
  await new LocalMemorySemanticIndex({ file, embedding: port(calls) }).search([writing], { query: "回顾", now });
  const raw = await readFile(file, "utf8");
  assert.ok(!raw.includes(writing.text));
  const second = new LocalMemorySemanticIndex({ file, embedding: port(calls) });
  await second.search([writing], { query: "回顾", now });
  assert.deepEqual(calls[1], ["回顾"]);
  await second.search([{ ...writing, revision: 2, text: "Serika" }], { query: "回顾", now });
  assert.deepEqual(calls[2], ["Serika", "回顾"]);
  const hits = await second.search([writing], { query: "回顾", now });
  assert.deepEqual(retrieveMemories([{ ...writing, revision: 2, text: "Serika" }], { query: "回顾", now, semanticHits: hits }).entries, []);
}));

it("corrupt cache and model change rebuild but never read a symlink cache", async () => fixture(async file => {
  await writeFile(file, "broken");
  const calls: string[][] = [];
  await new LocalMemorySemanticIndex({ file, embedding: port(calls) }).search([writing], { query: "回顾", now });
  await new LocalMemorySemanticIndex({ file, embedding: port(calls, "fixture-v2") }).search([writing], { query: "回顾", now });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [writing.text, "回顾"]);
  await symlink(file, file + ".link");
  assert.deepEqual(await new LocalMemorySemanticIndex({ file: file + ".link", embedding: port(calls) }).search([writing], { query: "回顾", now }), []);
  assert.equal(calls.length, 2);
}));

it("invalid dimensions, NaN, zero vectors and provider errors degrade to lexical", async () => fixture(async file => {
  for (const vectors of [[[1, 0], [1]], [[NaN], [1]], [[0], [0]], [[1e-300], [1e-300]], [[1e300], [1e300]]]) {
    assert.deepEqual(await new LocalMemorySemanticIndex({ file, embedding: { modelId: "fixture", async embed() { return vectors; } } }).search([writing], { query: "回顾", now }), []);
  }
  assert.deepEqual(await new LocalMemorySemanticIndex({ file, embedding: { modelId: "fixture", async embed() { throw Error("down"); } } }).search([writing], { query: "回顾", now }), []);
  assert.deepEqual(retrieveMemories([writing], { query: "复盘", now, semanticHits: [] }).entries.map(entry => entry.id), ["writing"]);
}));

it("keeps safe HTTP 200 response diagnostics through index degradation and clears them on success", async () => fixture(async file => {
  let invalid = true;
  const embedding = createLocalMemoryEmbedder({ modelId: "fixture" }, async (_url, init) => {
    const { input } = JSON.parse(init!.body as string) as { input: string[] };
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index,
      embedding: invalid ? "fixture-secret-must-not-be-recorded" : [1, 0] })) }));
  });
  const index = new LocalMemorySemanticIndex({ file, embedding });
  assert.deepEqual(await index.search([writing], { query: "回顾", now }), []);
  assert.deepEqual(index.lastFailure, { code: "response_vector_invalid", vectorFormat: "string" });
  assert.ok(!JSON.stringify(index.lastFailure).includes("fixture-secret"));
  invalid = false;
  await index.search([writing], { query: "回顾", now });
  assert.equal(index.lastState, "ready");
  assert.equal(index.lastFailure, undefined);
}));

it("distinguishes response count failure from cache-path failure without retaining exception text", async () => fixture(async file => {
  const embedding = createLocalMemoryEmbedder({ modelId: "fixture" }, async () => new Response(JSON.stringify({ data: [] })));
  const count = new LocalMemorySemanticIndex({ file, embedding });
  await count.search([writing], { query: "回顾", now });
  assert.deepEqual(count.lastFailure, { code: "response_count_mismatch", expectedCount: 2, returnedCount: 0 });
  await symlink(file, file + ".link");
  const unsafe = new LocalMemorySemanticIndex({ file: file + ".link", embedding });
  await unsafe.search([writing], { query: "回顾", now });
  assert.deepEqual(unsafe.lastFailure, { code: "cache_read_failed" });
}));

it("embedding deadline bounds uncooperative ports and caller cancellation propagates", async () => fixture(async file => {
  const embedding: MemoryEmbeddingPort = { modelId: "slow", embed: async () => new Promise(() => {}) };
  const index = new LocalMemorySemanticIndex({ file, embedding, timeoutMs: 20 });
  assert.deepEqual(await index.search([writing], { query: "回顾", now }), []);
  assert.deepEqual(index.lastFailure, { code: "deadline_exceeded" });
  const controller = new AbortController();
  const pending = index.search([writing], { query: "回顾", now, signal: controller.signal });
  controller.abort(new Error("foreground cancelled"));
  await assert.rejects(pending, /foreground cancelled/);
}));

it("hybrid top-k keeps pins first, honors current hashes and the serialized budget", async () => fixture(async file => {
  const entries = Array.from({ length: 20 }, (_, n) => fact(String(n).padStart(2, "0"), "复盘先给结论。"));
  const semanticHits = await new LocalMemorySemanticIndex({ file, embedding: port() }).search(entries, { query: "回顾", now });
  assert.equal(semanticHits.length, 12);
  const selection = retrieveMemories([...entries, fact("pin", "pinned unrelated", { pinned: true })], { query: "回顾", now, semanticHits });
  assert.equal(selection.entries[0]?.id, "pin");
  assert.equal(selection.entries.length, 12);
  assert.ok(selection.bytes <= 8192);
}));

it("dimension changes invalidate all old vectors without retrying the provider", async () => fixture(async file => {
  const calls: string[][] = [];
  await new LocalMemorySemanticIndex({ file, embedding: port(calls) }).search([writing], { query: "回顾", now });
  const embedding: MemoryEmbeddingPort = { modelId: "fixture-v1", async embed(texts) { calls.push([...texts]); return texts.map(() => [1, 0]); } };
  const changed = new LocalMemorySemanticIndex({ file, embedding });
  assert.deepEqual(await changed.search([writing], { query: "回顾", now }), []);
  assert.equal(changed.lastState, "degraded");
  assert.deepEqual(calls[1], ["回顾"]);
  assert.deepEqual((JSON.parse(await readFile(file, "utf8")) as { records: unknown[] }).records, []);
  assert.deepEqual((await changed.search([writing], { query: "回顾", now })).map(hit => hit.id), ["writing"]);
  assert.equal(changed.lastState, "ready");
  assert.deepEqual(calls[2], [writing.text, "回顾"]);
}));

it("does not call embedding or overwrite through a symlinked parent or oversized cache", async () => fixture(async file => {
  const outside = file + "-outside";
  await mkdir(outside);
  await symlink(outside, file + "-directory");
  const calls: string[][] = [];
  const linked = new LocalMemorySemanticIndex({ file: join(file + "-directory", "index.json"), embedding: port(calls) });
  assert.deepEqual(await linked.search([writing], { query: "回顾", now }), []);
  assert.equal(calls.length, 0);
  await assert.rejects(stat(join(outside, "index.json")), { code: "ENOENT" });
  await writeFile(file, " ".repeat(16 * 1024 * 1024 + 1));
  assert.deepEqual(await new LocalMemorySemanticIndex({ file, embedding: port(calls) }).search([writing], { query: "回顾", now }), []);
  assert.equal(calls.length, 0);
  assert.equal((await stat(file)).size, 16 * 1024 * 1024 + 1);
}));

it("late embedding completion after timeout/cancellation cannot write the cache", async () => fixture(async file => {
  let resolveEmbedding: ((vectors: number[][]) => void) | undefined;
  const embedding: MemoryEmbeddingPort = { modelId: "slow", embed: async () => new Promise(resolve => { resolveEmbedding = resolve; }) };
  const index = new LocalMemorySemanticIndex({ file, embedding, timeoutMs: 20 });
  assert.deepEqual(await index.search([writing], { query: "回顾", now }), []);
  resolveEmbedding!([[1], [1]]);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(stat(file), { code: "ENOENT" });
  const controller = new AbortController();
  const pending = index.search([writing], { query: "回顾", now, signal: controller.signal });
  // Wait until the provider, rather than only the filesystem preparation, is pending.
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(new Error("user stop"));
  await assert.rejects(pending, /user stop/);
  resolveEmbedding!([[1], [1]]);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(stat(file), { code: "ENOENT" });
}));

it("current lifecycle filtering rejects stale hits after disable, retract, expiry and scope changes", async () => fixture(async file => {
  const semanticHits = await new LocalMemorySemanticIndex({ file, embedding: port() }).search([writing], { query: "回顾", now });
  for (const mutation of [{ enabled: false }, { temporalState: "retracted" }, { expiresAt: now.toISOString() }, { scope: { kind: "thread", threadId: "elsewhere" } }] satisfies Partial<MemoryEntry>[]) {
    assert.deepEqual(retrieveMemories([{ ...writing, ...mutation }], { query: "回顾", now, threadId: "current", semanticHits }).entries, []);
  }
}));

it("corrupt duplicate cache IDs rebuild; duplicate current IDs fail closed", async () => fixture(async file => {
  const calls: string[][] = [];
  const index = new LocalMemorySemanticIndex({ file, embedding: port(calls) });
  await index.search([writing], { query: "回顾", now });
  const cache = JSON.parse(await readFile(file, "utf8")) as { records: unknown[] };
  cache.records.push(cache.records[0]);
  await writeFile(file, JSON.stringify(cache));
  await index.search([writing], { query: "回顾", now });
  assert.deepEqual(calls[1], [writing.text, "回顾"]);
  assert.deepEqual(await index.search([writing, writing], { query: "回顾", now }), []);
  assert.equal(calls.length, 2);
}));

it("large cold caches warm in bounded increments and keep progress across restart", async () => fixture(async file => {
  const entries = Array.from({ length: 45 }, (_, n) => fact(String(n), "复盘先给结论。"));
  const calls: string[][] = [];
  const first = new LocalMemorySemanticIndex({ file, embedding: port(calls) });
  assert.equal((await first.search(entries, { query: "回顾", now })).length, 12);
  assert.equal(calls[0]?.length, MEMORY_SEMANTIC_WARMUP_BATCH + 1);
  assert.equal(first.lastState, "warming");
  const second = new LocalMemorySemanticIndex({ file, embedding: port(calls) });
  await second.search(entries, { query: "回顾", now });
  assert.equal(calls[1]?.length, MEMORY_SEMANTIC_WARMUP_BATCH + 1);
  assert.equal(second.lastState, "warming");
  await second.search(entries, { query: "回顾", now });
  assert.equal(calls[2]?.length, 6);
  assert.equal(second.lastState, "ready");
  assert.equal((JSON.parse(await readFile(file, "utf8")) as { records: unknown[] }).records.length, 45);
  await second.search(entries, { query: "回顾", now });
  assert.deepEqual(calls[3], ["回顾"]);
}));

it("local HTTP fixture client drives index warmup, paraphrase retrieval and restart vector reuse", async () => fixture(async file => {
  const inputs: string[][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; input: string[] };
    inputs.push(body.input);
    assert.equal(request.url, "/v1/embeddings");
    assert.equal(body.model, "fixture");
    assert.equal(request.headers.authorization, undefined);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: vector(text) })).reverse(), usage: { prompt_tokens: body.input.length, total_tokens: body.input.length } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const embedding = createLocalMemoryEmbedder({ baseURL: `http://127.0.0.1:${address.port}/v1`, modelId: "fixture" });
    const entries = [writing, ...Array.from({ length: 21 }, (_, n) => fact(`weather-${n}`, "天气预报")), fact("foreign", "私密复盘", { scope: { kind: "thread", threadId: "private" } })];
    const first = new LocalMemorySemanticIndex({ file, embedding });
    const semanticHits = await first.search(entries, { query: "回顾应该怎么组织？", now, threadId: "current" });
    assert.deepEqual(retrieveMemories(entries, { query: "回顾应该怎么组织？", now, threadId: "current", semanticHits }).entries.map(entry => entry.id), ["writing"]);
    assert.deepEqual(inputs.map(input => input.length), [10, 10, 1]);
    assert.equal(first.lastState, "warming");
    assert.deepEqual(embedding.lastUsage, { inputTokens: 21, totalTokens: 21 });
    const restarted = new LocalMemorySemanticIndex({ file, embedding });
    await restarted.search(entries, { query: "回顾应该怎么组织？", now, threadId: "current" });
    assert.equal(inputs[3]?.length, 3);
    assert.equal(restarted.lastState, "ready");
    await restarted.search(entries, { query: "回顾应该怎么组织？", now, threadId: "current" });
    assert.deepEqual(inputs[4], ["回顾应该怎么组织？"]);
    assert.ok(!inputs.flat().includes("私密复盘"));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}));
