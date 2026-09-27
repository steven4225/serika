import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  AUTO_CONSOLIDATION_SOURCE,
  MAX_CONSOLIDATION_TOOL_EVIDENCE_BYTES,
  MAX_CONSOLIDATION_TURNS,
  consolidateMessages,
  findCommittedUserMessage,
  isExactUserQuote,
  selectIncrementalConsolidationTurns,
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

function autoRequest(id: string): UIMessage {
  return message(id, "user", [{ type: "text", text: "请整理" }], {
    source: AUTO_CONSOLIDATION_SOURCE,
  });
}

function prepareResult(id: string, output: unknown): UIMessage {
  return message(id, "assistant", [{
    type: "dynamic-tool",
    toolName: "memory_prepare_consolidation",
    toolCallId: id,
    state: "output-available",
    input: { mode: "incremental" },
    output,
  }]);
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
          ],
        },
      ],
    });
  });

  it("returns user text only and drops assistant text and tool output", () => {
    const messages: UIMessage[] = [
      message("user-0", "user", [
        { type: "text", text: "I prefer one agent" },
        {
          type: "dynamic-tool",
          toolName: "web_search",
          toolCallId: "call-1",
          state: "output-available",
          input: { query: "agents" },
          output: { text: "Multi-agent is the future" },
        },
      ]),
      assistant("assistant-0", "The user wants multi-agent"),
    ];

    const result = consolidateMessages(messages);

    assert.deepEqual(result, {
      ok: true,
      turns: [
        {
          messages: [
            { id: "user-0", role: "user", text: "I prefer one agent" },
          ],
        },
      ],
    });
    assert.equal(JSON.stringify(result).includes("Multi-agent is the future"), false);
    assert.equal(JSON.stringify(result).includes("The user wants multi-agent"), false);
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

describe("selectIncrementalConsolidationTurns", () => {
  it("bootstraps only the latest eight ordinary turns", () => {
    const messages = Array.from({ length: MAX_CONSOLIDATION_TURNS + 2 }, (_, index) => [
      user(`user-${index}`),
      assistant(`assistant-${index}`),
    ]).flat();

    const result = selectIncrementalConsolidationTurns(messages);

    assert.equal(result.bootstrap, true);
    assert.deepEqual(result.turns.map(({ user: selected }) => selected.messageId), [
      "user-2", "user-3", "user-4", "user-5", "user-6", "user-7", "user-8", "user-9",
    ]);
    assert.deepEqual(result.turns[0]?.assistant, [
      { messageId: "assistant-2", text: "assistant-2" },
    ]);
  });

  it("selects every eligible turn after the latest committed marker", () => {
    const messages: UIMessage[] = [
      user("old-user"),
      assistant("old-assistant"),
      autoRequest("marker-1"),
      prepareResult("marker-1-result", { ok: true, turns: [], memories: [] }),
      user("between-markers"),
      assistant("between-markers-result"),
      autoRequest("marker-2"),
      prepareResult("marker-2-result", { ok: true, turns: [], memories: [] }),
      user("new-user"),
      assistant("new-assistant"),
    ];

    const result = selectIncrementalConsolidationTurns(messages);

    assert.equal(result.bootstrap, false);
    assert.deepEqual(result.turns.map(({ user: selected }) => selected.messageId), ["new-user"]);
  });

  it("does not advance the cursor for missing, failed, denied, or repeated preparation", () => {
    const denied = message("denied-result", "assistant", [{
      type: "dynamic-tool",
      toolName: "memory_prepare_consolidation",
      toolCallId: "denied-call",
      state: "output-error",
      input: { mode: "incremental" },
      errorText: "TOOL_DENIED: user denied the call",
    }]);
    const repeated = prepareResult("repeated-result", { ok: true, turns: [], memories: [] });
    repeated.parts.push(...prepareResult("second-result", { ok: true, turns: [], memories: [] }).parts);
    const messages: UIMessage[] = [
      user("before-valid"),
      autoRequest("valid-marker"),
      prepareResult("valid-result", { ok: true, turns: [], memories: [] }),
      user("after-valid"),
      autoRequest("no-call"),
      assistant("no-call-result", "本次没有建议"),
      user("after-no-call"),
      autoRequest("failed-output"),
      prepareResult("failed-result", { ok: false, error: { code: "READ_FAILED" } }),
      user("after-failed-output"),
      autoRequest("denied"),
      denied,
      user("after-denied"),
      autoRequest("repeated"),
      repeated,
      user("after-repeated"),
    ];

    assert.deepEqual(
      selectIncrementalConsolidationTurns(messages).turns.map(({ user: selected }) => selected.messageId),
      ["after-valid", "after-no-call", "after-failed-output", "after-denied", "after-repeated"],
    );
  });

  it("bootstraps recent ordinary turns when no successful preparation exists", () => {
    const messages: UIMessage[] = [
      user("first"),
      autoRequest("empty-marker"),
      assistant("empty-result", "本次没有建议"),
      user("second"),
    ];

    const result = selectIncrementalConsolidationTurns(messages);
    assert.equal(result.bootstrap, true);
    assert.deepEqual(result.turns.map(({ user: selected }) => selected.messageId), ["first", "second"]);
  });

  it("excludes a turn that explicitly used any memory tool", () => {
    const messages: UIMessage[] = [
      user("ordinary-user"),
      assistant("ordinary-assistant"),
      user("memory-user"),
      message("memory-assistant", "assistant", [{
        type: "dynamic-tool",
        toolName: "memory_list",
        toolCallId: "memory-call",
        state: "output-available",
        input: {},
        output: { ok: true, entries: [] },
      }]),
    ];

    assert.deepEqual(
      selectIncrementalConsolidationTurns(messages).turns.map(({ user: selected }) => selected.messageId),
      ["ordinary-user"],
    );
  });

  it("returns assistant and bounded completed-tool evidence", () => {
    const oversized = `${"中".repeat(2_000)}tail`;
    const messages: UIMessage[] = [
      user("user-1", "Read the report but keep one agent"),
      message("assistant-1", "assistant", [
        { type: "text", text: "I will inspect it" },
        {
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "read-call",
          state: "output-available",
          input: { path: "report.md" },
          output: oversized,
        },
        {
          type: "dynamic-tool",
          toolName: "write_file",
          toolCallId: "denied-call",
          state: "output-error",
          input: { path: "result.md" },
          errorText: "TOOL_DENIED: user denied the call",
        },
        {
          type: "dynamic-tool",
          toolName: "web_fetch",
          toolCallId: "failed-call",
          state: "output-available",
          input: { url: "https://example.com" },
          output: { ok: false, error: { code: "TIMEOUT" } },
        },
      ]),
    ];

    const result = selectIncrementalConsolidationTurns(messages);
    const turn = result.turns[0]!;

    assert.deepEqual(turn.user, {
      messageId: "user-1",
      text: "Read the report but keep one agent",
    });
    assert.deepEqual(turn.assistant, [{ messageId: "assistant-1", text: "I will inspect it" }]);
    assert.equal(turn.tools[0]?.outcome, "success");
    assert.equal(turn.tools[0]?.truncated, true);
    assert.ok(Buffer.byteLength(turn.tools[0]!.content, "utf8") <= MAX_CONSOLIDATION_TOOL_EVIDENCE_BYTES);
    assert.equal(turn.tools[0]!.content.endsWith("tail"), false);
    assert.deepEqual(turn.tools.slice(1).map(({ outcome }) => outcome), ["denied", "failed"]);
  });

  it("omits pending tool calls and empty user turns", () => {
    const messages: UIMessage[] = [
      user("empty", ""),
      message("assistant", "assistant", [{
        type: "dynamic-tool",
        toolName: "read_file",
        toolCallId: "pending-call",
        state: "input-available",
        input: { path: "notes.md" },
      }]),
    ];

    assert.deepEqual(selectIncrementalConsolidationTurns(messages), {
      ok: true,
      bootstrap: true,
      turns: [],
    });
  });
});

describe("findCommittedUserMessage", () => {
  it("resolves a committed user message by id even outside the recent proposal window", () => {
    const committed = [user("decision", "Keep one agent"), ...Array.from(
      { length: MAX_CONSOLIDATION_TURNS + 1 },
      (_, index) => user(`later-${index}`),
    )];

    assert.deepEqual(findCommittedUserMessage(committed, "decision"), {
      id: "decision",
      role: "user",
      text: "Keep one agent",
    });
    assert.equal(consolidateMessages(committed).ok, true);
  });

  it("does not attribute assistant, tool, or auto-consolidation text to the user", () => {
    const committed: UIMessage[] = [
      assistant("assistant-only", "The user prefers multi-agent"),
      message("tool-only", "assistant", [{
        type: "dynamic-tool",
        toolName: "web_search",
        toolCallId: "call-1",
        state: "output-available",
        input: { query: "agents" },
        output: { text: "Multi-agent is the future" },
      }]),
      message("auto-user", "user", [{ type: "text", text: "Suggested memory" }], {
        source: AUTO_CONSOLIDATION_SOURCE,
      }),
      user("empty-user", ""),
      user("real-user", "I prefer one agent"),
    ];

    for (const id of ["assistant-only", "tool-only", "auto-user", "empty-user", "missing"]) {
      assert.equal(findCommittedUserMessage(committed, id), undefined, id);
    }
    assert.deepEqual(findCommittedUserMessage(committed, "real-user"), {
      id: "real-user",
      role: "user",
      text: "I prefer one agent",
    });
  });

  it("rejects ambiguous duplicate message ids", () => {
    assert.equal(findCommittedUserMessage([user("same", "first"), user("same", "second")], "same"), undefined);
  });

  it("accepts only an exact substring quote", () => {
    const text = "I prefer one agent";
    assert.equal(isExactUserQuote(text, "one agent"), true);
    assert.equal(isExactUserQuote(text, "I prefer one agent"), true);
    assert.equal(isExactUserQuote(text, "one  agent"), false);
    assert.equal(isExactUserQuote(text, "I prefer one Agent"), false);
    assert.equal(isExactUserQuote(text, " multi-agent"), false);
    assert.equal(isExactUserQuote(text, " "), false);
  });
});
