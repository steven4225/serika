import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SHELL_PROGRESS_MAX_BYTES,
  SHELL_PROGRESS_MAX_EVENTS,
  ShellProgressBuffer,
  utf8ByteLength,
} from "./shell-progress.js";

describe("ShellProgressBuffer", () => {
  it("groups by toolCallId and appends stdout/stderr by sequence, not arrival order", () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({
      toolCallId: "a", sequence: 2, stream: "stderr", text: "err", truncated: false,
    });
    buffer.apply({
      toolCallId: "a", sequence: 1, stream: "stdout", text: "out", truncated: false,
    });
    const view = buffer.view("a");
    assert.equal(view?.stdout, "out");
    assert.equal(view?.stderr, "err");
    assert.equal(view?.truncated, false);
  });

  it("keeps already shown text when a later event is empty and truncated", () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({
      toolCallId: "a", sequence: 1, stream: "stdout", text: "hello", truncated: false,
    });
    const view = buffer.apply({
      toolCallId: "a", sequence: 2, stream: "stdout", text: "", truncated: true,
    });
    assert.equal(view.stdout, "hello");
    assert.equal(view.truncated, true);
    assert.equal(view.stopped, true);
    buffer.apply({
      toolCallId: "a", sequence: 3, stream: "stdout", text: "more", truncated: false,
    });
    assert.equal(buffer.view("a")?.stdout, "hello");
  });

  it("does not treat truncated text as a reason to drop earlier chunks", () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({
      toolCallId: "a", sequence: 1, stream: "stdout", text: "kept", truncated: true,
    });
    assert.equal(buffer.view("a")?.stdout, "kept");
    assert.equal(buffer.view("a")?.truncated, true);
  });

  it("stops at 256 events without clearing prior output", () => {
    const buffer = new ShellProgressBuffer();
    for (let sequence = 1; sequence <= SHELL_PROGRESS_MAX_EVENTS + 5; sequence += 1) {
      buffer.apply({
        toolCallId: "a",
        sequence,
        stream: "stdout",
        text: sequence === SHELL_PROGRESS_MAX_EVENTS ? "" : "x",
        truncated: sequence >= SHELL_PROGRESS_MAX_EVENTS,
      });
    }
    const view = buffer.view("a");
    assert.equal(view?.stdout, "x".repeat(SHELL_PROGRESS_MAX_EVENTS - 1));
    assert.equal(view?.truncated, true);
    assert.equal(view?.stopped, true);
  });

  it("stops at 64 KiB without clearing prior output", () => {
    const buffer = new ShellProgressBuffer();
    const chunk = "a".repeat(40 * 1024);
    buffer.apply({
      toolCallId: "a", sequence: 1, stream: "stdout", text: chunk, truncated: false,
    });
    buffer.apply({
      toolCallId: "a", sequence: 2, stream: "stdout", text: chunk, truncated: false,
    });
    const view = buffer.view("a");
    assert.ok(view);
    assert.equal(utf8ByteLength(view.stdout), SHELL_PROGRESS_MAX_BYTES);
    assert.equal(view.stdout.startsWith("a"), true);
    assert.equal(view.truncated, true);
    assert.equal(view.stopped, true);
  });

  it("replays snapshot in tool-then-sequence order", () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({ toolCallId: "b", sequence: 1, stream: "stdout", text: "b", truncated: false });
    buffer.apply({ toolCallId: "a", sequence: 2, stream: "stdout", text: "a2", truncated: false });
    buffer.apply({ toolCallId: "a", sequence: 1, stream: "stdout", text: "a1", truncated: false });
    assert.deepEqual(
      buffer.snapshot().map((chunk) => `${chunk.toolCallId}:${chunk.sequence}`),
      ["b:1", "a:1", "a:2"],
    );
  });
});
