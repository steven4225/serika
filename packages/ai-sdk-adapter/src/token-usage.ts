import type { LanguageModelUsage } from "ai";
import type { TokenUsage } from "@serika/core";

export function normalizeTokenUsage(usage: LanguageModelUsage): TokenUsage {
  const result: TokenUsage = {};
  const fields = {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key as keyof TokenUsage] = value;
  }
  if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) {
    const total = result.inputTokens + result.outputTokens;
    if (Number.isSafeInteger(total)) result.totalTokens = total;
  }
  return result;
}

/** A sum is complete only when every invocation reported that field. */
export function sumTokenUsage(previous: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!previous) return { ...next };
  const result: TokenUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    if (previous[key] !== undefined && next[key] !== undefined) {
      const total = previous[key]! + next[key]!;
      if (Number.isSafeInteger(total)) result[key] = total;
    }
  }
  return result;
}
