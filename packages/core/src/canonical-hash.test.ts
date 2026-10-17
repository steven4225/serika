import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashCanonicalJson } from "./canonical-hash.js";

describe("RFC 8785 canonical hash", () => {
  it("is independent of object insertion order", () => {
    assert.equal(hashCanonicalJson({ b: 2, a: [1, { d: true, c: null }] }), hashCanonicalJson({ a: [1, { c: null, d: true }], b: 2 }));
  });

  it("keeps the stored jcs-sha256:v1 format stable", () => {
    // Pinned value: compaction prefix hashes persisted on disk depend on it.
    assert.equal(hashCanonicalJson({ a: 1 }), "jcs-sha256:v1:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  });

  it("rejects non-finite JSON numbers", () => {
    assert.throws(() => hashCanonicalJson({ value: Number.NaN }), TypeError);
  });
});
