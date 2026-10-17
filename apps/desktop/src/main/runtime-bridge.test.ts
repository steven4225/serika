import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistantEventToRenderer, sanitizeCandidateListInput, sanitizeCandidateResolveInput } from "./runtime-bridge.js";
import type { AssistantEvent } from "@serika/assistant";
import type { ExecutionRunRecord } from "@serika/assistant";
import { toGetRunResponse, toListRunsResponse, wrapExecutionQuery } from "../shared/execution-records.js";

describe("assistantEventToRenderer", () => {
  it("forwards structured shell progress without reading terminal text", () => {
    const event: AssistantEvent = {
      type: "shell-progress",
      phase: "primary",
      runId: "run-1",
      progress: {
        toolCallId: "call-1",
        sequence: 1,
        stream: "stdout",
        text: "hello",
        truncated: false,
      },
    };
    assert.deepEqual(assistantEventToRenderer(event), {
      type: "shell-progress",
      phase: "primary",
      runId: "run-1",
      progress: event.progress,
    });
  });

  it("keeps primary and consolidation run results distinct", () => {
    const result = {
      runId: "run-1",
      threadId: "thread",
      status: "completed" as const,
      text: "done",
      steps: 1,
      usage: {},
    };
    const mapped = assistantEventToRenderer({
      type: "run-result",
      phase: "consolidation",
      result,
    });
    assert.ok(mapped);
    if (mapped === null) return;
    assert.equal(mapped.type, "result");
    if (mapped.type === "result") assert.equal(mapped.phase, "consolidation");
    assert.notEqual(mapped.type, "memory-updated");
  });

  it("forwards memory-updated and work-task updates as typed events", () => {
    assert.deepEqual(assistantEventToRenderer({ type: "memory-updated", reason: "proposals" }), {
      type: "memory-updated",
      reason: "proposals",
    });
    assert.deepEqual(assistantEventToRenderer({ type: "work-task-updated", task: {} as never }), { type: "work-task-updated", task: {} });
  });

  it("upserts approvals by id rather than y/n prompt text", () => {
    const mapped = assistantEventToRenderer({
      type: "approval",
      approval: {
        approvalId: "apr-1",
        toolCallId: "call-1",
        toolName: "shell_exec",
        input: { command: "true" },
        preview: "",
      },
    });
    assert.ok(mapped);
    if (mapped === null) return;
    assert.equal(mapped.type, "approval");
    if (mapped.type === "approval") {
      assert.equal(mapped.approval.approvalId, "apr-1");
      assert.equal(mapped.approval.preview, "");
    }
  });
});

describe("memory candidate IPC input", () => {
  it("drops path, thread, and source fields and rejects an unknown status", () => {
    assert.deepEqual(sanitizeCandidateListInput({
      status: "pending",
      offset: 20,
      limit: 20,
      threadId: "other",
      workspace: "/tmp/workspace",
      source: "forged",
    }), { status: "pending", offset: 20, limit: 20 });
    const invalid = sanitizeCandidateListInput({ status: "all" });
    assert.equal("ok" in invalid && invalid.ok, false);
  });

  it("keeps the candidate revision and ignores approvalId or memory revision", () => {
    assert.deepEqual(sanitizeCandidateResolveInput({
      candidateId: "candidate-1",
      expectedCandidateRevision: 2,
      decision: "accept",
      approvalId: "apr-1",
      memoryRevision: 9,
      text: "rewritten",
    }), {
      candidateId: "candidate-1",
      expectedCandidateRevision: 2,
      decision: "accept",
    });
    const missing = sanitizeCandidateResolveInput({ approvalId: "apr-1", decision: "allow" });
    assert.equal("ok" in missing && missing.ok, false);
  });

  it("forwards only an explicit from-now acceptance and rejects supplied dates or rejection overrides", () => {
    const review = { candidateId: "c1", expectedCandidateRevision: 1, decision: "accept" };
    assert.deepEqual(sanitizeCandidateResolveInput({ ...review, effectiveAt: "now", text: "forged", threadId: "other" }),
      { ...review, effectiveAt: "now" });
    for (const input of [{ ...review, effectiveAt: "2026-01-01T00:00:00Z" }, { ...review, effectiveAt: null },
      { ...review, decision: "reject", effectiveAt: "now" }]) {
      const result = sanitizeCandidateResolveInput(input);
      assert.ok("ok" in result && result.ok === false);
    }
  });
});

describe("execution record queries", () => {
  it("wraps listRuns failures as unavailable instead of an empty list", async () => {
    const listed = toListRunsResponse(
      await wrapExecutionQuery(async (): Promise<ExecutionRunRecord[]> => {
        throw new Error("FILE_INVALID: Execution record file must be an object");
      }),
    );
    assert.equal(listed.ok, false);
    if (listed.ok) throw new Error("expected unavailable");
    assert.equal("runs" in listed, false);
  });

  it("keeps getRun null distinct from a query failure", async () => {
    const missing = toGetRunResponse(await wrapExecutionQuery(async () => null));
    assert.equal(missing.ok, true);
    if (missing.ok) assert.equal(missing.run, null);
    const failed = toGetRunResponse(
      await wrapExecutionQuery(async () => {
        throw new Error("CONFLICT");
      }),
    );
    assert.equal(failed.ok, false);
  });
});
