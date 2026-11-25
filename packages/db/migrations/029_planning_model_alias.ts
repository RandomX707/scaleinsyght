import type { MigrationBuilder } from 'node-pg-migrate';

// Planning has its own model alias (decision 44), configured by MODEL_PLANNING.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE core.model_usage DROP CONSTRAINT model_usage_model_alias_check;
    ALTER TABLE core.model_usage ADD CONSTRAINT model_usage_model_alias_check CHECK (model_alias IN ('cheap','default','planning'));`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE core.model_usage DROP CONSTRAINT model_usage_model_alias_check;
    ALTER TABLE core.model_usage ADD CONSTRAINT model_usage_model_alias_check CHECK (model_alias IN ('cheap','default'));`);
}
