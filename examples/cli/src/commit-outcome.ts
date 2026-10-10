import { AgentError } from "@aisdk-agent/core";

/** Store APIs return errors to the UI; tool callers must not disguise an
 * acknowledged-uncertain replacement as a proven no-effect failure.
 */
export async function toolCommitResult<T>(result: Promise<T>): Promise<T> {
  const value = await result;
  if (typeof value === "object" && value !== null && "ok" in value && value.ok === false &&
      "error" in value && typeof value.error === "object" && value.error !== null && "code" in value.error &&
      ["COMMIT_UNCERTAIN", "CHECKPOINT_COMMIT_UNCERTAIN"].includes(String(value.error.code))) {
    throw new AgentError({ code: "TOOL_OUTCOME_UNKNOWN", message: "Storage replacement acknowledgement is uncertain; reread after restart, never repeat this operation automatically", retryable: false, phase: "tool" });
  }
  return value;
}
