import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { createMemoryStore } from "./memory-store.js";

function response(toolName?: string, input?: unknown) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(toolName ? [{ type: "tool-call" as const, toolCallId: toolName, toolName, input: JSON.stringify(input) }] : [
      { type: "text-start" as const, id: "answer" },
      { type: "text-delta" as const, id: "answer", delta: "已处理；待审核不是正式记忆。" },
      { type: "text-end" as const, id: "answer" },
    ]),
    { type: "finish" as const, finishReason: { unified: toolName ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}

function findBatch(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.batchId === "string" && Array.isArray(record.turns)) return record.batchId;
  for (const child of Object.values(record)) { const found = findBatch(child); if (found) return found; }
  return undefined;
}

describe("native Memory app wiring", () => {
  for (const decision of ["allow", "deny"] as const) {
    it(`persists staged candidates only after success; apply ${decision} uses normal approval`, async () => {
      const root = await mkdtemp(join(tmpdir(), "runloom-memory-app-"));
      await mkdir(join(root, "workspace"));
      const config = join(root, "config.json");
      await writeFile(config, JSON.stringify({ version: 1, workspace: "./workspace", modules: { memory: { enabled: true } } }));
      let calls = 0, candidateId = "";
      const prompts: string[] = [];
      const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt)); calls++;
        if (calls === 1) return response("memory_prepare_consolidation", {});
        if (calls === 2) {
          const batchId = findBatch(prompt); assert.ok(batchId, "prepare result must reach model");
          return response("memory_stage_candidates", { batchId, proposals: [{ action: "add", text: "用户喜欢先结论后步骤。", scope: { kind: "workspace" }, sourceMessageId: "source-user", sourceQuote: "我喜欢先结论后步骤。", reason: "明确写作偏好" }] });
        }
        if (calls === 4) return response("memory_apply_candidate", { candidateId, expectedCandidateRevision: 1 });
        return response();
      } });
      const output = new PassThrough(); output.resume();
      const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "review", configPath: config }, modelAlias: "mock", model, output, env: {}, cwd: root });
      await app.store.save("review", [{ id: "source-user", role: "user", parts: [{ type: "text", text: "我喜欢先结论后步骤。" }] }]);
      const controller = createAssistantController(app);
      let allowApply = false;
      controller.subscribe((event) => {
        if (event.type === "approval") controller.confirm({ approvalId: event.approval.approvalId, decision: allowApply ? decision : "allow" });
      });
      async function run(text: string) {
        const done = new Promise<string>((resolve) => {
          const unsubscribe = controller.subscribe((event) => {
            if (event.type === "state" && event.state.kind === "idle") { unsubscribe(); resolve(controller.getSnapshot().lastPrimaryResult?.status ?? "missing"); }
          });
        });
        assert.equal((await controller.run(text)).ok, true);
        assert.equal(await done, "completed");
      }
      try {
        await run("请整理已提交的偏好，暂存候选，不要正式保存。");
        const listed = await controller.listMemoryCandidates(); assert.ok(listed.ok);
        assert.equal(listed.value.candidates.length, 1);
        candidateId = listed.value.candidates[0]!.id;
        assert.deepEqual(await app.memoryStore!.list(), { ok: true, entries: [] });
        const currentReferences: string[] = [];
        const visit = (value: unknown): void => {
          if (typeof value !== "object" || value === null) return;
          if ("text" in value && typeof value.text === "string" && value.text.startsWith("Current Memory reference:")) currentReferences.push(value.text);
          for (const child of Object.values(value)) visit(child);
        };
        visit(JSON.parse(prompts[2]!));
        assert.equal(currentReferences.length, 1);
        assert.doesNotMatch(currentReferences[0]!, /用户喜欢先结论后步骤。/);
        const reopened = createMemoryStore(join(root, "workspace"));
        const persisted = await reopened.listCandidates({}, undefined, { boundThreadId: "review" });
        assert.ok(persisted.ok); assert.equal(persisted.value.candidates[0]!.id, candidateId);
        allowApply = true;
        await run(`请接受候选 ${candidateId}。`);
        const entries = await reopened.list(); assert.ok(entries.ok);
        assert.equal(entries.entries.length, decision === "allow" ? 1 : 0);
        const preview = await controller.getMemoryCandidate(candidateId); assert.ok(preview.ok);
        assert.equal(preview.value.candidate.status, decision === "allow" ? "accepted" : "pending");
        if (decision === "allow") {
          const receipt = await controller.resolveMemoryCandidate({ candidateId, expectedCandidateRevision: 1, decision: "accept" });
          assert.ok(receipt.ok); assert.equal(receipt.value.replayed, true);
          assert.equal(entries.entries[0]!.source?.kind, "conversation");
        }
        const document = JSON.parse(await readFile(join(root, "workspace", ".runloom", "memory.json"), "utf8"));
        assert.equal(document.version, 4);
        const transcript = await app.store.getMessages("review");
        assert.equal(transcript.filter((message) => message.role === "user").length, 3);
      } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
    });
  }
});
