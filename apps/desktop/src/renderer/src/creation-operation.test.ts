import assert from "node:assert/strict";
import { test } from "node:test";
import { submitCreation } from "./creation-operation.js";

test("unknown creation retains ID across reload; confirmed success permits intentional new creation", async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, v: string) => { values.set(key, v); }, removeItem: (key: string) => { values.delete(key); } };
  let original = "";
  await assert.rejects(submitCreation(storage, "thread:work", { goal: "private task" }, async id => { original = id; throw new Error("response lost"); }));
  assert.equal(values.size, 1); assert.equal(JSON.stringify([...values]).includes("private task"), false);
  await submitCreation(storage, "thread:work", { goal: "private task" }, async id => { assert.equal(id, original); return { ok: true }; });
  assert.equal(values.size, 0);
  await submitCreation(storage, "thread:work", { goal: "private task" }, async id => { assert.notEqual(id, original); return { ok: true }; });
});
test("storage failure prevents dispatch", async () => {
  let calls = 0;
  await assert.rejects(submitCreation({ getItem: () => null, setItem: () => { throw new Error("disk"); }, removeItem: () => {} }, "t", {}, async () => { calls++; return { ok: true }; }));
  assert.equal(calls, 0);
});
