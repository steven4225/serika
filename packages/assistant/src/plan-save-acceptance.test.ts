import { DirectoryAccess } from "./directory-access.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  InMemoryAgentStore,
  type BeforeToolExecute,
} from "@serika/core";
import {
  AiSdkAgentLoop,
  InMemoryModelRegistry,
  ToolRegistry,
} from "@serika/ai-sdk-adapter";
import { createModuleHost } from "./module-host.js";
import { createReadFileModule } from "./modules/read-file-module.js";
import { createTodoistModule } from "./modules/todoist-module.js";
import { todoistPlanSaveInstructions } from "./todoist-plan-save-instructions.js";
import { createToolConfirmation } from "./tool-confirmation.js";

const definition = {
  id: "daily-plan",
  version: "1",
  instructions: todoistPlanSaveInstructions,
  model: "daily-plan-model",
  tools: ["todoist_list_tasks", "write_file"],
  limits: { maxSteps: 4, totalTimeoutMs: 5_000, stepTimeoutMs: 1_000 },
} as const;

const fixedNow = () => new Date("2026-09-11T01:00:00.000Z");

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function containsExactString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected));
  if (isRecord(value)) {
    return Object.values(value).some((item) => containsExactString(item, expected));
  }
  return false;
}

function currentTurnToolResults(prompt: unknown): RecordValue[] {
  if (!Array.isArray(prompt)) return [];
  let lastUser = -1;
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (isRecord(message) && message.role === "user") {
      lastUser = index;
      break;
    }
  }

  const results: RecordValue[] = [];
  for (const message of prompt.slice(lastUser + 1)) {
    if (!isRecord(message) || message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (isRecord(part) && part.type === "tool-result") results.push(part);
    }
  }
  return results;
}

function jsonResult(result: RecordValue): RecordValue | undefined {
  const output = result.output;
  if (!isRecord(output) || output.type !== "json" || !isRecord(output.value)) {
    return undefined;
  }
  return output.value;
}

function isDenied(result: RecordValue): boolean {
  const output = result.output;
  return isRecord(output) && output.type === "error-text" &&
    typeof output.value === "string" && output.value.startsWith("TOOL_DENIED:");
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

function toolCallResponse(toolName: string, toolCallId: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId,
          toolName,
          input: JSON.stringify(input),
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeTodoistFetch(): typeof globalThis.fetch {
  return (async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/api/v1/user")) return jsonResponse({ id: "user-1" });
    assert.match(url, /\/api\/v1\/tasks\?/);
    return jsonResponse({
      results: [
        {
          id: "task-1",
          project_id: "project-1",
          responsible_uid: null,
          checked: false,
          is_deleted: false,
          content: "准备周报",
          priority: 3,
          due: { date: "2026-09-11", is_recurring: false, timezone: null },
          deadline: { date: "2026-09-14" },
        },
      ],
      next_cursor: null,
    });
  }) as typeof globalThis.fetch;
}

const fixedWriteContent = "offline composition fixture\n";

type WriteFileInput = {
  path: string;
  content: string;
};

function createPlanModel(options: {
  calls: string[];
  todoistResults: RecordValue[];
  writeInputs: WriteFileInput[];
}) {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      assert.ok(
        containsExactString(prompt, todoistPlanSaveInstructions),
        "the mock model must receive the production Todoist plan-save instructions",
      );
      const results = currentTurnToolResults(prompt);
      const todoistResult = results.find((result) => result.toolName === "todoist_list_tasks");
      const writeResult = results.find((result) => result.toolName === "write_file");

      if (todoistResult === undefined) {
        options.calls.push("todoist_list_tasks");
        return toolCallResponse("todoist_list_tasks", "todoist-call", { view: "planning" });
      }
      if (writeResult === undefined) {
        const value = jsonResult(todoistResult);
        assert.ok(value);
        assert.equal(value.ok, true);
        options.todoistResults.push(value);
        const input: WriteFileInput = {
          path: "notes/2026-09-11-plan.md",
          content: fixedWriteContent,
        };
        options.writeInputs.push(input);
        options.calls.push("write_file");
        return toolCallResponse("write_file", "write-file-call", input);
      }

      if (isDenied(writeResult)) return textResponse("未保存：用户拒绝了写入。");
      const value = jsonResult(writeResult);
      assert.ok(value);
      assert.equal(value.ok, true);
      return textResponse("计划已保存。");
    },
  });
}

async function createFixture(options: { writeDenied: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "runloom-stage73-plan-"));
  await mkdir(join(root, "notes"));
  const output = new PassThrough();
  const rendered: string[] = [];
  output.on("data", (chunk) => rendered.push(String(chunk)));
  const host = createModuleHost(
    [
      createTodoistModule({
        apiToken: "test-token",
        timeZone: "Asia/Shanghai",
        now: fixedNow,
        fetch: fakeTodoistFetch(),
      }),
      createReadFileModule(new DirectoryAccess({ load: async () => [{ path: root, access: "readwrite" }], protectedPaths: [] })),
    ],
    { notify: () => undefined },
  );
  // The confirmation reads the permission facts the assembled modules declared.
  const confirmation = createToolConfirmation(output, { toolPermissions: host.toolPermissions });
  const confirmedTools: string[] = [];
  const beforeToolExecute: BeforeToolExecute = (input) => {
    confirmedTools.push(input.toolName);
    const decision = confirmation.beforeToolExecute(input);
    queueMicrotask(() => {
      confirmation.handleLine(
        options.writeDenied && input.toolName === "write_file" ? "n" : "y",
      );
    });
    return decision;
  };

  const calls: string[] = [];
  const todoistResults: RecordValue[] = [];
  const writeInputs: WriteFileInput[] = [];
  const model = createPlanModel({ calls, todoistResults, writeInputs });
  const store = new InMemoryAgentStore();
  const runtime = new DefaultAgentRuntime({
    catalog: new InMemoryAgentCatalog([definition]),
    loop: new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ [definition.model]: model }),
      tools: new ToolRegistry(host.tools),
    }),
    beforeToolExecute,
    store,
  });

  return {
    root,
    output,
    rendered,
    host,
    calls,
    todoistResults,
    writeInputs,
    confirmedTools,
    runtime,
    store,
  };
}

function userMessage(text: string): UIMessage {
  return { id: "plan-user", role: "user", parts: [{ type: "text", text }] };
}

describe("Stage 7-3 Todoist plan save acceptance", () => {
  it("connects Todoist query and file write through confirmations, then commits the Run", async () => {
    const fixture = await createFixture({ writeDenied: false });
    try {
      const handle = await fixture.runtime.run({
        agentId: definition.id,
        threadId: "stage73-thread",
        messages: [userMessage("读取 Todoist，生成今日计划，保存到 notes/2026-09-11-plan.md。")],
      });
      const result = await handle.result;

      assert.equal(result.status, "completed");
      assert.deepEqual(fixture.calls, ["todoist_list_tasks", "write_file"]);
      assert.equal(fixture.todoistResults.length, 1);
      assert.equal(fixture.todoistResults[0]?.ok, true);
      assert.deepEqual(fixture.confirmedTools, ["todoist_list_tasks", "write_file"]);
      assert.equal(fixture.writeInputs.length, 1);
      const writeInput = fixture.writeInputs[0]!;
      const rendered = fixture.rendered.join("");
      assert.ok(rendered.indexOf("Tool: todoist_list_tasks") < rendered.indexOf("Tool: write_file"));
      assert.ok(rendered.includes(`Path: ${JSON.stringify(writeInput.path)}`));
      assert.ok(rendered.includes(`Content: ${JSON.stringify(writeInput.content)}`));

      const content = await readFile(join(fixture.root, "notes/2026-09-11-plan.md"), "utf8");
      assert.equal(content, writeInput.content);

      const messages = await fixture.store.getMessages("stage73-thread");
      assert.equal(messages[0]?.role, "user");
      assert.ok(messages.some((message) =>
        message.parts.some((part) => part.type === "dynamic-tool" &&
          part.toolName === "todoist_list_tasks" && part.state === "output-available"),
      ));
      assert.ok(messages.some((message) =>
        message.parts.some((part) => part.type === "dynamic-tool" &&
          part.toolName === "write_file" && part.state === "output-available"),
      ));
      assert.equal((await fixture.store.getRun(handle.runId))?.status, "completed");
    } finally {
      fixture.host.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("turns a denied write confirmation into TOOL_DENIED without creating the target", async () => {
    const fixture = await createFixture({ writeDenied: true });
    try {
      const handle = await fixture.runtime.run({
        agentId: definition.id,
        threadId: "stage73-denied-thread",
        messages: [userMessage("读取 Todoist，生成今日计划，保存到 notes/2026-09-11-plan.md。")],
      });
      const result = await handle.result;

      assert.equal(result.status, "completed");
      assert.deepEqual(fixture.calls, ["todoist_list_tasks", "write_file"]);
      assert.deepEqual(fixture.confirmedTools, ["todoist_list_tasks", "write_file"]);
      await assert.rejects(readFile(join(fixture.root, "notes/2026-09-11-plan.md")), { code: "ENOENT" });
      const messages = await fixture.store.getMessages("stage73-denied-thread");
      assert.ok(messages.some((message) =>
        message.parts.some((part) => part.type === "dynamic-tool" &&
          part.toolName === "write_file" && part.state === "output-error" &&
          part.errorText.includes("TOOL_DENIED")),
      ));
    } finally {
      fixture.host.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
