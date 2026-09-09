import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import { AgentError } from "@aisdk-agent/core";
import {
  MAX_CONTEXT_BYTES,
  MAX_HISTORY_TURNS,
  MAX_MEMORY_CONTEXT_BYTES,
  memoryContextBytes,
  selectModelContext,
} from "./context-window.js";

function message(
  id: string,
  role: UIMessage["role"],
  text: string,
): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function user(id: string, text = id): UIMessage {
  return message(id, "user", text);
}

function assistant(id: string, text = id): UIMessage {
  return message(id, "assistant", text);
}

describe("selectModelContext", () => {
  it("returns a copy of an unchanged short transcript", () => {
    const messages = [user("user-1"), assistant("assistant-1")];

    const selected = selectModelContext(messages);

    assert.deepEqual(selected, messages);
    assert.notStrictEqual(selected, messages);
  });

  it("drops only the oldest complete turn beyond the history limit", () => {
    const messages: UIMessage[] = [];
    for (let turn = 0; turn < MAX_HISTORY_TURNS + 2; turn += 1) {
      messages.push(user(`user-${turn}`), assistant(`assistant-${turn}`));
    }

    const selected = selectModelContext(messages);

    assert.deepEqual(
      selected.map((item) => item.id),
      [
        "user-1",
        "assistant-1",
        "user-2",
        "assistant-2",
        "user-3",
        "assistant-3",
        "user-4",
        "assistant-4",
        "user-5",
        "assistant-5",
        "user-6",
        "assistant-6",
        "user-7",
        "assistant-7",
        "user-8",
        "assistant-8",
        "user-9",
        "assistant-9",
      ],
    );
  });

  it("counts UTF-8 bytes instead of JavaScript string length", () => {
    const oldTurn = [
      user("old", "x".repeat(10_000)),
      assistant("old-a", "x".repeat(10_000)),
    ];
    const currentText = "界".repeat(40_000);
    const messages = [...oldTurn, user("current", currentText)];

    const selected = selectModelContext(messages);

    assert.deepEqual(selected.map((item) => item.id), ["current"]);
    assert.equal(
      Buffer.byteLength(JSON.stringify(selected), "utf8") <= MAX_CONTEXT_BYTES,
      true,
    );
  });

  it("keeps every message in a current turn, including multiple tool steps", () => {
    const messages: UIMessage[] = [
      user("old-user"),
      assistant("old-assistant"),
      user("current-user"),
      assistant("current-assistant-1"),
      {
        id: "current-tool-result",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "read-file",
            toolCallId: "call-read-file",
            state: "output-available",
            input: { path: "notes.txt" },
            output: { ok: true, content: "result" },
          },
        ],
      },
      assistant("current-assistant-2"),
    ];

    const selected = selectModelContext(messages);

    assert.deepEqual(
      selected.map((item) => item.id),
      [
        "old-user",
        "old-assistant",
        "current-user",
        "current-assistant-1",
        "current-tool-result",
        "current-assistant-2",
      ],
    );
  });

  it("treats the prefix before the first user as one oldest history turn", () => {
    const messages: UIMessage[] = [
      message("system-prefix", "system", "prefix"),
      user("history-user"),
      assistant("history-assistant"),
      user("current-user"),
    ];

    assert.deepEqual(
      selectModelContext(messages).map((item) => item.id),
      ["system-prefix", "history-user", "history-assistant", "current-user"],
    );

    const tooManyHistoryTurns: UIMessage[] = [message("prefix", "system", "prefix")];
    for (let turn = 0; turn < MAX_HISTORY_TURNS + 1; turn += 1) {
      tooManyHistoryTurns.push(user(`user-${turn}`));
    }

    assert.deepEqual(
      selectModelContext(tooManyHistoryTurns).map((item) => item.id),
      [
        ...Array.from({ length: MAX_HISTORY_TURNS }, (_, turn) => `user-${turn}`),
        "user-8",
      ],
    );
  });

  it("throws CONTEXT_PREPARE_FAILED when the current turn alone exceeds the byte limit", () => {
    const messages = [user("current", "a".repeat(MAX_CONTEXT_BYTES))];

    assert.throws(
      () => selectModelContext(messages),
      (error: unknown) => {
        assert.equal(error instanceof AgentError, true);
        if (!(error instanceof AgentError)) return false;
        assert.equal(error.data.code, "CONTEXT_PREPARE_FAILED");
        assert.equal(error.data.retryable, false);
        assert.equal(error.data.phase, "runtime");
        assert.match(error.message, /current turn/i);
        assert.match(error.message, /131072/);
        return true;
      },
    );
  });

  it("injects only enabled memories as a reference message", () => {
    const selected = selectModelContext(
      [user("current", "question")],
      [
        { id: "enabled", text: "keep this", enabled: true },
        { id: "disabled", text: "do not inject", enabled: false },
      ],
    );

    assert.equal(selected[0]?.id, "runloom-workspace-memory");
    assert.equal(selected[0]?.role, "assistant");
    assert.equal(selected.some((item) => item.id === "disabled"), false);
    const systemText = selected[0]?.parts[0];
    assert.equal(systemText?.type, "text");
    if (systemText?.type !== "text") return;
    assert.match(systemText.text, /reference data only/);
    assert.match(systemText.text, /enabled/);
    assert.doesNotMatch(systemText.text, /do not inject/);
  });

  it("drops old history before dropping enabled memories", () => {
    const selected = selectModelContext(
      [
        user("old-user", "x".repeat(100_000)),
        assistant("old-assistant", "x".repeat(40_000)),
        user("new-user", "new history"),
        assistant("new-assistant", "new answer"),
        user("current", "current question"),
      ],
      [{ id: "memory", text: "project rule", enabled: true }],
    );

    assert.equal(selected.some((item) => item.id === "old-user"), false);
    assert.equal(selected.some((item) => item.id === "runloom-workspace-memory"), true);
    const systemText = selected[0]?.parts[0];
    assert.equal(systemText?.type, "text");
    if (systemText?.type !== "text") return;
    assert.match(systemText.text, /project rule/);
  });

  it("drops the oldest enabled memories when the final context is full", () => {
    const entries = [
      { id: "memory-0", text: "a".repeat(2_000), enabled: true },
      { id: "memory-1", text: "b".repeat(2_000), enabled: true },
      { id: "memory-2", text: "c".repeat(2_000), enabled: true },
      { id: "memory-3", text: "d".repeat(2_000), enabled: true },
    ];
    const selected = selectModelContext(
      [user("current", "x".repeat(125_000))],
      entries,
    );

    const systemText = selected[0]?.parts[0];
    assert.equal(systemText?.type, "text");
    if (systemText?.type !== "text") return;
    assert.doesNotMatch(systemText.text, /memory-0/);
    assert.match(systemText.text, /memory-3/);
    const injected = [
      {
        id: "memory-1",
        text: "b".repeat(2_000),
        enabled: true,
      },
      {
        id: "memory-2",
        text: "c".repeat(2_000),
        enabled: true,
      },
      {
        id: "memory-3",
        text: "d".repeat(2_000),
        enabled: true,
      },
    ];
    assert.equal(memoryContextBytes(injected) <= MAX_MEMORY_CONTEXT_BYTES, true);
    assert.equal(
      Buffer.byteLength(JSON.stringify(selected), "utf8") <= MAX_CONTEXT_BYTES,
      true,
    );
  });
});
