import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "ai";
import { assembleFiveLayerContext, contextFingerprint, commonContextPrefix } from "./five-layer-context.js";

test("five layers preserve tools, exact message order and appended current references without mutating inputs", () => {
  const message = (content: string): ModelMessage => ({ role: "user", content });
  const input = { instructions: "fixed", tools: [{ name: "read" }], reference: [message("preferences + indexes")],
    summary: [message("summary")], recent: [message("old + its saved time")], current: [message("new + current time/task")] };
  const before = structuredClone(input), result = assembleFiveLayerContext(input);
  assert.deepEqual(result.messages.map(m => m.content), ["fixed", "preferences + indexes", "summary", "old + its saved time", "new + current time/task"]);
  assert.deepEqual(result.tools, input.tools); assert.deepEqual(input, before);
  const next = assembleFiveLayerContext({ ...input, recent: [...input.recent, ...input.current], current: [message("next")] });
  const old = result.messages.map(contextFingerprint), current = next.messages.map(contextFingerprint);
  assert.equal(commonContextPrefix({ previous: old, current }).segments, old.length);
});

test("snapshot replacement breaks at layer two even when later summary/history hashes match", () => {
  const previous = ["instructions", "old snapshot", "same history"].map(contextFingerprint);
  const current = ["instructions", "new snapshot", "same history"].map(contextFingerprint);
  const shared = commonContextPrefix({ previous, current });
  assert.equal(shared.segments, 1); assert.equal(shared.estimatedTokens, previous[0]!.estimatedTokens);
  assert.equal(commonContextPrefix({ previous: [], current }).estimatedTokens, 0);
});
