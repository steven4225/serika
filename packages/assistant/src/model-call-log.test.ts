import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { hashCanonicalJson } from "@serika/core";
import { ModelCallLog, modelInputSegments } from "./model-call-log.js";
import { ExecutionRecordStore } from "./execution-record-store.js";
import { observeModelUsage } from "./model-usage-observer.js";
import type { ModelCallRecord } from "./model-usage.js";

const at = new Date("2026-10-20T16:00:00.000Z");
const call = (id: string): ModelCallRecord => ({ id, threadId: "thread", runId: "run", purpose: "chat",
  provider: "mock", modelId: "mock", startedAt: at.toISOString(), finishedAt: null, status: "pending", usage: {} });
const response = { content: [{ type: "text" as const, text: "private response" }],
  finishReason: { unified: "stop" as const, raw: undefined }, warnings: [],
  usage: { inputTokens: { total: 17, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined } } };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "serika-call-log-"));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
async function events(directory: string) {
  const names = (await readdir(directory)).filter(name => /^model-calls-.*\.jsonl$/.test(name)).sort();
  return (await Promise.all(names.map(name => readFile(join(directory, name), "utf8"))))
    .flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
}

test("provider segments preserve order, canonical hashes and byte/token counts without retaining content", () => {
  const input = { tools: [{ name: "fixture", inputSchema: { type: "object" } }],
    prompt: [{ role: "system", content: "fixed" }, { role: "user", content: "私密原话" }] };
  const segments = modelInputSegments(input);
  assert.deepEqual(segments.map(s => s.part), ["tools", "system", "user"]);
  assert.equal(segments[2]!.hash, hashCanonicalJson(input.prompt[1]!));
  assert.equal(segments[2]!.bytes, Buffer.byteLength(JSON.stringify(input.prompt[1])));
  assert.equal(segments[2]!.estimatedTokens, Math.ceil(JSON.stringify(input.prompt[1]).length / 2));
  const changed = modelInputSegments({ ...input, prompt: [input.prompt[0]!, { role: "user", content: "new" }] });
  assert.deepEqual(changed.slice(0, 2), segments.slice(0, 2));
  assert.notEqual(changed[2]!.hash, segments[2]!.hash);
  const reordered = { prompt: [{ content: "fixed", role: "system" }] };
  assert.equal(modelInputSegments(reordered)[1]!.hash, segments[1]!.hash);
  assert.doesNotMatch(JSON.stringify(segments), /私密|fixed|inputSchema/);
});

test("daily append retains more than 128 attempts and exactly 30 calendar days at +08:00", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "model-calls-2026-09-21.jsonl"), "old\n");
    await writeFile(join(f.directory, "model-calls-2026-09-22.jsonl"), "kept\n");
    await writeFile(join(f.directory, "execution-records.json"), "receipt sentinel");
    const log = new ModelCallLog(f.directory, () => at);
    for (let i = 0; i < 129; i++) await log.start(call(String(i)), []);
    await log.finish({ id: "128", status: "returned", usage: { inputTokens: 17, outputTokens: 2 }, durationMs: 25 });
    const names = await readdir(f.directory);
    assert.ok(!names.includes("model-calls-2026-09-21.jsonl"));
    assert.ok(names.includes("model-calls-2026-09-22.jsonl"));
    const text = await readFile(join(f.directory, "model-calls-2026-10-21.jsonl"), "utf8");
    const rows = text.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.length, 130);
    assert.equal(rows.at(-1).durationMs, 25);
    assert.equal(rows.at(-1).usage.cacheReadTokens, undefined);
    assert.equal(await readFile(join(f.directory, "execution-records.json"), "utf8"), "receipt sentinel");
  } finally { await f.cleanup(); }
});

test("locked concurrent append and reopen preserve complete events after an interrupted suffix", async () => {
  const f = await fixture();
  try {
    const file = join(f.directory, "model-calls-2026-10-21.jsonl");
    await writeFile(file, '{"incomplete":');
    await Promise.all(["one", "two", "three"].map(id => new ModelCallLog(f.directory, () => at).start(call(id), [])));
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines[0], '{"incomplete":');
    assert.deepEqual(lines.slice(1).map(line => JSON.parse(line).id).sort(), ["one", "three", "two"]);
    await new ModelCallLog(f.directory, () => at).finish({ id: "one", status: "unknown", usage: {}, durationMs: 50 });
    assert.equal(JSON.parse((await readFile(file, "utf8")).trim().split("\n").at(-1)!).status, "unknown");
  } finally { await f.cleanup(); }
});

test("log barrier failure stops dispatch, preserves a symlink target and latches subsequent calls", async () => {
  const f = await fixture();
  try {
    const target = join(f.directory, "sentinel");
    await writeFile(target, "untouched");
    await symlink(target, join(f.directory, "model-calls-2026-10-21.jsonl"));
    let dispatches = 0;
    const model = observeModelUsage(new MockLanguageModelV3({ doGenerate: async () => { dispatches++; return response; } }), {
      records: new ExecutionRecordStore(f.directory), threadId: "thread", enabled: () => true,
      scope: () => ({ purpose: "chat", runId: "run" }), callLog: new ModelCallLog(f.directory, () => at),
    });
    await assert.rejects(generateText({ model, prompt: "secret", maxRetries: 0 }));
    await assert.rejects(generateText({ model, prompt: "secret", maxRetries: 0 }), /restart/);
    assert.equal(dispatches, 0);
    assert.equal(await readFile(target, "utf8"), "untouched");
  } finally { await f.cleanup(); }
});

test("actual generate and cancellation log metadata once; missing usage stays unknown", async () => {
  const f = await fixture();
  try {
    const log = new ModelCallLog(f.directory, () => at);
    const records = new ExecutionRecordStore(f.directory);
    const options = { records, threadId: "thread", enabled: () => true, scope: () => ({ purpose: "chat" as const, runId: "run" }), callLog: log };
    const model = observeModelUsage(new MockLanguageModelV3({ doGenerate: async () => response }), options);
    await generateText({ model, system: "private instruction", prompt: "private input", maxRetries: 0 });
    let rows = await events(f.directory);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].runId, "run"); assert.equal(rows[1].id, rows[0].id);
    assert.deepEqual(rows[1].usage, { inputTokens: 17, outputTokens: 2, totalTokens: 19 });
    assert.ok(rows[1].durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(rows), /private instruction|private input|private response/);
    let started!: () => void, resolve!: (value: typeof response) => void;
    const dispatched = new Promise<void>(r => { started = r; });
    const slow = observeModelUsage(new MockLanguageModelV3({ doGenerate: () => { started(); return new Promise(r => { resolve = r; }); } }), options);
    const controller = new AbortController();
    const pending = generateText({ model: slow, prompt: "cancel", abortSignal: controller.signal, maxRetries: 0 });
    await dispatched; controller.abort(); resolve(response);
    await assert.rejects(pending);
    rows = await events(f.directory);
    assert.equal(rows.length, 4);
    assert.equal(rows.at(-1).status, "cancelled");
    assert.deepEqual(rows.at(-1).usage, {});
  } finally { await f.cleanup(); }
});

test("32K and daily-window provider inputs are fingerprinted whole without changing the request", async () => {
  const f = await fixture();
  try {
    for (const tokens of [26_624, 256_000]) {
      const text = "a".repeat(tokens * 2 - JSON.stringify({ role: "user", content: [{ type: "text", text: "" }] }).length);
      const model = observeModelUsage(new MockLanguageModelV3({ doGenerate: async params => {
        assert.equal(params.prompt[0]!.role, "user");
        assert.deepEqual(params.prompt[0]!.content, [{ type: "text", text }]);
        return response;
      } }), { records: new ExecutionRecordStore(f.directory), threadId: "thread", enabled: () => true,
        scope: () => ({ purpose: "chat" }), callLog: new ModelCallLog(f.directory, () => at) });
      await generateText({ model, prompt: text, maxRetries: 0 });
      const rows = await events(f.directory);
      const segment = rows.at(-2).segments.at(-1);
      assert.equal(segment.estimatedTokens, tokens);
      assert.equal(segment.bytes, tokens * 2);
    }
  } finally { await f.cleanup(); }
});
