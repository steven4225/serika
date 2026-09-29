import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistantEventToRenderer } from "./runtime-bridge.js";
import type { AssistantEvent } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import type { ExecutionRunRecord } from "@aisdk-agent/example-cli/dist/execution-record-store.js";
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
    assert.equal(mapped.type, "result");
    if (mapped.type === "result") assert.equal(mapped.phase, "consolidation");
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
    assert.equal(mapped.type, "approval");
    if (mapped.type === "approval") {
      assert.equal(mapped.approval.approvalId, "apr-1");
      assert.equal(mapped.approval.preview, "");
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
