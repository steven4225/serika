import type { UIMessage } from "ai";
import { AgentError } from "@aisdk-agent/core";
import {
  createMemoryContextMessage,
  memoryContextBytes,
  MEMORY_CONTEXT_MAX_BYTES,
  type MemoryEntry,
} from "./memory-store.js";

export { createMemoryContextMessage, memoryContextBytes } from "./memory-store.js";

export const MAX_HISTORY_TURNS = 8;
export const MAX_CONTEXT_BYTES = 131_072;
export const MAX_MEMORY_CONTEXT_BYTES = MEMORY_CONTEXT_MAX_BYTES;

/** The subset of a persisted memory entry needed by model-context selection. */
export type ContextMemoryEntry = MemoryEntry;

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

/**
 * Select recent complete turns and, when present, inject enabled workspace
 * memories without changing the transcript.
 */
export function selectModelContext(
  messages: UIMessage[],
  memories: readonly ContextMemoryEntry[] = [],
): UIMessage[] {
  if (messages.length === 0 && memories.length === 0) return messages;

  const userStarts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") userStarts.push(index);
  }

  const historyTurns: UIMessage[][] = [];

  let currentTurn: UIMessage[];
  if (userStarts.length === 0) {
    currentTurn = messages.slice();
  } else {
    const firstUserStart = userStarts[0]!;
    const currentStart = userStarts[userStarts.length - 1]!;
    if (firstUserStart > 0) historyTurns.push(messages.slice(0, firstUserStart));
    for (let index = 0; index < userStarts.length - 1; index += 1) {
      historyTurns.push(messages.slice(userStarts[index], userStarts[index + 1]));
    }
    currentTurn = messages.slice(currentStart);
  }

  if (messageBytes(currentTurn) > MAX_CONTEXT_BYTES) throw contextTooLarge();

  const selectedHistory = historyTurns.slice(-MAX_HISTORY_TURNS);
  const selectedMemories = memories.filter((memory) => memory.enabled).slice();

  // The injected message has its own limit. Evict oldest enabled entries if a
  // caller supplies entries that were not already checked by the store.
  while (
    selectedMemories.length > 0 &&
    memoryContextBytes(selectedMemories) > MAX_MEMORY_CONTEXT_BYTES
  ) {
    selectedMemories.shift();
  }

  const memoryMessage = (): UIMessage[] => {
    const message = createMemoryContextMessage(selectedMemories);
    return message === undefined ? [] : [message];
  };
  const compose = (): UIMessage[] => [
    ...memoryMessage(),
    ...selectedHistory.flat(),
    ...currentTurn,
  ];
  let selected = compose();

  while (
    selectedHistory.length > 0 &&
    messageBytes(selected) > MAX_CONTEXT_BYTES
  ) {
    selectedHistory.shift();
    selected = compose();
  }

  while (
    selectedMemories.length > 0 &&
    messageBytes(selected) > MAX_CONTEXT_BYTES
  ) {
    selectedMemories.shift();
    selected = compose();
  }

  return selected;
}
