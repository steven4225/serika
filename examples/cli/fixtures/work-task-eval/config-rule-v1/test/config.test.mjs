import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.mjs";

test("preserves the existing defaults and explicit settings", () => {
  assert.deepEqual(parseConfig({}), { enabled: true, mode: "brief" });
  assert.deepEqual(parseConfig({ enabled: false, mode: "full" }), { enabled: false, mode: "full" });
  assert.deepEqual(parseConfig({ ignored: 1 }), { enabled: true, mode: "brief" });
});

test("preserves existing error messages and precedence", () => {
  for (const input of [null, [], "brief"]) {
    assert.throws(() => parseConfig(input), { name: "TypeError", message: "config must be an object" });
  }
  assert.throws(() => parseConfig({ enabled: 1, mode: "bad" }), { name: "TypeError", message: "enabled must be a boolean" });
  assert.throws(() => parseConfig({ mode: "bad" }), { name: "TypeError", message: "mode must be brief or full" });
});
