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
} from "@aisdk-agent/core";
import {
  AiSdkAgentLoop,
  InMemoryModelRegistry,
  ToolRegistry,
} from "@aisdk-agent/ai-sdk-adapter";
import { createModuleHost } from "./module-host.js";
import { createReadFileModule } from "./modules/read-file-module.js";
import { createTodoistModule } from "./modules/todoist-module.js";
import { createToolConfirmation } from "./tui.js";

const definition = {
  id: "daily-plan",
  version: "1",
  instructions: "Read Todoist planning tasks, compose the requested Markdown plan, and save it.",
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

function markdownFromQuery(value: RecordValue): string {
  assert.equal(value.ok, true);
  const queryValue = value.value;
  assert.ok(isRecord(queryValue));
  const tasks = queryValue.tasks;
  assert.ok(Array.isArray(tasks));
  const task = tasks[0];
  assert.ok(isRecord(task));
  assert.equal(task.title, "准备周报");
  assert.equal(task.id, "task-1");

  return [
    "# 今日计划｜2026-09-11",
    "",
    `- 规划时区：${queryValue.timeZone}`,
    `- 查询时间：${queryValue.asOf}`,
    `- 查询范围：(-∞, ${isRecord(queryValue.window) ? queryValue.window.toExclusive : "2026-09-19"})`,
    `- 查询完整性：${queryValue.truncated === true ? "不完整" : "完整"}`,
    `- 返回任务数：${tasks.length}`,
    "",
    "## 今日三件最重要的事",
    `- ${task.title}（Todoist ID: ${task.id}，来源：${task.url}）`,
    "",
    "## 上午 / 下午 / 晚上",
    "- 上午：建议准备周报。",
    "",
    "## 逾期处理",
    "- 当前查询结果中的逾期任务按事实处理；安排建议不改变 Todoist。",
    "",
    "## 未来 7 天风险",
    `- 截止日期：${task.deadlineDate}（来源：${task.url}）。`,
    "",
    "## 15 分钟立即行动",
    "- 建议先打开周报草稿并列出本周三条进展。",
    "",
  ].join("\n");
}

function createPlanModel(options: { calls: string[] }) {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
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
        options.calls.push("write_file");
        return toolCallResponse("write_file", "write-file-call", {
          path: "notes/2026-09-11-plan.md",
          content: markdownFromQuery(value),
        });
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
  const confirmation = createToolConfirmation(output);
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

  const host = createModuleHost(
    [
      createTodoistModule({
        apiToken: "test-token",
        timeZone: "Asia/Shanghai",
        now: fixedNow,
        fetch: fakeTodoistFetch(),
      }),
      createReadFileModule(root),
    ],
    { notify: () => undefined },
  );
  const calls: string[] = [];
  const model = createPlanModel({ calls });
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

  return { root, output, rendered, host, calls, confirmedTools, runtime, store };
}

function userMessage(text: string): UIMessage {
  return { id: "plan-user", role: "user", parts: [{ type: "text", text }] };
}

describe("Stage 7-3 Todoist plan save acceptance", () => {
  it("queries planning tasks, confirms both tools, writes Markdown, and commits the Run", async () => {
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
      assert.deepEqual(fixture.confirmedTools, ["todoist_list_tasks", "write_file"]);
      assert.match(fixture.rendered.join(""), /Tool: todoist_list_tasks/);
      assert.match(fixture.rendered.join(""), /Tool: write_file/);

      const content = await readFile(join(fixture.root, "notes/2026-09-11-plan.md"), "utf8");
      assert.match(content, /# 今日计划｜2026-09-11/);
      assert.match(content, /准备周报/);
      assert.match(content, /Asia\/Shanghai/);
      assert.match(content, /## 今日三件最重要的事/);
      assert.match(content, /## 上午 \/ 下午 \/ 晚上/);
      assert.match(content, /## 逾期处理/);
      assert.match(content, /## 未来 7 天风险/);
      assert.match(content, /## 15 分钟立即行动/);

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
