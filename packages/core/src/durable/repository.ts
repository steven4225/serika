import type {
  ActionState,
  ApprovalState,
  AttemptDispatchState,
  AttemptState,
  DurableDecision,
  ExternalEffect,
  IsoTimestamp,
  ReconciliationCaseState,
  RunState,
  RuntimeSnapshot,
  ThreadState,
  TurnState,
} from "./types.js";

export interface TriggerMessage<TContent = unknown> {
  id: string;
  threadId: string;
  parentMessageId: string | null;
  createdByRunId: string;
  role: "user";
  content: TContent;
  createdAt: IsoTimestamp;
}

/**
 * Complete aggregate required by the atomic create-Run transaction.
 * `thread` is the expected pre-creation Thread state. The repository advances
 * its head and active Run only after all initial records can be inserted.
 */
export interface CreateRunInput<TMessageContent = unknown> {
  thread: ThreadState;
  triggerMessage: TriggerMessage<TMessageContent>;
  run: RunState;
  turn: TurnState;
  action: ActionState;
  clientIdempotencyKey: string | null;
  requestHash: string;
}

export type CreateRunResult =
  | { kind: "created"; runId: string }
  | { kind: "existing"; runId: string };

export interface RunLocator {
  runId: string;
  actionId: string;
}

export interface DueRetryCandidate extends RunLocator {
  retryAt: IsoTimestamp;
}

export interface ExpiredApprovalCandidate extends RunLocator {
  approvalId: string;
  expiresAt: IsoTimestamp;
}

export interface RecoverableAttemptCandidate extends RunLocator {
  attemptId: string;
  actionKind: ActionState["input"]["kind"];
  dispatchState: AttemptDispatchState;
}

export interface PendingEffect {
  effect: ExternalEffect;
  createdAt: IsoTimestamp;
}

export interface LockedRunTransaction {
  /** PostgreSQL time in production; deterministic injected time in tests. */
  readonly databaseNow: IsoTimestamp;

  /** Current transaction-local projection, refreshed after every apply call. */
  readonly snapshot: RuntimeSnapshot;

  /**
   * Atomically apply state changes and enqueue their external Effects. Passing
   * the complete decision prevents a caller from committing an Attempt while
   * accidentally dropping its durable dispatch intent.
   */
  apply(decision: DurableDecision): Promise<void>;
}

/**
 * Aggregate-oriented write port. Implementations must not expose arbitrary
 * per-table updates that can bypass Durable Runtime invariants.
 */
export interface DurableRepository<TMessageContent = unknown> {
  createRun(
    input: CreateRunInput<TMessageContent>,
  ): Promise<CreateRunResult>;

  withLockedRun<T>(
    runId: string,
    operation: (transaction: LockedRunTransaction) => Promise<T>,
  ): Promise<T>;

  locateApproval(approvalId: string): Promise<RunLocator | null>;
  locateReconciliation(
    reconciliationId: string,
  ): Promise<RunLocator | null>;

  findDueRetries(limit: number): Promise<readonly DueRetryCandidate[]>;
  findExpiredApprovals(
    limit: number,
  ): Promise<readonly ExpiredApprovalCandidate[]>;
  findRecoverableAttempts(
    limit: number,
  ): Promise<readonly RecoverableAttemptCandidate[]>;
  findPendingEffects(limit: number): Promise<readonly PendingEffect[]>;
}

export interface DurableRunView {
  thread: ThreadState;
  run: RunState;
  turns: readonly TurnState[];
  actions: readonly ActionState[];
  attempts: readonly AttemptState[];
  approvals: readonly ApprovalState[];
  reconciliations: readonly ReconciliationCaseState[];
}

/** Read-only port for UI and diagnostics. */
export interface DurableQueryRepository<TMessage = unknown> {
  getRun(runId: string): Promise<DurableRunView | null>;
  listMessages(threadId: string): Promise<readonly TMessage[]>;
}

export type DurableStore<
  TCreateMessageContent = unknown,
  TMessageView = unknown,
> = DurableRepository<TCreateMessageContent> &
  DurableQueryRepository<TMessageView>;

export type RetryWakeResult =
  | { kind: "woken"; runId: string; actionId: string }
  | { kind: "ignored"; runId: string; actionId: string }
  | { kind: "failed"; runId: string; actionId: string; error: unknown };
