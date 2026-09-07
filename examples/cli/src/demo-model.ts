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

/**
 * Deterministic CLI model: it decides from the current user turn's tool
 * result, so previous turns cannot make a new turn skip its tool call.
 */
export function createDemoModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const currentTurn = JSON.stringify(promptAfterLastUser(prompt));
      if (currentTurn.includes("TOOL_DENIED")) {
        return textResponse("The add tool was denied.");
      }
      if (currentTurn.includes('"value":42')) {
        return textResponse("20 + 22 = 42");
      }
      return addCallResponse();
    },
  });
}
