import type { UIMessage } from "ai";
import { AgentError } from "@aisdk-agent/core";

export const MAX_HISTORY_TURNS = 8;
export const MAX_CONTEXT_BYTES = 131_072;

function messageBytes(messages: UIMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function contextTooLarge(): AgentError {
  return new AgentError({
    code: "CONTEXT_PREPARE_FAILED",
    message: `Current turn exceeds the ${MAX_CONTEXT_BYTES}-byte context limit`,
    retryable: false,
    phase: "runtime",
  });
}

/** Selects recent complete turns for a model request without changing the transcript. */
export function selectModelContext(messages: UIMessage[]): UIMessage[] {
  if (messages.length === 0) return messages;

  const userStarts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") userStarts.push(index);
  }

  if (userStarts.length === 0) {
    if (messageBytes(messages) > MAX_CONTEXT_BYTES) throw contextTooLarge();
    return messages.slice();
  }

  const firstUserStart = userStarts[0]!;
  const currentStart = userStarts[userStarts.length - 1]!;
  const historyTurns: UIMessage[][] = [];

  if (firstUserStart > 0) historyTurns.push(messages.slice(0, firstUserStart));
  for (let index = 0; index < userStarts.length - 1; index += 1) {
    historyTurns.push(messages.slice(userStarts[index], userStarts[index + 1]));
  }

  const currentTurn = messages.slice(currentStart);
  if (messageBytes(currentTurn) > MAX_CONTEXT_BYTES) throw contextTooLarge();

  const selectedHistory = historyTurns.slice(-MAX_HISTORY_TURNS);
  let selected = [...selectedHistory.flat(), ...currentTurn];

  while (
    selectedHistory.length > 0 &&
    messageBytes(selected) > MAX_CONTEXT_BYTES
  ) {
    selectedHistory.shift();
    selected = [...selectedHistory.flat(), ...currentTurn];
  }

  return selected;
}
