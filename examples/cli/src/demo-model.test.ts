import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDemoModel } from "./demo-model.js";

type DemoPrompt = Parameters<ReturnType<typeof createDemoModel>["doStream"]>[0]["prompt"];

async function streamChunks(prompt: DemoPrompt): Promise<unknown[]> {
  const result = await createDemoModel().doStream({ prompt });
  const chunks: unknown[] = [];
  for await (const chunk of result.stream) chunks.push(chunk);
  return chunks;
}

function textDelta(chunks: unknown[]): string {
  return chunks
    .filter(
      (chunk): chunk is { type: "text-delta"; delta: string } =>
        typeof chunk === "object" &&
        chunk !== null &&
        "type" in chunk &&
        chunk.type === "text-delta" &&
        "delta" in chunk &&
        typeof chunk.delta === "string",
    )
    .map((chunk) => chunk.delta)
    .join("");
}

function hasToolCall(chunks: unknown[]): boolean {
  return chunks.some(
    (chunk) =>
      typeof chunk === "object" &&
      chunk !== null &&
      "type" in chunk &&
      chunk.type === "tool-call",
  );
}

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

const toolResult = (value: { value: number }) => ({
  role: "tool" as const,
  content: [
    {
      type: "tool-result" as const,
      toolCallId: "call-add",
      toolName: "add",
      output: { type: "json" as const, value },
    },
  ],
});

describe("createDemoModel", () => {
  it("reads the structured current-turn result instead of matching serialized text", async () => {
    const chunks = await streamChunks([
      user("What is 20 + 22?"),
      toolResult({ value: 99 }),
    ]);

    assert.equal(textDelta(chunks), "The add tool returned 99.");
    assert.equal(hasToolCall(chunks), false);
  });

  it("turns a structured denial into a model answer", async () => {
    const chunks = await streamChunks([
      user("What is 20 + 22?"),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-add",
            toolName: "add",
            output: { type: "error-text", value: "TOOL_DENIED: not permitted" },
          },
        ],
      },
    ]);

    assert.equal(textDelta(chunks), "The add tool was denied.");
    assert.equal(hasToolCall(chunks), false);
  });

  it("does not let a previous turn's result suppress a new tool call", async () => {
    const chunks = await streamChunks([
      user("First calculation"),
      toolResult({ value: 42 }),
      user("Second calculation"),
    ]);

    assert.equal(hasToolCall(chunks), true);
    assert.equal(textDelta(chunks), "");
  });
});
