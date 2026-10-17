import { InvalidToolInputError, JSONParseError, TypeValidationError, type DynamicToolUIPart } from "ai";
import { AgentError, type AgentErrorData } from "@serika/core";

export interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid: boolean;
  validationError?: unknown;
}

export function invalidInputHint(call: PendingToolCall, schemaFields: readonly string[]): string {
  // Reuse the SDK's validation, never its message/input (which may contain secrets).
  // Report only schema-owned top-level field names, not arbitrary record keys.
  let cause = InvalidToolInputError.isInstance(call.validationError) ? call.validationError.cause : undefined;
  if (JSONParseError.isInstance(cause)) return "Invalid JSON arguments.";
  if (TypeValidationError.isInstance(cause)) cause = cause.cause;
  const issues = Array.isArray(cause) ? cause
    : cause && typeof cause === "object" && "issues" in cause && Array.isArray(cause.issues) ? cause.issues : [];
  const hints = new Set<string>();
  for (const issue of issues.slice(0, 8)) {
    if (!issue || typeof issue !== "object") continue;
    const field = Array.isArray(issue.path) ? issue.path[0] : undefined;
    if (typeof field !== "string" || !schemaFields.includes(field)) {
      hints.add("Field combination or object constraints failed");
      continue;
    }
    const missing = issue.path.length === 1 && issue.code === "invalid_type" &&
      call.input !== null && typeof call.input === "object" &&
      (!Object.hasOwn(call.input, field) || (call.input as Record<string, unknown>)[field] === undefined);
    const reason = missing ? "required" : issue.code === "invalid_type" ? "invalid type"
      : issue.code === "invalid_value" || issue.code === "invalid_enum_value" ? "invalid value" : "constraint failed";
    hints.add(`${field.slice(0, 64)}: ${reason}`);
  }
  return hints.size > 0 ? `${[...hints].join("; ")}. Check the named fields (case-sensitive).`
    : "Arguments failed validation; check the tool's input schema and field combinations.";
}

export function toolError(
  code: "TOOL_INVALID_INPUT" | "TOOL_EXECUTION_FAILED" | "TOOL_DENIED",
  toolName: string,
  message?: string,
  cause?: unknown,
): AgentError {
  return new AgentError(
    {
      code,
      message:
        message ??
        (code === "TOOL_INVALID_INPUT"
          ? `Tool input is invalid: ${toolName}`
          : code === "TOOL_DENIED"
            ? `Tool execution denied: ${toolName}`
            : `Tool execution failed: ${toolName}`),
      retryable: false,
      phase: "tool",
    },
    { cause },
  );
}

export function toolPrecheckError(
  toolName: string,
  message: string,
  cause?: unknown,
): AgentError {
  return new AgentError(
    {
      code: "TOOL_PRECHECK_FAILED",
      message: `Tool precheck failed: ${toolName}: ${message}`,
      retryable: false,
      phase: "tool",
    },
    { cause },
  );
}

export function toolOutcomeUnknown(
  toolName: string,
  message: string,
  cause?: unknown,
): AgentError {
  return new AgentError(
    {
      code: "TOOL_OUTCOME_UNKNOWN",
      message: `Tool outcome is unknown: ${toolName}: ${message}`,
      retryable: false,
      phase: "tool",
    },
    { cause },
  );
}

export function validateToolExecutionDecision(
  value: unknown,
  toolName: string,
): { allow: true } | { allow: false; reason: string } {
  if (typeof value !== "object" || value === null) {
    throw toolPrecheckError(
      toolName,
      "beforeToolExecute must return an allow/deny decision",
    );
  }

  const decision = value as { allow?: unknown; reason?: unknown };
  if (typeof decision.allow !== "boolean") {
    throw toolPrecheckError(
      toolName,
      "beforeToolExecute decision.allow must be a boolean",
    );
  }
  if (decision.allow) return { allow: true };
  if (typeof decision.reason !== "string" || decision.reason.trim().length === 0) {
    throw toolPrecheckError(
      toolName,
      "beforeToolExecute denial must include a non-empty reason",
    );
  }
  return { allow: false, reason: decision.reason };
}

export function toolResultError(
  call: PendingToolCall,
  error: AgentErrorData,
): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    state: "output-error",
    input: call.input,
    errorText: `${error.code}: ${error.message}`,
  };
}
