import {
  APICallError,
  convertToModelMessages,
  stepCountIs,
  streamText,
  type DynamicToolUIPart,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import {
  AgentError,
  type AgentErrorData,
  type AgentLoop,
  type AgentLoopInput,
  type TokenUsage,
} from "@aisdk-agent/core";
import type { ModelRegistry } from "./registries.js";
import { ToolRegistry } from "./registries.js";

export interface AiSdkAgentLoopOptions {
  models: ModelRegistry;
  tools: ToolRegistry;
  /** Delays between model attempts; an empty/omitted value disables retries. */
  modelRetryDelaysMs?: readonly number[];
}

interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  invalid: boolean;
}

function normalizeUsage(usage: LanguageModelUsage): TokenUsage {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined || outputTokens !== undefined
      ? { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }
      : {}),
  };
}

function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  const add = (left?: number, right?: number) =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);
  const inputTokens = add(total.inputTokens, next.inputTokens);
  const outputTokens = add(total.outputTokens, next.outputTokens);
  const totalTokens = add(total.totalTokens, next.totalTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function validateStepOutcome(finishReason: string, toolCallCount: number): void {
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

function toolError(
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

function toolPrecheckError(
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

function toolOutcomeUnknown(
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

function validateToolExecutionDecision(
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

function toolResultError(
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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Agent operation aborted", "AbortError");
}

async function awaitWithSignal<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    // once removes the listener when abort wins; the settle handlers remove it
    // when the operation wins.
    signal.addEventListener("abort", onAbort, { once: true });
    let result: PromiseLike<T> | T;
    try {
      if (signal.aborted) {
        onAbort();
        return;
      }
      result = operation();
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

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

function modelFailureError(
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

function isStartedModelOutput(type: string): boolean {
  return (
    type === "text-delta" ||
    type === "reasoning-delta" ||
    type === "tool-call" ||
    type === "tool-input-start" ||
    type === "tool-input-delta" ||
    type === "tool-input-end"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}

export class AiSdkAgentLoop implements AgentLoop {
  readonly #models: ModelRegistry;
  readonly #tools: ToolRegistry;
  readonly #modelRetryDelaysMs: readonly number[];

  constructor(options: AiSdkAgentLoopOptions) {
    this.#models = options.models;
    this.#tools = options.tools;
    this.#modelRetryDelaysMs = options.modelRetryDelaysMs
      ? [...options.modelRetryDelaysMs]
      : [];
  }

  async execute<TContext>(input: AgentLoopInput<TContext>) {
    const executableTools = this.#tools.resolve(input.definition.tools);
    const modelTools = this.#tools.definitions(input.definition.tools);
    const model = this.#models.resolve(input.definition.model);
    const messages = structuredClone(input.messages);
    let steps = 0;
    let totalUsage: TokenUsage = {};

    while (steps < input.definition.limits.maxSteps) {
      steps += 1;
      await input.emit("step.started", { stepNumber: steps });
      throwIfAborted(input.signal);

      let modelInput = messages;
      if (input.prepareModelContext) {
        const hookMessages = structuredClone(messages);
        let prepared: unknown;
        try {
          prepared = await awaitWithSignal(
            () =>
              input.prepareModelContext!({
                messages: hookMessages,
                definition: input.definition,
                ...(input.context !== undefined
                  ? { context: input.context }
                  : {}),
                signal: input.signal,
              }),
            input.signal,
          );
        } catch (error) {
          if (input.signal.aborted) throw abortReason(input.signal);
          if (
            error instanceof AgentError &&
            error.data.code === "CONTEXT_PREPARE_FAILED"
          ) {
            throw error;
          }
          throw new AgentError(
            {
              code: "CONTEXT_PREPARE_FAILED",
              message: "Failed to prepare model context",
              retryable: false,
              phase: "runtime",
            },
            { cause: error },
          );
        }
        if (!Array.isArray(prepared)) {
          throw new AgentError({
            code: "CONTEXT_PREPARE_FAILED",
            message: "Model context preparation must return UIMessage[]",
            retryable: false,
            phase: "runtime",
          });
        }
        modelInput = prepared as UIMessage[];
      }

      const modelMessages = await convertToModelMessages(modelInput, {
        tools: modelTools,
      });
      throwIfAborted(input.signal);
      let pendingCalls: PendingToolCall[] = [];
      let stepText = "";
      let stepUsage!: TokenUsage;
      let finishReason!: string;

      for (let attempt = 0; ; attempt += 1) {
        throwIfAborted(input.signal);
        const stepTimeout = AbortSignal.timeout(
          input.definition.limits.stepTimeoutMs,
        );
        const stepSignal = AbortSignal.any([input.signal, stepTimeout]);
        const attemptCalls: PendingToolCall[] = [];
        let attemptText = "";
        let attemptHasOutput = false;

        try {
          const result = streamText({
            model,
            instructions: input.definition.instructions,
            messages: modelMessages,
            tools: modelTools,
            stopWhen: stepCountIs(1),
            maxRetries: 0,
            abortSignal: stepSignal,
            ...(input.definition.limits.maxOutputTokens !== undefined
              ? { maxOutputTokens: input.definition.limits.maxOutputTokens }
              : {}),
            telemetry: { isEnabled: false },
          });

          for await (const part of result.stream) {
            if (part.type === "text-delta") {
              attemptHasOutput = true;
              attemptText += part.text;
              await input.emit("message.delta", { text: part.text });
            } else if (part.type === "tool-call") {
              attemptHasOutput = true;
              const call: PendingToolCall = {
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                invalid: part.invalid === true,
              };
              attemptCalls.push(call);
              await input.emit("tool.call.requested", {
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: call.input,
              });
            } else if (part.type === "abort") {
              throw new DOMException(
                part.reason ?? "Model stream aborted",
                "AbortError",
              );
            } else if (part.type === "error") {
              throw part.error;
            } else if (isStartedModelOutput(part.type)) {
              attemptHasOutput = true;
            }
            throwIfAborted(input.signal);
          }

          stepUsage = normalizeUsage(
            (await awaitWithSignal(
              () => result.usage,
              stepSignal,
            )) as LanguageModelUsage,
          );
          finishReason = await awaitWithSignal(
            () => result.finishReason,
            stepSignal,
          );
          pendingCalls = attemptCalls;
          stepText = attemptText;
          break;
        } catch (error) {
          if (input.signal.aborted) throw abortReason(input.signal);
          const failure = modelFailureError(
            error,
            stepTimeout,
            input.definition.limits.stepTimeoutMs,
          );
          const canRetry =
            !attemptHasOutput &&
            failure.data.retryable &&
            attempt < this.#modelRetryDelaysMs.length;
          if (!canRetry) throw failure;

          const delayMs = this.#modelRetryDelaysMs[attempt]!;
          await input.emit("model.retry.scheduled", {
            stepNumber: steps,
            nextAttempt: attempt + 2,
            maxAttempts: this.#modelRetryDelaysMs.length + 1,
            delayMs,
            error: failure.data,
          });
          await sleepWithSignal(delayMs, input.signal);
        }
      }

      totalUsage = addUsage(totalUsage, stepUsage);
      await input.emit("step.completed", {
        stepNumber: steps,
        finishReason,
        usage: stepUsage,
      });
      await input.emit("usage.updated", { usage: totalUsage });
      throwIfAborted(input.signal);
      validateStepOutcome(finishReason, pendingCalls.length);

      const assistantParts: UIMessage["parts"] = [];
      if (stepText.length > 0) {
        assistantParts.push({ type: "text", text: stepText });
      }

      for (const call of pendingCalls) {
        throwIfAborted(input.signal);
        const registered = executableTools[call.toolName];
        if (!registered) {
          throw new AgentError({
            code: "TOOL_NOT_FOUND",
            message: `Tool is not registered: ${call.toolName}`,
            retryable: false,
            phase: "tool",
          });
        }

        if (call.invalid) {
          const error = toolError("TOOL_INVALID_INPUT", call.toolName);
          assistantParts.push(toolResultError(call, error.data));
          await input.emit("tool.call.failed", {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            error: error.data,
          });
          continue;
        }

        if (input.beforeToolExecute) {
          // The hook may inspect the call input, but it must not mutate the
          // transcript's original value that will be passed to execute.
          const hookInput = structuredClone(call.input);
          let decision: unknown;
          try {
            decision = await awaitWithSignal(
              () =>
                input.beforeToolExecute!({
                  toolName: call.toolName,
                  toolCallId: call.toolCallId,
                  input: hookInput,
                  definition: input.definition,
                  ...(input.context !== undefined
                    ? { context: input.context }
                    : {}),
                  signal: input.signal,
                }),
              input.signal,
            );
          } catch (error) {
            if (input.signal.aborted) throw abortReason(input.signal);
            if (
              error instanceof AgentError &&
              error.data.code === "TOOL_PRECHECK_FAILED"
            ) {
              throw error;
            }
            throw toolPrecheckError(
              call.toolName,
              "beforeToolExecute failed",
              error,
            );
          }

          const validatedDecision = validateToolExecutionDecision(
            decision,
            call.toolName,
          );
          throwIfAborted(input.signal);
          if (!validatedDecision.allow) {
            const error = toolError(
              "TOOL_DENIED",
              call.toolName,
              validatedDecision.reason,
            );
            assistantParts.push(toolResultError(call, error.data));
            await input.emit("tool.call.failed", {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              error: error.data,
            });
            continue;
          }
        }

        await input.emit("tool.call.started", {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
        });
        throwIfAborted(input.signal);

        const metadata = this.#tools.metadata(call.toolName);
        const timeoutMs =
          metadata?.timeoutMs ?? input.definition.limits.stepTimeoutMs;
        const toolTimeout = AbortSignal.timeout(
          timeoutMs,
        );
        const toolSignal = AbortSignal.any([input.signal, toolTimeout]);

        try {
          if (!registered.execute) {
            throw new Error("Registered tool has no execute function");
          }
          const output = await awaitWithSignal(
            () =>
              registered.execute!(call.input, {
                toolCallId: call.toolCallId,
                messages: modelMessages,
                abortSignal: toolSignal,
                context: input.context ?? {},
              }),
            toolSignal,
          );
          if (isAsyncIterable(output)) {
            throw new Error("Streaming tool output is not supported in M-Local");
          }
          assistantParts.push({
            type: "dynamic-tool",
            toolName: call.toolName,
            toolCallId: call.toolCallId,
            state: "output-available",
            input: call.input,
            output,
          });
          await input.emit("tool.call.completed", {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output,
          });
        } catch (error) {
          if (input.signal.aborted) throw abortReason(input.signal);
          const toolFailed = toolTimeout.aborted;
          if (!metadata?.idempotent) {
            const unknown = toolOutcomeUnknown(
              call.toolName,
              toolFailed
                ? `execution timed out after ${timeoutMs}ms`
                : "execution failed before a result was confirmed",
              error,
            );
            await input.emit("tool.call.failed", {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              error: unknown.data,
            });
            throw unknown;
          }
          const errorData = toolError(
            "TOOL_EXECUTION_FAILED",
            call.toolName,
            toolFailed
              ? `Tool execution timed out after ${timeoutMs}ms: ${call.toolName}`
              : `Tool execution failed: ${call.toolName}`,
            error,
          ).data;
          assistantParts.push(toolResultError(call, errorData));
          await input.emit("tool.call.failed", {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            error: errorData,
          });
        }
      }

      throwIfAborted(input.signal);

      messages.push({
        id: input.generateId(),
        role: "assistant",
        parts: assistantParts,
      });

      if (pendingCalls.length === 0) {
        return {
          text: stepText,
          messages,
          steps,
          usage: totalUsage,
          stopReason: "completed" as const,
        };
      }
    }

    throw new AgentError({
      code: "RUN_LIMIT_EXCEEDED",
      message: `Run exceeded ${input.definition.limits.maxSteps} model steps`,
      retryable: false,
      phase: "runtime",
    });
  }
}
