import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  MAX_CONSOLIDATION_TURNS,
  consolidateMessages,
} from "./consolidation.js";

function message(
  id: string,
  role: UIMessage["role"],
  parts: UIMessage["parts"],
): UIMessage {
  return { id, role, parts };
}

function user(id: string, text = id): UIMessage {
  return message(id, "user", [{ type: "text", text }]);
}

function assistant(id: string, text = id): UIMessage {
  return message(id, "assistant", [{ type: "text", text }]);
}

describe("consolidateMessages", () => {
  it("returns the most recent eight user-started turns by default", () => {
    const messages: UIMessage[] = [];
    for (let turn = 0; turn < MAX_CONSOLIDATION_TURNS + 2; turn += 1) {
      messages.push(user(`user-${turn}`), assistant(`assistant-${turn}`));
    }

    const result = consolidateMessages(messages);

    assert.deepEqual(
      result,
      {
        ok: true,
        turns: Array.from({ length: MAX_CONSOLIDATION_TURNS }, (_, index) => ({
          messages: [
            { id: `user-${index + 2}`, role: "user", text: `user-${index + 2}` },
            { id: `assistant-${index + 2}`, role: "assistant", text: `assistant-${index + 2}` },
          ],
        })),
      },
    );
  });

  it("uses the requested number of recent turns and returns all available turns when fewer exist", () => {
    const messages = [user("user-0"), assistant("assistant-0"), user("user-1")];

    assert.deepEqual(consolidateMessages(messages, 1), {
      ok: true,
      turns: [{ messages: [{ id: "user-1", role: "user", text: "user-1" }] }],
    });
    assert.deepEqual(consolidateMessages(messages, 8), {
      ok: true,
      turns: [
        {
          messages: [
            { id: "user-0", role: "user", text: "user-0" },
            { id: "assistant-0", role: "assistant", text: "assistant-0" },
          ],
        },
        { messages: [{ id: "user-1", role: "user", text: "user-1" }] },
      ],
    });
  });

  it("does not make prefix messages into a turn", () => {
    const messages: UIMessage[] = [
      message("system-prefix", "system", [{ type: "text", text: "prefix" }]),
      assistant("assistant-prefix"),
      user("user-0"),
      assistant("assistant-0"),
    ];

    assert.deepEqual(consolidateMessages(messages), {
      ok: true,
      turns: [
        {
          messages: [
            { id: "user-0", role: "user", text: "user-0" },
            { id: "assistant-0", role: "assistant", text: "assistant-0" },
          ],
        },
      ],
    });
  });

  it("extracts only text parts in their original order and preserves message ids", () => {
    const messages: UIMessage[] = [
      user("user-0"),
      message("assistant-0", "assistant", [
        { type: "text", text: "first" },
        {
          type: "dynamic-tool",
          toolName: "read-file",
          toolCallId: "call-1",
          state: "output-available",
          input: { path: "notes.txt" },
          output: { ok: true },
        },
        { type: "text", text: "second" },
      ]),
    ];

    const result = consolidateMessages(messages);

    assert.deepEqual(result, {
      ok: true,
      turns: [
        {
          messages: [
            { id: "user-0", role: "user", text: "user-0" },
            { id: "assistant-0", role: "assistant", text: "first\nsecond" },
          ],
        },
      ],
    });
  });

  it("drops empty and pure-tool messages without backfilling an omitted turn", () => {
    const messages: UIMessage[] = [
      user("old-user"),
      assistant("old-assistant"),
      user("empty-user", ""),
      message("tool-only", "assistant", [
        {
          type: "dynamic-tool",
          toolName: "read-file",
          toolCallId: "call-2",
          state: "output-available",
          input: { path: "notes.txt" },
          output: { ok: true },
        },
      ]),
    ];

    assert.deepEqual(consolidateMessages(messages, 1), { ok: true, turns: [] });
  });

  it("returns an empty result for an empty transcript", () => {
    assert.deepEqual(consolidateMessages([]), { ok: true, turns: [] });
  });

  it("rejects turns outside the supported range", () => {
    assert.deepEqual(consolidateMessages([], 0), {
      ok: false,
      error: { code: "INVALID_INPUT", message: "turns must be an integer from 1 to 8" },
    });
    assert.deepEqual(consolidateMessages([], 9), {
      ok: false,
      error: { code: "INVALID_INPUT", message: "turns must be an integer from 1 to 8" },
    });
  });
});
