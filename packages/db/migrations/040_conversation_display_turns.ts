import type { MigrationBuilder } from 'node-pg-migrate';

// Home chat (decision 56): a follow-up that only changes the form of the previous answer ("as a table", "show all") is a
// display turn. It points at the run whose stored answer it reuses and records the form; it holds no result rows
// (non-negotiable 9) and starts no run, plan, query or model call.
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE runs.conversation_display_turns (
      tenant_id text NOT NULL,
      display_turn_id uuid NOT NULL DEFAULT gen_random_uuid(),
      conversation_id uuid NOT NULL,
      principal_id uuid NOT NULL,
      source_run_id uuid NOT NULL,
      form text NOT NULL CHECK (form IN ('table','chart','number','all','top','bottom','sort_name','sort_value')),
      size integer CHECK (size IS NULL OR size BETWEEN 1 AND 100),
      question text NOT NULL CHECK (length(question) BETWEEN 1 AND 500),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id,display_turn_id),
      FOREIGN KEY (tenant_id,source_run_id) REFERENCES runs.runs(tenant_id,run_id),
      FOREIGN KEY (tenant_id,conversation_id) REFERENCES runs.conversations(tenant_id,conversation_id),
      FOREIGN KEY (tenant_id,principal_id) REFERENCES core.users(tenant_id,user_id),
      CHECK ((form IN ('top','bottom')) = (size IS NOT NULL))
    );
    CREATE INDEX runs_conversation_display_turns_conversation ON runs.conversation_display_turns(tenant_id,conversation_id,created_at);
    ALTER TABLE runs.conversation_display_turns ENABLE ROW LEVEL SECURITY;
    ALTER TABLE runs.conversation_display_turns FORCE ROW LEVEL SECURITY;
    CREATE POLICY conversation_display_turns_tenant ON runs.conversation_display_turns
      USING (tenant_id=(SELECT current_setting('app.tenant_id',true)))
      WITH CHECK (tenant_id=(SELECT current_setting('app.tenant_id',true)));
    GRANT SELECT,INSERT ON runs.conversation_display_turns TO si_app;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE runs.conversation_display_turns');
}
