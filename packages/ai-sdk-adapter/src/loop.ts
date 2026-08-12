import {
  convertToModelMessages,
  stepCountIs,
  ToolLoopAgent,
  type LanguageModelUsage,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import {
  AgentError,
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

function toolError(toolName: string, error: unknown): AgentError {
  return new AgentError(
    {
      code: "TOOL_EXECUTION_FAILED",
      message: `Tool execution failed: ${toolName}`,
      retryable: false,
      phase: "tool",
    },
    { cause: error },
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
    const tools = this.#tools.resolve(input.definition.tools);
    const model = this.#models.resolve(input.definition.model);
    let stepNumber = 0;
    let text = "";
    let finalUsage: TokenUsage = {};
    let approvalRequired = false;

    const agent = new ToolLoopAgent({
      id: `${input.definition.id}@${input.definition.version}`,
      model,
      instructions: input.definition.instructions,
      tools,
      stopWhen: stepCountIs(input.definition.limits.maxSteps),
      ...(input.definition.limits.maxOutputTokens !== undefined
        ? { maxOutputTokens: input.definition.limits.maxOutputTokens }
        : {}),
      maxRetries: 2,
      telemetry: { isEnabled: false },
    });

    const messages = await convertToModelMessages(input.messages, { tools });
    const result = await agent.stream({
      messages,
      abortSignal: input.signal,
      timeout: {
        totalMs: input.definition.limits.totalTimeoutMs,
        stepMs: input.definition.limits.stepTimeoutMs,
      },
    });

    for await (const part of result.stream) {
      await this.#handlePart(part, {
        input,
        getStepNumber: () => stepNumber,
        incrementStep: () => {
          stepNumber += 1;
          return stepNumber;
        },
        appendText: (delta) => {
          text += delta;
        },
        setUsage: (usage) => {
          finalUsage = usage;
        },
        markApprovalRequired: () => {
          approvalRequired = true;
        },
      });
    }

    return {
      text,
      steps: stepNumber,
      usage: finalUsage,
      stopReason: approvalRequired
        ? ("approval_required" as const)
        : ("completed" as const),
    };
  }

  async #handlePart<TContext>(
    part: TextStreamPart<ToolSet>,
    state: {
      input: AgentLoopInput<TContext>;
      getStepNumber: () => number;
      incrementStep: () => number;
      appendText: (delta: string) => void;
      setUsage: (usage: TokenUsage) => void;
      markApprovalRequired: () => void;
    },
  ): Promise<void> {
    const { emit } = state.input;
    switch (part.type) {
      case "text-delta":
        state.appendText(part.text);
        await emit("message.delta", { text: part.text });
        break;
      case "start-step": {
        const current = state.incrementStep();
        await emit("step.started", { stepNumber: current });
        break;
      }
      case "finish-step": {
        const usage = normalizeUsage(part.usage);
        await emit("step.completed", {
          stepNumber: state.getStepNumber(),
          finishReason: part.finishReason,
          usage,
        });
        break;
      }
      case "tool-call":
        await emit("tool.call.requested", {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        // M1 only executes tools that do not require approval. M2 will move this
        // transition behind the approval policy/resume boundary.
        await emit("tool.call.started", {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
        });
        break;
      case "tool-approval-request":
        state.markApprovalRequired();
        await emit("tool.call.approval_required", {
          approvalId: part.approvalId,
          toolCallId: part.toolCall.toolCallId,
          toolName: part.toolCall.toolName,
          input: part.toolCall.input,
        });
        break;
      case "tool-result":
        await emit("tool.call.completed", {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
        });
        break;
      case "tool-error": {
        const error = toolError(part.toolName, part.error);
        await emit("tool.call.failed", {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          error: error.data,
        });
        break;
      }
      case "finish": {
        const usage = normalizeUsage(part.totalUsage);
        state.setUsage(usage);
        await emit("usage.updated", { usage });
        break;
      }
      case "abort":
        throw new DOMException(part.reason ?? "Agent stream aborted", "AbortError");
      case "error":
        throw new AgentError(
          {
            code: "MODEL_BAD_RESPONSE",
            message: "Model stream returned an error",
            retryable: false,
            phase: "model",
          },
          { cause: part.error },
        );
    }
  }
}
