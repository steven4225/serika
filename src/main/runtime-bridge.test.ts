import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assistantEventToRenderer } from "./runtime-bridge.js";
import type { AssistantEvent } from "@aisdk-agent/example-cli/dist/assistant-controller.js";

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
