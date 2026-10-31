import { reportedContextOverflow } from "./model-errors.js";
import { asSchema, convertToModelMessages, stepCountIs, streamText, type LanguageModelUsage, type UIMessage } from "ai";
import { AgentError, type AfterToolCallInput, type AgentLoop, type AgentLoopInput, type LoopOutcome, type TokenUsage } from "@serika/core";
import { abortReason, awaitWithSignal, invocationDeadline, modelStreamWithSignal, sleepWithSignal, throwIfAborted } from "./abort.js";
import { isStartedModelOutput, modelFailureError, validateStepOutcome } from "./model-errors.js";
import type { ModelRegistry, ToolRegistry } from "./registries.js";
import { normalizeTokenUsage, sumTokenUsage } from "./token-usage.js";
import {
  invalidInputHint, toolError, toolOutcomeUnknown, toolPrecheckError, toolResultError, validateToolExecutionDecision,
  type PendingToolCall,
} from "./tool-errors.js";

export interface AiSdkAgentLoopOptions {
  models: ModelRegistry;
  tools: ToolRegistry;
  /** Delays between model attempts; an empty/omitted value disables retries. */
  modelRetryDelaysMs?: readonly number[];
  /** Host-owned one-shot workflows may opt out without changing other Agents' policy. */
  modelRetryDisabledAgentIds?: readonly string[];
}

const completionStopReasons = ["delivered", "needs_confirmation", "needs_information", "budget_exhausted", "needs_review"];

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function contextPrepareFailed(message: string, cause?: unknown): AgentError {
  return new AgentError({ code: "CONTEXT_PREPARE_FAILED", message, retryable: false, phase: "runtime" }, { cause });
}

/**
 * Minimal model → tools → model loop. Application policy (approval, context
 * assembly, finish checks, repetition guards) arrives through the hooks on
 * AgentLoopInput; this class owns only ordering, cancellation and the
 * tool side-effect invariants (unknown outcomes stop the Run, nothing replays).
 */
export class AiSdkAgentLoop implements AgentLoop {
  readonly #models: ModelRegistry;
  readonly #tools: ToolRegistry;
  readonly #modelRetryDelaysMs: readonly number[];
  readonly #modelRetryDisabledAgentIds: ReadonlySet<string>;

  constructor(options: AiSdkAgentLoopOptions) {
    this.#models = options.models;
    this.#tools = options.tools;
    this.#modelRetryDisabledAgentIds = new Set(options.modelRetryDisabledAgentIds ?? []);
    this.#modelRetryDelaysMs = options.modelRetryDelaysMs ? [...options.modelRetryDelaysMs] : [];
  }

  async execute<TContext>(input: AgentLoopInput<TContext>): Promise<LoopOutcome> {
    const { definition, signal } = input;
    const model = this.#models.resolve(definition.model);
    const messages = structuredClone(input.messages);
    const runStart = messages.length;
    const contextField = input.context !== undefined ? { context: input.context } : {};
    let steps = 0;
    let totalUsage: TokenUsage = {};
    let corrections = 0;
    // Host feedback from the latest completed tool call; it reaches only the next model request.
    let toolFeedback: string | undefined;

    while (steps < definition.limits.maxSteps) {
      if (input.steering?.hasPending()) {
        const requests = await input.steering.drain();
        throwIfAborted(signal);
        if (requests.length > 0) toolFeedback = undefined;
        for (const request of requests) {
          const messageId = input.generateId();
          messages.push({ id: messageId, role: "user", metadata: { source: "steer", memoryConsolidation: "exclude" },
            parts: [{ type: "text", text: request.text }] });
          await input.steering.applied(request, messageId);
        }
      }
      steps += 1;
      await input.emit("step.started", { stepNumber: steps });
      throwIfAborted(signal);

      const modelInput = await this.#prepareContext(input, messages);
      const toolNames = definition.tools;
      const executableTools = this.#tools.resolve(toolNames);
      const modelTools = this.#tools.definitions(toolNames);
      let modelMessages = await convertToModelMessages(modelInput, { tools: modelTools });
      // Internal feedback belongs only to this model request, never the
      // assistant transcript, emitted chat text or persisted user-fact sources.
      const instructions = toolFeedback === undefined ? definition.instructions : `${definition.instructions}\n\n${toolFeedback}`;
      toolFeedback = undefined;
      throwIfAborted(signal);
      let pendingCalls: PendingToolCall[] = [];
      let stepText = "";
      let stepUsage!: TokenUsage;
      let finishReason!: string;

      let contextRetried = false;
      for (let attempt = 0; ; attempt += 1) {
        throwIfAborted(signal);
        const deadline = invocationDeadline(definition.limits.stepTimeoutMs);
        const stepSignal = AbortSignal.any([signal, deadline.signal]);
        const attemptCalls: PendingToolCall[] = [];
        let attemptText = "";
        let attemptHasOutput = false;
        try {
          const result = streamText({
            model, instructions, messages: modelMessages, tools: modelTools, stopWhen: stepCountIs(1), maxRetries: 0,
            abortSignal: stepSignal, telemetry: { isEnabled: false },
            ...(definition.limits.maxOutputTokens !== undefined ? { maxOutputTokens: definition.limits.maxOutputTokens } : {}),
          });
          for await (const part of modelStreamWithSignal(result.stream, stepSignal)) {
            if (part.type === "text-delta") {
              attemptHasOutput = true;
              attemptText += part.text;
              await input.emit("message.delta", { text: part.text });
            } else if (part.type === "tool-call") {
              attemptHasOutput = true;
              const call: PendingToolCall = { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input,
                invalid: part.invalid === true, ...(part.invalid === true ? { validationError: part.error } : {}) };
              attemptCalls.push(call);
              await input.emit("tool.call.requested", { toolCallId: call.toolCallId, toolName: call.toolName, input: call.input });
            } else if (part.type === "abort") {
              throw new DOMException(part.reason ?? "Model stream aborted", "AbortError");
            } else if (part.type === "error") {
              throw part.error;
            } else if (isStartedModelOutput(part.type)) {
              attemptHasOutput = true;
            }
            throwIfAborted(signal);
          }
          stepUsage = normalizeTokenUsage((await awaitWithSignal(() => result.usage, stepSignal)) as LanguageModelUsage);
          finishReason = await awaitWithSignal(() => result.finishReason, stepSignal);
          pendingCalls = attemptCalls;
          stepText = attemptText;
          break;
        } catch (error) {
          if (signal.aborted) throw abortReason(signal);
          const overflow = !attemptHasOutput && !contextRetried && input.prepareModelContext ? reportedContextOverflow(error) : undefined;
          if (overflow) {
            contextRetried = true;
            const smaller = await this.#prepareContext(input, messages, overflow);
            modelMessages = await convertToModelMessages(smaller, { tools: modelTools });
            continue;
          }
          const failure = modelFailureError(error, deadline.signal, definition.limits.stepTimeoutMs);
          const canRetry = !this.#modelRetryDisabledAgentIds.has(definition.id) && !attemptHasOutput &&
            failure.data.retryable && attempt < this.#modelRetryDelaysMs.length;
          if (!canRetry) throw failure;
          const delayMs = this.#modelRetryDelaysMs[attempt]!;
          await input.emit("model.retry.scheduled", { stepNumber: steps, nextAttempt: attempt + 2,
            maxAttempts: this.#modelRetryDelaysMs.length + 1, delayMs, error: failure.data });
          await sleepWithSignal(delayMs, signal);
        } finally {
          deadline.dispose();
        }
      }

      totalUsage = sumTokenUsage(steps === 1 ? undefined : totalUsage, stepUsage);
      await input.emit("step.completed", { stepNumber: steps, finishReason, usage: stepUsage });
      await input.emit("usage.updated", { usage: totalUsage });
      throwIfAborted(signal);
      validateStepOutcome(finishReason, pendingCalls.length);

      const assistantParts: UIMessage["parts"] = [];
      if (stepText.length > 0) assistantParts.push({ type: "text", text: stepText });

      let supersededBatch = false;
      const superseded = async (call: PendingToolCall): Promise<boolean> => {
        if (!supersededBatch && !input.steering?.hasPending()) return false;
        supersededBatch = true;
        assistantParts.push({ type: "dynamic-tool", toolName: call.toolName, toolCallId: call.toolCallId,
          state: "output-error", input: call.input,
          errorText: "STEER_SUPERSEDED: This proposed call was not dispatched because the user changed direction. Replan; no effect occurred." });
        await input.emit("tool.call.superseded", { toolCallId: call.toolCallId, toolName: call.toolName, reason: "steer" });
        return true;
      };
      const failCall = async (call: PendingToolCall, error: AgentError) => {
        assistantParts.push(toolResultError(call, error.data));
        await input.emit("tool.call.failed", { toolCallId: call.toolCallId, toolName: call.toolName, error: error.data });
      };

      for (const call of pendingCalls) {
        throwIfAborted(signal);
        // Feedback describes the latest call; any later call (even a denied one) replaces it.
        toolFeedback = undefined;
        if (await superseded(call)) continue;
        const registered = executableTools[call.toolName];
        if (!registered) {
          throw new AgentError({ code: "TOOL_NOT_FOUND", message: `Tool is not registered: ${call.toolName}`, retryable: false, phase: "tool" });
        }

        if (call.invalid) {
          const schema = await asSchema(registered.inputSchema).jsonSchema;
          const hint = invalidInputHint(call, Object.keys(schema.properties ?? {}));
          await failCall(call, toolError("TOOL_INVALID_INPUT", call.toolName, `Tool input is invalid: ${call.toolName}. ${hint} No tool was executed.`));
          continue;
        }

        if (input.beforeToolExecute) {
          // The hook may inspect the call input, but must not mutate the
          // transcript's original value that will be passed to execute.
          const hookInput = structuredClone(call.input);
          const steerSignal = input.steering?.signal;
          let decision: unknown;
          try {
            decision = await awaitWithSignal(() => input.beforeToolExecute!({
              toolName: call.toolName, toolCallId: call.toolCallId, input: hookInput, definition, ...contextField, signal,
              ...(steerSignal ? { steerSignal } : {}),
            }), steerSignal ? AbortSignal.any([signal, steerSignal]) : signal);
          } catch (error) {
            if (signal.aborted) throw abortReason(signal);
            if (await superseded(call)) continue;
            if (error instanceof AgentError && error.data.code === "TOOL_PRECHECK_FAILED") throw error;
            throw toolPrecheckError(call.toolName, "beforeToolExecute failed", error);
          }
          if (await superseded(call)) continue;
          const validated = validateToolExecutionDecision(decision, call.toolName);
          throwIfAborted(signal);
          if (!validated.allow) {
            await failCall(call, toolError("TOOL_DENIED", call.toolName, validated.reason));
            continue;
          }
        }

        await input.emit("tool.call.started", { toolCallId: call.toolCallId, toolName: call.toolName });
        throwIfAborted(signal);
        // The persisted start barrier is not the external dispatch boundary.
        // A steer accepted while append() awaited still proves zero invocation.
        if (await superseded(call)) continue;

        const metadata = this.#tools.metadata(call.toolName);
        const timeoutMs = metadata?.timeoutMs ?? definition.limits.stepTimeoutMs;
        const deadline = invocationDeadline(timeoutMs);
        const toolSignal = AbortSignal.any([signal, deadline.signal]);
        let completed: { output: unknown } | undefined;
        try {
          if (!registered.execute) throw new Error("Registered tool has no execute function");
          const output = await awaitWithSignal(() => registered.execute!(call.input, {
            toolCallId: call.toolCallId, messages: modelMessages, abortSignal: toolSignal, context: input.context ?? {},
          }), toolSignal);
          if (isAsyncIterable(output)) throw new Error("Streaming tool output is not supported");
          assistantParts.push({ type: "dynamic-tool", toolName: call.toolName, toolCallId: call.toolCallId,
            state: "output-available", input: call.input, output });
          await input.emit("tool.call.completed", { toolCallId: call.toolCallId, toolName: call.toolName, output });
          completed = { output };
        } catch (error) {
          if (signal.aborted) throw abortReason(signal);
          if (error instanceof AgentError && error.data.code === "CONTEXT_PREPARE_FAILED") throw error;
          const timedOut = deadline.signal.aborted;
          if (!metadata?.idempotent) {
            // Never disguise an unconfirmed side effect as an ordinary failure.
            const unknown = toolOutcomeUnknown(call.toolName,
              timedOut ? `execution timed out after ${timeoutMs}ms` : "execution failed before a result was confirmed", error);
            await failCall(call, unknown);
            messages.push({ id: input.generateId(), role: "assistant", parts: assistantParts });
            return { text: stepText, messages, steps, usage: totalUsage, stopReason: "failed" as const, error: unknown.data };
          }
          await failCall(call, toolError("TOOL_EXECUTION_FAILED", call.toolName,
            timedOut ? `Tool execution timed out after ${timeoutMs}ms: ${call.toolName}` : `Tool execution failed: ${call.toolName}`, error));
        } finally {
          deadline.dispose();
        }
        throwIfAborted(signal);
        if (completed && input.afterToolCall) {
          const pending: UIMessage = { id: "pending-assistant", role: "assistant", parts: assistantParts };
          const { output } = completed;
          const decision = await this.#afterToolCall(input, () => ({
            toolName: call.toolName, toolCallId: call.toolCallId, input: structuredClone(call.input),
            output: structuredClone(output), runMessages: structuredClone([...messages.slice(runStart), pending]),
            definition, ...contextField, signal,
          }));
          // The completed call and its events stay truthful; stopping here cannot turn it into a failed effect.
          if (decision?.kind === "stop") throw new AgentError({ code: "RUN_LIMIT_EXCEEDED", message: decision.message, retryable: false, phase: "runtime" });
          if (decision?.kind === "feedback") toolFeedback = decision.text;
        }
      }

      throwIfAborted(signal);
      messages.push({ id: input.generateId(), role: "assistant", parts: assistantParts });
      if (pendingCalls.length > 0) continue;

      if (input.steering?.hasPending() && steps < definition.limits.maxSteps) continue;
      const decision = input.beforeRunFinish ? await awaitWithSignal(() => input.beforeRunFinish!({
        messages: structuredClone(messages), definition, context: input.context,
        signal, text: stepText, steps, remainingSteps: definition.limits.maxSteps - steps, corrections,
      }), signal) : undefined;
      throwIfAborted(signal);
      // A finish check may await disk/evidence reads. Admission stays open until
      // the synchronous seal below; never drop a steer accepted during that wait.
      if (input.steering?.hasPending() && steps < definition.limits.maxSteps) continue;
      if (decision !== undefined && (!decision || decision.kind !== "continue" && decision.kind !== "stop" ||
        decision.kind === "stop" && !completionStopReasons.includes(decision.reason))) {
        throw new AgentError({ code: "INTERNAL", message: "Completion decision is invalid", retryable: false, phase: "runtime" });
      }
      if (decision?.kind === "continue" && steps < definition.limits.maxSteps) {
        if (typeof decision.feedback !== "string" || !decision.feedback.trim() || decision.feedback.length > 8192) {
          throw new AgentError({ code: "INTERNAL", message: "Completion feedback is invalid", retryable: false, phase: "runtime" });
        }
        corrections += 1;
        await input.emit("run.completion.checked", { decision: "continue", corrections });
        messages.push({ id: input.generateId(), role: "assistant", metadata: { source: "completion-check" },
          parts: [{ type: "text", text: `Program completion check (not user facts or tool permission):\n${decision.feedback}` }] });
        continue;
      }
      if (input.steering && !input.steering.sealIfEmpty()) {
        if (steps < definition.limits.maxSteps) continue;
        await input.steering.close("budget_exhausted");
      }
      const reason = decision?.kind === "stop" ? decision.reason : "budget_exhausted" as const;
      if (decision !== undefined) await input.emit("run.completion.checked", { decision: "stop", reason, corrections });
      return {
        text: stepText, messages, steps, usage: totalUsage, stopReason: "completed" as const,
        ...(decision === undefined ? {} : { completion: { reason, corrections } }),
      };
    }

    await input.steering?.close("budget_exhausted");
    throw new AgentError({ code: "RUN_LIMIT_EXCEEDED", message: `Run exceeded ${definition.limits.maxSteps} model steps`, retryable: false, phase: "runtime" });
  }

  async #prepareContext<TContext>(input: AgentLoopInput<TContext>, messages: UIMessage[], contextOverflow?: { inputTokens: number }): Promise<UIMessage[]> {
    if (!input.prepareModelContext) return messages;
    const hookMessages = structuredClone(messages);
    let prepared: unknown;
    try {
      prepared = await awaitWithSignal(() => input.prepareModelContext!({
        messages: hookMessages, definition: input.definition, ...(contextOverflow ? { contextOverflow } : {}),
        ...(input.context !== undefined ? { context: input.context } : {}), signal: input.signal,
      }), input.signal);
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      if (error instanceof AgentError && error.data.code === "CONTEXT_PREPARE_FAILED") throw error;
      throw contextPrepareFailed("Failed to prepare model context", error);
    }
    if (!Array.isArray(prepared)) throw contextPrepareFailed("Model context preparation must return UIMessage[]");
    return prepared as UIMessage[];
  }

  async #afterToolCall<TContext>(input: AgentLoopInput<TContext>, build: () => AfterToolCallInput) {
    let hookInput: AfterToolCallInput;
    // Outputs that cannot be copied keep the plain path rather than becoming a new failure.
    try { hookInput = build(); } catch { return undefined; }
    let decision: unknown;
    try {
      decision = await awaitWithSignal(() => input.afterToolCall!(hookInput), input.signal);
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      throw new AgentError({ code: "INTERNAL", message: "afterToolCall hook failed", retryable: false, phase: "runtime" }, { cause: error });
    }
    throwIfAborted(input.signal);
    if (decision === undefined) return undefined;
    const value = decision as { kind?: unknown; text?: unknown; message?: unknown };
    if (value?.kind === "feedback" && typeof value.text === "string" && value.text.trim()) return { kind: "feedback" as const, text: value.text };
    if (value?.kind === "stop" && typeof value.message === "string" && value.message.trim()) return { kind: "stop" as const, message: value.message };
    throw new AgentError({ code: "INTERNAL", message: "afterToolCall decision is invalid", retryable: false, phase: "runtime" });
  }
}
