import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { InMemoryAgentStore } from "@aisdk-agent/core";
import { createTaskWorkerAgent, todoistTaskWorkerInstructions } from "./task-worker-entry.js";
import { createTaskStore } from "./task-store.js";
import { runTaskWorker } from "./task-worker.js";

type RecordValue = Record<string, unknown>;

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected));
  return isRecord(value) && Object.values(value).some((item) => containsExactString(item, expected));
}

function toolResults(prompt: unknown): RecordValue[] {
  if (!Array.isArray(prompt)) return [];
  return prompt.flatMap((message) => {
    if (!isRecord(message) || message.role !== "tool" || !Array.isArray(message.content)) return [];
    return message.content.filter((part): part is RecordValue =>
      isRecord(part) && part.type === "tool-result");
  });
}

function resultValue(result: RecordValue): RecordValue {
  const output = result.output;
  assert.ok(isRecord(output) && output.type === "json" && isRecord(output.value));
  return output.value;
}

function toolCallResponse() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "todoist-call",
          toolName: "todoist_list_tasks",
          input: JSON.stringify({ view: "planning" }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function textResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: text },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawTask(index: number) {
  return {
    id: `task-${index}`,
    project_id: "project-1",
    responsible_uid: null,
    checked: false,
    is_deleted: false,
    content: `Task ${index}`,
    priority: 2,
    due: { date: "2026-09-12", is_recurring: false, timezone: null },
    deadline: null,
  };
}

function todoistFetch(kind: "complete" | "truncated" | "empty" | "auth"): typeof globalThis.fetch {
  return (async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/api/v1/user")) {
      return kind === "auth" ? jsonResponse({}, 401) : jsonResponse({ id: "user-1" });
    }
    assert.match(url, /\/api\/v1\/tasks\?/);
    const results = kind === "empty"
      ? []
      : kind === "truncated"
      ? Array.from({ length: 501 }, (_, index) => rawTask(index))
      : [rawTask(1)];
    return jsonResponse({ results, next_cursor: null });
  }) as typeof globalThis.fetch;
}

function createQueryingModel(observed: { calls: number; results: RecordValue[] }) {
  return new MockLanguageModelV3({
    doStream: async ({ prompt, tools }) => {
      assert.ok(containsExactString(prompt, todoistTaskWorkerInstructions));
      assert.deepEqual(tools?.map((candidate) => candidate.name), ["todoist_list_tasks"]);
      const result = toolResults(prompt).find((candidate) =>
        candidate.toolName === "todoist_list_tasks");
      if (result === undefined) {
        observed.calls += 1;
        return toolCallResponse();
      }
      const value = resultValue(result);
      observed.results.push(value);
      return textResponse(`observed:${JSON.stringify(value)}`);
    },
  });
}

describe("Stage 7-4 Todoist worker composition", () => {
  it("preserves the plain-text worker with no tools when Todoist is disabled", async () => {
    const store = new InMemoryAgentStore();
    const observedTools: string[][] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt, tools }) => {
        assert.ok(containsExactString(prompt, "Respond to the supplied prompt in plain text."));
        observedTools.push(tools?.map((candidate) => candidate.name) ?? []);
        return textResponse("plain response");
      },
    });
    const agent = createTaskWorkerAgent({ modelAlias: "plain-test", model, store });
    try {
      const handle = await agent.runtime.run({
        agentId: "scheduled-responder",
        threadId: "plain-thread",
        messages: [{ id: "plain-user", role: "user", parts: [{ type: "text", text: "two words" }] }],
      });
      const result = await handle.result;
      assert.equal(result.status, "completed");
      assert.equal(result.text, "plain response");
      assert.deepEqual(observedTools, [[]]);
    } finally {
      agent.dispose();
    }
  });

  it("injects one captured workspace reference without adding tools or persisting it", async () => {
    const store = new InMemoryAgentStore();
    const observed: { prompt: unknown; tools: string[] }[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt, tools }) => {
        observed.push({ prompt, tools: tools?.map((candidate) => candidate.name) ?? [] });
        return textResponse("ordinary reminder");
      },
    });
    const agent = createTaskWorkerAgent({
      modelAlias: "workspace-test",
      model,
      store,
      workspaceContext: true,
    });
    try {
      const handle = await agent.runtime.run({
        agentId: "scheduled-responder",
        threadId: "workspace-thread",
        context: { referenceMessages: [{
          id: "runloom-task-worker-observation",
          role: "assistant",
          parts: [{ type: "text", text: "saved checkpoint version 2" }],
        }] },
        messages: [{ id: "reminder-user", role: "user", parts: [{ type: "text", text: "Remind me to drink water" }] }],
      });
      assert.equal((await handle.result).status, "completed");
      assert.equal(observed.length, 1);
      assert.deepEqual(observed[0]?.tools, []);
      assert.match(JSON.stringify(observed[0]?.prompt), /saved checkpoint version 2/);
      assert.doesNotMatch(JSON.stringify(observed[0]?.prompt), /15-minute first step/);
      assert.doesNotMatch(JSON.stringify(await store.getMessages("workspace-thread")), /saved checkpoint version 2/);
    } finally {
      agent.dispose();
    }
  });

  it("narrows Todoist daily-plan instructions only when workspace context is also enabled", async () => {
    const store = new InMemoryAgentStore();
    const seen: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        seen.push(prompt);
        return textResponse("ordinary reminder");
      },
    });
    const withContext = createTaskWorkerAgent({
      modelAlias: "todoist-context-test",
      model,
      store,
      todoist: {
        apiToken: "test-token",
        timeZone: "Asia/Shanghai",
        fetch: todoistFetch("empty"),
      },
      workspaceContext: true,
    });
    try {
      const handle = await withContext.runtime.run({
        agentId: "scheduled-responder",
        threadId: "todoist-context-thread",
        messages: [{ id: "reminder-user", role: "user", parts: [{ type: "text", text: "Remind me to drink water" }] }],
      });
      assert.equal((await handle.result).status, "completed");
      const serialized = JSON.stringify(seen[0]);
      assert.match(serialized, /explicitly requested Todoist daily plan/);
      assert.doesNotMatch(serialized, /For a daily plan, call todoist_list_tasks/);
      assert.match(serialized, /Follow the scheduled prompt's requested output format/);
      assert.equal(containsExactString(seen[0], todoistTaskWorkerInstructions), false);
    } finally {
      withContext.dispose();
    }
  });

  for (const kind of ["complete", "truncated", "empty", "auth"] as const) {
    it(`passes the ${kind} query result through the production worker agent`, async () => {
      const root = await mkdtemp(join(tmpdir(), `runloom-worker-todoist-${kind}-`));
      let taskClock = 1_000;
      const taskStore = createTaskStore(root, { now: () => taskClock });
      const transcriptStore = new InMemoryAgentStore();
      const observed = { calls: 0, results: [] as RecordValue[] };
      const agent = createTaskWorkerAgent({
        modelAlias: "todoist-test",
        model: createQueryingModel(observed),
        store: transcriptStore,
        todoist: {
          apiToken: "test-token",
          timeZone: "Asia/Shanghai",
          now: () => new Date("2026-09-12T01:00:00.000Z"),
          fetch: todoistFetch(kind),
        },
      });
      const controller = new AbortController();
      try {
        const created = await taskStore.create({
          runAt: new Date(2_000).toISOString(),
          prompt: "Create today's plan from Todoist.",
        });
        assert.ok(created.ok);
        taskClock = 3_000;
        await runTaskWorker({
          store: taskStore,
          runtime: agent.runtime,
          signal: controller.signal,
          pollIntervalMs: 0,
          onTaskFinished: () => controller.abort("test_complete"),
        });

        const completed = await taskStore.get(created.value.id);
        assert.ok(completed.ok);
        assert.equal(completed.value.status, "completed");
        assert.equal(observed.calls, 1);
        assert.equal(observed.results.length, 1);
        assert.equal(completed.value.resultText, `observed:${JSON.stringify(observed.results[0])}`);
        assert.ok(completed.value.threadId);

        const transcript = await transcriptStore.getMessages(completed.value.threadId);
        assert.ok(transcript.some((message) => message.parts.some((part) =>
          part.type === "dynamic-tool" && part.toolName === "todoist_list_tasks" &&
          part.state === "output-available")));
        assert.equal(transcript.some((message) => message.parts.some((part) =>
          part.type === "dynamic-tool" && part.toolName !== "todoist_list_tasks")), false);

        const inbox = await taskStore.list({ inbox: true });
        assert.ok(inbox.ok);
        assert.deepEqual(inbox.value.tasks.map((task) => task.id), [created.value.id]);
        if (kind === "auth") {
          assert.equal(observed.results[0]?.ok, false);
          assert.deepEqual((observed.results[0]?.error as RecordValue | undefined)?.code, "AUTH_FAILED");
          const attention = await taskStore.list({ status: "attention" });
          assert.ok(attention.ok);
          assert.equal(attention.value.tasks.length, 0);
        } else {
          assert.equal(observed.results[0]?.ok, true);
          const value = observed.results[0]?.value as RecordValue;
          const tasks = value.tasks as unknown[];
          assert.equal(tasks.length, kind === "empty" ? 0 : kind === "truncated" ? 100 : 1);
          assert.equal(value.truncated, kind === "truncated");
        }
      } finally {
        controller.abort("test_cleanup");
        agent.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
