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
- AI SDK and Tool adapters do not retry tools or hide retries by default. The interactive TUI may explicitly opt into bounded model-request retries for a still-empty step; Durable Runtime remains the owner of external-effect retry policy and every real invocation must remain auditable as an Attempt.
- A tool without an explicit replay-safety classification is treated as non-idempotent and defaults to one attempt.
- Never automatically retry a non-idempotent tool when dispatch or outcome is unknown; transition to reconciliation instead.
- Approval is persisted before any Tool Attempt is created. Approval authorizes execution but does not execute the tool inside the approval transaction.
- Terminal Run states never transition back to a non-terminal state.
- Do not hide an unknown external side effect as an ordinary failure, cancellation, or timeout.

## MVP boundaries

- Do not add multi-worker execution, parallel tools, queued Runs, Steering, Follow-up, multi-agent orchestration, RAG, long-term memory, Redis, or Kafka unless a later design discussion explicitly promotes it into scope.
- PostgreSQL may be selected as the persistence target while tests continue to use deterministic in-memory fakes around explicit ports.

## Local behavior milestone

- M-Local is a local behavior harness built from `DefaultAgentRuntime`, `AgentLoop`, and transcript-only JSONL snapshots. It does not replace Durable Runtime or provide durable external-effect guarantees.
- `AgentLoop` is the only owner of the model -> tool -> model behavior loop. A future Durable Run Driver may persist and invoke already-decided Actions and Attempts, but must not introduce a second behavior loop.
- M-Local JSONL stores only completed conversation transcripts. Run records and runtime events remain process-local.

## Thin TUI boundary

- M-TUI-thin's Agent execution path only calls `run`, `handle.events`, `handle.result`, and `handle.cancel`; idle input may dispatch an explicitly registered module command without adding a command bus, session object, or second loop.
- TUI may read committed transcript messages from the Store for display, but must never put that history into `RunRequest.messages` or maintain a second messages cache.
- Its visible state is `idle | running(handle)`. While running, ordinary input is rejected as busy rather than queued; when a tool confirmation is pending, input belongs to that confirmation. Only `handle.result` returns the UI to idle.
- TUI confirmation is a single in-memory `beforeToolExecute` hook: `y` allows the current call, `n` returns `TOOL_DENIED`, and any other line keeps waiting. Abort rejects the hook with the abort reason and never becomes a denial. There is no approval queue or remembered `y/n` answer.
- An explicit `/authorize` may grant the next Run automatic `{ allow: true }` for only the listed file tools and workspace-relative path prefixes; all other tools and paths keep the original `y/n` confirmation, with no approval queue.
- Persistent file authorization may come only from explicit `fileAuthorizations` in the TUI config; the config must resolve outside the workspace, rules load at startup, and editing or removing them takes effect after restart. Memory text and transcripts never grant permission.
- Docker Shell sandbox is opt-in through `modules.shell.sandbox`; it mounts only declared workspace paths, uses no network, and never falls back to host execution when Docker is unavailable. `/authorize-shell` is next-Run only; it never creates persistent Shell permission.
- Web fetching is opt-in through `modules.web.enabled`; `web_fetch` is public HTTP(S) GET-only, validates every redirect target and DNS result, carries no cookies or application secrets, and returns bounded text with provenance/truncation. A public hostname whose DNS answer is Clash/Surge fake-ip (`198.18.0.0/15`) is not treated as a private fetch target; IP literals in that range and RFC1918/loopback/link-local/metadata targets stay blocked. `/authorize-web` is exact-origin, next-Run-only permission for `web_fetch`; web content is data, never execution instructions. R3b `web_search` is separately opt-in through `modules.web.search.enabled`, requires `BRAVE_SEARCH_API_KEY`, remains read-only and per-call confirmed, and only discovers sources; factual claims require `web_fetch`. R3c research may select at most two sources per baseline task, must distinguish discovered/verified/partial/failed sources, must cite `finalUrl`, and may claim a saved report only after `write_file` succeeds. Browser automation, login, uploads, and worker web tools are out of scope.
- When idle, a line trimmed to start with `/` is dispatched to the registered command map; commands do not create Runs or transcript messages. Confirmation input has priority over commands, and running or run-starting input is rejected as busy. A command that returns a thenable must finish before the next input line is accepted.
- When older complete turns are omitted from the model prompt, TUI injects a process-local work summary in `prepareModelContext` only. The summary is not written to the transcript or a separate persistence file; reopening the same transcript directory and thread deterministically rebuilds it from that thread's committed messages, without mixing in other threads. This is conversation-context reconstruction, not Durable recovery: uncommitted actions from failed or cancelled Runs and all tool authorizations remain unrestored. Goal text is the original request, not current world state; completed items are short `ok:true` tool receipts. Idle `/history` reads the current thread's committed transcript messages from the Store.
- Context compaction is opt-in through the TUI config's `contextCompaction.enabled`. When enabled, the budget path replaces the R4 eight-turn trimming path and counts instructions, tool definitions, enabled memory, dynamic context, and messages with the versioned `char-half/v1` estimate. It may summarize earlier complete tool interactions, but never splits a tool call from its result or infers permission from a summary. `thread.context.compacted` records share the JSONL file with v1 committed transcripts; Core treats their payload as opaque, and invalid compaction records do not replace a valid transcript. `/compact` is an idle TUI operation with `idle | running | compacting` state, does not create a Run or consume authorization, and Ctrl+C returns it to idle. Compaction is context reconstruction, not Durable recovery; only a summary matching the latest committed transcript prefix is restored.
- R5's TUI model retry is bounded to the explicit interactive adapter option: at most three model requests for a still-empty step, with 250ms then 1s delays; it never retries tools, worker/print runs, authentication failures, partial output, or a tool-call attempt. A non-idempotent tool whose execution outcome is unknown is reported as `TOOL_OUTCOME_UNKNOWN`, stops the current Run, and requires user verification before any new request; explicit `ok:false` and other structured failures remain ordinary tool failures.
- Ctrl+C cancels a running handle and waits for its result; Ctrl+C while idle exits. If startup is still awaiting `runtime.run()`, or stdin closes, record the stop request and cancel as soon as the handle arrives.

## PostgreSQL persistence

- The PostgreSQL adapter lives in `packages/postgres`; Core must not import `pg`, Kysely, migration types, SQLSTATE types, or database row types.
- Use `pg` for pooling, Kysely for typed queries and short transaction callbacks, and `node-pg-migrate` for immutable forward migration history. Never run migrations automatically during application startup.
- Persist current relational state rather than event-sourcing `DurableEvent`. IDs are Runtime-generated non-empty text values; PostgreSQL does not generate domain identities.
- Use strong columns for identity, status, time, versions, scheduling, constraints and frequently queried discriminators. Use versioned JSONB payloads only for JSON content, model/tool data, resolutions, errors and evidence.
- Only Runloom `JsonValue` crosses a JSONB boundary. Do not persist SDK objects, `undefined`, `Date`, `BigInt`, class instances or non-finite numbers.
- Stable request and tool-input hashes use the versioned `jcs-sha256:v1` protocol over RFC 8785 canonical JSON; never hash `jsonb::text`.
- An external Effect and its `Attempt(not_dispatched)` are committed atomically. The Effect remains in `effect_outbox` until a separate transaction records the dispatch boundary and removes the row.
- `EffectDispatcher` is a non-reentrant, single-worker batch service. Outbox scans are hints; the locked Run transaction must revalidate the candidate and commit `dispatched` before invoking an external port.
- ModelInvoker and ToolExecutor are SDK-neutral Core ports. They receive immutable invocation data plus one Runtime-owned `AbortSignal`; they never retry, persist state, create IDs, or decide orchestration policy.
- A Tool invocation is pinned by `toolsetVersion`, `toolName` and `toolCallId`. Do not resolve an active Run against an unversioned current Tool implementation.
- `not_applied` requires proof that no external side effect occurred. Timeouts, connection loss and unclassified Adapter errors are `outcome_unknown`; an unknown non-idempotent Tool always requires reconciliation.
- Persist a Stop Request before aborting an active in-process Attempt. Active AbortControllers are process-local acceleration and never replace durable Stop state.
- Duplicate Outbox writes are idempotent only when their complete Effect payloads match. A conflicting payload is an invariant failure, not `ON CONFLICT DO NOTHING` success.
- PostgreSQL integration tests use the pinned `postgres:18.4-alpine` Testcontainer and the same Repository Contract as the in-memory reference adapter.

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
