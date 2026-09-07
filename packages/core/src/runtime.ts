import { randomUUID } from "node:crypto";
import { AsyncChannel } from "./async-channel.js";
import type { AgentCatalog } from "./catalog.js";
import { AgentError, toAgentError } from "./errors.js";
import type {
  AgentEvent,
  AgentEventDataMap,
  AgentEventType,
} from "./events.js";
import type { AgentStore, RunRecord } from "./store.js";
import type {
  AgentLoop,
  RunHandle,
  RunRequest,
  RunResult,
  PrepareModelContext,
  BeforeToolExecute,
} from "./types.js";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Agent operation aborted", "AbortError");
}

export interface AgentRuntimeOptions {
  catalog: AgentCatalog;
  loop: AgentLoop;
  store: AgentStore;
  idGenerator?: () => string;
  now?: () => Date;
  prepareModelContext?: PrepareModelContext;
  beforeToolExecute?: BeforeToolExecute;
}

export class DefaultAgentRuntime {
  readonly #catalog: AgentCatalog;
  readonly #loop: AgentLoop;
  readonly #store: AgentStore;
  readonly #idGenerator: () => string;
  readonly #now: () => Date;
  readonly #prepareModelContext: PrepareModelContext | undefined;
  readonly #beforeToolExecute: BeforeToolExecute | undefined;

  constructor(options: AgentRuntimeOptions) {
    this.#catalog = options.catalog;
    this.#loop = options.loop;
    this.#store = options.store;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#prepareModelContext = options.prepareModelContext;
    this.#beforeToolExecute = options.beforeToolExecute;
  }

  async run<TContext>(request: RunRequest<TContext>): Promise<RunHandle> {
    if (request.signal?.aborted) {
      throw new AgentError(
        {
          code: "RUN_CANCELLED",
          message: "Agent run was cancelled",
          retryable: false,
          phase: "runtime",
        },
        { cause: request.signal.reason },
      );
    }

    if (request.messages.length !== 1 || request.messages[0]?.role !== "user") {
      throw new AgentError({
        code: "INVALID_REQUEST",
        message: "A run requires exactly one new user message",
        retryable: false,
        phase: "runtime",
      });
    }

    const definition = this.#catalog.get(request.agentId);
    if (!definition) {
      throw new AgentError({
        code: "AGENT_NOT_FOUND",
        message: `Agent is not registered: ${request.agentId}`,
        retryable: false,
        phase: "runtime",
      });
    }

    const parsedContext = definition.contextSchema
      ? definition.contextSchema.parse(request.context)
      : request.context;
    const runId = this.#idGenerator();
    const now = this.#now().toISOString();
    const record: RunRecord = {
      id: runId,
      threadId: request.threadId,
      agentId: definition.id,
      agentVersion: definition.version,
      status: "created",
      version: 0,
      createdAt: now,
      updatedAt: now,
    };

    const controller = new AbortController();
    let stopCause: "cancelled" | "timed_out" | undefined;
    let cancelReason: string | undefined;
    let acceptingStop = true;
    const acceptStop = (
      cause: "cancelled" | "timed_out",
      reason?: unknown,
    ): boolean => {
      if (!acceptingStop || stopCause !== undefined) return false;
      stopCause = cause;
      if (cause === "cancelled") cancelReason = "external_abort";
      controller.abort(reason);
      return true;
    };
    const onExternalAbort = () => {
      acceptStop("cancelled", request.signal?.reason);
    };

    request.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (request.signal?.aborted) onExternalAbort();

    try {
      await this.#store.create(record);
    } catch (error) {
      request.signal?.removeEventListener("abort", onExternalAbort);
      throw error;
    }

    const channel = new AsyncChannel<AgentEvent>();

    let sequence = 0;
    const emit = async <TType extends AgentEventType>(
      type: TType,
      data: AgentEventDataMap[TType],
    ): Promise<void> => {
      const event = {
        id: this.#idGenerator(),
        type,
        occurredAt: this.#now().toISOString(),
        runId,
        threadId: request.threadId,
        sequence: ++sequence,
        data,
      } as AgentEvent;
      await this.#store.append(event);
      channel.push(event);
    };

    const result = this.#execute({
      definition,
      request,
      parsedContext,
      runId,
      controller,
      requestStop: acceptStop,
      getStopCause: () => stopCause,
      getCancelReason: () => cancelReason,
      stop: () => {
        acceptingStop = false;
      },
      emit,
    }).finally(() => {
      request.signal?.removeEventListener("abort", onExternalAbort);
      channel.close();
    });

    return {
      runId,
      events: channel,
      result,
      cancel: async (reason?: string) => {
        if (acceptStop("cancelled", reason)) {
          cancelReason = reason ?? "user_requested";
        }
      },
    };
  }

  async #execute<TContext>(options: {
    definition: NonNullable<ReturnType<AgentCatalog["get"]>>;
    request: RunRequest<TContext>;
    parsedContext: unknown;
    runId: string;
    controller: AbortController;
    requestStop: (
      cause: "cancelled" | "timed_out",
      reason?: unknown,
    ) => boolean;
    getStopCause: () => "cancelled" | "timed_out" | undefined;
    getCancelReason: () => string | undefined;
    stop: () => void;
    emit: <TType extends AgentEventType>(
      type: TType,
      data: AgentEventDataMap[TType],
    ) => Promise<void>;
  }): Promise<RunResult> {
    const {
      definition,
      request,
      runId,
      controller,
      requestStop,
      getStopCause,
      getCancelReason,
      stop,
      emit,
    } = options;
    let version = 0;
    const deadline = Date.now() + definition.limits.totalTimeoutMs;
    const timeoutReason = () =>
      new DOMException("Run timed out", "TimeoutError");
    const acceptTimeoutIfDue = () => {
      if (getStopCause() === undefined && Date.now() >= deadline) {
        requestStop("timed_out", timeoutReason());
      }
    };
    const timeout = setTimeout(() => {
      requestStop("timed_out", timeoutReason());
    }, definition.limits.totalTimeoutMs);
    let transcriptCommitted = false;
    let saveStarted = false;

    const notify = async <TType extends AgentEventType>(
      type: TType,
      data: AgentEventDataMap[TType],
    ): Promise<void> => {
      try {
        await emit(type, data);
      } catch {
        // Terminal notifications are best effort. The Run result and Store
        // state are already authoritative once their commit has succeeded.
      }
    };

    try {
      if (controller.signal.aborted) {
        const cancelled: RunResult = {
          runId,
          threadId: request.threadId,
          status: "cancelled",
          text: "",
          steps: 0,
          usage: {},
          error: {
            code: "RUN_CANCELLED",
            message: "Agent run was cancelled",
            retryable: false,
            phase: "runtime",
          },
        };
        await this.#transitionIfActive(runId, "cancelled", cancelled);
        const reason = getCancelReason();
        await notify("run.cancelled", reason ? { reason } : {});
        return cancelled;
      }

      const running = await this.#store.transition(runId, version, "running");
      version = running.version;
      if (controller.signal.aborted) throw abortReason(controller.signal);
      await emit("run.started", {
        agentId: definition.id,
        agentVersion: definition.version,
      });

      const previousMessages = await this.#store.getMessages(request.threadId);
      if (controller.signal.aborted) throw abortReason(controller.signal);
      const outcome = await this.#loop.execute({
        definition,
        messages: [...previousMessages, ...request.messages],
        ...(options.parsedContext !== undefined
          ? { context: options.parsedContext }
          : {}),
        signal: controller.signal,
        ...(this.#prepareModelContext
          ? { prepareModelContext: this.#prepareModelContext }
          : {}),
        ...(this.#beforeToolExecute
          ? { beforeToolExecute: this.#beforeToolExecute }
          : {}),
        generateId: this.#idGenerator,
        emit,
      });

      if (outcome.stopReason === "approval_required") {
        await this.#store.transition(runId, version, "waiting_approval");
        throw new AgentError({
          code: "INTERNAL",
          message: "Approval resume is reserved for M2 and is not implemented yet",
          retryable: false,
          phase: "approval",
        });
      }

      if (
        controller.signal.aborted ||
        Date.now() >= deadline
      ) {
        acceptTimeoutIfDue();
        throw abortReason(controller.signal);
      }

      stop();
      clearTimeout(timeout);
      saveStarted = true;
      await this.#store.save(request.threadId, outcome.messages);
      transcriptCommitted = true;
      const completed: RunResult = {
        runId,
        threadId: request.threadId,
        status: "completed",
        text: outcome.text,
        steps: outcome.steps,
        usage: outcome.usage,
      };

      try {
        await this.#store.transition(runId, version, "completed", completed);
      } catch (error) {
        throw new AgentError(
          {
            code: "INTERNAL",
            message: "Failed to finalize the completed run",
            retryable: false,
            phase: "storage",
          },
          { cause: error },
        );
      }

      await notify("run.completed", {
        text: outcome.text,
        steps: outcome.steps,
        usage: outcome.usage,
      });
      return completed;
    } catch (error) {
      if (transcriptCommitted) {
        // The transcript is a committed fact. A failed terminal transition
        // must not be rewritten as an ordinary Run failure.
        throw error;
      }

      if (!saveStarted && !controller.signal.aborted) acceptTimeoutIfDue();

      if (saveStarted) {
        // Once saving starts, a late cancellation or timeout cannot change a
        // storage failure into a cancellation result.
        const agentError = toAgentError(error);
        const failed: RunResult = {
          runId,
          threadId: request.threadId,
          status: "failed",
          text: "",
          steps: 0,
          usage: {},
          error: agentError.data,
        };
        await this.#transitionIfActive(runId, "failed", failed);
        await notify("run.failed", { error: agentError.data });
        return failed;
      }

      if (getStopCause() === "timed_out") {
        const timedOutResult: RunResult = {
          runId,
          threadId: request.threadId,
          status: "timed_out",
          text: "",
          steps: 0,
          usage: {},
          error: {
            code: "RUN_TIMEOUT",
            message: `Run exceeded ${definition.limits.totalTimeoutMs}ms`,
            retryable: true,
            phase: "runtime",
          },
        };
        await this.#transitionIfActive(runId, "timed_out", timedOutResult);
        await notify("run.timed_out", {
          timeoutMs: definition.limits.totalTimeoutMs,
        });
        return timedOutResult;
      }

      if (getStopCause() === "cancelled") {
        const cancelled: RunResult = {
          runId,
          threadId: request.threadId,
          status: "cancelled",
          text: "",
          steps: 0,
          usage: {},
          error: {
            code: "RUN_CANCELLED",
            message: "Agent run was cancelled",
            retryable: false,
            phase: "runtime",
          },
        };
        const reason = getCancelReason();
        await this.#transitionIfActive(runId, "cancelled", cancelled);
        await notify("run.cancelled", reason ? { reason } : {});
        return cancelled;
      }

      const agentError = toAgentError(error);
      const failed: RunResult = {
        runId,
        threadId: request.threadId,
        status: "failed",
        text: "",
        steps: 0,
        usage: {},
        error: agentError.data,
      };
      await this.#transitionIfActive(runId, "failed", failed);
      await notify("run.failed", { error: agentError.data });
      return failed;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #transitionIfActive(
    runId: string,
    status: "failed" | "cancelled" | "timed_out",
    result: RunResult,
  ): Promise<void> {
    const current = await this.#store.getRun(runId);
    if (!current) return;
    if (["completed", "failed", "cancelled", "timed_out"].includes(current.status)) {
      return;
    }
    await this.#store.transition(runId, current.version, status, result);
  }
}
