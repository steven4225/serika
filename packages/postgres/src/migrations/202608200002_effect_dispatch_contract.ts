import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE attempts
      DROP CONSTRAINT attempts_resolution_kind_check;

    UPDATE attempts
    SET
      resolution_kind = 'outcome_unknown',
      resolution = jsonb_set(
        jsonb_set(
          resolution,
          '{kind}',
          to_jsonb('outcome_unknown'::text),
          false
        ),
        '{legacyResolutionKind}',
        to_jsonb('known_failure'::text),
        true
      )
    WHERE resolution_kind = 'known_failure';

    ALTER TABLE attempts
      ADD CONSTRAINT attempts_resolution_kind_check
      CHECK (resolution_kind IN (
        'completed', 'not_applied', 'safely_aborted',
        'interrupted', 'outcome_unknown'
      ));

    UPDATE effect_outbox AS effect
    SET
      payload = jsonb_set(
        jsonb_set(
          effect.payload,
          '{toolsetVersion}',
          to_jsonb(runs.toolset_version),
          true
        ),
        '{toolCallId}',
        to_jsonb(actions.tool_call_id),
        true
      ),
      payload_schema_version = 2
    FROM actions
    JOIN runs ON runs.id = actions.run_id
    WHERE effect.action_id = actions.id
      AND effect.effect_kind = 'execute_tool';

    UPDATE effect_outbox
    SET payload_schema_version = 2
    WHERE effect_kind = 'invoke_model';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    UPDATE effect_outbox
    SET
      payload = CASE
        WHEN effect_kind = 'execute_tool'
          THEN payload - 'toolsetVersion' - 'toolCallId'
        ELSE payload
      END,
      payload_schema_version = 1;

    ALTER TABLE attempts
      DROP CONSTRAINT attempts_resolution_kind_check;

    UPDATE attempts
    SET
      resolution_kind = 'known_failure',
      resolution = jsonb_set(
        resolution - 'legacyResolutionKind',
        '{kind}',
        to_jsonb('known_failure'::text),
        false
      )
    WHERE resolution_kind = 'outcome_unknown'
      AND resolution ->> 'legacyResolutionKind' = 'known_failure';

    UPDATE attempts
    SET
      resolution_kind = 'known_failure',
      resolution = jsonb_set(
        resolution,
        '{kind}',
        to_jsonb('known_failure'::text),
        false
      )
    WHERE resolution_kind = 'not_applied';

    ALTER TABLE attempts
      ADD CONSTRAINT attempts_resolution_kind_check
      CHECK (resolution_kind IN (
        'completed', 'known_failure', 'safely_aborted',
        'interrupted', 'outcome_unknown'
      ));
  `);
}
