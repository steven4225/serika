import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashCanonicalJson, hashToolInput } from "./hash.js";

describe("RFC 8785 hashes", () => {
  it("is independent of object insertion order", () => {
    assert.equal(
      hashCanonicalJson({ b: 2, a: { y: true, x: "value" } }),
      hashCanonicalJson({ a: { x: "value", y: true }, b: 2 }),
    );
  });

  it("binds tool identity and schema version into the input hash", () => {
    const base = hashToolInput({
      toolName: "send_email",
      toolVersion: "1",
      inputSchemaVersion: 1,
      input: { to: "person@example.com" },
    });
    const changedVersion = hashToolInput({
      toolName: "send_email",
      toolVersion: "2",
      inputSchemaVersion: 1,
      input: { to: "person@example.com" },
    });
    assert.match(base, /^jcs-sha256:v1:[0-9a-f]{64}$/);
    assert.notEqual(base, changedVersion);
  });

  it("rejects non-finite JSON numbers", () => {
    assert.throws(
      () => hashCanonicalJson({ value: Number.NaN }),
      /must contain only JSON values/,
    );
  });
});
