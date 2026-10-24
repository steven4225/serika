import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createMemoryStore } from "./memory-v6-store.js";
import { createAssistantController } from "./assistant-controller.js";
import { memorySnapshot } from "./memory-snapshot.js";
import { memoryReadTools } from "./memory-read-tools.js";

test("production five-layer runtime persists references, reopens the same prefix, reads documents and overflow without approval", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-five-layer-"));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json"), directory = join(root, "transcripts");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { memory: { enabled: true, autoConsolidate: true } },
    automation: { dreaming: { enabled: true } }, desktopAutonomy: { authorizedDirectory: workspace } }));
  const store = createMemoryStore(join(workspace, ".runloom/memory.json")), documentId = randomUUID();
  assert.ok((await store.changeLibrary!({ operation: "save-document", id: documentId, title: "reference document", text: "DOCUMENT_BODY_ONLY_ON_READ", folderId: null, expectedRevision: 0, entries: [] })).ok);
  for (let i = 0; i < 3; i++) assert.ok((await store.add({ text: `overflow_marker_${i} ` + "x".repeat(1800) })).ok);
  assert.ok((await store.add({ text: "DISABLED_SECRET", enabled: false })).ok);
  const prompts: Array<Parameters<MockLanguageModelV3["doStream"]>[0]> = [];
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
  const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("No retrieval or dreaming model call is allowed"); }, doStream: async options => {
    prompts.push(structuredClone(options));
    const query = prompts.length === 1 ? { id: documentId } : prompts.length === 2 ? { query: "overflow_marker" } : undefined;
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] }, ...(query ? [{ type: "tool-call" as const, toolCallId: `read-${prompts.length}`, toolName: "memory_read", input: JSON.stringify(query) }] : [{ type: "text-start" as const, id: "answer" },
      { type: "text-delta" as const, id: "answer", delta: "done" }, { type: "text-end" as const, id: "answer" },
      ]), { type: "finish" as const, finishReason: { unified: query ? "tool-calls" as const : "stop" as const, raw: undefined }, usage }] }) };
  } });
  const open = () => createRuntimeApp({ directory, assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "thread", configPath }, modelAlias: "fixture", model, output: new PassThrough(), env: {}, cwd: root, desktopAutonomyHost: { home: join(root, "H") } });
  let app = await open();
  const run = async (id: string) => {
    const request = { id, role: "user" as const, parts: [{ type: "text" as const, text: id }] };
    app.beginForegroundExecution?.("desktop", request);
    try { const handle = await app.runtime.run({ agentId: app.agentId, threadId: "thread", messages: [request], signal: AbortSignal.timeout(5000) });
      assert.equal((await handle.result).status, "completed");
    } finally { await app.endForegroundExecution?.(); }
  };
  try {
    const legacy = { id: "legacy", role: "user" as const, parts: [{ type: "text" as const, text: "old message" }] };
    await app.store.save("thread", [legacy]);
    await run("first");
    const before = await app.store.getMessages("thread");
    assert.deepEqual(before[0], legacy);
    assert.ok(JSON.stringify(before.find(message => message.id === "first")?.metadata).includes("contextReferences"));
    assert.ok(!JSON.stringify(prompts[0]!.prompt).includes("DOCUMENT_BODY_ONLY_ON_READ"));
    assert.ok(JSON.stringify(prompts[1]!.prompt).includes("DOCUMENT_BODY_ONLY_ON_READ"));
    const result = JSON.stringify(prompts[2]!.prompt.filter(message => message.role === "tool"));
    for (let i = 0; i < 3; i++) assert.ok(result.includes(`overflow_marker_${i}`));
    assert.doesNotMatch(JSON.stringify(prompts), /PRIVATE_THREAD|DISABLED_SECRET/);
    assert.equal(prompts[0]!.tools?.some(tool => tool.name === "memory_read"), true);
    assert.equal(prompts[0]!.tools?.some(tool => tool.name === "memory_add"), false);
    const bytes = JSON.stringify(before);
    app.dispose(); app = await open();
    await run("second");
    assert.equal(JSON.stringify((await app.store.getMessages("thread")).slice(0, before.length)), bytes);
    assert.deepEqual(prompts[3]!.prompt.slice(0, prompts[0]!.prompt.length - 1), prompts[0]!.prompt.slice(0, -1));
    const controller = createAssistantController(app);
    assert.equal((await controller.dreaming.dream()).ok, false);
    await controller.shutdown();
  } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("snapshot budgets include whole serialized entries, pin priority and temporal scope, without deleting overflow", () => {
  const entries = [{ id: "large", text: "x".repeat(4096), enabled: true }, { id: "pin", text: "pinned", pinned: true, enabled: true },
    { id: "old", text: "retracted", enabled: false }];
  const selected = memorySnapshot(entries, { now: new Date() });
  assert.deepEqual(selected.entries.map(entry => entry.id), ["pin"]); assert.equal(selected.truncated, true);
  assert.equal(entries.length, 3); assert.ok(selected.bytes < 4096);
});

test("memory reads recheck disabled documents and retracted overflow instead of returning stale bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-read-recheck-")), store = createMemoryStore(join(root, ".runloom/memory.json"));
  try {
    const added = await store.add({ text: "RETRACTED_READ_SECRET" }); assert.ok(added.ok);
    assert.ok((await store.writeV6!([{ id: added.entry.id, expectedRevision: added.entry.revision!, operation: "retract", source: { kind: "manual" } }])).ok);
    const id = randomUUID();
    assert.ok((await store.changeLibrary!({ operation: "save-document", id, title: "document", text: "DISABLED_READ_SECRET", folderId: null, expectedRevision: 0, entries: [] })).ok);
    const material = await store.readReferenceMaterial!(new AbortController().signal, new Date()); assert.ok(material.ok);
    const entry = material.value.entries.find(item => item.text === "DISABLED_READ_SECRET")!;
    assert.ok((await store.update(entry.id, { expectedRevision: entry.revision!, enabled: false })).ok);
    const execute = memoryReadTools({ store, dreaming: undefined, threadId: "thread" })[0]!.tool.execute! as unknown as
      (input: { id?: string; query?: string }, options: { toolCallId: string; messages: never[]; abortSignal: AbortSignal }) => Promise<unknown>;
    const options = { toolCallId: "read", messages: [], abortSignal: new AbortController().signal };
    const search = await execute({ query: "RETRACTED_READ_SECRET" }, options);
    assert.doesNotMatch(JSON.stringify(search), /RETRACTED_READ_SECRET/);
    const document = await execute({ id }, options);
    assert.equal((document as { ok: boolean }).ok, false);
    assert.doesNotMatch(JSON.stringify(document), /DISABLED_READ_SECRET/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
