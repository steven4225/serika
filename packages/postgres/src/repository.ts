import {
  applyDecision,
  assertJsonValue,
  assertRuntimeSnapshot,
  DurableRepositoryError,
  type ActionState,
  type ApprovalState,
  type AttemptState,
  type CreateRunInput,
  type CreateRunResult,
  type DueRetryCandidate,
  type DurableDecision,
  type DurableRunView,
  type DurableStore,
  type ExpiredApprovalCandidate,
  type JsonValue,
  type LockedRunTransaction,
  type PendingEffect,
  type ReconciliationCaseState,
  type RecoverableAttemptCandidate,
  type RunLocator,
  type RuntimeSnapshot,
  type ThreadState,
  type TriggerMessage,
} from "@aisdk-agent/core/durable";
import {
  type Kysely,
  sql,
  type Transaction,
  type UpdateResult,
} from "kysely";
import { DatabaseError } from "pg";
import type { RunloomDatabase } from "./database.js";
import {
  actionValues,
  approvalValues,
  attemptValues,
  effectValues,
  mapAction,
  mapApproval,
  mapAttempt,
  mapEffect,
  mapMessage,
  mapReconciliation,
  mapRun,
  mapStopRequest,
  mapThread,
  mapTurn,
  messageValues,
  reconciliationValues,
  runValues,
  threadValues,
  toIso,
  turnValues,
} from "./mappers.js";

type DatabaseExecutor = Kysely<RunloomDatabase> | Transaction<RunloomDatabase>;

export class PostgresDurableRepository
  implements DurableStore<JsonValue, TriggerMessage<JsonValue>>
{
  readonly #db: Kysely<RunloomDatabase>;

  constructor(db: Kysely<RunloomDatabase>) {
    this.#db = db;
  }

  async createRun(
    input: CreateRunInput<JsonValue>,
  ): Promise<CreateRunResult> {
    validateCreateInput(input);
    try {
      return await this.#db.transaction().execute(async (transaction) => {
        await transaction
          .insertInto("threads")
          .values(threadValues(input.thread))
          .onConflict((conflict) => conflict.column("id").doNothing())
          .execute();

        const storedThreadRow = await transaction
          .selectFrom("threads")
          .selectAll()
          .where("id", "=", input.thread.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const storedThread = mapThread(storedThreadRow);

        if (input.clientIdempotencyKey !== null) {
          const existing = await transaction
            .selectFrom("runs")
            .select(["id", "request_hash"])
            .where("thread_id", "=", input.thread.id)
            .where("client_idempotency_key", "=", input.clientIdempotencyKey)
            .executeTakeFirst();
          if (existing) {
            if (existing.request_hash !== input.requestHash) {
              throw new DurableRepositoryError(
                "IDEMPOTENCY_KEY_REUSED",
                "Idempotency key was reused with a different request",
              );
            }
            return { kind: "existing", runId: existing.id };
          }
        }

        if (
          storedThread.version !== input.thread.version ||
          storedThread.headMessageId !== input.thread.headMessageId ||
          storedThread.activeRunId !== input.thread.activeRunId
        ) {
          throw new DurableRepositoryError(
            "THREAD_VERSION_CONFLICT",
            `Thread changed before Run creation: ${input.thread.id}`,
          );
        }
        if (storedThread.activeRunId !== null) {
          throw new DurableRepositoryError(
            "THREAD_BUSY",
            `Thread already has active Run: ${storedThread.activeRunId}`,
          );
        }

        const duplicateRun = await transaction
          .selectFrom("runs")
          .select("id")
          .where("id", "=", input.run.id)
          .executeTakeFirst();
        if (duplicateRun) {
          throw new DurableRepositoryError(
            "RUN_ALREADY_EXISTS",
            `Run already exists: ${input.run.id}`,
          );
        }

        const nextThread: ThreadState = {
          ...storedThread,
          activeRunId: input.run.id,
          headMessageId: input.triggerMessage.id,
          version: storedThread.version + 1,
        };
        const snapshot: RuntimeSnapshot = {
          thread: nextThread,
          run: input.run,
          turn: input.turn,
          action: input.action,
          attempt: null,
          approval: null,
          reconciliation: null,
        };
        assertRuntimeSnapshot(snapshot);

        await transaction.insertInto("runs").values(
          runValues(input.run, {
            clientIdempotencyKey: input.clientIdempotencyKey,
            requestHash: input.requestHash,
          }),
        ).execute();
        await transaction.insertInto("messages").values(
          messageValues(input.triggerMessage),
        ).execute();
        await transaction.insertInto("turns").values(
          turnValues(input.turn),
        ).execute();
        await transaction.insertInto("actions").values(
          actionValues(input.action),
        ).execute();
        await expectOne(
          transaction
            .updateTable("threads")
            .set({
              active_run_id: nextThread.activeRunId,
              head_message_id: nextThread.headMessageId,
              version: nextThread.version,
            })
            .where("id", "=", storedThread.id)
            .where("version", "=", storedThread.version)
            .executeTakeFirst(),
          "Thread changed while creating Run",
        );
        return { kind: "created", runId: input.run.id };
      });
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async withLockedRun<T>(
    runId: string,
    operation: (transaction: LockedRunTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.#db.transaction().execute(async (databaseTransaction) => {
        const initial = await loadRuntimeSnapshot(databaseTransaction, runId, true);
        if (initial === null) {
          throw new DurableRepositoryError(
            "RUN_NOT_FOUND",
            `Run not found: ${runId}`,
          );
        }
        let working: RuntimeSnapshot = initial;
        const nowRow = await sql<{ now: Date }>`select transaction_timestamp() as now`
          .execute(databaseTransaction);
        const databaseNow = toIso(nowRow.rows[0]!.now);
        const lockedTransaction: LockedRunTransaction = {
          databaseNow,
          get snapshot() {
            return structuredClone(working);
          },
          apply: async (decision) => {
            const previous = working;
            const next = applyDecision(previous, decision);
            assertRuntimeSnapshot(next);
            await persistDecision(
              databaseTransaction,
              previous,
              next,
              decision,
              databaseNow,
            );
            working = next;
          },
        };
        return operation(lockedTransaction);
      });
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async locateApproval(approvalId: string): Promise<RunLocator | null> {
    const row = await this.#db
      .selectFrom("approvals")
      .select(["run_id", "action_id"])
      .where("id", "=", approvalId)
      .executeTakeFirst();
    return row ? { runId: row.run_id, actionId: row.action_id } : null;
  }

  async locateReconciliation(
    reconciliationId: string,
  ): Promise<RunLocator | null> {
    const row = await this.#db
      .selectFrom("reconciliation_cases")
      .select(["run_id", "action_id"])
      .where("id", "=", reconciliationId)
      .executeTakeFirst();
    return row ? { runId: row.run_id, actionId: row.action_id } : null;
  }

  async findDueRetries(limit: number): Promise<readonly DueRetryCandidate[]> {
    assertLimit(limit);
    const rows = await this.#db
      .selectFrom("actions")
      .innerJoin("runs", "runs.id", "actions.run_id")
      .select([
        "actions.run_id as run_id",
        "actions.id as action_id",
        "actions.retry_at as retry_at",
      ])
      .where("actions.status", "=", "waiting_retry")
      .where("runs.status", "=", "waiting_retry")
      .where("actions.retry_at", "<=", sql<Date>`transaction_timestamp()`)
      .orderBy("actions.retry_at", "asc")
      .orderBy("actions.id", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      runId: row.run_id,
      actionId: row.action_id,
      retryAt: toIso(row.retry_at!),
    }));
  }

  async findExpiredApprovals(
    limit: number,
  ): Promise<readonly ExpiredApprovalCandidate[]> {
    assertLimit(limit);
    const rows = await this.#db
      .selectFrom("approvals")
      .innerJoin("runs", "runs.id", "approvals.run_id")
      .select([
        "approvals.run_id as run_id",
        "approvals.action_id as action_id",
        "approvals.id as approval_id",
        "approvals.expires_at as expires_at",
      ])
      .where("approvals.status", "=", "pending")
      .where("runs.status", "=", "waiting_approval")
      .where("approvals.expires_at", "is not", null)
      .where("approvals.expires_at", "<=", sql<Date>`transaction_timestamp()`)
      .orderBy("approvals.expires_at", "asc")
      .orderBy("approvals.id", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      runId: row.run_id,
      actionId: row.action_id,
      approvalId: row.approval_id,
      expiresAt: toIso(row.expires_at!),
    }));
  }

  async findRecoverableAttempts(
    limit: number,
  ): Promise<readonly RecoverableAttemptCandidate[]> {
    assertLimit(limit);
    const rows = await this.#db
      .selectFrom("attempts")
      .innerJoin("actions", "actions.id", "attempts.action_id")
      .innerJoin("runs", "runs.id", "actions.run_id")
      .select([
        "actions.run_id as run_id",
        "actions.id as action_id",
        "actions.kind as action_kind",
        "attempts.id as attempt_id",
        "attempts.dispatch_state as dispatch_state",
      ])
      .where("attempts.status", "=", "started")
      .where("actions.status", "=", "executing")
      .where("runs.status", "=", "executing")
      .orderBy("attempts.started_at", "asc")
      .orderBy("attempts.id", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      runId: row.run_id,
      actionId: row.action_id,
      attemptId: row.attempt_id,
      actionKind: row.action_kind as ActionState["input"]["kind"],
      dispatchState: row.dispatch_state as AttemptState["dispatchState"],
    }));
  }

  async findPendingEffects(limit: number): Promise<readonly PendingEffect[]> {
    assertLimit(limit);
    const rows = await this.#db
      .selectFrom("effect_outbox")
      .selectAll()
      .orderBy("created_at", "asc")
      .orderBy("attempt_id", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      effect: mapEffect(row),
      createdAt: toIso(row.created_at),
    }));
  }

  async getRun(runId: string): Promise<DurableRunView | null> {
    const runRow = await this.#db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!runRow) return null;
    const threadRow = await this.#db
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", runRow.thread_id)
      .executeTakeFirstOrThrow();
    const stops = await loadStopRequests(this.#db, runId);
    const turnRows = await this.#db
      .selectFrom("turns")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("sequence", "asc")
      .execute();
    const actionRows = await this.#db
      .selectFrom("actions")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("sequence", "asc")
      .execute();
    const actionIds = actionRows.map((row) => row.id);
    const attempts = actionIds.length === 0
      ? []
      : await this.#db.selectFrom("attempts").selectAll()
          .where("action_id", "in", actionIds).orderBy("started_at", "asc").execute();
    const approvals = actionIds.length === 0
      ? []
      : await this.#db.selectFrom("approvals").selectAll()
          .where("action_id", "in", actionIds).orderBy("requested_at", "asc").execute();
    const reconciliations = actionIds.length === 0
      ? []
      : await this.#db.selectFrom("reconciliation_cases").selectAll()
          .where("action_id", "in", actionIds).orderBy("opened_at", "asc").execute();
    return {
      thread: mapThread(threadRow),
      run: mapRun(runRow, stops),
      turns: turnRows.map(mapTurn),
      actions: actionRows.map(mapAction),
      attempts: attempts.map(mapAttempt),
      approvals: approvals.map(mapApproval),
      reconciliations: reconciliations.map(mapReconciliation),
    };
  }

  async listMessages(
    threadId: string,
  ): Promise<readonly TriggerMessage<JsonValue>[]> {
    const rows = await this.#db
      .selectFrom("messages")
      .selectAll()
      .where("thread_id", "=", threadId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(mapMessage);
  }
}

async function loadRuntimeSnapshot(
  db: DatabaseExecutor,
  runId: string,
  lockRun: boolean,
): Promise<RuntimeSnapshot | null> {
  let runQuery = db.selectFrom("runs").selectAll().where("id", "=", runId);
  if (lockRun) runQuery = runQuery.forUpdate();
  const runRow = await runQuery.executeTakeFirst();
  if (!runRow) return null;
  const threadRow = await db.selectFrom("threads").selectAll()
    .where("id", "=", runRow.thread_id).executeTakeFirstOrThrow();
  const actionRow = await db.selectFrom("actions").selectAll()
    .where("run_id", "=", runId).orderBy("sequence", "desc")
    .limit(1).executeTakeFirstOrThrow();
  const turnRow = await db.selectFrom("turns").selectAll()
    .where("id", "=", actionRow.turn_id).executeTakeFirstOrThrow();
  const attemptRow = await db.selectFrom("attempts").selectAll()
    .where("action_id", "=", actionRow.id).orderBy("sequence", "desc")
    .limit(1).executeTakeFirst();
  const approvalRow = await db.selectFrom("approvals").selectAll()
    .where("action_id", "=", actionRow.id).executeTakeFirst();
  const reconciliationRow = await db.selectFrom("reconciliation_cases").selectAll()
    .where("action_id", "=", actionRow.id).executeTakeFirst();
  const stops = await loadStopRequests(db, runId);
  const snapshot: RuntimeSnapshot = {
    thread: mapThread(threadRow),
    run: mapRun(runRow, stops),
    turn: mapTurn(turnRow),
    action: mapAction(actionRow),
    attempt: attemptRow ? mapAttempt(attemptRow) : null,
    approval: approvalRow ? mapApproval(approvalRow) : null,
    reconciliation: reconciliationRow
      ? mapReconciliation(reconciliationRow)
      : null,
  };
  assertRuntimeSnapshot(snapshot);
  return snapshot;
}

async function loadStopRequests(
  db: DatabaseExecutor,
  runId: string,
) {
  const rows = await db.selectFrom("run_stop_requests").selectAll()
    .where("run_id", "=", runId).orderBy("sequence", "asc").execute();
  return rows.map(mapStopRequest);
}

async function persistDecision(
  db: Transaction<RunloomDatabase>,
  previous: RuntimeSnapshot,
  next: RuntimeSnapshot,
  decision: DurableDecision,
  databaseNow: string,
): Promise<void> {
  if (next.thread.version !== previous.thread.version) {
    await expectOne(db.updateTable("threads").set({
      active_run_id: next.thread.activeRunId,
      head_message_id: next.thread.headMessageId,
      version: next.thread.version,
    }).where("id", "=", previous.thread.id)
      .where("version", "=", previous.thread.version).executeTakeFirst(),
    "Thread version conflict");
  }
  if (next.run.version !== previous.run.version) {
    await expectOne(db.updateTable("runs").set({
      status: next.run.status,
      version: next.run.version,
      updated_at: new Date(next.run.updatedAt),
      terminal_error: next.run.terminalError,
      terminal_error_schema_version: next.run.terminalError === null ? null : 1,
    }).where("id", "=", previous.run.id)
      .where("version", "=", previous.run.version).executeTakeFirst(),
    "Run version conflict");
  }
  if (next.action.version !== previous.action.version) {
    const values = actionValues(next.action);
    await expectOne(db.updateTable("actions").set({
      status: values.status,
      version: values.version,
      attempt_count: values.attempt_count,
      retry_at: values.retry_at,
      resolution_kind: values.resolution_kind,
      resolution: values.resolution,
      resolution_schema_version: values.resolution_schema_version,
    }).where("id", "=", previous.action.id)
      .where("version", "=", previous.action.version).executeTakeFirst(),
    "Action version conflict");
  }
  await persistAttempt(db, previous.attempt, next.attempt);
  await persistApproval(db, previous.approval, next.approval);
  await persistReconciliation(db, previous.reconciliation, next.reconciliation);
  const oldStops = [
    ...(previous.run.stopRequest ? [previous.run.stopRequest] : []),
    ...previous.run.laterStopRequests,
  ];
  const newStops = [
    ...(next.run.stopRequest ? [next.run.stopRequest] : []),
    ...next.run.laterStopRequests,
  ];
  for (let index = oldStops.length; index < newStops.length; index += 1) {
    const request = newStops[index]!;
    await db.insertInto("run_stop_requests").values({
      run_id: next.run.id,
      sequence: index + 1,
      reason: request.reason,
      requested_at: new Date(request.requestedAt),
      requested_by: request.requestedBy,
      detail: request.detail,
    }).execute();
  }
  for (const effect of decision.effects) {
    await db.insertInto("effect_outbox").values(
      effectValues(effect, databaseNow),
    ).onConflict((conflict) => conflict.column("attempt_id").doNothing()).execute();
  }
  for (const event of decision.events) {
    if (event.type === "attempt_dispatch_recorded") {
      await db.deleteFrom("effect_outbox")
        .where("attempt_id", "=", event.attemptId).execute();
    }
  }
}

async function persistAttempt(
  db: Transaction<RunloomDatabase>,
  previous: AttemptState | null,
  next: AttemptState | null,
): Promise<void> {
  if (next === null) return;
  if (previous === null || previous.id !== next.id) {
    await db.insertInto("attempts").values(attemptValues(next)).execute();
    return;
  }
  if (previous.version === next.version) return;
  const values = attemptValues(next);
  await expectOne(db.updateTable("attempts").set({
    status: values.status,
    dispatch_state: values.dispatch_state,
    resolved_at: values.resolved_at,
    resolution_kind: values.resolution_kind,
    resolution: values.resolution,
    resolution_schema_version: values.resolution_schema_version,
    version: values.version,
  }).where("id", "=", previous.id).where("version", "=", previous.version)
    .executeTakeFirst(), "Attempt version conflict");
}

async function persistApproval(
  db: Transaction<RunloomDatabase>,
  previous: ApprovalState | null,
  next: ApprovalState | null,
): Promise<void> {
  if (next === null) return;
  if (previous === null) {
    await db.insertInto("approvals").values(approvalValues(next)).execute();
    return;
  }
  if (previous.version === next.version) return;
  const values = approvalValues(next);
  await expectOne(db.updateTable("approvals").set({
    status: values.status,
    resolved_at: values.resolved_at,
    resolved_by: values.resolved_by,
    reason: values.reason,
    version: values.version,
  }).where("id", "=", previous.id).where("version", "=", previous.version)
    .executeTakeFirst(), "Approval version conflict");
}

async function persistReconciliation(
  db: Transaction<RunloomDatabase>,
  previous: ReconciliationCaseState | null,
  next: ReconciliationCaseState | null,
): Promise<void> {
  if (next === null) return;
  if (previous === null) {
    await db.insertInto("reconciliation_cases")
      .values(reconciliationValues(next)).execute();
    return;
  }
  if (previous.version === next.version) return;
  const values = reconciliationValues(next);
  await expectOne(db.updateTable("reconciliation_cases").set({
    status: values.status,
    resolution_kind: values.resolution_kind,
    resolution_disposition: values.resolution_disposition,
    resolution_output: values.resolution_output,
    resolution_evidence: values.resolution_evidence,
    resolved_at: values.resolved_at,
    resolved_by: values.resolved_by,
    resolution_schema_version: values.resolution_schema_version,
    version: values.version,
  }).where("id", "=", previous.id).where("version", "=", previous.version)
    .executeTakeFirst(), "Reconciliation version conflict");
}

async function expectOne(
  result: Promise<UpdateResult> | UpdateResult,
  message: string,
): Promise<void> {
  const resolved = await result;
  if (resolved.numUpdatedRows !== 1n) {
    throw new DurableRepositoryError("TRANSACTION_CONFLICT", message);
  }
}

function validateCreateInput(input: CreateRunInput<JsonValue>): void {
  assertJsonValue(input.triggerMessage.content, "triggerMessage.content");
  if (
    input.run.threadId !== input.thread.id ||
    input.turn.runId !== input.run.id ||
    input.action.runId !== input.run.id ||
    input.action.turnId !== input.turn.id ||
    input.triggerMessage.threadId !== input.thread.id ||
    input.triggerMessage.createdByRunId !== input.run.id ||
    input.triggerMessage.id !== input.run.triggerMessageId ||
    input.triggerMessage.parentMessageId !== input.run.baseHeadMessageId ||
    input.run.baseHeadMessageId !== input.thread.headMessageId ||
    input.thread.activeRunId !== null ||
    input.run.status !== "ready" ||
    input.action.status !== "ready" ||
    input.action.attemptCount !== 0 ||
    input.action.resolution !== null
  ) {
    throw new DurableRepositoryError(
      "INVALID_CREATE_RUN",
      "Initial Thread, Message, Run, Turn and Action are inconsistent",
    );
  }
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("scan limit must be a positive integer");
  }
}

function mapDatabaseError(error: unknown): unknown {
  if (error instanceof DurableRepositoryError) return error;
  if (!(error instanceof DatabaseError)) return error;
  if (error.code === "23505") {
    if (error.constraint === "runs_one_active_per_thread") {
      return new DurableRepositoryError("THREAD_BUSY", "Thread already has an active Run", { cause: error });
    }
    if (error.constraint === "runs_client_idempotency_key") {
      return new DurableRepositoryError("IDEMPOTENCY_KEY_REUSED", "Idempotency key conflict", { cause: error });
    }
    if (error.constraint === "runs_pkey") {
      return new DurableRepositoryError("RUN_ALREADY_EXISTS", "Run already exists", { cause: error });
    }
    return new DurableRepositoryError("CONSTRAINT_VIOLATION", "Database uniqueness constraint failed", { cause: error });
  }
  if (error.code === "23503" || error.code === "23514") {
    return new DurableRepositoryError("CONSTRAINT_VIOLATION", "Database constraint failed", { cause: error });
  }
  if (error.code === "40001" || error.code === "40P01") {
    return new DurableRepositoryError("TRANSACTION_CONFLICT", "Database transaction conflicted", { cause: error });
  }
  if (error.code === "55P03") {
    return new DurableRepositoryError("LOCK_NOT_AVAILABLE", "Database lock was not available", { cause: error });
  }
  return new DurableRepositoryError("DATABASE_ERROR", "PostgreSQL operation failed", { cause: error });
}
