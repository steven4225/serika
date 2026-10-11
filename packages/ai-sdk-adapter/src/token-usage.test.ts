import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelUsage } from "ai";
import { normalizeTokenUsage, sumTokenUsage } from "./token-usage.js";

test("normalization preserves provider cache read/write, keeps absence unknown and preserves reported zero", () => {
  const usage = { inputTokens: 10, outputTokens: 3, totalTokens: 13,
    inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 0 } } as LanguageModelUsage;
  assert.deepEqual(normalizeTokenUsage(usage), { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 4, cacheWriteTokens: 0 });
  assert.deepEqual(normalizeTokenUsage({ inputTokens: 10 } as LanguageModelUsage), { inputTokens: 10 });
  assert.deepEqual(normalizeTokenUsage({ inputTokens: 10, outputTokens: 3 } as LanguageModelUsage), { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
});
test("aggregates only fully reported fields instead of treating a missing step as zero", () => {
  assert.deepEqual(sumTokenUsage(undefined, { inputTokens: 10, cacheReadTokens: 0 }), { inputTokens: 10, cacheReadTokens: 0 });
  assert.deepEqual(sumTokenUsage({ inputTokens: 10, cacheReadTokens: 4 }, { inputTokens: 20 }), { inputTokens: 30 });
  assert.deepEqual(sumTokenUsage({}, { inputTokens: 20 }), {});
  assert.deepEqual(sumTokenUsage({ cacheWriteTokens: 0 }, { cacheWriteTokens: 0 }), { cacheWriteTokens: 0 });
});
