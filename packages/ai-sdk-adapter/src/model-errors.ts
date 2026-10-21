import { APICallError } from "ai";
import { AgentError, type AgentErrorData } from "@serika/core";

const RETRYABLE_UNAVAILABLE_STATUS = new Set([408, 500, 502, 503, 504, 529]);

function errorCause(error: unknown): unknown {
  return typeof error === "object" && error !== null && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
}

function isNetworkFailure(error: unknown, depth = 0): boolean {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (
    [
      "EAI_AGAIN",
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETUNREACH",
      "ENETDOWN",
      "ENOTFOUND",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
  ) {
    return true;
  }
  const message =
    typeof candidate?.message === "string" ? candidate.message : "";
  if (
    /(?:fetch failed|network error|network request|connection reset|connection refused|dns lookup)/i.test(
      message,
    )
  ) {
    return true;
  }
  const cause = errorCause(error);
  return depth < 2 && cause !== undefined
    ? isNetworkFailure(cause, depth + 1)
    : false;
}

function findApiCallError(error: unknown, depth = 0): APICallError | undefined {
  if (APICallError.isInstance(error)) return error;
  const cause = errorCause(error);
  return depth < 2 && cause !== undefined
    ? findApiCallError(cause, depth + 1)
    : undefined;
}

function modelFailureFromStatus(statusCode: number): AgentErrorData | undefined {
  if (statusCode === 401 || statusCode === 403) {
    return {
      code: "MODEL_AUTH",
      message: "Model authentication failed",
      retryable: false,
      phase: "model",
    };
  }
  if (statusCode === 429) {
    return {
      code: "MODEL_RATE_LIMIT",
      message: "Model request was rate limited",
      retryable: true,
      phase: "model",
    };
  }
  if (RETRYABLE_UNAVAILABLE_STATUS.has(statusCode)) {
    return {
      code: "MODEL_UNAVAILABLE",
      message: "Model service is temporarily unavailable",
      retryable: true,
      phase: "model",
    };
  }
  return undefined;
}

export function modelFailureError(
  error: unknown,
  stepTimeout: AbortSignal,
  stepTimeoutMs: number,
): AgentError {
  if (stepTimeout.aborted) {
    return new AgentError(
      {
        code: "MODEL_TIMEOUT",
        message: `Model step exceeded ${stepTimeoutMs}ms`,
        retryable: true,
        phase: "model",
      },
      { cause: error },
    );
  }

  const apiError = findApiCallError(error);
  const fromStatus =
    apiError?.statusCode === undefined
      ? undefined
      : modelFailureFromStatus(apiError.statusCode);
  if (fromStatus) {
    return new AgentError(fromStatus, { cause: error });
  }

  if (isNetworkFailure(error)) {
    return new AgentError(
      {
        code: "MODEL_UNAVAILABLE",
        message: "Model service is temporarily unavailable",
        retryable: true,
        phase: "model",
      },
      { cause: error },
    );
  }

  return new AgentError(
    {
      code: "MODEL_BAD_RESPONSE",
      message: "Model stream returned an error",
      retryable: false,
      phase: "model",
    },
    { cause: error },
  );
}

export function isStartedModelOutput(type: string): boolean {
  return (
    type === "text-delta" ||
    type === "reasoning-delta" ||
    type === "tool-call" ||
    type === "tool-input-start" ||
    type === "tool-input-delta" ||
    type === "tool-input-end"
  );
}

export function validateStepOutcome(finishReason: string, toolCallCount: number): void {
  if (finishReason === "stop" && toolCallCount === 0) return;
  if (finishReason === "tool-calls" && toolCallCount > 0) return;

  if (finishReason === "length") {
    throw new AgentError({
      code: "MODEL_BAD_RESPONSE",
      message: `Model output was truncated (finishReason: ${finishReason}); ${toolCallCount} tool call(s) were not executed`,
      retryable: false,
      phase: "model",
    });
  }

  if (finishReason === "stop" || finishReason === "tool-calls") {
    throw new AgentError({
      code: "MODEL_BAD_RESPONSE",
      message: `Model finishReason ${finishReason} is inconsistent with ${toolCallCount} tool call(s)`,
      retryable: false,
      phase: "model",
    });
  }

  throw new AgentError({
    code: "MODEL_BAD_RESPONSE",
    message: `Model ended with finishReason ${finishReason}; ${toolCallCount} tool call(s) were not executed`,
    retryable: false,
    phase: "model",
  });
}

/** Recover only a provider context rejection carrying a concrete reported input size. */
export function reportedContextOverflow(error: unknown): { inputTokens: number } | undefined {
  const api = findApiCallError(error);
  if (!api || api.statusCode !== 400 && api.statusCode !== 413) return undefined;
  let body: Record<string, unknown> = {};
  try { const raw = JSON.parse(api.responseBody ?? "{}"); body = raw.error ?? raw; } catch { /* provider text is inspected only at this boundary */ }
  const message = typeof body.message === "string" ? body.message : api.message;
  const code = typeof body.code === "string" ? body.code : "";
  if (!/context_length_exceeded|context_window_exceeded|prompt_too_long/.test(code) && !/context.{0,30}(?:exceed|maximum|long)|(?:input|prompt).{0,30}too long/i.test(message)) return undefined;
  const value = body.input_tokens ?? body.prompt_tokens ?? body.requested_tokens ?? /(?:requested|input|prompt)[^\d]{0,30}([\d,]+)/i.exec(message)?.[1]?.replaceAll(",", "");
  const inputTokens = Number(value);
  return Number.isSafeInteger(inputTokens) && inputTokens > 0 ? { inputTokens } : undefined;
}
