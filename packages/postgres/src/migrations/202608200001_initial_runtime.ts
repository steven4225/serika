import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE threads (
      id text PRIMARY KEY CHECK (length(id) > 0),
      active_run_id text,
      head_message_id text,
      version integer NOT NULL CHECK (version >= 0)
    );

    CREATE TABLE runs (
      id text PRIMARY KEY CHECK (length(id) > 0),
      thread_id text NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
      status text NOT NULL CHECK (status IN (
        'ready', 'executing', 'waiting_approval', 'waiting_retry',
        'requires_reconciliation', 'completed', 'failed', 'cancelled', 'timed_out'
      )),
      version integer NOT NULL CHECK (version >= 0),
      created_at timestamptz(3) NOT NULL,
      updated_at timestamptz(3) NOT NULL,
      base_head_message_id text,
      trigger_message_id text NOT NULL,
      agent_id text NOT NULL,
      agent_version text NOT NULL,
      model_id text NOT NULL,
      instruction_version text NOT NULL,
      toolset_version text NOT NULL,
      deadline_at timestamptz(3),
      max_turns integer NOT NULL CHECK (max_turns >= 1),
      max_actions integer NOT NULL CHECK (max_actions >= 1),
      terminal_error jsonb,
      terminal_error_schema_version smallint,
      client_idempotency_key text,
      request_hash text NOT NULL,
      UNIQUE (id, thread_id),
      CHECK (
        (terminal_error IS NULL AND terminal_error_schema_version IS NULL)
        OR
        (terminal_error IS NOT NULL AND terminal_error_schema_version IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX runs_one_active_per_thread
      ON runs(thread_id)
      WHERE status IN (
        'ready', 'executing', 'waiting_approval', 'waiting_retry',
        'requires_reconciliation'
      );

    CREATE UNIQUE INDEX runs_client_idempotency_key
      ON runs(thread_id, client_idempotency_key)
      WHERE client_idempotency_key IS NOT NULL;

    CREATE TABLE messages (
      id text PRIMARY KEY CHECK (length(id) > 0),
      thread_id text NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
      parent_message_id text,
      created_by_run_id text NOT NULL,
      role text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content jsonb NOT NULL,
      content_schema_version smallint NOT NULL CHECK (content_schema_version >= 1),
      created_at timestamptz(3) NOT NULL,
      UNIQUE (id, thread_id),
      CONSTRAINT messages_parent_fk
        FOREIGN KEY (parent_message_id)
        REFERENCES messages(id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT messages_created_by_run_fk
        FOREIGN KEY (created_by_run_id, thread_id)
        REFERENCES runs(id, thread_id)
        DEFERRABLE INITIALLY DEFERRED
    );

    ALTER TABLE runs ADD CONSTRAINT runs_base_head_message_fk
      FOREIGN KEY (base_head_message_id, thread_id)
      REFERENCES messages(id, thread_id)
      DEFERRABLE INITIALLY DEFERRED;

    ALTER TABLE runs ADD CONSTRAINT runs_trigger_message_fk
      FOREIGN KEY (trigger_message_id, thread_id)
      REFERENCES messages(id, thread_id)
      DEFERRABLE INITIALLY DEFERRED;

    ALTER TABLE threads ADD CONSTRAINT threads_head_message_fk
      FOREIGN KEY (head_message_id)
      REFERENCES messages(id)
      DEFERRABLE INITIALLY DEFERRED;

    ALTER TABLE threads ADD CONSTRAINT threads_active_run_fk
      FOREIGN KEY (active_run_id, id)
      REFERENCES runs(id, thread_id)
      DEFERRABLE INITIALLY DEFERRED;

    CREATE TABLE run_stop_requests (
      run_id text NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      sequence integer NOT NULL CHECK (sequence >= 1),
      reason text NOT NULL CHECK (reason IN ('cancel', 'deadline')),
      requested_at timestamptz(3) NOT NULL,
      requested_by text NOT NULL,
      detail text,
      PRIMARY KEY (run_id, sequence)
    );

    CREATE TABLE turns (
      id text PRIMARY KEY CHECK (length(id) > 0),
      run_id text NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      sequence integer NOT NULL CHECK (sequence >= 1),
      version integer NOT NULL CHECK (version >= 0),
      UNIQUE (run_id, sequence),
      UNIQUE (id, run_id)
    );

    CREATE TABLE actions (
      id text PRIMARY KEY CHECK (length(id) > 0),
      run_id text NOT NULL,
      turn_id text NOT NULL,
      sequence integer NOT NULL CHECK (sequence >= 1),
      kind text NOT NULL CHECK (kind IN ('invoke_model', 'execute_tool')),
      status text NOT NULL CHECK (status IN (
        'ready', 'executing', 'waiting_approval', 'waiting_retry',
        'requires_reconciliation', 'resolved'
      )),
      version integer NOT NULL CHECK (version >= 0),
      model_id text,
      message_snapshot_id text,
      tool_name text,
      tool_call_id text,
      tool_input jsonb,
      tool_input_schema_version smallint,
      input_hash text,
      replay_safety text CHECK (replay_safety IN (
        'read_only', 'naturally_idempotent', 'idempotency_keyed', 'non_idempotent'
      )),
      business_idempotency_key text,
      max_attempts integer NOT NULL CHECK (max_attempts >= 1),
      attempt_count integer NOT NULL CHECK (attempt_count >= 0),
      attempt_timeout_ms integer NOT NULL CHECK (attempt_timeout_ms > 0),
      retry_at timestamptz(3),
      retry_policy jsonb NOT NULL,
      resolution_kind text CHECK (resolution_kind IN (
        'model_result', 'tool_result', 'not_executed', 'runtime_failure'
      )),
      resolution jsonb,
      resolution_schema_version smallint,
      UNIQUE (run_id, sequence),
      UNIQUE (id, run_id),
      CONSTRAINT actions_turn_fk
        FOREIGN KEY (turn_id, run_id) REFERENCES turns(id, run_id) ON DELETE RESTRICT,
      CHECK (
        (kind = 'invoke_model'
          AND model_id IS NOT NULL AND message_snapshot_id IS NOT NULL
          AND tool_name IS NULL AND tool_call_id IS NULL AND tool_input IS NULL
          AND tool_input_schema_version IS NULL AND input_hash IS NULL
          AND replay_safety IS NULL AND business_idempotency_key IS NULL)
        OR
        (kind = 'execute_tool'
          AND model_id IS NULL AND message_snapshot_id IS NULL
          AND tool_name IS NOT NULL AND tool_call_id IS NOT NULL
          AND tool_input IS NOT NULL AND tool_input_schema_version IS NOT NULL
          AND input_hash IS NOT NULL AND replay_safety IS NOT NULL)
      ),
      CHECK (replay_safety <> 'idempotency_keyed' OR business_idempotency_key IS NOT NULL),
      CHECK (
        (status = 'waiting_retry' AND retry_at IS NOT NULL)
        OR
        (status <> 'waiting_retry' AND retry_at IS NULL)
      ),
      CHECK (
        (status = 'resolved' AND resolution_kind IS NOT NULL
          AND resolution IS NOT NULL AND resolution_schema_version IS NOT NULL)
        OR
        (status <> 'resolved' AND resolution_kind IS NULL
          AND resolution IS NULL AND resolution_schema_version IS NULL)
      )
    );

    CREATE INDEX actions_due_retry
      ON actions(retry_at, id)
      WHERE status = 'waiting_retry';

    CREATE TABLE attempts (
      id text PRIMARY KEY CHECK (length(id) > 0),
      action_id text NOT NULL REFERENCES actions(id) ON DELETE RESTRICT,
      sequence integer NOT NULL CHECK (sequence >= 1),
      status text NOT NULL CHECK (status IN ('started', 'resolved')),
      dispatch_state text NOT NULL CHECK (dispatch_state IN (
        'not_dispatched', 'dispatched', 'response_received', 'unknown'
      )),
      started_at timestamptz(3) NOT NULL,
      resolved_at timestamptz(3),
      resolution_kind text CHECK (resolution_kind IN (
        'completed', 'known_failure', 'safely_aborted',
        'interrupted', 'outcome_unknown'
      )),
      resolution jsonb,
      resolution_schema_version smallint,
      version integer NOT NULL CHECK (version >= 0),
      UNIQUE (action_id, sequence),
      UNIQUE (id, action_id),
      CHECK (
        (status = 'started' AND resolved_at IS NULL AND resolution_kind IS NULL
          AND resolution IS NULL AND resolution_schema_version IS NULL)
        OR
        (status = 'resolved' AND resolved_at IS NOT NULL AND resolution_kind IS NOT NULL
          AND resolution IS NOT NULL AND resolution_schema_version IS NOT NULL)
      )
    );

    CREATE INDEX attempts_recoverable
      ON attempts(started_at, id)
      WHERE status = 'started';

    CREATE TABLE approvals (
      id text PRIMARY KEY CHECK (length(id) > 0),
      run_id text NOT NULL,
      action_id text NOT NULL UNIQUE,
      status text NOT NULL CHECK (status IN (
        'pending', 'approved', 'rejected', 'expired', 'cancelled'
      )),
      requested_at timestamptz(3) NOT NULL,
      expires_at timestamptz(3),
      resolved_at timestamptz(3),
      resolved_by text,
      reason text,
      action_input_hash text NOT NULL,
      version integer NOT NULL CHECK (version >= 0),
      CONSTRAINT approvals_action_fk
        FOREIGN KEY (action_id, run_id) REFERENCES actions(id, run_id) ON DELETE RESTRICT,
      CHECK (
        (status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL)
        OR
        (status <> 'pending' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
      )
    );

    CREATE INDEX approvals_due_expiry
      ON approvals(expires_at, id)
      WHERE status = 'pending' AND expires_at IS NOT NULL;

    CREATE TABLE reconciliation_cases (
      id text PRIMARY KEY CHECK (length(id) > 0),
      run_id text NOT NULL,
      action_id text NOT NULL,
      attempt_id text NOT NULL UNIQUE,
      status text NOT NULL CHECK (status IN ('open', 'resolved')),
      dispatch_state text NOT NULL CHECK (dispatch_state IN ('dispatched', 'unknown')),
      action_input_hash text NOT NULL,
      business_idempotency_key text,
      opened_at timestamptz(3) NOT NULL,
      resolution_kind text CHECK (resolution_kind IN (
        'effect_succeeded', 'effect_failed', 'effect_not_applied'
      )),
      resolution_disposition text CHECK (resolution_disposition IN ('retry', 'return_error')),
      resolution_output jsonb,
      resolution_evidence jsonb,
      resolved_at timestamptz(3),
      resolved_by text,
      resolution_schema_version smallint,
      version integer NOT NULL CHECK (version >= 0),
      CONSTRAINT reconciliation_action_fk
        FOREIGN KEY (action_id, run_id) REFERENCES actions(id, run_id) ON DELETE RESTRICT,
      CONSTRAINT reconciliation_attempt_fk
        FOREIGN KEY (attempt_id, action_id) REFERENCES attempts(id, action_id) ON DELETE RESTRICT,
      CHECK (
        (status = 'open' AND resolution_kind IS NULL AND resolution_disposition IS NULL
          AND resolution_output IS NULL AND resolution_evidence IS NULL
          AND resolved_at IS NULL AND resolved_by IS NULL
          AND resolution_schema_version IS NULL)
        OR
        (status = 'resolved' AND resolution_kind IS NOT NULL
          AND resolution_output IS NOT NULL AND resolution_evidence IS NOT NULL
          AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
          AND resolution_schema_version IS NOT NULL)
      ),
      CHECK (
        (resolution_kind = 'effect_not_applied' AND resolution_disposition IS NOT NULL)
        OR
        (resolution_kind IS DISTINCT FROM 'effect_not_applied' AND resolution_disposition IS NULL)
      )
    );

    CREATE TABLE effect_outbox (
      attempt_id text PRIMARY KEY,
      run_id text NOT NULL,
      action_id text NOT NULL,
      effect_kind text NOT NULL CHECK (effect_kind IN ('invoke_model', 'execute_tool')),
      payload jsonb NOT NULL,
      payload_schema_version smallint NOT NULL CHECK (payload_schema_version >= 1),
      created_at timestamptz(3) NOT NULL,
      CONSTRAINT effect_outbox_attempt_fk
        FOREIGN KEY (attempt_id, action_id) REFERENCES attempts(id, action_id) ON DELETE RESTRICT,
      CONSTRAINT effect_outbox_action_fk
        FOREIGN KEY (action_id, run_id) REFERENCES actions(id, run_id) ON DELETE RESTRICT
    );

    CREATE INDEX effect_outbox_pending ON effect_outbox(created_at, attempt_id);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    DROP TABLE IF EXISTS effect_outbox CASCADE;
    DROP TABLE IF EXISTS reconciliation_cases CASCADE;
    DROP TABLE IF EXISTS approvals CASCADE;
    DROP TABLE IF EXISTS attempts CASCADE;
    DROP TABLE IF EXISTS actions CASCADE;
    DROP TABLE IF EXISTS turns CASCADE;
    DROP TABLE IF EXISTS run_stop_requests CASCADE;
    DROP TABLE IF EXISTS messages CASCADE;
    DROP TABLE IF EXISTS runs CASCADE;
    DROP TABLE IF EXISTS threads CASCADE;
  `);
}
