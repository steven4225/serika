import {
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
  code: "TOOL_INVALID_INPUT" | "TOOL_EXECUTION_FAILED",
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
          : `Tool execution failed: ${toolName}`),
      retryable: false,
      phase: "tool",
    },
    { cause },
  );
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
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

  constructor(options: AiSdkAgentLoopOptions) {
    this.#models = options.models;
    this.#tools = options.tools;
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
      const stepTimeout = AbortSignal.timeout(
        input.definition.limits.stepTimeoutMs,
      );
      const stepSignal = AbortSignal.any([input.signal, stepTimeout]);
      const pendingCalls: PendingToolCall[] = [];
      let stepText = "";
      let result!: ReturnType<typeof streamText>;
      let stepUsage: TokenUsage;
      let finishReason: string;

      try {
        throwIfAborted(input.signal);
        result = streamText({
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
            stepText += part.text;
            await input.emit("message.delta", { text: part.text });
          } else if (part.type === "tool-call") {
            const call: PendingToolCall = {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              invalid: part.invalid === true,
            };
            pendingCalls.push(call);
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
          }
          throwIfAborted(input.signal);
        }

        stepUsage = normalizeUsage(
          (await awaitWithSignal(() => result.usage, stepSignal)) as LanguageModelUsage,
        );
        finishReason = await awaitWithSignal(
          () => result.finishReason,
          stepSignal,
        );
      } catch (error) {
        if (input.signal.aborted) throw abortReason(input.signal);
        if (stepTimeout.aborted) {
          throw new AgentError(
            {
              code: "MODEL_TIMEOUT",
              message: `Model step exceeded ${input.definition.limits.stepTimeoutMs}ms`,
              retryable: true,
              phase: "model",
            },
            { cause: error },
          );
        }
        throw new AgentError(
          {
            code: "MODEL_BAD_RESPONSE",
            message: "Model stream returned an error",
            retryable: false,
            phase: "model",
          },
          { cause: error },
        );
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
