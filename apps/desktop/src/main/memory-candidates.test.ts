import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createDemoModel } from "@serika/assistant";
import type { CandidateDraft } from "@serika/assistant/testing";
import type { MainToRenderer } from "../shared/ui-contract.js";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function draft(text: string, quote: string): CandidateDraft {
  return {
    change: { operation: "add", text, scope: { kind: "workspace" }, expiresAt: null },
    source: { kind: "conversation", threadId: "thread-a", messageId: `message-${quote}`, quote },
    reason: "明确的长期偏好",
  };
}

async function openDesktop(root: string, thread: string, memory: boolean, model: LanguageModel = createDemoModel()) {
  const messages: MainToRenderer[] = [];
  const output = new TeeOutput((message) => { messages.push(message); });
  const app = await createRuntimeApp({
    args: ["--tui", join(root, "transcripts"), "--thread", thread, "--config", join(root, "runloom.json")],
    modelAlias: "mock",
    model,
    output,
    env: {},
    cwd: root,
  });
  const controller = createAssistantController(app);
  output.attach(controller);
  const bridge = new RuntimeBridge(
    app,
    controller,
    { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false },
    output,
    (message) => { messages.push(message); },
  );
  assert.equal(bridge.info().memory.enabled, memory);
  assert.equal(bridge.info().memory.autoConsolidate, false);
  return { app, bridge, messages };
}

async function prepare(memory: boolean) {
  const root = await mkdtemp(join(tmpdir(), "runloom-desktop-memory-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(join(root, "transcripts"));
  await writeFile(join(root, "runloom.json"), JSON.stringify({
    version: 1,
    workspace: "./workspace",
    modules: memory ? { memory: { enabled: true } } : {},
    run: { totalTimeoutMs: 15_000 },
  }), "utf8");
  return { root, workspace };
}

describe("desktop memory candidate review", { concurrency: false }, () => {
  it("lists, previews, and resolves only the current thread, then keeps the receipt across restart", async () => {
    const { root, workspace } = await prepare(true);
    const first = await openDesktop(root, "thread-a", true);
    try {
      const store = first.app.memoryStore;
      assert.ok(store);
      const committed = await store.commitCandidateBatch({
        batchId: "batch-1",
        originThreadId: "thread-a",
        candidates: [draft("先给结论", "先给结论"), draft("用中文回复", "用中文回复")],
        expectedCursor: null,
        nextCursor: null,
      }, undefined, { boundThreadId: "thread-a" });
      assert.equal(committed.ok, true);
      if (!committed.ok) return;
      const [acceptId, rejectId] = committed.value.candidateIds;
      assert.ok(acceptId && rejectId);

      const forged = await first.bridge.listMemoryCandidates({
        status: "pending",
        threadId: "thread-b",
        workspace: workspace,
      } as never);
      assert.equal(forged.ok, true);
      if (!forged.ok) return;
      assert.equal(forged.value.candidates.length, 2);
      assert.equal(forged.value.candidates.every((item) => item.originThreadId === "thread-a"), true);

      const page = await first.bridge.listMemoryCandidates({ status: "pending", limit: 1 });
      assert.equal(page.ok, true);
      if (!page.ok) return;
      assert.equal(page.value.candidates.length, 1);
      assert.equal(typeof page.value.nextOffset, "number");
      const rest = await first.bridge.listMemoryCandidates({ status: "pending", offset: page.value.nextOffset ?? 0, limit: 1 });
      assert.equal(rest.ok, true);
      if (!rest.ok) return;
      assert.equal(rest.value.candidates.length, 1);
      assert.notEqual(rest.value.candidates[0]?.id, page.value.candidates[0]?.id);

      const opened = await first.bridge.getMemoryCandidate(acceptId);
      assert.equal(opened.ok, true);
      if (!opened.ok) return;
      assert.equal(opened.value.candidate.source.quote, "先给结论");
      assert.equal(opened.value.proposed?.text, "先给结论");
      assert.equal(opened.value.proposed?.scope.kind, "workspace");
      assert.equal(opened.value.applicable, true);
      const resolution = await first.bridge.resolveMemoryCandidate({
        candidateId: acceptId,
        expectedCandidateRevision: opened.value.candidate.revision,
        decision: "accept",
        approvalId: "not-used",
        memoryRevision: 99,
      } as never);
      assert.equal(resolution.ok, true);
      if (!resolution.ok) return;
      assert.equal(resolution.value.replayed, false);
      assert.equal(typeof resolution.value.memoryId, "string");
      assert.equal(resolution.value.memoryRevision, 1);
      assert.equal(first.messages.some((message) => message.type === "memory-updated" && message.reason === "review"), true);
      assert.equal(first.messages.some((message) => message.type === "result" && message.phase === "consolidation"), false);
      const replay = await first.bridge.resolveMemoryCandidate({
        candidateId: acceptId,
        expectedCandidateRevision: opened.value.candidate.revision,
        decision: "accept",
      });
      assert.equal(replay.ok, true);
      if (!replay.ok) return;
      assert.equal(replay.value.replayed, true);
      assert.equal(replay.value.memoryId, resolution.value.memoryId);
      const entries = await store.list();
      assert.equal(entries.ok, true);
      if (!entries.ok) return;
      assert.equal(entries.entries.length, 1);

      const rejected = await first.bridge.resolveMemoryCandidate({
        candidateId: rejectId,
        expectedCandidateRevision: 1,
        decision: "reject",
      });
      assert.equal(rejected.ok, true);
      if (!rejected.ok) return;
      assert.equal(rejected.value.status, "rejected");
      const afterReject = await store.list();
      assert.equal(afterReject.ok, true);
      if (!afterReject.ok) return;
      assert.equal(afterReject.entries.length, 1);
    } finally {
      await first.bridge.shutdown();
    }

    const reopened = await openDesktop(root, "thread-a", true);
    try {
      const pending = await reopened.bridge.listMemoryCandidates({ status: "pending" });
      assert.equal(pending.ok, true);
      if (!pending.ok) return;
      assert.equal(pending.value.candidates.length, 0);
      const accepted = await reopened.bridge.listMemoryCandidates({ status: "accepted" });
      assert.equal(accepted.ok, true);
      if (!accepted.ok) return;
      assert.equal(accepted.value.candidates.length, 1);
      const entries = await reopened.app.memoryStore!.list();
      assert.equal(entries.ok, true);
      if (!entries.ok) return;
      assert.equal(entries.entries[0]?.text, "先给结论");
    } finally {
      await reopened.bridge.shutdown();
    }

    const other = await openDesktop(root, "thread-b", true);
    try {
      const hidden = await other.bridge.listMemoryCandidates();
      assert.equal(hidden.ok, true);
      if (!hidden.ok) return;
      assert.equal(hidden.value.candidates.length, 0);
      const entries = await other.app.memoryStore!.list();
      assert.equal(entries.ok, true);
      if (!entries.ok) return;
      assert.equal(entries.entries.length, 1);
    } finally {
      await other.bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a conflict while the controller is busy and does not change the candidate", async () => {
    const { root } = await prepare(true);
    const model = new MockLanguageModelV3({
      doStream: async () => {
        await delay(2_000);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "answer" },
              { type: "text-delta" as const, id: "answer", delta: "later" },
              { type: "text-end" as const, id: "answer" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
            ],
          }),
        };
      },
    });
    const { app, bridge } = await openDesktop(root, "thread-a", true, model);
    try {
      const committed = await app.memoryStore!.commitCandidateBatch({
        batchId: "batch-busy",
        originThreadId: "thread-a",
        candidates: [draft("保持原样", "保持原样")],
        expectedCursor: null,
        nextCursor: null,
      }, undefined, { boundThreadId: "thread-a" });
      assert.equal(committed.ok, true);
      if (!committed.ok) return;
      const started = bridge.run("hold the controller");
      const deadline = Date.now() + 1_000;
      while (bridge.snapshot().state.kind !== "running" && Date.now() < deadline) await delay(10);
      const conflict = await bridge.resolveMemoryCandidate({
        candidateId: committed.value.candidateIds[0]!,
        expectedCandidateRevision: 1,
        decision: "accept",
      });
      assert.equal(conflict.ok, false);
      if (conflict.ok) return;
      assert.equal(conflict.error.code, "MEMORY_CANDIDATE_CONFLICT");
      await bridge.cancel();
      await started;
      const still = await bridge.getMemoryCandidate(committed.value.candidateIds[0]!);
      assert.equal(still.ok, true);
      if (!still.ok) return;
      assert.equal(still.value.candidate.status, "pending");
      const entries = await app.memoryStore!.list();
      assert.equal(entries.ok, true);
      if (!entries.ok) return;
      assert.equal(entries.entries.length, 0);
    } finally {
      await bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a disabled module and a corrupt file instead of an empty candidate list", async () => {
    const disabledRoot = await prepare(false);
    const disabled = await openDesktop(disabledRoot.root, "thread-a", false);
    try {
      const listed = await disabled.bridge.listMemoryCandidates();
      assert.equal(listed.ok, false);
      if (listed.ok) return;
      assert.equal(listed.error.code, "MEMORY_DISABLED");
    } finally {
      await disabled.bridge.shutdown();
      await rm(disabledRoot.root, { recursive: true, force: true });
    }

    const { root } = await prepare(true);
    const first = await openDesktop(root, "thread-a", true);
    await first.bridge.shutdown();
    await mkdir(join(root, "workspace", ".runloom"), { recursive: true });
    await writeFile(join(root, "workspace", ".runloom", "memory.json"), "{broken");
    const second = await openDesktop(root, "thread-a", true);
    try {
      const listed = await second.bridge.listMemoryCandidates();
      assert.equal(listed.ok, false);
      if (listed.ok) return;
      assert.equal(listed.error.code, "MEMORY_FILE_INVALID");
    } finally {
      await second.bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
