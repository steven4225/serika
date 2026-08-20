import { assertRuntimeSnapshot, timestampMs } from "./invariants.js";
import { applyDecision } from "./orchestrator.js";
import { DurableRepositoryError } from "./repository-errors.js";
import type {
  CreateRunInput,
  CreateRunResult,
  DueRetryCandidate,
  DurableRepository,
  DurableRunView,
  ExpiredApprovalCandidate,
  LockedRunTransaction,
  PendingEffect,
  RecoverableAttemptCandidate,
  RunLocator,
  TriggerMessage,
} from "./repository.js";
import type {
  AttemptState,
  DurableDecision,
  IsoTimestamp,
  RuntimeSnapshot,
  ThreadState,
} from "./types.js";

interface IdempotencyRecord {
  requestHash: string;
  runId: string;
}

/**
 * Deterministic transactional reference adapter. It is intentionally stricter
 * than a plain Map fake so PostgreSQL implementations can share its contract
 * tests. It is not a production persistence implementation.
 */
export class InMemoryDurableRepository<TMessageContent = unknown>
  implements DurableRepository<TMessageContent>
{
  readonly #runs = new Map<string, RuntimeSnapshot>();
  readonly #threads = new Map<string, ThreadState>();
  readonly #messages = new Map<
    string,
    TriggerMessage<TMessageContent>[]
  >();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #attemptsByRun = new Map<string, Map<string, AttemptState>>();
  readonly #pendingEffects = new Map<string, PendingEffect>();
  readonly #now: () => IsoTimestamp;
  #transactionTail: Promise<void> = Promise.resolve();

  constructor(options?: { now?: () => IsoTimestamp }) {
    this.#now = options?.now ?? (() => new Date().toISOString());
  }

  /** Test-only aggregate seeding without inventing a public table CRUD API. */
  seed(snapshot: RuntimeSnapshot): void {
    assertRuntimeSnapshot(snapshot);
    if (this.#runs.has(snapshot.run.id)) {
      throw new DurableRepositoryError(
        "RUN_ALREADY_EXISTS",
        `Run already exists: ${snapshot.run.id}`,
      );
    }
    this.#runs.set(snapshot.run.id, clone(snapshot));
    this.#threads.set(snapshot.thread.id, clone(snapshot.thread));
    this.#recordAttempt(snapshot);
  }

  readSnapshot(runId: string): RuntimeSnapshot | null {
    const snapshot = this.#runs.get(runId);
    return snapshot ? clone(snapshot) : null;
  }

  readAttempts(runId: string): readonly AttemptState[] {
    return [...(this.#attemptsByRun.get(runId)?.values() ?? [])]
      .sort((left, right) => left.sequence - right.sequence)
      .map(clone);
  }

  async createRun(
    input: CreateRunInput<TMessageContent>,
  ): Promise<CreateRunResult> {
    return this.#exclusive(async () => {
      validateCreateInput(input);

      const idempotencyKey = input.clientIdempotencyKey;
      if (idempotencyKey !== null) {
        const key = `${input.thread.id}\u0000${idempotencyKey}`;
        const existing = this.#idempotency.get(key);
        if (existing) {
          if (existing.requestHash !== input.requestHash) {
            throw new DurableRepositoryError(
              "IDEMPOTENCY_KEY_REUSED",
              "Idempotency key was reused with a different request",
            );
          }
          return { kind: "existing", runId: existing.runId };
        }
      }

      if (this.#runs.has(input.run.id)) {
        throw new DurableRepositoryError(
          "RUN_ALREADY_EXISTS",
          `Run already exists: ${input.run.id}`,
        );
      }

      const storedThread = this.#threads.get(input.thread.id);
      const expectedThread = storedThread ?? input.thread;
      if (
        storedThread !== undefined &&
        (storedThread.version !== input.thread.version ||
          storedThread.headMessageId !== input.thread.headMessageId ||
          storedThread.activeRunId !== input.thread.activeRunId)
      ) {
        throw new DurableRepositoryError(
          "THREAD_VERSION_CONFLICT",
          `Thread changed before Run creation: ${input.thread.id}`,
        );
      }
      if (expectedThread.activeRunId !== null) {
        throw new DurableRepositoryError(
          "THREAD_BUSY",
          `Thread already has active Run: ${expectedThread.activeRunId}`,
        );
      }

      const thread: ThreadState = {
        ...expectedThread,
        activeRunId: input.run.id,
        headMessageId: input.triggerMessage.id,
        version: expectedThread.version + 1,
      };
      const snapshot: RuntimeSnapshot = {
        thread,
        run: clone(input.run),
        turn: clone(input.turn),
        action: clone(input.action),
        attempt: null,
        approval: null,
        reconciliation: null,
      };
      assertRuntimeSnapshot(snapshot);

      this.#threads.set(thread.id, clone(thread));
      this.#runs.set(input.run.id, clone(snapshot));
      this.#attemptsByRun.set(input.run.id, new Map());
      const messages = this.#messages.get(thread.id) ?? [];
      messages.push(clone(input.triggerMessage));
      this.#messages.set(thread.id, messages);

      if (idempotencyKey !== null) {
        this.#idempotency.set(`${thread.id}\u0000${idempotencyKey}`, {
          requestHash: input.requestHash,
          runId: input.run.id,
        });
      }
      return { kind: "created", runId: input.run.id };
    });
  }

  async withLockedRun<T>(
    runId: string,
    operation: (transaction: LockedRunTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#exclusive(async () => {
      const stored = this.#runs.get(runId);
      if (!stored) {
        throw new DurableRepositoryError(
          "RUN_NOT_FOUND",
          `Run not found: ${runId}`,
        );
      }

      let working = clone(stored);
      const pendingDecisions: DurableDecision[] = [];
      const databaseNow = this.#now();
      timestampMs(databaseNow, "databaseNow");
      const transaction: LockedRunTransaction = {
        databaseNow,
        get snapshot() {
          return clone(working);
        },
        async apply(decision: DurableDecision) {
          working = applyDecision(working, decision);
          assertRuntimeSnapshot(working);
          for (const effect of decision.effects) {
            if (effect.attemptId !== working.attempt?.id) {
              throw new DurableRepositoryError(
                "INVALID_CREATE_RUN",
                "An Effect must belong to the current Attempt",
              );
            }
          }
          pendingDecisions.push(clone(decision));
        },
      };

      // The working copy is committed only when the callback resolves.
      const result = await operation(transaction);
      this.#runs.set(runId, clone(working));
      this.#threads.set(working.thread.id, clone(working.thread));
      this.#recordAttempt(working);
      for (const decision of pendingDecisions) {
        for (const effect of decision.effects) {
          this.#pendingEffects.set(effect.attemptId, {
            effect: clone(effect),
            createdAt: databaseNow,
          });
        }
        for (const event of decision.events) {
          if (event.type === "attempt_dispatch_recorded") {
            this.#pendingEffects.delete(event.attemptId);
          }
        }
      }
      return result;
    });
  }

  async locateApproval(approvalId: string): Promise<RunLocator | null> {
    for (const snapshot of this.#runs.values()) {
      if (snapshot.approval?.id === approvalId) {
        return { runId: snapshot.run.id, actionId: snapshot.action.id };
      }
    }
    return null;
  }

  async locateReconciliation(
    reconciliationId: string,
  ): Promise<RunLocator | null> {
    for (const snapshot of this.#runs.values()) {
      if (snapshot.reconciliation?.id === reconciliationId) {
        return { runId: snapshot.run.id, actionId: snapshot.action.id };
      }
    }
    return null;
  }

  async findDueRetries(limit: number): Promise<readonly DueRetryCandidate[]> {
    assertLimit(limit);
    const now = timestampMs(this.#now(), "databaseNow");
    return [...this.#runs.values()]
      .filter(
        (snapshot) =>
          snapshot.run.status === "waiting_retry" &&
          snapshot.action.status === "waiting_retry" &&
          snapshot.action.retryAt !== null &&
          timestampMs(snapshot.action.retryAt, "retryAt") <= now,
      )
      .sort((left, right) =>
        left.action.retryAt!.localeCompare(right.action.retryAt!),
      )
      .slice(0, limit)
      .map((snapshot) => ({
        runId: snapshot.run.id,
        actionId: snapshot.action.id,
        retryAt: snapshot.action.retryAt!,
      }));
  }

  async findExpiredApprovals(
    limit: number,
  ): Promise<readonly ExpiredApprovalCandidate[]> {
    assertLimit(limit);
    const now = timestampMs(this.#now(), "databaseNow");
    return [...this.#runs.values()]
      .filter(
        (snapshot) =>
          snapshot.run.status === "waiting_approval" &&
          snapshot.approval?.status === "pending" &&
          snapshot.approval.expiresAt !== null &&
          timestampMs(snapshot.approval.expiresAt, "expiresAt") <= now,
      )
      .sort((left, right) =>
        left.approval!.expiresAt!.localeCompare(right.approval!.expiresAt!),
      )
      .slice(0, limit)
      .map((snapshot) => ({
        runId: snapshot.run.id,
        actionId: snapshot.action.id,
        approvalId: snapshot.approval!.id,
        expiresAt: snapshot.approval!.expiresAt!,
      }));
  }

  async findRecoverableAttempts(
    limit: number,
  ): Promise<readonly RecoverableAttemptCandidate[]> {
    assertLimit(limit);
    return [...this.#runs.values()]
      .filter(
        (snapshot) =>
          snapshot.run.status === "executing" &&
          snapshot.action.status === "executing" &&
          snapshot.attempt?.status === "started",
      )
      .slice(0, limit)
      .map((snapshot) => ({
        runId: snapshot.run.id,
        actionId: snapshot.action.id,
        attemptId: snapshot.attempt!.id,
        actionKind: snapshot.action.input.kind,
        dispatchState: snapshot.attempt!.dispatchState,
      }));
  }

  async findPendingEffects(limit: number): Promise<readonly PendingEffect[]> {
    assertLimit(limit);
    return [...this.#pendingEffects.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async getRun(runId: string): Promise<DurableRunView | null> {
    const snapshot = this.#runs.get(runId);
    if (!snapshot) return null;
    return clone({
      thread: snapshot.thread,
      run: snapshot.run,
      turns: [snapshot.turn],
      actions: [snapshot.action],
      attempts: this.readAttempts(runId),
      approvals: snapshot.approval ? [snapshot.approval] : [],
      reconciliations: snapshot.reconciliation
        ? [snapshot.reconciliation]
        : [],
    });
  }

  async listMessages(
    threadId: string,
  ): Promise<readonly TriggerMessage<TMessageContent>[]> {
    return clone(this.#messages.get(threadId) ?? []);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#transactionTail;
    let release!: () => void;
    this.#transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #recordAttempt(snapshot: RuntimeSnapshot): void {
    if (snapshot.attempt === null) return;
    const attempts = this.#attemptsByRun.get(snapshot.run.id) ?? new Map();
    attempts.set(snapshot.attempt.id, clone(snapshot.attempt));
    this.#attemptsByRun.set(snapshot.run.id, attempts);
  }
}

function validateCreateInput<TMessageContent>(
  input: CreateRunInput<TMessageContent>,
): void {
  if (
    input.run.threadId !== input.thread.id ||
    input.turn.runId !== input.run.id ||
    input.action.runId !== input.run.id ||
    input.action.turnId !== input.turn.id ||
    input.triggerMessage.threadId !== input.thread.id ||
    input.triggerMessage.createdByRunId !== input.run.id ||
    input.triggerMessage.id !== input.run.triggerMessageId ||
    input.triggerMessage.parentMessageId !== input.run.baseHeadMessageId ||
    input.run.baseHeadMessageId !== input.thread.headMessageId
  ) {
    throw new DurableRepositoryError(
      "INVALID_CREATE_RUN",
      "Initial Thread, Message, Run, Turn and Action identities are inconsistent",
    );
  }
  if (
    input.run.status !== "ready" ||
    input.action.status !== "ready" ||
    input.action.attemptCount !== 0 ||
    input.action.resolution !== null
  ) {
    throw new DurableRepositoryError(
      "INVALID_CREATE_RUN",
      "A new Run must contain one ready Action with no Attempts",
    );
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("scan limit must be a positive integer");
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
