import assert from "node:assert/strict";
import { test } from "node:test";
import { sameFact, sameFactSlot, validateFactIdentity } from "./memory-fact-identity.js";

test("versioned everyday identities coexist with unchanged legacy identities without migration", () => {
  const legacy = { attribute: "coffee", scenario: "general", value: "sweetened" };
  assert.deepEqual(validateFactIdentity(legacy), legacy);
  const current = { version: 2, subject: "user", attribute: "diet_spiciness", scenario: "工作日早餐", value: "mild" };
  const value = validateFactIdentity(current);
  assert.deepEqual(value, current);
  assert.equal(sameFact(value, validateFactIdentity(current)), true);
  assert.equal(sameFactSlot(value, validateFactIdentity({ ...current, value: "none" })), true);
  assert.equal(sameFactSlot(value, validateFactIdentity({ ...current, scenario: "休息日早餐" })), false);
  for (const bad of [
    { ...current, version: 3 }, { ...current, subject: "friend" }, { ...current, attribute: "coffee" },
    { ...current, value: "arbitrary" }, { ...current, sourceQuote: "多余字段" },
    { ...current, scenario: "a\nb" }, { ...legacy, version: 2 },
  ]) assert.throws(() => validateFactIdentity(bad));
});
