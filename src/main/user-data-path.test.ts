import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultUserDataPath, userDataPathFromEnv } from "./user-data-path.js";

describe("desktop user data path", () => {
  it("keeps the legacy profile independent of the product name", () => {
    assert.equal(defaultUserDataPath("/Users/test/Library/Application Support"), "/Users/test/Library/Application Support/@aisdk-agent/desktop");
  });
  it("ignores a missing or blank override", () => {
    assert.equal(userDataPathFromEnv({}), undefined);
    assert.equal(userDataPathFromEnv({ RUNLOOM_USER_DATA: "   " }), undefined);
  });

  it("accepts an absolute directory and rejects a relative one", () => {
    assert.equal(userDataPathFromEnv({ RUNLOOM_USER_DATA: "/tmp/runloom-profile" }), "/tmp/runloom-profile");
    assert.throws(() => userDataPathFromEnv({ RUNLOOM_USER_DATA: "profiles/daily" }), /absolute path/);
  });
});
