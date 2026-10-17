import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { createMemoryStore, MEMORY_FILE_NAME } from "./memory-store.js";

// Accept/reject/replay already have real-store Controller coverage in
// assistant-controller.test.ts. This exercises the missing preview/confirm race
// through the assembled runtime, not a mocked candidate-resolution port.
test("Controller review rejects a preview whose formal target changed before confirmation, without another write or Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-review-cas-"));
  let controller: AssistantController | undefined;
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: {
      enabled: true, autoConsolidate: false,
    } } }));
    const output = new PassThrough(); output.resume();
    const model = new MockLanguageModelV3({
      doGenerate: async () => { assert.fail("Candidate review must not call a model"); },
      doStream: async () => { assert.fail("Candidate review must not start a Run"); },
    });
    const app = await createRuntimeApp({
      directory: join(root, "transcripts"), assistant: { threadId: "review-thread", configPath: config },
      modelAlias: "fixture/not-real-model", model, output, env: {}, cwd: root,
    });
    controller = createAssistantController(app);
    const store = app.memoryStore!;
    const options = { boundThreadId: "review-thread" };
    const added = await store.add({ text: "报告先给结论", pinned: true,
      scope: { kind: "thread", threadId: "review-thread" } }, undefined, options);
    assert.ok(added.ok);
    const staged = await store.commitCandidateBatch({ batchId: "review", originThreadId: "review-thread",
      expectedCursor: null, nextCursor: null, candidates: [{
        change: { operation: "update", memoryId: added.entry.id, expectedRevision: added.entry.revision!,
          text: "报告先讲背景", expiresAt: null },
        source: { kind: "conversation", threadId: "review-thread", messageId: "source", quote: "报告先讲背景" },
        reason: "用户提出的新偏好",
      }],
    }, undefined, options);
    assert.ok(staged.ok);
    const candidateId = staged.value.candidateIds[0]!;
    const preview = await app.memoryStore!.getCandidate(candidateId, undefined, { boundThreadId: app.threadId });
    assert.ok(preview.ok); assert.equal(preview.value.applicable, true);

    const edited = await createMemoryStore(workspace).update(added.entry.id, {
      expectedRevision: added.entry.revision!, text: "报告先给结论，再列证据",
    }, undefined, options);
    assert.ok(edited.ok);
    const beforeConfirmation = await readFile(join(workspace, MEMORY_FILE_NAME), "utf8");
    const confirmed = await app.memoryStore!.resolveCandidate({ candidateId,
      expectedCandidateRevision: preview.value.candidate.revision, decision: "accept" }, undefined, { boundThreadId: app.threadId });
    assert.equal(confirmed.ok, false);
    if (!confirmed.ok) assert.equal(confirmed.error.code, "MEMORY_CANDIDATE_STALE");
    assert.equal(await readFile(join(workspace, MEMORY_FILE_NAME), "utf8"), beforeConfirmation);
    const current = await store.get(added.entry.id, undefined, options); assert.ok(current.ok);
    assert.equal(current.entry.text, edited.entry.text);
    assert.equal(current.entry.revision, edited.entry.revision);
    assert.equal(current.entry.pinned, true);
    assert.deepEqual(current.entry.scope, { kind: "thread", threadId: "review-thread" });
    const stale = await app.memoryStore!.getCandidate(candidateId, undefined, { boundThreadId: app.threadId }); assert.ok(stale.ok);
    assert.equal(stale.value.candidate.status, "stale");
    assert.equal(stale.value.candidate.staleReason, "target_changed");
    assert.equal(stale.value.applicable, false);
    const pending = await app.memoryStore!.listCandidates({ status: "pending" }, undefined, { boundThreadId: app.threadId }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 0);
    assert.equal(controller.getSnapshot().state.kind, "idle");
    assert.deepEqual(await controller.getHistory(), []);
    assert.deepEqual(await controller.runs.list(), []);
  } finally {
    await controller?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
