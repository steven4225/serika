import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import type { AgentEvent } from "@aisdk-agent/core";
import { AiSdkAgentLoop } from "./loop.js";
import { InMemoryModelRegistry, ToolRegistry } from "./registries.js";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

describe("AiSdkAgentLoop", () => {
  it("maps a model-tool-model stream into stable framework events", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "call-1",
                  toolName: "double",
                  input: JSON.stringify({ value: 21 }),
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
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "text-1" },
              { type: "text-delta" as const, id: "text-1", delta: "42" },
              { type: "text-end" as const, id: "text-1" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: undefined },
                usage,
              },
            ],
          }),
        };
      },
    });
    const double = tool({
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ value: z.number() }),
      execute: async ({ value }) => ({ value: value * 2 }),
    });
    const loop = new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry([
        {
          metadata: {
            name: "double",
            version: "1",
            risk: "read",
            timeoutMs: 1_000,
            idempotent: true,
          },
          tool: double,
        },
      ]),
    });
    const events: AgentEvent[] = [];
    let eventId = 0;
    const outcome = await loop.execute({
      definition: {
        id: "test",
        version: "1",
        instructions: "Use tools",
        model: "test",
        tools: ["double"],
        limits: { maxSteps: 4, totalTimeoutMs: 5_000, stepTimeoutMs: 2_000 },
      },
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "double 21" }] },
      ],
      signal: new AbortController().signal,
      async emit(type, data) {
        events.push({
          id: `event-${++eventId}`,
          type,
          data,
          runId: "run",
          threadId: "thread",
          sequence: eventId,
          occurredAt: new Date(0).toISOString(),
        } as AgentEvent);
      },
    });

    assert.equal(outcome.text, "42");
    assert.equal(outcome.steps, 2);
    assert.ok(events.some((event) => event.type === "tool.call.requested"));
    assert.ok(events.some((event) => event.type === "tool.call.started"));
    assert.ok(events.some((event) => event.type === "tool.call.completed"));
    assert.ok(events.some((event) => event.type === "message.delta"));
  });
});
