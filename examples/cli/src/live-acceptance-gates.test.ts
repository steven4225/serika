import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const [entry, optIn] of [
  ["memory-native-acceptance", "RUNLOOM_MEMORY_ACCEPTANCE"],
  ["context-continuity-acceptance", "RUNLOOM_CONTEXT_CONTINUITY"],
] as const) {
  test(`${entry} rejects implicit live calls and mock opt-in before provider access`, () => {
    const path = fileURLToPath(new URL(`./${entry}.js`, import.meta.url));
    for (const env of [
      { RUNLOOM_MODEL: "command-code" },
      { [optIn]: "1", RUNLOOM_MODEL: "mock" },
      { [optIn]: "1", RUNLOOM_MODEL: "unknown" },
    ]) {
      // No credentials inherited; the CLI must fail at the explicit opt-in gate.
      const result = spawnSync(process.execPath, [path], { env, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /live opt-in required/i);
      assert.doesNotMatch(result.stderr, /API_KEY is required/);
    }
    const enabled = spawnSync(process.execPath, [path], {
      env: { [optIn]: "1", RUNLOOM_MODEL: "command-code" }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(enabled.status, 1, enabled.stderr);
    assert.match(enabled.stderr, /COMMAND_CODE_API_KEY is required/);
  });
}
