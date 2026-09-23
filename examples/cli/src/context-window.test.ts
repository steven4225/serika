import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import { AgentError } from "@aisdk-agent/core";
import {
  CHECKPOINT_INJECTION_MAX_BYTES,
  type CheckpointSnapshot,
} from "./checkpoint-store.js";
import {
  CHECKPOINT_CONTEXT_MESSAGE_ID,
  MAX_CONTEXT_BYTES,
  MAX_HISTORY_TURNS,
  MAX_MEMORY_CONTEXT_BYTES,
  WORK_SUMMARY_MESSAGE_ID,
  createCheckpointContextMessage,
  checkpointAndMemoryContextMessages,
  memoryContextBytes,
  selectValidMemoryEntries,
  selectModelContext,
  shouldInjectProjectCheckpoint,
} from "./context-window.js";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";

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
  it("places a one-run resume observation before checkpoint and memory in both paths", () => {
    const resume = assistant("runloom-resume-observation", "Git observed at 2026-09-23T00:00:00Z");
    const checkpoint: CheckpointSnapshot = {
      id: "checkpoint-1", version: 1, status: "active", goal: "Continue Runloom",
      summary: "Saved intent", completed: [], inProgress: [], nextActions: [],
      blockers: [], artifacts: [], source: { threadId: "thread-a" },
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const memories = [{ id: "memory-1", text: "Keep scope small", enabled: true }];
    const expectedPrefix = [resume.id, CHECKPOINT_CONTEXT_MESSAGE_ID, "runloom-workspace-memory"];
    assert.deepEqual(
      selectModelContext([user("next")], memories, {}, checkpoint, resume).slice(0, 3).map((item) => item.id),
      expectedPrefix,
    );
    assert.deepEqual(
      checkpointAndMemoryContextMessages(checkpoint, memories, {}, resume).map((item) => item.id),
      expectedPrefix,
    );
  });

  it("injects the current checkpoint beside memory as a non-permission reference", () => {
    const checkpoint: CheckpointSnapshot = {
      id: "checkpoint-1",
      version: 4,
      status: "active",
      goal: "Continue Runloom",
      summary: "Feature work is underway.",
      completed: ["M4 merged"],
      inProgress: ["M5 checkpoint"],
      nextActions: ["Run acceptance"],
      blockers: [],
      artifacts: [{ label: "Plan", path: "docs/m5.md" }],
      source: { threadId: "thread-a" },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    };
    const selected = selectModelContext(
      [user("thread-b-user", "Continue Runloom")],
      [{ id: "memory-current", text: "Keep M5 in one PR.", enabled: true }],
      { threadId: "thread-b" },
      checkpoint,
    );

    assert.equal(selected[0]?.id, CHECKPOINT_CONTEXT_MESSAGE_ID);
    assert.equal(selected[1]?.id, "runloom-workspace-memory");
    assert.equal(selected.at(-1)?.id, "thread-b-user");
    assert.match(JSON.stringify(selected[0]), /not a live filesystem/);
    assert.match(JSON.stringify(selected[0]), /grants no tool permissions/);
    assert.match(JSON.stringify(selected[0]), /prefer that Memory/);
    assert.match(JSON.stringify(selected[0]), /\"version\":4/);
    assert.match(JSON.stringify(selected[1]), /memory-current/);
  });

  it("rejects an oversized checkpoint context message instead of truncating it", () => {
    const oversized = {
      id: "checkpoint-1",
      version: 1,
      status: "active",
      goal: "Continue Runloom",
      summary: "x".repeat(CHECKPOINT_INJECTION_MAX_BYTES),
      completed: [],
      inProgress: [],
      nextActions: [],
      blockers: [],
      artifacts: [],
      source: { threadId: "thread-a" },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    } as CheckpointSnapshot;
    assert.throws(
      () => createCheckpointContextMessage(oversized),
      /project checkpoint exceeds the 12288-byte context limit/,
    );
  });

  it("prepends checkpoint and memory onto compacted conversation once", () => {
    const checkpoint: CheckpointSnapshot = {
      id: "checkpoint-1",
      version: 2,
      status: "active",
      goal: "Continue Runloom",
      summary: "Compaction path.",
      completed: [],
      inProgress: ["M5"],
      nextActions: ["Accept"],
      blockers: [],
      artifacts: [],
      source: { threadId: "thread-a" },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
    const compacted = [user("recent-user", "continue")];
    const prefix = checkpointAndMemoryContextMessages(
      checkpoint,
      [{ id: "memory-current", text: "Keep M5 in one PR.", enabled: true }],
      { threadId: "thread-b" },
    );
    const selected = [...prefix, ...compacted];

    assert.deepEqual(selected.map((item) => item.id), [
      CHECKPOINT_CONTEXT_MESSAGE_ID,
      "runloom-workspace-memory",
      "recent-user",
    ]);
    assert.equal(selected.filter((item) => item.id === CHECKPOINT_CONTEXT_MESSAGE_ID).length, 1);
    assert.match(JSON.stringify(selected[0]), /prefer that Memory/);
  });

  it("injects project checkpoint only for the interactive TUI agent", () => {
    assert.equal(shouldInjectProjectCheckpoint("calculator"), true);
    assert.equal(shouldInjectProjectCheckpoint(AUTO_CONSOLIDATION_AGENT_ID), false);
  });

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
        WORK_SUMMARY_MESSAGE_ID,
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
    const currentText = "界".repeat(37_000);
    const messages = [...oldTurn, user("current", currentText)];

    const selected = selectModelContext(messages);

    assert.deepEqual(selected.map((item) => item.id), [WORK_SUMMARY_MESSAGE_ID, "current"]);
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
    for (let turn = 0; turn < MAX_HISTORY_TURNS + 2; turn += 1) {
      tooManyHistoryTurns.push(user(`user-${turn}`));
    }

    assert.deepEqual(
      selectModelContext(tooManyHistoryTurns).map((item) => item.id),
      [
        WORK_SUMMARY_MESSAGE_ID,
        ...Array.from({ length: MAX_HISTORY_TURNS }, (_, turn) => `user-${turn + 1}`),
        "user-9",
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

  it("filters M1 memory status, scope, and expiry before injection", () => {
    const now = new Date("2026-09-22T00:00:00.000Z");
    const memories = [
      { id: "legacy", text: "legacy workspace memory", enabled: true },
      {
        id: "workspace",
        text: "active workspace memory",
        enabled: true,
        status: "active" as const,
        scope: { kind: "workspace" } as const,
      },
      {
        id: "thread-current",
        text: "current thread memory",
        enabled: true,
        status: "active" as const,
        scope: { kind: "thread", threadId: "thread-a" } as const,
      },
      {
        id: "thread-other",
        text: "other thread memory",
        enabled: true,
        status: "active" as const,
        scope: { kind: "thread", threadId: "thread-b" } as const,
      },
      {
        id: "disabled",
        text: "disabled memory",
        enabled: true,
        status: "disabled" as const,
      },
      {
        id: "contradictory",
        text: "contradictory memory",
        enabled: false,
        status: "active" as const,
      },
      {
        id: "expired",
        text: "expired memory",
        enabled: true,
        status: "active" as const,
        expiresAt: "2026-09-21T23:59:59.999Z",
      },
    ];

    assert.deepEqual(
      selectValidMemoryEntries(memories, { threadId: "thread-a", now })
        .map((entry) => entry.id),
      ["legacy", "workspace", "thread-current"],
    );
    assert.deepEqual(
      selectValidMemoryEntries(memories, { threadId: "thread-b", now })
        .map((entry) => entry.id),
      ["legacy", "workspace", "thread-other"],
    );
    assert.equal(
      selectValidMemoryEntries(memories, {
        threadId: "thread-a",
        now: new Date("2026-09-21T23:59:59.998Z"),
      }).some((entry) => entry.id === "expired"),
      true,
    );
  });

  it("injects only the current memory text, not superseded history", () => {
    const selected = selectModelContext(
      [user("current", "what is the agent policy?")],
      [{
        id: "policy",
        text: "multi-agent is allowed",
        enabled: true,
        status: "active",
        scope: { kind: "workspace" },
        source: { kind: "manual" },
        history: [{
          revision: 1,
          text: "prefer single agent",
          status: "active",
          scope: { kind: "workspace" },
          expiresAt: null,
          source: { kind: "manual" },
          changedAt: "2026-09-01T00:00:00.000Z",
        }],
      }],
    );

    const memory = selected.find((item) => item.id === "runloom-workspace-memory");
    assert.ok(memory);
    const part = memory.parts[0];
    assert.equal(part?.type, "text");
    if (part?.type !== "text") return;
    assert.match(part.text, /multi-agent is allowed/);
    assert.doesNotMatch(part.text, /prefer single agent/);
    assert.match(part.text, /only the entries in this message are current/);
    assert.doesNotMatch(part.text, /"source"/);
    assert.doesNotMatch(part.text, /"scope"/);
    assert.doesNotMatch(part.text, /"history"/);
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

  it("injects a bounded process-local work summary without changing the transcript", () => {
    const messages: UIMessage[] = [];
    for (let turn = 0; turn < MAX_HISTORY_TURNS + 2; turn += 1) {
      messages.push(user(`user-${turn}`), assistant(`assistant-${turn}`));
    }
    const original = structuredClone(messages);
    const selected = selectModelContext(messages);

    assert.equal(selected[0]?.id, WORK_SUMMARY_MESSAGE_ID);
    assert.equal(selected.some((item) => item.id === "user-0"), false);
    assert.equal(selected.some((item) => item.id === "user-1"), true);
    assert.equal(selected.some((item) => item.id === "user-2"), true);
    assert.deepEqual(messages, original);
    const summaryText = selected[0]?.parts[0];
    assert.equal(summaryText?.type, "text");
    if (summaryText?.type === "text") {
      assert.match(summaryText.text, /user-0/);
      assert.match(summaryText.text, /explicit ok:true/);
      assert.match(summaryText.text, /not current disk or world state/);
      assert.match(summaryText.text, /read_file/);
    }
  });

  it("keeps the first omitted goal when omitted history would overflow the summary cap", () => {
    const messages: UIMessage[] = [
      user("user-0", "Write the report to docs/report.md and do not use /tmp"),
      assistant("assistant-0", "x".repeat(4_000)),
    ];
    for (let turn = 1; turn < MAX_HISTORY_TURNS + 4; turn += 1) {
      messages.push(user(`user-${turn}`, "C".repeat(2_000)));
      messages.push(assistant(`assistant-${turn}`, "D".repeat(2_000)));
    }
    messages.push(user("current", "continue"));
    const selected = selectModelContext(messages);
    const summary = selected.find((item) => item.id === WORK_SUMMARY_MESSAGE_ID);
    assert.ok(summary);
    const summaryText = summary?.parts[0];
    assert.equal(summaryText?.type, "text");
    if (summaryText?.type === "text") {
      assert.match(summaryText.text, /docs\/report\.md/);
      assert.match(summaryText.text, /do not use \/tmp/);
    }
    assert.equal(selected.some((item) => item.id === "user-0"), false);
    assert.equal(
      Buffer.byteLength(JSON.stringify(selected), "utf8") <= MAX_CONTEXT_BYTES,
      true,
    );
  });

});
