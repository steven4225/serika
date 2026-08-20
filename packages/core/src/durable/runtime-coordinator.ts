import { applyDecision, decide } from "./orchestrator.js";
import { isReplaySafe } from "./policies.js";
import type {
  DurableRepository,
  ExpiredApprovalCandidate,
  RecoverableAttemptCandidate,
  RetryWakeResult,
} from "./repository.js";
import type {
  DurableCommand,
  DurableDecision,
  IsoTimestamp,
  RuntimeSnapshot,
} from "./types.js";

export type DurableCommandFactory = (context: {
  databaseNow: IsoTimestamp;
  snapshot: RuntimeSnapshot;
}) => DurableCommand;

export type OptionalDurableCommandFactory = (context: {
  databaseNow: IsoTimestamp;
  snapshot: RuntimeSnapshot;
}) => DurableCommand | null;

/**
 * Executes one transaction-sized state-machine command. External Effects are
 * returned only after `withLockedRun` has committed successfully.
 */
export class DurableRuntimeCoordinator {
  readonly #repository: DurableRepository;

  constructor(repository: DurableRepository) {
    this.#repository = repository;
  }

  async transact(
    runId: string,
    createCommand: DurableCommandFactory,
  ): Promise<DurableDecision> {
    return this.transactOptional(runId, createCommand);
  }

  async transactOptional(
    runId: string,
    createCommand: OptionalDurableCommandFactory,
  ): Promise<DurableDecision> {
    return this.#repository.withLockedRun(runId, async (transaction) => {
      const command = createCommand({
        databaseNow: transaction.databaseNow,
        snapshot: transaction.snapshot,
      });
      if (command === null) return { events: [], effects: [] };
      const decision = decide(transaction.snapshot, command);
      await transaction.apply(decision);
      return decision;
    });
  }
}

/**
 * Polls durable candidates and advances each one in its own short transaction.
 * Candidate reads are hints; the Orchestrator rechecks authoritative state.
 */
export class RetryScheduler {
  readonly #repository: DurableRepository;
  readonly #coordinator: DurableRuntimeCoordinator;

  constructor(
    repository: DurableRepository,
    coordinator = new DurableRuntimeCoordinator(repository),
  ) {
    this.#repository = repository;
    this.#coordinator = coordinator;
  }

  async tick(limit = 100): Promise<readonly RetryWakeResult[]> {
    const candidates = await this.#repository.findDueRetries(limit);
    const results: RetryWakeResult[] = [];

    for (const candidate of candidates) {
      try {
        const decision = await this.#coordinator.transact(
          candidate.runId,
          ({ databaseNow }) => ({
            type: "wake_retry",
            now: databaseNow,
            actionId: candidate.actionId,
          }),
        );
        results.push({
          kind: decision.events.some((event) => event.type === "retry_woken")
            ? "woken"
            : "ignored",
          runId: candidate.runId,
          actionId: candidate.actionId,
        });
      } catch (error) {
        results.push({
          kind: "failed",
          runId: candidate.runId,
          actionId: candidate.actionId,
          error,
        });
      }
    }

    return results;
  }
}

export interface ApprovalExpiryResult {
  candidate: ExpiredApprovalCandidate;
  kind: "expired" | "ignored" | "failed";
  error?: unknown;
}

export class ApprovalExpiryScheduler {
  readonly #repository: DurableRepository;
  readonly #coordinator: DurableRuntimeCoordinator;
  readonly #resolvedBy: string;

  constructor(options: {
    repository: DurableRepository;
    coordinator?: DurableRuntimeCoordinator;
    resolvedBy?: string;
  }) {
    this.#repository = options.repository;
    this.#coordinator =
      options.coordinator ?? new DurableRuntimeCoordinator(options.repository);
    this.#resolvedBy = options.resolvedBy ?? "runtime:approval-expiry";
  }

  async tick(limit = 100): Promise<readonly ApprovalExpiryResult[]> {
    const candidates = await this.#repository.findExpiredApprovals(limit);
    const results: ApprovalExpiryResult[] = [];

    for (const candidate of candidates) {
      try {
        const decision = await this.#coordinator.transact(
          candidate.runId,
          ({ databaseNow }) => ({
            type: "expire_approval",
            now: databaseNow,
            approvalId: candidate.approvalId,
            resolvedBy: this.#resolvedBy,
          }),
        );
        results.push({
          candidate,
          kind: decision.events.some(
            (event) =>
              event.type === "approval_resolved" &&
              event.status === "expired",
          )
            ? "expired"
            : "ignored",
        });
      } catch (error) {
        results.push({ candidate, kind: "failed", error });
      }
    }
    return results;
  }
}

/**
 * Startup recovery deliberately delegates the final policy decision. Recovery
 * may require a stable retry time or Reconciliation ID supplied by the Runtime.
 */
export class AttemptRecoveryScanner {
  readonly #repository: DurableRepository;

  constructor(repository: DurableRepository) {
    this.#repository = repository;
  }

  async scan(
    recover: (candidate: RecoverableAttemptCandidate) => Promise<void>,
    limit = 100,
  ): Promise<void> {
    const candidates = await this.#repository.findRecoverableAttempts(limit);
    for (const candidate of candidates) await recover(candidate);
  }
}

export interface AttemptRecoveryDependencies {
  repository: DurableRepository;
  coordinator?: DurableRuntimeCoordinator;
  scheduleRetryAt(input: {
    databaseNow: IsoTimestamp;
    snapshot: RuntimeSnapshot;
  }): IsoTimestamp;
  createReconciliationId(candidate: RecoverableAttemptCandidate): string;
}

/** Applies the confirmed startup recovery matrix to one candidate at a time. */
export class AttemptRecoveryCoordinator {
  readonly #repository: DurableRepository;
  readonly #coordinator: DurableRuntimeCoordinator;
  readonly #scheduleRetryAt: AttemptRecoveryDependencies["scheduleRetryAt"];
  readonly #createReconciliationId: AttemptRecoveryDependencies["createReconciliationId"];

  constructor(dependencies: AttemptRecoveryDependencies) {
    this.#repository = dependencies.repository;
    this.#coordinator =
      dependencies.coordinator ??
      new DurableRuntimeCoordinator(dependencies.repository);
    this.#scheduleRetryAt = dependencies.scheduleRetryAt;
    this.#createReconciliationId = dependencies.createReconciliationId;
  }

  async recoverAll(limit = 100): Promise<readonly DurableDecision[]> {
    const candidates = await this.#repository.findRecoverableAttempts(limit);
    const decisions: DurableDecision[] = [];
    for (const candidate of candidates) {
      decisions.push(await this.recover(candidate));
    }
    return decisions;
  }

  async recover(
    candidate: RecoverableAttemptCandidate,
  ): Promise<DurableDecision> {
    return this.#coordinator.transactOptional(
      candidate.runId,
      ({ databaseNow, snapshot }) => {
        if (
          snapshot.action.id !== candidate.actionId ||
          snapshot.attempt?.id !== candidate.attemptId
        ) {
          return null;
        }

        const attempt = snapshot.attempt;
        if (attempt.dispatchState === "not_dispatched") {
          return {
            type: "resume_undispatched_attempt",
            now: databaseNow,
            attemptId: attempt.id,
          };
        }

        const failure = {
          code: "ATTEMPT_INTERRUPTED_BY_RESTART",
          message:
            "The process restarted before the external result was durably committed",
          retryable: true,
        };
        if (isReplaySafe(snapshot.action, attempt)) {
          return {
            type: "resolve_attempt",
            now: databaseNow,
            attemptId: attempt.id,
            resolution: { kind: "interrupted", failure },
            retryAt: this.#scheduleRetryAt({ databaseNow, snapshot }),
          };
        }

        return {
          type: "resolve_attempt",
          now: databaseNow,
          attemptId: attempt.id,
          resolution: { kind: "outcome_unknown", failure },
          reconciliationId: this.#createReconciliationId(candidate),
        };
      },
    );
  }
}

/** Helper for Repository implementations and transaction tests. */
export function projectDecision(
  snapshot: RuntimeSnapshot,
  decision: DurableDecision,
): RuntimeSnapshot {
  return applyDecision(snapshot, decision);
}
