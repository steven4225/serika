import assert from "node:assert/strict";
import { it } from "node:test";
import { nativeFixtureApprovalAllowed } from "./computer-native-acceptance.js";

it("restricts native fixture approvals to a fresh exact TextEdit area and one marker", () => {
  const target = { bundleId: "com.apple.TextEdit", pid: 123, windowId: 456 };
  const fresh = { ok: true as const, observationId: "fresh", elements: [{ role: "AXTextArea", element_token: "text" }] };
  const input = { ...target, observationId: "fresh", elementToken: "text", action: "type_text", text: "marker" };
  const allowed = (value: unknown, actions = 0) => nativeFixtureApprovalAllowed("computer_action", value, target, "marker", fresh, actions);
  assert.ok(allowed(input));
  assert.equal(allowed(input, 1), false);
  for (const change of [{ bundleId: "com.apple.finder" }, { pid: 789 }, { windowId: 999 }, { observationId: "old" },
    { elementToken: "menu" }, { action: "click" }, { text: "different" }]) assert.equal(allowed({ ...input, ...change }), false);
  assert.equal(nativeFixtureApprovalAllowed("shell_exec", input, target, "marker", fresh, 0), false);
  assert.equal(nativeFixtureApprovalAllowed("computer_observe", { bundleId: target.bundleId }, target, "marker", fresh, 0), false);
  assert.ok(nativeFixtureApprovalAllowed("computer_observe", target, target, "marker", fresh, 0));
  assert.equal(nativeFixtureApprovalAllowed("computer_action", input, target, "marker", undefined, 0), false);
  assert.equal(nativeFixtureApprovalAllowed("computer_action", input, target, "marker", {
    ...fresh, elements: [...fresh.elements, { role: "AXTextArea", element_token: "other" }],
  }, 0), false);
});
