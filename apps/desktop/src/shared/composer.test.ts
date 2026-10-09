import assert from "node:assert/strict";
import { it } from "node:test";
import { canSteerComposer, canSubmitComposer, shouldSubmitComposer } from "./composer.js";

it("sends on Enter but preserves Shift+Enter and input-method composition", () => {
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false }), true);
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSubmitComposer({ key: "a", shiftKey: false, isComposing: false }), false);
});

it("opens Steer only for an identified foreground primary Run admitted by the controller", () => {
  const primary = { kind: "running", runId: "run", phase: "primary" } as const;
  assert.equal(canSteerComposer(primary, true), true);
  assert.equal(canSteerComposer(primary, false), false);
  assert.equal(canSubmitComposer(primary, "task"), false, "Steer never grants new task admission");
  assert.equal(canSteerComposer({ ...primary, runId: null }, true), false);
  assert.equal(canSteerComposer({ ...primary, background: true }, true), false);
  assert.equal(canSteerComposer({ ...primary, phase: "consolidation" }, true), false);
  assert.equal(canSteerComposer({ ...primary, phase: "skill" }, true), false);
  assert.equal(canSteerComposer({ kind: "idle" }, true), false);
});

it("allows chat to preempt background Skills but never manual Skills or primary Runs", () => {
  const background = { kind: "running", runId: "skill-run", phase: "skill", background: true } as const;
  assert.equal(canSubmitComposer(background), true);
  assert.equal(canSubmitComposer(background, "command"), false);
  assert.equal(canSubmitComposer(background, "task"), false);
  assert.equal(canSubmitComposer({ kind: "running", runId: "manual", phase: "skill" }), false);
  assert.equal(canSubmitComposer({ ...background, phase: "primary" }), false);
});
