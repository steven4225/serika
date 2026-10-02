import assert from "node:assert/strict";
import { it } from "node:test";
import { shouldSubmitComposer } from "./composer.js";

it("sends on Enter but preserves Shift+Enter and input-method composition", () => {
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false }), true);
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSubmitComposer({ key: "a", shiftKey: false, isComposing: false }), false);
});
