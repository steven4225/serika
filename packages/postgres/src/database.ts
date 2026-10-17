import { Kysely, PostgresDialect, type ColumnType } from "kysely";
import { Pool, type PoolConfig } from "pg";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type Json = ColumnType<unknown, unknown, unknown>;

export interface ThreadTable {
  id: string;
  active_run_id: string | null;
  head_message_id: string | null;
  version: number;
}

export interface RunTable {
  id: string;
  thread_id: string;
  status: string;
  version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
  base_head_message_id: string | null;
  trigger_message_id: string;
  agent_id: string;
  agent_version: string;
  model_id: string;
  instruction_version: string;
  toolset_version: string;
  deadline_at: Timestamp | null;
  max_turns: number;
  max_actions: number;
  terminal_error: Json | null;
  terminal_error_schema_version: number | null;
  client_idempotency_key: string | null;
  request_hash: string;
}

export interface MessageTable {
  id: string;
  thread_id: string;
  parent_message_id: string | null;
  created_by_run_id: string;
  role: string;
  content: Json;
  content_schema_version: number;
  created_at: Timestamp;
}

export interface RunStopRequestTable {
  run_id: string;
  sequence: number;
  reason: string;
  requested_at: Timestamp;
  requested_by: string;
  detail: string | null;
}

export interface TurnTable {
  id: string;
  run_id: string;
  sequence: number;
  version: number;
}

export interface ActionTable {
  id: string;
  run_id: string;
  turn_id: string;
  sequence: number;
  kind: string;
  status: string;
  version: number;
  model_id: string | null;
  message_snapshot_id: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_input: Json | null;
  tool_input_schema_version: number | null;
  input_hash: string | null;
  replay_safety: string | null;
  business_idempotency_key: string | null;
  max_attempts: number;
  attempt_count: number;
  attempt_timeout_ms: number;
  retry_at: Timestamp | null;
  retry_policy: Json;
  resolution_kind: string | null;
  resolution: Json | null;
  resolution_schema_version: number | null;
}

export interface AttemptTable {
  id: string;
  action_id: string;
  sequence: number;
  status: string;
  dispatch_state: string;
  started_at: Timestamp;
  resolved_at: Timestamp | null;
  resolution_kind: string | null;
  resolution: Json | null;
  resolution_schema_version: number | null;
  version: number;
}

export interface ApprovalTable {
  id: string;
  run_id: string;
  action_id: string;
  status: string;
  requested_at: Timestamp;
  expires_at: Timestamp | null;
  resolved_at: Timestamp | null;
  resolved_by: string | null;
  reason: string | null;
  action_input_hash: string;
  version: number;
}

export interface ReconciliationCaseTable {
  id: string;
  run_id: string;
  action_id: string;
  attempt_id: string;
  status: string;
  dispatch_state: string;
  action_input_hash: string;
  business_idempotency_key: string | null;
  opened_at: Timestamp;
  resolution_kind: string | null;
  resolution_disposition: string | null;
  resolution_output: Json | null;
  resolution_evidence: Json | null;
  resolved_at: Timestamp | null;
  resolved_by: string | null;
  resolution_schema_version: number | null;
  version: number;
}

export interface EffectOutboxTable {
  attempt_id: string;
  run_id: string;
  action_id: string;
  effect_kind: string;
  payload: Json;
  payload_schema_version: number;
  created_at: Timestamp;
}

export interface SerikaDatabase {
  threads: ThreadTable;
  runs: RunTable;
  messages: MessageTable;
  run_stop_requests: RunStopRequestTable;
  turns: TurnTable;
  actions: ActionTable;
  attempts: AttemptTable;
  approvals: ApprovalTable;
  reconciliation_cases: ReconciliationCaseTable;
  effect_outbox: EffectOutboxTable;
}

export function createPostgresDatabase(
  config: PoolConfig | Pool,
): Kysely<SerikaDatabase> {
  const pool = config instanceof Pool ? config : new Pool(config);
  return new Kysely<SerikaDatabase>({
    dialect: new PostgresDialect({ pool }),
  });
}
