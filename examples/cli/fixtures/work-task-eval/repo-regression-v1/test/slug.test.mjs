import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSlug } from "../src/slug.mjs";

test("normalizes case and trims the surrounding whitespace", () => {
  assert.equal(normalizeSlug("  Release Notes  "), "release-notes");
});

test("collapses every internal whitespace group", () => {
  assert.equal(normalizeSlug("Agent   Weekly\t\tReview"), "agent-weekly-review");
  assert.equal(normalizeSlug("One Two Three"), "one-two-three");
});

test("preserves empty input, digits and existing separators", () => {
  assert.equal(normalizeSlug(" \t "), "");
  assert.equal(normalizeSlug("  Release-2_Notes "), "release-2_notes");
});

test("rejects non-string input with the existing error", () => {
  assert.throws(() => normalizeSlug(null), { name: "TypeError", message: "slug input must be a string" });
});
