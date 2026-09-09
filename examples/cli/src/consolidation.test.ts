import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  AUTO_CONSOLIDATION_SOURCE,
  MAX_CONSOLIDATION_TURNS,
  consolidateMessages,
} from "./consolidation.js";

function message(
  id: string,
  role: UIMessage["role"],
  parts: UIMessage["parts"],
  metadata?: unknown,
): UIMessage {
  return metadata === undefined ? { id, role, parts } : { id, role, parts, metadata };
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

  it("excludes auto-consolidation turns before selecting the most recent eight turns", () => {
    const messages: UIMessage[] = [];
    for (let turn = 0; turn < MAX_CONSOLIDATION_TURNS; turn += 1) {
      messages.push(user(`user-${turn}`), assistant(`assistant-${turn}`));
    }
    messages.push(
      message("auto-user", "user", [{ type: "text", text: "" }], {
        source: AUTO_CONSOLIDATION_SOURCE,
      }),
      assistant("auto-assistant", "suggestion"),
      user("newest-user"),
      assistant("newest-assistant"),
    );

    const result = consolidateMessages(messages);

    assert.equal(result.ok, true);
    if (!result.ok) {
      assert.fail("expected consolidation to succeed");
    }
    assert.equal(result.turns.length, MAX_CONSOLIDATION_TURNS);
    assert.deepEqual(
      result.turns.at(-1),
      {
        messages: [
          { id: "newest-user", role: "user", text: "newest-user" },
          { id: "newest-assistant", role: "assistant", text: "newest-assistant" },
        ],
      },
    );
    assert.equal(
      result.turns
        .flatMap(({ messages: turnMessages }) => turnMessages)
        .some(({ id }) => id.startsWith("auto-")),
      false,
    );
  });

  it("keeps ordinary turns that use other message metadata", () => {
    const ordinaryUser = message(
      "ordinary-user",
      "user",
      [{ type: "text", text: "ordinary" }],
      { source: "other" },
    );

    assert.deepEqual(consolidateMessages([ordinaryUser, assistant("ordinary-assistant")]), {
      ok: true,
      turns: [
        {
          messages: [
            { id: "ordinary-user", role: "user", text: "ordinary" },
            { id: "ordinary-assistant", role: "assistant", text: "ordinary-assistant" },
          ],
        },
      ],
    });
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
