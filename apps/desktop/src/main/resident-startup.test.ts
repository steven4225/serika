import assert from "node:assert/strict";
import { test } from "node:test";
import { retainResidentEnvironmentSource } from "./resident-startup.js";

test("headless startup preserves the trusted Node env-file path for existing task automation without copying credentials", () => {
  const env: NodeJS.ProcessEnv = { RUNLOOM_MODEL: "command-code" };
  retainResidentEnvironmentSource(env, ["--env-file=/private/config/serika.env"]);
  assert.deepEqual(env, { RUNLOOM_MODEL: "command-code", RUNLOOM_ENV_FILE: "/private/config/serika.env" });
  retainResidentEnvironmentSource(env, ["--env-file=/private/config/other.env"]);
  assert.equal(env.RUNLOOM_ENV_FILE, "/private/config/serika.env", "explicit configured source wins");
  assert.throws(() => retainResidentEnvironmentSource({}, ["--env-file=relative.env"]), /绝对路径/);
  const unconfigured = {};
  retainResidentEnvironmentSource(unconfigured, ["--import", "tsx"]);
  assert.deepEqual(unconfigured, {}, "never invent a credential source");
});
