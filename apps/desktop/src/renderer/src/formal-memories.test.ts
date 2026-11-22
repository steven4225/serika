import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { detailWriteIsStale } from "./formal-memories.js";

it("a late memory write never overwrites the entry the user switched to", async () => {
  const started = { request: 3, id: "memory-a" };
  assert.equal(detailWriteIsStale(started, { request: 3, id: "memory-a" }), false);
  assert.equal(detailWriteIsStale(started, { request: 4, id: "memory-b" }), true, "opening another entry bumps the request");
  assert.equal(detailWriteIsStale(started, { request: 4, id: null }), true, "going back closes the detail");
  assert.equal(detailWriteIsStale(started, { request: 3, id: "memory-b" }), true);
  const source = await readFile(new URL("./formal-memories.tsx", import.meta.url), "utf8");
  const apply = source.slice(source.indexOf("async function apply("), source.indexOf("function back()"));
  assert.match(apply, /const started = \{ request: detailSequence\.current, id: openId \}/);
  assert.match(apply, /if \(stale\) \{ await load\(\); return; \}/);
});
