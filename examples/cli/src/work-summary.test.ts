import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  WORK_SUMMARY_MAX_BYTES,
  WORK_SUMMARY_VERSION,
  createWorkSummaryFromMessages,
  validateWorkSummary,
  workSummaryBytes,
  lookupTranscript,
  type WorkSummary,
} from "./work-summary.js";

function summary(overrides: Partial<WorkSummary> = {}): WorkSummary {
  return {
    version: WORK_SUMMARY_VERSION,
    coveredThrough: {
      messageId: "message-3",
      messageIndex: 3,
      turn: 1,
    },
    goal: "Finish the report",
    constraints: ["Use the existing workspace"],
    completed: [
      {
        text: "Read the source file",
        evidenceMessageIds: ["message-2"],
      },
    ],
    unresolved: ["Confirm the final output path"],
    failures: [],
    unknowns: [],
    nextStep: "Ask for the output path",
    ...overrides,
  };
}

function errorCode(result: ReturnType<typeof validateWorkSummary>): string {
  if (result.ok) throw new Error("expected summary validation to fail");
  return result.code;
}

function dynamicToolMessage(
  id: string,
  toolName: string,
  state:
    | { type: "output-available"; output: unknown }
    | { type: "output-error"; errorText: string },
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: state.type === "output-available"
      ? [{
          type: "dynamic-tool",
          toolName,
          toolCallId: `call-${id}`,
          state: "output-available",
          input: {},
          output: state.output,
        }]
      : [{
          type: "dynamic-tool",
          toolName,
          toolCallId: `call-${id}`,
          state: "output-error",
          input: {},
          errorText: state.errorText,
        }],
  };
}

describe("work summary contract", () => {
  it("accepts a bounded summary and reports its UTF-8 byte size", () => {
    const value = summary();
    const result = validateWorkSummary(value);

    assert.deepEqual(result, { ok: true, bytes: workSummaryBytes(value) });
    assert.equal(result.ok && result.bytes <= WORK_SUMMARY_MAX_BYTES, true);
  });

  it("rejects empty required text and malformed evidence", () => {
    assert.equal(errorCode(validateWorkSummary(summary({ goal: "  " }))), "EMPTY_TEXT");
    assert.equal(
      errorCode(validateWorkSummary(
        summary({ completed: [{ text: "done", evidenceMessageIds: [] }] }),
      )),
      "INVALID_ITEM",
    );
    assert.equal(
      errorCode(validateWorkSummary(
        summary({
          failures: [
            { text: "failed", evidenceMessageIds: ["message-4", "message-4"] },
          ],
        }),
      )),
      "INVALID_ITEM",
    );
  });

  it("rejects a coverage position that moves backward or changes its message", () => {
    const previous = summary();

    assert.equal(
      errorCode(validateWorkSummary(
        summary({
          coveredThrough: { messageId: "message-2", messageIndex: 2, turn: 1 },
        }),
        previous,
      )),
      "COVERAGE_NOT_MONOTONIC",
    );
    assert.equal(
      errorCode(validateWorkSummary(
        summary({
          coveredThrough: { messageId: "other", messageIndex: 3, turn: 1 },
        }),
        previous,
      )),
      "COVERAGE_NOT_MONOTONIC",
    );
    assert.equal(
      validateWorkSummary(
        summary({
          coveredThrough: { messageId: "message-4", messageIndex: 4, turn: 2 },
        }),
        previous,
      ).ok,
      true,
    );
  });

  it("rejects a summary over the configured byte cap without changing the value", () => {
    const value = summary({ constraints: ["x".repeat(512)] });
    const before = JSON.stringify(value);
    const result = validateWorkSummary(value, undefined, 128);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "SUMMARY_TOO_LARGE");
      assert.equal(result.bytes, Buffer.byteLength(before, "utf8"));
    }
    assert.equal(JSON.stringify(value), before);
  });

  it("does not treat a null next step as an invalid empty value", () => {
    assert.equal(validateWorkSummary(summary({ nextStep: null })).ok, true);
    assert.equal(
      errorCode(validateWorkSummary(summary({ nextStep: "  " }))),
      "EMPTY_TEXT",
    );
  });

  it("looks up one complete turn by message id or turn number without mutation", () => {
    const messages: UIMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "first" }] },
      { id: "a0", role: "assistant", parts: [{ type: "text", text: "answer" }] },
      { id: "u1", role: "user", parts: [{ type: "text", text: "second" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "answer 2" }] },
    ];
    const byId = lookupTranscript(messages, "a0");
    assert.equal(byId.ok, true);
    if (byId.ok) assert.deepEqual(byId.messages.map((message) => message.id), ["u0", "a0"]);
    const byTurn = lookupTranscript(messages, "turn:1");
    assert.equal(byTurn.ok, true);
    if (byTurn.ok) assert.deepEqual(byTurn.messages.map((message) => message.id), ["u1", "a1"]);
    assert.equal(messages.length, 4);
  });

  it("keeps the first user goal and later user constraints without treating prose as completed", () => {
    const messages: UIMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "Save to docs/out.md" }] },
      {
        id: "a0",
        role: "assistant",
        parts: [{ type: "text", text: "I suggest using the existing template" }],
      },
      { id: "u1", role: "user", parts: [{ type: "text", text: "Also keep the original filename" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "I can do that next" }],
      },
    ];
    const summary = createWorkSummaryFromMessages(messages, [0, 1, 2, 3]);
    assert.ok(summary);
    assert.equal(summary.goal, "Save to docs/out.md");
    assert.deepEqual(summary.constraints, ["Also keep the original filename"]);
    assert.deepEqual(summary.completed, []);
    assert.equal(validateWorkSummary(summary).ok, true);
  });

  it("classifies tool results by execution fact and preserves evidence message ids", () => {
    const messages: UIMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "Update the report" }] },
      dynamicToolMessage("success", "write_file", {
        type: "output-available",
        output: { ok: true, path: "docs/report.md" },
      }),
      dynamicToolMessage("business-failure", "write_file", {
        type: "output-available",
        output: { ok: false, code: "FILE_EXISTS" },
      }),
      dynamicToolMessage("execution-error", "read_file", {
        type: "output-error",
        errorText: "TOOL_EXECUTION_FAILED: disk unavailable",
      }),
      dynamicToolMessage("denied", "shell_exec", {
        type: "output-error",
        errorText: "TOOL_DENIED: user declined",
      }),
      dynamicToolMessage("unknown", "calculate", {
        type: "output-available",
        output: { value: 42 },
      }),
    ];

    const summary = createWorkSummaryFromMessages(
      messages,
      messages.map((_, index) => index),
    );

    assert.ok(summary);
    assert.deepEqual(summary.completed.map((item) => item.evidenceMessageIds), [["success"]]);
    assert.match(summary.completed[0]?.text ?? "", /write_file completed: ok=true path=docs\/report\.md/);
    assert.doesNotMatch(summary.completed[0]?.text ?? "", /\{/);
    assert.deepEqual(
      summary.failures.map((item) => item.evidenceMessageIds),
      [["business-failure"], ["execution-error"]],
    );
    assert.match(summary.failures[0]?.text ?? "", /ok=false/);
    assert.match(summary.failures[0]?.text ?? "", /code=FILE_EXISTS/);
    assert.equal(summary.unresolved.length, 1);
    assert.deepEqual(summary.unknowns.map((item) => item.evidenceMessageIds), [["unknown"]]);
    assert.match(summary.unknowns[0]?.text ?? "", /value=42/);
    assert.equal(validateWorkSummary(summary).ok, true);
  });

  it("classifies TOOL_OUTCOME_UNKNOWN as unknown rather than a completed or failed receipt", () => {
    const messages: UIMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "Run the command" }] },
      dynamicToolMessage("unknown-outcome", "shell_exec", {
        type: "output-error",
        errorText: "TOOL_OUTCOME_UNKNOWN: process disconnected",
      }),
    ];
    const summary = createWorkSummaryFromMessages(messages, [0, 1]);
    assert.ok(summary);
    assert.equal(summary.completed.length, 0);
    assert.equal(summary.failures.length, 0);
    assert.equal(summary.unknowns.length, 1);
    assert.match(summary.unknowns[0]?.text ?? "", /unclassified/);
  });

  it("keeps short write receipts and omits file or page bodies from completed facts", () => {
    const messages: UIMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "Save the note" }] },
      dynamicToolMessage("write", "write_file", {
        type: "output-available",
        output: {
          ok: true,
          path: "notes/constraints.md",
          bytes: 421,
          content: "# Status\n".repeat(400),
        },
      }),
      dynamicToolMessage("fetch", "web_fetch", {
        type: "output-available",
        output: {
          ok: true,
          value: {
            finalUrl: "https://example.com/a",
            truncated: false,
            text: "PAGE BODY ".repeat(400),
          },
        },
      }),
    ];
    const summary = createWorkSummaryFromMessages(messages, [0, 1, 2]);
    assert.ok(summary);
    assert.equal(summary.completed.length, 2);
    for (const item of summary.completed) {
      assert.doesNotMatch(item.text, /PAGE BODY/);
      assert.doesNotMatch(item.text, /# Status/);
    }
    assert.match(summary.completed[0]?.text ?? "", /path=notes\/constraints\.md/);
    assert.match(summary.completed[0]?.text ?? "", /bytes=421/);
    assert.match(summary.completed[1]?.text ?? "", /finalUrl=https:\/\/example.com\/a/);
  });

  it("shrinks an oversized omitted transcript until the summary fits", () => {
    const messages: UIMessage[] = [
      {
        id: "u0",
        role: "user",
        parts: [{ type: "text", text: "Keep path docs/report.md and never write /tmp" }],
      },
    ];
    for (let index = 1; index < 20; index += 1) {
      messages.push({
        id: `u${index}`,
        role: "user",
        parts: [{ type: "text", text: "C".repeat(2_000) }],
      });
      messages.push({
        id: `a${index}`,
        role: "assistant",
        parts: [{ type: "text", text: "D".repeat(2_000) }],
      });
    }
    const summary = createWorkSummaryFromMessages(
      messages,
      messages.map((_, index) => index),
    );
    assert.ok(summary);
    assert.equal(validateWorkSummary(summary).ok, true);
    assert.equal(workSummaryBytes(summary) <= WORK_SUMMARY_MAX_BYTES, true);
    assert.match(summary.goal, /docs\/report\.md/);
    assert.match(summary.goal, /never write \/tmp/);
  });

  it("rejects unknown local history selectors", () => {
    assert.deepEqual(lookupTranscript([], "turn:0"), { ok: false, error: "TURN_NOT_FOUND" });
    assert.deepEqual(lookupTranscript([], "missing"), { ok: false, error: "MESSAGE_NOT_FOUND" });
    assert.deepEqual(lookupTranscript([], "turn:nope"), { ok: false, error: "INVALID_SELECTOR" });
  });
});
