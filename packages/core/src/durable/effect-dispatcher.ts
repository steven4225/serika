import { hashCanonicalJson } from "./hash.js";
import { hasDeadlinePassed, timestampMs } from "./invariants.js";
import { assertJsonValue } from "./json.js";
import { decide } from "./orchestrator.js";
import { isAttemptRetryEligible } from "./policies.js";
import type { DurableRepository, PendingEffect } from "./repository.js";
import { DurableRepositoryError } from "./repository-errors.js";
import { DurableRuntimeCoordinator } from "./runtime-coordinator.js";
import type {
  AttemptResolution,
  ExternalEffect,
  IsoTimestamp,
  JsonValue,
  RuntimeFailure,
  RuntimeSnapshot,
  StopRequest,
} from "./types.js";

export interface InvocationIdentity {
  runId: string;
  turnId: string;
  actionId: string;
  attemptId: string;
}

export interface InvocationContext {
  identity: InvocationIdentity;
  signal: AbortSignal;
}

export interface ModelInvocationRequest {
  modelId: string;
  messageSnapshotId: string;
}

export interface ToolExecutionRequest {
  toolsetVersion: string;
  toolName: string;
  toolCallId: string;
  input: JsonValue;
  businessIdempotencyKey: string | null;
}

export type EffectFailureObservation =
  | { kind: "not_applied"; failure: RuntimeFailure }
  | { kind: "outcome_unknown"; failure: RuntimeFailure };

export type ModelInvocationObservation =
  | {
      kind: "completed";
      outcome: "final_answer" | "tool_calls";
      output: JsonValue;
    }
  | EffectFailureObservation;

export type ToolExecutionObservation =
  | { kind: "completed"; isError: boolean; output: JsonValue }
  | EffectFailureObservation;

export interface ModelInvoker {
  invoke(
    request: ModelInvocationRequest,
    context: InvocationContext,
  ): Promise<ModelInvocationObservation>;
}

export interface ToolExecutor {
  execute(
    request: ToolExecutionRequest,
    context: InvocationContext,
  ): Promise<ToolExecutionObservation>;
}

export type AttemptAbortReason =
  | { kind: "cancel"; message: string }
  | { kind: "deadline"; message: string }
  | { kind: "attempt_timeout"; message: string };

/** Process-local acceleration only; PostgreSQL remains the source of truth. */
export class ActiveAttemptRegistry {
  readonly #controllers = new Map<string, AbortController>();

  register(
    attemptId: string,
    controller: AbortController,
  ): (() => void) | null {
    if (this.#controllers.has(attemptId)) return null;
    this.#controllers.set(attemptId, controller);
    return () => {
      if (this.#controllers.get(attemptId) === controller) {
        this.#controllers.delete(attemptId);
      }
    };
  }

  abort(attemptId: string, reason: AttemptAbortReason): boolean {
    const controller = this.#controllers.get(attemptId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  has(attemptId: string): boolean {
    return this.#controllers.has(attemptId);
  }
}

export interface RequestRunStopInput {
  runId: string;
  reason: StopRequest["reason"];
  requestedBy: string;
  detail?: string;
}

/** Persists the Stop Request before accelerating it through AbortSignal. */
export class RunStopCoordinator {
  readonly #coordinator: DurableRuntimeCoordinator;
  readonly #activeAttempts: ActiveAttemptRegistry;

  constructor(options: {
    repository: DurableRepository;
    activeAttempts: ActiveAttemptRegistry;
  }) {
    this.#coordinator = new DurableRuntimeCoordinator(options.repository);
    this.#activeAttempts = options.activeAttempts;
  }

  async request(input: RequestRunStopInput): Promise<void> {
    let activeAttemptId: string | null = null;
    let primaryReason: StopRequest["reason"] = input.reason;
    await this.#coordinator.transact(input.runId, ({ databaseNow, snapshot }) => {
      activeAttemptId =
        snapshot.attempt?.status === "started" ? snapshot.attempt.id : null;
      primaryReason = snapshot.run.stopRequest?.reason ?? input.reason;
      return {
        type: "request_stop",
        request: {
          reason: input.reason,
          requestedAt: databaseNow,
          requestedBy: input.requestedBy,
          detail: input.detail ?? null,
        },
      };
    });

    if (activeAttemptId !== null) {
      this.#activeAttempts.abort(
        activeAttemptId,
        primaryReason === "deadline"
          ? deadlineAbortReason()
          : { kind: "cancel", message: input.detail ?? "Run was cancelled" },
      );
    }
  }
}

export interface EffectDispatcherDependencies {
  repository: DurableRepository;
  modelInvoker: ModelInvoker;
  toolExecutor: ToolExecutor;
  activeAttempts?: ActiveAttemptRegistry;
  scheduleRetryAt(input: {
    databaseNow: IsoTimestamp;
    snapshot: RuntimeSnapshot;
  }): IsoTimestamp;
  /** Must return a new stable Runtime-generated ID. */
  createReconciliationId(effect: ExternalEffect): string;
  monotonicNow?: () => number;
}

export interface EffectProcessingFailure {
  attemptId: string;
  stage: "prepare" | "persist_result";
  code: string;
  message: string;
}

export interface EffectTickReport {
  scanned: number;
  invoked: number;
  settledWithoutInvocation: number;
  stale: number;
  failures: readonly EffectProcessingFailure[];
}

export type EffectTickResult =
  | { kind: "busy" }
  | { kind: "completed"; report: EffectTickReport };

type PreparedDispatch =
  | { kind: "stale" }
  | { kind: "settled" }
  | {
      kind: "ready";
      effect: ExternalEffect;
      remainingRunMs: number | null;
      measuredAt: number;
    };

type CandidateResult =
  | { kind: "invoked" }
  | { kind: "settled_without_invocation" }
  | { kind: "stale" }
  | { kind: "failed"; failure: EffectProcessingFailure; invoked: boolean };

/**
 * Sequentially advances one batch of durable Outbox Effects. It owns neither
 * polling cadence nor process lifecycle, and never invokes an external port
 * while a database transaction is open.
 */
export class EffectDispatcher {
  readonly #repository: DurableRepository;
  readonly #coordinator: DurableRuntimeCoordinator;
  readonly #modelInvoker: ModelInvoker;
  readonly #toolExecutor: ToolExecutor;
  readonly #activeAttempts: ActiveAttemptRegistry;
  readonly #scheduleRetryAt: EffectDispatcherDependencies["scheduleRetryAt"];
  readonly #createReconciliationId: EffectDispatcherDependencies["createReconciliationId"];
  readonly #monotonicNow: () => number;
  #tickRunning = false;

  constructor(dependencies: EffectDispatcherDependencies) {
    this.#repository = dependencies.repository;
    this.#coordinator = new DurableRuntimeCoordinator(dependencies.repository);
    this.#modelInvoker = dependencies.modelInvoker;
    this.#toolExecutor = dependencies.toolExecutor;
    this.#activeAttempts =
      dependencies.activeAttempts ?? new ActiveAttemptRegistry();
    this.#scheduleRetryAt = dependencies.scheduleRetryAt;
    this.#createReconciliationId = dependencies.createReconciliationId;
    this.#monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  }

  async tick(limit = 100): Promise<EffectTickResult> {
    if (this.#tickRunning) return { kind: "busy" };
    this.#tickRunning = true;
    try {
      const pending = await this.#repository.findPendingEffects(limit);
      const failures: EffectProcessingFailure[] = [];
      const report: EffectTickReport = {
        scanned: pending.length,
        invoked: 0,
        settledWithoutInvocation: 0,
        stale: 0,
        failures,
      };

      for (const candidate of pending) {
        const result = await this.#processCandidate(candidate);
        switch (result.kind) {
          case "invoked":
            report.invoked += 1;
            break;
          case "settled_without_invocation":
            report.settledWithoutInvocation += 1;
            break;
          case "stale":
            report.stale += 1;
            break;
          case "failed":
            if (result.invoked) report.invoked += 1;
            failures.push(result.failure);
            break;
        }
      }

      return { kind: "completed", report };
    } finally {
      this.#tickRunning = false;
    }
  }

  async #processCandidate(candidate: PendingEffect): Promise<CandidateResult> {
    const controller = new AbortController();
    const unregister = this.#activeAttempts.register(
      candidate.effect.attemptId,
      controller,
    );
    if (unregister === null) return { kind: "stale" };

    try {
      let prepared: PreparedDispatch;
      try {
        prepared = await this.#prepareDispatch(candidate);
      } catch (error) {
        return {
          kind: "failed",
          failure: processingFailure(candidate, "prepare", error),
          invoked: false,
        };
      }
      if (prepared.kind === "stale") return prepared;
      if (prepared.kind === "settled") {
        return { kind: "settled_without_invocation" };
      }

      const elapsedSinceMeasurement = Math.max(
        0,
        this.#monotonicNow() - prepared.measuredAt,
      );
      const remainingRunMs =
        prepared.remainingRunMs === null
          ? null
          : prepared.remainingRunMs - elapsedSinceMeasurement;

      let invocation: { resolution: AttemptResolution; invoked: boolean };
      let invocationStarted = false;
      try {
        if (controller.signal.aborted) {
          invocation = {
            resolution: notAppliedBeforeInvocation(controller.signal.reason),
            invoked: false,
          };
        } else if (remainingRunMs !== null && remainingRunMs <= 0) {
          await this.#persistDeadlineStop(prepared.effect);
          controller.abort(deadlineAbortReason());
          invocation = {
            resolution: notAppliedBeforeInvocation(controller.signal.reason),
            invoked: false,
          };
        } else {
          invocationStarted = true;
          invocation = await this.#invoke(
            prepared.effect,
            controller,
            remainingRunMs,
          );
        }
      } catch (error) {
        return {
          kind: "failed",
          failure: processingFailure(candidate, "persist_result", error),
          invoked: invocationStarted,
        };
      }

      try {
        await this.#persistResolution(prepared.effect, invocation.resolution);
      } catch (error) {
        return {
          kind: "failed",
          failure: processingFailure(candidate, "persist_result", error),
          invoked: invocation.invoked,
        };
      }
      return invocation.invoked
        ? { kind: "invoked" }
        : { kind: "settled_without_invocation" };
    } finally {
      unregister();
    }
  }

  async #prepareDispatch(candidate: PendingEffect): Promise<PreparedDispatch> {
    return this.#repository.withLockedRun(
      candidate.effect.runId,
      async (transaction) => {
        const snapshot = transaction.snapshot;
        if (
          snapshot.action.id !== candidate.effect.actionId ||
          snapshot.attempt?.id !== candidate.effect.attemptId ||
          snapshot.attempt.status !== "started" ||
          snapshot.attempt.dispatchState !== "not_dispatched"
        ) {
          return { kind: "stale" };
        }

        const decision = decide(snapshot, {
          type: "prepare_dispatch",
          now: transaction.databaseNow,
          attemptId: candidate.effect.attemptId,
        });
        const expectedEffect = decision.effects[0];
        if (
          expectedEffect !== undefined &&
          !sameEffect(candidate.effect, expectedEffect)
        ) {
          throw new DurableRepositoryError(
            "OUTBOX_PAYLOAD_MISMATCH",
            `Outbox payload does not match Attempt: ${candidate.effect.attemptId}`,
          );
        }

        const measuredAt = this.#monotonicNow();
        const remainingRunMs = remainingRunBudget(
          snapshot,
          transaction.databaseNow,
        );
        await transaction.apply(decision);
        return expectedEffect === undefined
          ? decision.events.length === 0
            ? { kind: "stale" }
            : { kind: "settled" }
          : {
              kind: "ready",
              effect: expectedEffect,
              remainingRunMs,
              measuredAt,
            };
      },
    );
  }

  async #invoke(
    effect: ExternalEffect,
    controller: AbortController,
    remainingRunMs: number | null,
  ): Promise<{ resolution: AttemptResolution; invoked: true }> {
    let forcedSelected = false;
    let resolveForced!: (resolution: AttemptResolution) => void;
    let rejectForced!: (error: unknown) => void;
    const forced = new Promise<AttemptResolution>((resolve, reject) => {
      resolveForced = resolve;
      rejectForced = reject;
    });
    const selectAbort = () => {
      if (forcedSelected) return;
      forcedSelected = true;
      resolveForced(unknownAfterInvocation(controller.signal.reason));
    };
    controller.signal.addEventListener("abort", selectAbort, { once: true });

    let attemptTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (remainingRunMs !== null && remainingRunMs <= effect.timeoutMs) {
      deadlineTimer = setTimeout(() => {
        if (forcedSelected) return;
        forcedSelected = true;
        void this.#persistDeadlineStop(effect).then(
          () => {
            controller.abort(deadlineAbortReason());
            resolveForced(unknownAfterInvocation(deadlineAbortReason()));
          },
          rejectForced,
        );
      }, Math.max(0, remainingRunMs));
    } else {
      attemptTimer = setTimeout(() => {
        controller.abort(attemptTimeoutAbortReason());
      }, effect.timeoutMs);
    }

    const invocation = Promise.resolve().then(
      () => this.#invokePort(effect, controller.signal),
    ).then(
      (observation) => {
        const resolution = toAttemptResolution(effect, observation);
        return forcedSelected ? forced : resolution;
      },
      () => {
        const resolution: AttemptResolution = {
          kind: "outcome_unknown",
          failure: {
            code: "EXTERNAL_EFFECT_UNCLASSIFIED",
            message: "External effect failed without a classified outcome",
            retryable: false,
          },
        };
        return forcedSelected ? forced : resolution;
      },
    );

    try {
      return {
        resolution: await Promise.race([invocation, forced]),
        invoked: true,
      };
    } finally {
      if (attemptTimer !== undefined) clearTimeout(attemptTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      controller.signal.removeEventListener("abort", selectAbort);
    }
  }

  #invokePort(
    effect: ExternalEffect,
    signal: AbortSignal,
  ): Promise<ModelInvocationObservation | ToolExecutionObservation> {
    const context: InvocationContext = {
      identity: identityFor(effect),
      signal,
    };
    return effect.kind === "invoke_model"
      ? this.#modelInvoker.invoke(
          {
            modelId: effect.modelId,
            messageSnapshotId: effect.messageSnapshotId,
          },
          context,
        )
      : this.#toolExecutor.execute(
          {
            toolsetVersion: effect.toolsetVersion,
            toolName: effect.toolName,
            toolCallId: effect.toolCallId,
            input: effect.input,
            businessIdempotencyKey: effect.businessIdempotencyKey,
          },
          context,
        );
  }

  async #persistDeadlineStop(effect: ExternalEffect): Promise<void> {
    await this.#coordinator.transactOptional(
      effect.runId,
      ({ databaseNow, snapshot }) => {
        if (
          snapshot.action.id !== effect.actionId ||
          snapshot.attempt?.id !== effect.attemptId ||
          snapshot.attempt.status !== "started"
        ) {
          return null;
        }
        return {
          type: "request_stop",
          request: {
            reason: "deadline",
            requestedAt: databaseNow,
            requestedBy: "runtime:effect-dispatcher",
            detail: null,
          },
        };
      },
    );
  }

  async #persistResolution(
    effect: ExternalEffect,
    resolution: AttemptResolution,
  ): Promise<void> {
    const reconciliationId =
      resolution.kind === "outcome_unknown"
        ? this.#createReconciliationId(effect)
        : undefined;
    await this.#coordinator.transactOptional(
      effect.runId,
      ({ databaseNow, snapshot }) => {
        if (
          snapshot.action.id !== effect.actionId ||
          snapshot.attempt?.id !== effect.attemptId ||
          snapshot.attempt.status !== "started"
        ) {
          return null;
        }
        const retryAt =
          resolution.kind !== "completed" &&
          resolution.kind !== "safely_aborted" &&
          snapshot.run.stopRequest === null &&
          !hasDeadlinePassed(snapshot.run.limits.deadlineAt, databaseNow) &&
          isAttemptRetryEligible(
            snapshot.action,
            snapshot.attempt,
            resolution,
          )
            ? this.#scheduleRetryAt({ databaseNow, snapshot })
            : undefined;
        return {
          type: "resolve_attempt",
          now: databaseNow,
          attemptId: effect.attemptId,
          resolution,
          ...(retryAt !== undefined ? { retryAt } : {}),
          ...(reconciliationId !== undefined ? { reconciliationId } : {}),
        };
      },
    );
  }
}

function identityFor(effect: ExternalEffect): InvocationIdentity {
  return {
    runId: effect.runId,
    turnId: effect.turnId,
    actionId: effect.actionId,
    attemptId: effect.attemptId,
  };
}

function remainingRunBudget(
  snapshot: RuntimeSnapshot,
  databaseNow: IsoTimestamp,
): number | null {
  const deadlineAt = snapshot.run.limits.deadlineAt;
  return deadlineAt === null
    ? null
    : timestampMs(deadlineAt, "deadlineAt") -
        timestampMs(databaseNow, "databaseNow");
}

function sameEffect(left: unknown, right: unknown): boolean {
  assertJsonValue(left, "Outbox Effect");
  assertJsonValue(right, "expected Effect");
  return hashCanonicalJson(left) === hashCanonicalJson(right);
}

function toAttemptResolution(
  effect: ExternalEffect,
  observation: ModelInvocationObservation | ToolExecutionObservation,
): AttemptResolution {
  if (observation.kind !== "completed") return observation;
  if (effect.kind === "invoke_model") {
    const model = observation as Extract<
      ModelInvocationObservation,
      { kind: "completed" }
    >;
    return {
      kind: "completed",
      output: {
        kind: "model",
        outcome: model.outcome,
        value: model.output,
      },
    };
  }
  const tool = observation as Extract<
    ToolExecutionObservation,
    { kind: "completed" }
  >;
  return {
    kind: "completed",
    output: { kind: "tool", isError: tool.isError, value: tool.output },
  };
}

function notAppliedBeforeInvocation(reason: unknown): AttemptResolution {
  const abort = abortReason(reason);
  return {
    kind: "not_applied",
    failure: {
      code:
        abort.kind === "deadline"
          ? "RUN_DEADLINE_EXCEEDED"
          : "EFFECT_CANCELLED_BEFORE_INVOCATION",
      message: abort.message,
      retryable: false,
    },
  };
}

function unknownAfterInvocation(reason: unknown): AttemptResolution {
  const abort = abortReason(reason);
  return {
    kind: "outcome_unknown",
    failure: {
      code:
        abort.kind === "attempt_timeout"
          ? "ATTEMPT_TIMEOUT"
          : abort.kind === "deadline"
            ? "RUN_DEADLINE_EXCEEDED"
            : "EFFECT_CANCELLED",
      message: abort.message,
      retryable: abort.kind === "attempt_timeout",
    },
  };
}

function abortReason(reason: unknown): AttemptAbortReason {
  if (
    typeof reason === "object" &&
    reason !== null &&
    "kind" in reason &&
    "message" in reason &&
    (reason.kind === "cancel" ||
      reason.kind === "deadline" ||
      reason.kind === "attempt_timeout") &&
    typeof reason.message === "string"
  ) {
    return reason as AttemptAbortReason;
  }
  return { kind: "cancel", message: "Attempt was aborted" };
}

function deadlineAbortReason(): AttemptAbortReason {
  return { kind: "deadline", message: "Run deadline was reached" };
}

function attemptTimeoutAbortReason(): AttemptAbortReason {
  return { kind: "attempt_timeout", message: "Attempt timeout was reached" };
}

function processingFailure(
  candidate: PendingEffect,
  stage: EffectProcessingFailure["stage"],
  error: unknown,
): EffectProcessingFailure {
  const repositoryError =
    error instanceof DurableRepositoryError ? error : undefined;
  return {
    attemptId: candidate.effect.attemptId,
    stage,
    code: repositoryError?.code ?? `EFFECT_${stage.toUpperCase()}_FAILED`,
    message:
      repositoryError?.message ??
      `Effect processing failed during ${stage.replace("_", " ")}`,
  };
}
