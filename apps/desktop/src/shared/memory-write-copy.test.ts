import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewErrorText } from "./memory-review.js";
import * as drafts from "./conversation-drafts.js";

test("memory conflicts are Chinese explanations, never raw ids or codes", () => {
  for (const code of ["MEMORY_CANDIDATE_CONFLICT", "MEMORY_CANDIDATE_STALE", "MEMORY_TEMPORAL_CONFLICT", "MEMORY_REVISION_CONFLICT"]) {
    const text = reviewErrorText({ code, message: "Conflict at memory 123e4567-e89b-12d3-a456-426614174000 revision 3" }, true);
    assert.match(text, /确认|变化|冲突|重新/); assert.doesNotMatch(text, /MEMORY_|123e4567|revision|Conflict/);
  }
});
test("long draft feedback names the byte limit without implying storage repair or discarding input", () => {
  const message = (drafts as unknown as { conversationDraftError(text: string): string }).conversationDraftError("长".repeat(23000));
  assert.match(message, /内容太长，请分段/); assert.match(message, /保留/); assert.doesNotMatch(message, /修复保存位置/);
});
