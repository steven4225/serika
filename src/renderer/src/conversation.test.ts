import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@aisdk-agent/core";
import { ShellProgressBuffer } from "../../shared/shell-progress.js";
import {
  applyEvent,
  applyShellProgress,
  emptyLiveRun,
  overlayShellProgress,
  rowsFromHistory,
} from "./conversation.js";

it("keeps background consolidation out of chat without hiding the next user turn", () => {
  const text = (id: string, role: "user" | "assistant", value: string) => ({ id, role, parts: [{ type: "text" as const, text: value }] });
  const messages = [text("u1", "user", "first"), text("a1", "assistant", "reply"),
    { ...text("bg", "user", "internal prompt"), metadata: { source: "auto-consolidation" } },
    text("bg-a", "assistant", "internal analysis"), text("u2", "user", "internal prompt"), text("a2", "assistant", "next reply")];
  assert.deepEqual(rowsFromHistory(messages).map(row => row.kind === "text" ? row.text : row.kind), ["first", "reply", "internal prompt", "next reply"]);
  assert.equal(messages.length, 6); // Display only: original history remains untouched.
});

function completed(output: unknown): AgentEvent {
  return {
    id: "e1",
    type: "tool.call.completed",
    runId: "run",
    threadId: "thread",
    sequence: 2,
    occurredAt: "2026-09-29T00:00:00.000Z",
    data: { toolCallId: "sh-1", toolName: "shell_exec", output },
  };
}

describe("conversation shell display", () => {
  it("shows live progress before the tool result and does not mark truncation as failure", () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({
      toolCallId: "sh-1", sequence: 1, stream: "stdout", text: "working", truncated: false,
    });
    let live = applyEvent(emptyLiveRun, {
      id: "e0",
      type: "tool.call.requested",
      runId: "run",
      threadId: "thread",
      sequence: 1,
      occurredAt: "2026-09-29T00:00:00.000Z",
      data: { toolCallId: "sh-1", toolName: "shell_exec", input: { command: "sleep 1" } },
    });
    live = applyShellProgress(live, "sh-1", buffer);
    const tool = live.rows.find((row) => row.kind === "tool");
    assert.equal(tool?.kind, "tool");
    if (tool?.kind === "tool") {
      assert.equal(tool.status, "requested");
      assert.equal(tool.stdout, "working");
    }
    buffer.apply({
      toolCallId: "sh-1", sequence: 2, stream: "stdout", text: "", truncated: true,
    });
    live = applyShellProgress(live, "sh-1", buffer);
    live = applyEvent(live, completed({
      ok: true, exitCode: 0, cancelled: false, timedOut: false, output: "working", truncated: true,
    }));
    const done = live.rows.find((row) => row.kind === "tool");
    assert.equal(done?.kind, "tool");
    if (done?.kind === "tool") {
      assert.equal(done.status, "ok");
      assert.equal(done.stdout, "working");
      assert.equal(done.progressTruncated, true);
    }
  });

  it("keeps truncated progress when overlaying a snapshot after reload", () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({ toolCallId: "sh-1", sequence: 1, stream: "stdout", text: "log", truncated: false });
    buffer.apply({ toolCallId: "sh-1", sequence: 2, stream: "stdout", text: "", truncated: true });
    const rows = overlayShellProgress(
      [{ kind: "tool", key: "t:sh-1", toolCallId: "sh-1", toolName: "shell_exec", status: "requested" }],
      buffer,
    );
    const tool = rows[0];
    assert.equal(tool?.kind, "tool");
    if (tool?.kind === "tool") {
      assert.equal(tool.stdout, "log");
      assert.equal(tool.progressTruncated, true);
      assert.equal(tool.status, "requested");
    }
  });
});
