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

  it("builds a summary from omitted messages and keeps the first user goal", () => {
    const messages: UIMessage[] = [
      { id: "u0", role: "user", parts: [{ type: "text", text: "Save to docs/out.md" }] },
      { id: "a0", role: "assistant", parts: [{ type: "text", text: "saved" }] },
      { id: "u1", role: "user", parts: [{ type: "text", text: "Also keep the original filename" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
    ];
    const summary = createWorkSummaryFromMessages(messages, [0, 1, 2, 3]);
    assert.ok(summary);
    assert.equal(summary.goal, "Save to docs/out.md");
    assert.deepEqual(summary.constraints, ["Also keep the original filename"]);
    assert.deepEqual(summary.completed[0]?.evidenceMessageIds, ["u0", "a0", "u1", "a1"]);
    assert.equal(validateWorkSummary(summary).ok, true);
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
