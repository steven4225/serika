import assert from "node:assert/strict";
import { test } from "node:test";
import { dualWriteMismatches } from "./app/dual-write-check.js";

test("dual-write check: equal copies report nothing", () => {
  assert.deepEqual(dualWriteMismatches({ memoryRefresh: 2, contextRefresh: 5, taskRefresh: 0 }, { memoryRefresh: 2, contextRefresh: 5, taskRefresh: 0 }), []);
});

test("dual-write check: names every field whose copies differ", () => {
  assert.deepEqual(dualWriteMismatches({ memoryRefresh: 2, contextRefresh: 5, taskRefresh: 1 }, { memoryRefresh: 2, contextRefresh: 4, taskRefresh: 0 }), ["contextRefresh", "taskRefresh"]);
});
