import assert from "node:assert/strict";
import { test } from "node:test";
import { MEMORY_WRITE_RULES } from "./memory-write.js";
import { SKILL_INSTRUCTIONS_MAX_BYTES } from "./skill-catalog.js";

test("M1 extraction rules fit the existing instruction budget without a consolidation Skill", () => {
  assert.ok(Buffer.byteLength(MEMORY_WRITE_RULES) <= SKILL_INSTRUCTIONS_MAX_BYTES);
  assert.match(MEMORY_WRITE_RULES, /嗯 and 好吧/);
});
