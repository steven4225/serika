import assert from "node:assert/strict";
import { resolveApplicationHome } from "@serika/assistant";
import { realpathSync } from "node:fs";
import { describe, it } from "node:test";
import { userDataPathFromEnv } from "./user-data-path.js";

describe("desktop user data path", () => {
  it("uses the application home independently of the product name", () => {
    assert.equal(resolveApplicationHome({ env: {}, cwd: "/", userHome: "/tmp/serika-test-user" }), `${realpathSync("/tmp")}/serika-test-user/.serika`);
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
