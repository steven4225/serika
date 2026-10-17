import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { AssistantSteerRecord } from "@serika/assistant";
import { ConversationDraftStore } from "./conversation-draft-store.js";
import { ConversationDraftSession } from "./conversation-draft-session.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import { draftScope, type DesktopSteerResponse, type ConversationDraftScope } from "../shared/conversation-drafts.js";
import type { GetRunResponse } from "../shared/ui-contract.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "serika-draft-session-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function fakeHost(root: string) {
  let identity: ConversationDraftScope = { workspaceRoot: join(root, "workspace"), directory: join(root, "transcripts"), threadId: "personal" };
  let state = "running", dispatches = 0;
  let result: GetRunResponse = { ok: true, run: null };
  let dispatch: () => Promise<DesktopSteerResponse> = async () => ({ ok: false, reason: "failed" });
  const host = {
    info: () => identity,
    current: {
      steer: async () => { dispatches++; return dispatch(); },
      snapshot: () => ({ state: { kind: state } }),
      getRun: async () => result,
    },
  };
  return {
    host: host as unknown as ConstructorParameters<typeof ConversationDraftSession>[0],
    scope: () => ({ ...identity }),
    dispatches: () => dispatches,
    setScope: (next: ConversationDraftScope) => { identity = next; },
    setState: (next: string) => { state = next; },
    setDispatch: (next: () => Promise<DesktopSteerResponse>) => { dispatch = next; },
    setResult: (next: GetRunResponse) => { result = next; },
  };
}
function input(scope: ConversationDraftScope) { return { scope, id: "request-1", expectedRunId: "run-1", text: "保留原文再追加两步" }; }
function receipt(status: AssistantSteerRecord["status"] = "applied"): AssistantSteerRecord {
  return { id: "request-1", runId: "run-1", text: "保留原文再追加两步", status, receivedAt: new Date().toISOString() };
}
function runResult(threadId: string, steers: AssistantSteerRecord[]): GetRunResponse {
  return { ok: true, run: { runId: "run-1", threadId, phase: "primary", status: "running", startedAt: new Date().toISOString(), finishedAt: null,
    resultTextPreview: null, resultTextTruncated: false, errorPreview: null, tools: [], steers } };
}

describe("persisted desktop Steer session", () => {
  it("releases task-origin uncertainty back to the same task and never overwrites ordinary or newer task drafts", async () => fixture(async root => {
    const store = new ConversationDraftStore(join(root, "profile")), fake = fakeHost(root);
    const session = new ConversationDraftSession(fake.host, store), request = { ...input(fake.scope()), taskId: "task-1" };
    await session.save(request.scope, { text: "separate chat", excludeFromMemory: true });
    await session.steer(request);
    fake.setState("idle");
    await session.saveTask(request.scope, { kind: "instruction", taskId: "task-1", text: "new task draft" });
    await assert.rejects(session.release(request.scope, request.id), /另有新草稿/);
    assert.ok((await session.load(request.scope)).uncertainSteer);
    await session.saveTask(request.scope, { kind: "instruction", taskId: "task-1", text: request.text });
    assert.equal(await session.release(request.scope, request.id), true);
    const restored = await new ConversationDraftSession(fake.host, new ConversationDraftStore(join(root, "profile"))).load(request.scope);
    assert.equal(restored.draft.text, "separate chat");
    assert.equal(restored.taskDrafts?.instructions["task-1"], request.text);
    assert.equal(restored.taskDrafts?.composerTaskId, "task-1");
    assert.equal(restored.uncertainSteer, null);
    assert.equal(fake.dispatches(), 1);
    fake.setScope({ ...request.scope, threadId: "another" });
    assert.throws(() => session.saveTask(request.scope, { kind: "composer", taskId: "task-1" }), /会话已切换/);
  }));
  it("persists pending identity before dispatch and retains it through thrown or failed responses and reconstruction", async () => fixture(async root => {
    for (const mode of ["throw", "failed"] as const) {
      const store = new ConversationDraftStore(join(root, mode)), fake = fakeHost(root);
      const request = input(fake.scope());
      const session = new ConversationDraftSession(fake.host, store);
      await session.save(request.scope, { text: request.text, excludeFromMemory: true });
      fake.setDispatch(async () => {
        assert.equal((await new ConversationDraftStore(join(root, mode)).load(request.scope)).uncertainSteer?.id, request.id);
        if (mode === "throw") throw new Error("IPC response lost");
        return { ok: false, reason: "failed" };
      });
      if (mode === "throw") await assert.rejects(session.steer(request), /response lost/);
      else assert.deepEqual(await session.steer(request), { ok: false, reason: "failed" });
      const reopened = new ConversationDraftSession(fake.host, new ConversationDraftStore(join(root, mode)));
      assert.equal((await reopened.load(request.scope)).uncertainSteer?.id, request.id);
      assert.deepEqual(await reopened.steer({ ...request, id: "another" }), { ok: false, reason: "unresolved" });
      assert.equal(fake.dispatches(), 1, "reloading and repeated send cannot dispatch a new correction");
    }
  }));

  it("never dispatches if persistence fails, and clears a definitive rejection without removing its draft", async () => fixture(async root => {
    const fake = fakeHost(root), userData = join(root, "profile");
    await mkdir(userData);
    await writeFile(join(userData, "conversation-drafts.json"), "broken");
    const store = new ConversationDraftStore(userData), session = new ConversationDraftSession(fake.host, store);
    assert.deepEqual(await session.steer(input(fake.scope())), { ok: false, reason: "storage" });
    assert.equal(fake.dispatches(), 0);
    await writeFile(store.path, JSON.stringify({ version: 1, conversations: {} }));
    await session.save(fake.scope(), { text: "keep draft", excludeFromMemory: true });
    fake.setDispatch(async () => ({ ok: false, reason: "stale" }));
    assert.deepEqual(await session.steer(input(fake.scope())), { ok: false, reason: "stale" });
    assert.deepEqual(await session.load(fake.scope()), { draft: { text: "keep draft", excludeFromMemory: true }, uncertainSteer: null });
  }));

  it("acknowledges only observed receipts, preserving new drafts and not-applied correction text", async () => fixture(async root => {
    const store = new ConversationDraftStore(join(root, "profile")), fake = fakeHost(root);
    const session = new ConversationDraftSession(fake.host, store), request = input(fake.scope());
    await session.save(request.scope, { text: request.text, excludeFromMemory: true });
    await session.steer(request);
    fake.setResult({ ok: false, reason: "unavailable", message: "unreadable" });
    await assert.rejects(session.acknowledge(request.scope, request.id), /保持锁定/);
    fake.setResult(runResult(request.scope.threadId, [{ ...receipt(), id: "other" }]));
    assert.equal(await session.acknowledge(request.scope, request.id), null);
    assert.ok((await session.load(request.scope)).uncertainSteer);
    fake.setResult(runResult("another-thread", [receipt()]));
    assert.equal(await session.acknowledge(request.scope, request.id), null);
    assert.ok((await session.load(request.scope)).uncertainSteer);
    fake.setResult(runResult(request.scope.threadId, [{ ...receipt(), text: "wrong text" }]));
    assert.equal(await session.acknowledge(request.scope, request.id), null);
    assert.ok((await session.load(request.scope)).uncertainSteer);
    fake.setResult(runResult(request.scope.threadId, [receipt("not_applied")]));
    assert.equal((await session.acknowledge(request.scope, request.id))?.status, "not_applied");
    assert.equal((await session.load(request.scope)).draft.text, request.text);
    await session.steer(request);
    fake.setResult(runResult(request.scope.threadId, [receipt()]));
    await session.save(request.scope, { text: "new unsent thought", excludeFromMemory: false });
    await session.acknowledge(request.scope, request.id);
    assert.equal((await session.load(request.scope)).draft.text, "new unsent thought");
    await session.save(request.scope, { text: request.text, excludeFromMemory: true });
    await session.steer(request);
    await session.acknowledge(request.scope, request.id);
    assert.deepEqual(await session.load(request.scope), { draft: { text: "", excludeFromMemory: false }, uncertainSteer: null });
    assert.equal(fake.dispatches(), 3, "acknowledgement never starts a Run or dispatches a correction");
  }));

  it("rejects late old-scope writes and only releases uncertain text after explicit idle action", async () => fixture(async root => {
    const store = new ConversationDraftStore(join(root, "profile")), fake = fakeHost(root);
    const session = new ConversationDraftSession(fake.host, store), old = fake.scope();
    await session.save(old, { text: "old draft", excludeFromMemory: true });
    fake.setScope({ ...old, threadId: "new-thread" });
    assert.throws(() => session.save(old, { text: "late text", excludeFromMemory: false }), /会话已切换/);
    await assert.rejects(session.steer(input(old)), /会话已切换/);
    assert.equal((await store.load(old)).draft.text, "old draft");
    assert.equal((await session.load(fake.scope())).draft.text, "");
    const request = input(fake.scope());
    await session.steer(request);
    await assert.rejects(session.release(request.scope, request.id), /还在运行/);
    assert.ok((await session.load(request.scope)).uncertainSteer);
    fake.setState("idle");
    assert.equal(await session.release(request.scope, "wrong-id"), false);
    await session.save(request.scope, { text: "different draft", excludeFromMemory: false });
    await assert.rejects(session.release(request.scope, request.id), /另有一份草稿/);
    assert.equal((await session.load(request.scope)).uncertainSteer?.text, request.text);
    await session.save(request.scope, { text: request.text, excludeFromMemory: false });
    assert.equal(await session.release(request.scope, request.id), true);
    assert.deepEqual(await session.load(request.scope), { draft: { text: request.text, excludeFromMemory: false }, uncertainSteer: null });
    assert.equal(fake.dispatches(), 1, "manual release does not replay or begin a Run");
  }));
});

it("uses real same-Run steering receipts after full DesktopRuntime and draft-store reconstruction", async () => fixture(async root => {
  const workspace = join(root, "workspace"), userData = join(root, "profile"), configPath = join(root, "config.json");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { "read-file": { enabled: true }, memory: { enabled: false } }, run: { totalTimeoutMs: 15_000 } }));
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls++;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      ...(calls === 1 ? [{ type: "tool-call" as const, toolCallId: "old-write", toolName: "write_file", input: JSON.stringify({ path: "notes.md", content: "old intent" }) }] : [
        { type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: "只保留要求，不再写入。" }, { type: "text-end" as const, id: "answer" },
      ]),
      { type: "finish" as const, finishReason: { unified: calls === 1 ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
    ] }) };
  } });
  const options = { userData, cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", model, send: () => {} };
  let host = await DesktopRuntime.create(options);
  async function until(check: () => boolean) {
    const deadline = Date.now() + 8_000;
    while (!check()) { if (Date.now() > deadline) throw new Error("Desktop session timed out"); await delay(10); }
  }
  try {
    const scope = draftScope(host.info()), session = new ConversationDraftSession(host, new ConversationDraftStore(userData));
    const started = await host.current.run("写 notes.md", { memoryConsolidation: "exclude" });
    assert.ok(started.ok); if (!started.ok) return;
    await until(() => host.current.snapshot().pendingApproval !== null);
    const text = "不写文件，只说明会保留原文";
    await session.save(scope, { text, excludeFromMemory: true });
    assert.ok((await session.steer({ scope, id: "real-request", expectedRunId: started.runId, text })).ok);
    await until(() => host.current.snapshot().state.kind === "idle");
    await host.shutdown();
    host = await DesktopRuntime.create(options);
    const restored = new ConversationDraftSession(host, new ConversationDraftStore(userData));
    assert.equal((await restored.load(scope)).uncertainSteer?.id, "real-request");
    assert.equal((await restored.acknowledge(scope, "real-request"))?.status, "applied");
    assert.equal((await restored.load(scope)).draft.text, "");
    const runs = await host.current.listRuns(); assert.ok(runs.ok);
    assert.equal(runs.runs.length, 1); assert.equal(runs.runs[0]?.runId, started.runId);
    assert.equal(runs.runs[0]?.tools[0]?.status, "not_started");
    assert.equal(calls, 2, "restart and acknowledgement do not invoke the model or replay tools");
  } finally { await host.shutdown(); }
}));
