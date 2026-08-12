# Runloom Development Constraints

## Project workflow

- Discuss and explicitly confirm a module's behavior before implementing it.
- Implement only the currently confirmed scope. Do not preemptively add database schemas, adapters, public APIs, or abstractions for later milestones.
- Before changing an already confirmed invariant or state-machine rule, explain the impact and obtain explicit confirmation.
- Keep changes focused on the current module. Do not perform unrelated refactors or dependency upgrades.
- Do not commit or push unless the user explicitly asks for a version-control checkpoint.

## Terminology and architecture

- The project name is Runloom.
- Core domain language uses `Thread`; do not introduce `Session` as an alias.
- Preserve this dependency direction:

  ```text
  Application / Harness
          -> Durable Runtime
          -> Orchestrator
          -> ModelInvoker / ToolExecutor ports
          <- infrastructure adapters
  ```

- The Orchestrator is a pure state machine. It must not access PostgreSQL, call models or tools, read the system clock, generate IDs, or perform external effects.
- PostgreSQL is the durable source of truth. Do not add Redis, Kafka, or another source of execution truth in the MVP.

## Durable execution invariants

- The identity hierarchy is `Thread -> Run -> Turn -> Action -> Attempt`; an Approval binds to a Tool Action.
- A Thread has at most one active Run in the MVP.
- Each external effect is represented by one Action; each real invocation is represented by a new persisted Attempt.
- External model and tool calls run outside database transactions. Persist intent before the call and persist its resolution in a new short transaction afterward.
- AI SDK adapters and Tool adapters must not retry internally. Retry decisions belong to the Durable Runtime so every real invocation is auditable as an Attempt.
- A tool without an explicit replay-safety classification is treated as non-idempotent and defaults to one attempt.
- Never automatically retry a non-idempotent tool when dispatch or outcome is unknown; transition to reconciliation instead.
- Approval is persisted before any Tool Attempt is created. Approval authorizes execution but does not execute the tool inside the approval transaction.
- Terminal Run states never transition back to a non-terminal state.
- Do not hide an unknown external side effect as an ordinary failure, cancellation, or timeout.

## MVP boundaries

- Do not add multi-worker execution, parallel tools, queued Runs, Steering, Follow-up, multi-agent orchestration, RAG, long-term memory, Redis, or Kafka unless a later design discussion explicitly promotes it into scope.
- PostgreSQL may be selected as the persistence target while tests continue to use deterministic in-memory fakes around explicit ports.

## Testing and quality

- Use TypeScript strict mode and keep domain types free of AI SDK, database, and transport-specific objects.
- Every state transition must have deterministic tests for its normal path and relevant idempotency, cancellation/deadline, concurrency, and crash-recovery edge cases.
- Prefer pure transition tests before repository or adapter integration tests.
- Run `pnpm typecheck` and `pnpm test` before requesting a code checkpoint.

## Documentation and repository hygiene

- Keep confirmed developer constraints in this `AGENTS.md`.
- Runtime specifications, discussion notes, scratch files, and personal knowledge-base material are local working documents unless the user explicitly approves versioning a specific file.
- Do not stage local specifications or notes merely because they are under the repository directory.
- Never commit credentials, `.env` files, generated output, dependency directories, editor state, or Obsidian metadata.
