import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
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
          usage: usage(15, 8),
        },
      ],
    }),
  };
}

function addCallResponse() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "call-add",
          toolName: "add",
          input: JSON.stringify({ left: 20, right: 22 }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: usage(10, 5),
        },
      ],
    }),
  };
}

function promptAfterLastUser(prompt: unknown): unknown[] {
  if (!Array.isArray(prompt)) return [];
  let lastUser = -1;
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (typeof message === "object" && message !== null && "role" in message) {
      if ((message as { role?: unknown }).role === "user") {
        lastUser = index;
        break;
      }
    }
  }
  return lastUser === -1 ? [] : prompt.slice(lastUser + 1);
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function currentTurnToolResults(prompt: unknown): RecordValue[] {
  const results: RecordValue[] = [];
  for (const message of promptAfterLastUser(prompt)) {
    if (!isRecord(message) || message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (isRecord(part) && part.type === "tool-result") results.push(part);
    }
  }
  return results;
}

function addResultValue(result: RecordValue): number | undefined {
  if (!isRecord(result.output) || result.output.type !== "json") return undefined;
  const value = result.output.value;
  if (!isRecord(value) || typeof value.value !== "number") return undefined;
  return value.value;
}

function isDeniedResult(result: RecordValue): boolean {
  return (
    isRecord(result.output) &&
    result.output.type === "error-text" &&
    typeof result.output.value === "string" &&
    result.output.value.startsWith("TOOL_DENIED:")
  );
}

function addResultResponse(value: number): string {
  return value === 42 ? "20 + 22 = 42" : `The add tool returned ${value}.`;
}

/**
 * Deterministic CLI model: it decides from the current user turn's tool
 * result, so previous turns cannot make a new turn skip its tool call.
 */
export function createDemoModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const results = currentTurnToolResults(prompt);
      if (results.some(isDeniedResult)) {
        return textResponse("The add tool was denied.");
      }
      const value = results.map(addResultValue).find((item) => item !== undefined);
      if (value !== undefined) {
        return textResponse(addResultResponse(value));
      }
      return addCallResponse();
    },
  });
}
