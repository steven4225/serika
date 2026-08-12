export type AgentErrorCode =
  | "AGENT_NOT_FOUND"
  | "INVALID_REQUEST"
  | "MODEL_AUTH"
  | "MODEL_RATE_LIMIT"
  | "MODEL_TIMEOUT"
  | "MODEL_BAD_RESPONSE"
  | "TOOL_NOT_FOUND"
  | "TOOL_INVALID_INPUT"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_DENIED"
  | "RUN_CONFLICT"
  | "RUN_CANCELLED"
  | "RUN_TIMEOUT"
  | "INTERNAL";

export type AgentErrorPhase =
  | "runtime"
  | "model"
  | "tool"
  | "storage"
  | "approval";

export interface AgentErrorData {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  phase: AgentErrorPhase;
}

export class AgentError extends Error {
  readonly data: AgentErrorData;
  override readonly cause?: unknown;

  constructor(data: AgentErrorData, options?: { cause?: unknown }) {
    super(data.message);
    this.name = "AgentError";
    this.data = data;
    this.cause = options?.cause;
  }
}

export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;

  if (error instanceof DOMException && error.name === "AbortError") {
    return new AgentError({
      code: "RUN_CANCELLED",
      message: "Agent run was cancelled",
      retryable: false,
      phase: "runtime",
    }, { cause: error });
  }

  return new AgentError({
    code: "INTERNAL",
    message: error instanceof Error ? error.message : "Unknown agent runtime error",
    retryable: false,
    phase: "runtime",
  }, { cause: error });
}
