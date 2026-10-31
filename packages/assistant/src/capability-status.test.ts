import assert from "node:assert/strict";
import { it } from "node:test";
import { capabilityStatus, scrubCapabilityTools } from "./capability-status.js";

it("scrubs tools removed from the model request and leaves an unchanged list intact", () => {
  const tools = ["herdr_pi_discover", "herdr_pi_read", "herdr_pi_control"];
  const status = capabilityStatus({ config: undefined, tools, toolModules: new Map(tools.map(name => [name, "terminal"])) });
  assert.equal(scrubCapabilityTools(status, tools), status);
  const scrubbed = scrubCapabilityTools(status, tools.slice(1));
  assert.deepEqual(scrubbed.tools, tools.slice(1));
  assert.deepEqual(scrubbed.modules.find(module => module.id === "terminal")?.registeredTools, tools.slice(1));
  assert.equal(scrubbed.execution, status.execution);
  assert.equal(JSON.stringify(scrubbed).includes("herdr_pi_discover"), false);
});
