import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  DurableRuntimeCoordinator,
  ApprovalExpiryScheduler,
  type RuntimeSnapshot,
} from "@aisdk-agent/core/durable";
import {
  createContractRunInput,
  runDurableRepositoryContract,
} from "@aisdk-agent/core/durable/repository-contract";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql, type Kysely } from "kysely";
import { DatabaseError } from "pg";
import { createPostgresDatabase, type RunloomDatabase } from "./database.js";
import { runMigrations } from "./migrations.js";
import { actionValues, approvalValues, runValues } from "./mappers.js";
import { PostgresDurableRepository } from "./repository.js";

let container: StartedPostgreSqlContainer;
let database: Kysely<RunloomDatabase>;
let databaseUrl: string;

before(async () => {
  container = await new PostgreSqlContainer("postgres:18.4-alpine")
    .withDatabase("runloom_test")
    .withUsername("runloom")
    .withPassword("runloom")
    .start();
  databaseUrl = container.getConnectionUri();
  await runMigrations({ databaseUrl });
  database = createPostgresDatabase({ connectionString: databaseUrl, max: 8 });
});

after(async () => {
  await database?.destroy();
  await container?.stop();
});

runDurableRepositoryContract("PostgreSQL", async () => {
  await resetRuntimeTables();
  const repository = new PostgresDurableRepository(database);
  return {
    repository,
    readSnapshot: async (runId) => {
      const view = await repository.getRun(runId);
      if (!view) return null;
      return {
        thread: view.thread,
        run: view.run,
        turn: view.turns.at(-1)!,
        action: view.actions.at(-1)!,
        attempt: view.attempts.at(-1) ?? null,
        approval: view.approvals.at(-1) ?? null,
        reconciliation: view.reconciliations.at(-1) ?? null,
      } satisfies RuntimeSnapshot;
    },
  };
});

describe("PostgreSQL durable behavior", () => {
  it("applies the complete migration history idempotently", async () => {
    await runMigrations({ databaseUrl });
    const result = await sql<{ table_name: string }>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'threads', 'messages', 'runs', 'run_stop_requests', 'turns',
          'actions', 'attempts', 'approvals', 'reconciliation_cases',
          'effect_outbox'
        )
    `.execute(database);
    assert.equal(result.rows.length, 10);
  });

  it("restores an undispatched Effect through a new pool", async () => {
    await resetRuntimeTables();
    const first = new PostgresDurableRepository(database);
    await first.createRun(createContractRunInput());
    await new DurableRuntimeCoordinator(first).transact(
      "contract-run-1",
      ({ databaseNow }) => ({
        type: "start_action",
        now: databaseNow,
        attemptId: "contract-attempt-1",
      }),
    );

    const restartedDatabase = createPostgresDatabase({
      connectionString: databaseUrl,
      max: 2,
    });
    try {
      const restarted = new PostgresDurableRepository(restartedDatabase);
      const pending = await restarted.findPendingEffects(10);
      assert.equal(pending[0]?.effect.attemptId, "contract-attempt-1");
      assert.equal((await restarted.getRun("contract-run-1"))?.run.status, "executing");
    } finally {
      await restartedDatabase.destroy();
    }
  });

  it("uses database time when scanning due retries", async () => {
    await resetRuntimeTables();
    const repository = new PostgresDurableRepository(database);
    await repository.createRun(createContractRunInput());
    const coordinator = new DurableRuntimeCoordinator(repository);
    await coordinator.transact("contract-run-1", ({ databaseNow }) => ({
      type: "start_action",
      now: databaseNow,
      attemptId: "contract-attempt-1",
    }));
    await coordinator.transact("contract-run-1", ({ databaseNow }) => ({
      type: "resolve_attempt",
      now: databaseNow,
      attemptId: "contract-attempt-1",
      resolution: {
        kind: "known_failure",
        failure: {
          code: "MODEL_RATE_LIMIT",
          message: "rate limited",
          retryable: true,
        },
      },
      retryAt: databaseNow,
    }));
    const due = await repository.findDueRetries(10);
    assert.equal(due[0]?.runId, "contract-run-1");
    assert.equal(due[0]?.actionId, "contract-action-1");
  });

  it("locates and expires a persisted Approval", async () => {
    await resetRuntimeTables();
    const repository = new PostgresDurableRepository(database);
    const input = createContractRunInput();
    await repository.createRun(input);
    const toolAction = {
      ...input.action,
      status: "waiting_approval" as const,
      input: {
        kind: "execute_tool" as const,
        toolName: "send_email",
        toolCallId: "tool-call-1",
        input: { to: "person@example.com" },
        inputHash: "jcs-sha256:v1:tool-input",
        replaySafety: "non_idempotent" as const,
        businessIdempotencyKey: null,
      },
    };
    await database.transaction().execute(async (transaction) => {
      await transaction.deleteFrom("actions")
        .where("id", "=", input.action.id).execute();
      await transaction.insertInto("actions").values(actionValues(toolAction)).execute();
      await transaction.updateTable("runs")
        .set({ status: "waiting_approval" })
        .where("id", "=", input.run.id).execute();
      await transaction.insertInto("approvals").values(approvalValues({
        id: "approval-1",
        runId: input.run.id,
        actionId: input.action.id,
        status: "pending",
        requestedAt: input.run.createdAt,
        expiresAt: input.run.createdAt,
        resolvedAt: null,
        resolvedBy: null,
        reason: null,
        actionInputHash: "jcs-sha256:v1:tool-input",
        version: 0,
      })).execute();
    });

    assert.deepEqual(await repository.locateApproval("approval-1"), {
      runId: input.run.id,
      actionId: input.action.id,
    });
    assert.equal((await repository.findExpiredApprovals(10))[0]?.approvalId, "approval-1");
    await new ApprovalExpiryScheduler({ repository }).tick();
    const view = await repository.getRun(input.run.id);
    assert.equal(view?.approvals[0]?.status, "expired");
    assert.equal(view?.actions[0]?.resolution?.kind, "not_executed");
  });

  it("persists and resolves a Reconciliation case", async () => {
    await resetRuntimeTables();
    const repository = new PostgresDurableRepository(database);
    const input = createContractRunInput();
    input.action.input = {
      kind: "execute_tool",
      toolName: "send_email",
      toolCallId: "tool-call-1",
      input: { to: "person@example.com" },
      inputHash: "jcs-sha256:v1:tool-input",
      replaySafety: "non_idempotent",
      businessIdempotencyKey: null,
    };
    input.action.retryPolicy = { ...input.action.retryPolicy, maxAttempts: 1 };
    await repository.createRun(input);
    const coordinator = new DurableRuntimeCoordinator(repository);
    await coordinator.transact(input.run.id, ({ databaseNow }) => ({
      type: "start_action",
      now: databaseNow,
      attemptId: "attempt-1",
    }));
    await coordinator.transact(input.run.id, ({ databaseNow }) => ({
      type: "record_dispatch",
      now: databaseNow,
      attemptId: "attempt-1",
      dispatchState: "unknown",
    }));
    await coordinator.transact(input.run.id, ({ databaseNow }) => ({
      type: "resolve_attempt",
      now: databaseNow,
      attemptId: "attempt-1",
      resolution: {
        kind: "outcome_unknown",
        failure: {
          code: "TOOL_OUTCOME_UNKNOWN",
          message: "connection ended after dispatch",
          retryable: true,
        },
      },
      reconciliationId: "reconciliation-1",
    }));
    assert.deepEqual(
      await repository.locateReconciliation("reconciliation-1"),
      { runId: input.run.id, actionId: input.action.id },
    );
    await coordinator.transact(input.run.id, ({ databaseNow }) => ({
      type: "resolve_reconciliation",
      now: databaseNow,
      reconciliationId: "reconciliation-1",
      resolvedBy: "operator-1",
      evidence: { providerLookup: "not_found" },
      outcome: {
        kind: "effect_not_applied",
        disposition: "retry",
      },
    }));
    const view = await repository.getRun(input.run.id);
    assert.equal(view?.reconciliations[0]?.status, "resolved");
    assert.equal(view?.reconciliations[0]?.resolution?.disposition, "retry");
    assert.equal(view?.actions[0]?.status, "ready");
  });

  it("enforces one non-terminal Run per Thread in PostgreSQL", async () => {
    await resetRuntimeTables();
    const repository = new PostgresDurableRepository(database);
    await repository.createRun(createContractRunInput());
    const view = await repository.getRun("contract-run-1");
    assert.ok(view);
    await assert.rejects(
      database.insertInto("runs").values(
        runValues(
          {
            ...view.run,
            id: "illegal-second-run",
            triggerMessageId: "contract-message-1",
          },
          {
            clientIdempotencyKey: "illegal-second-key",
            requestHash: "jcs-sha256:v1:illegal-second-request",
          },
        ),
      ).execute(),
      (error: unknown) =>
        error instanceof DatabaseError &&
        error.constraint === "runs_one_active_per_thread",
    );
  });
});

async function resetRuntimeTables(): Promise<void> {
  await sql`
    TRUNCATE TABLE
      effect_outbox,
      reconciliation_cases,
      approvals,
      attempts,
      actions,
      turns,
      run_stop_requests,
      messages,
      runs,
      threads
    CASCADE
  `.execute(database);
}
