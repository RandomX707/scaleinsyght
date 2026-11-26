import type { MigrationBuilder } from 'node-pg-migrate';

// Decision 59: a large table's column statistics come from a bounded sample or the database's catalog statistics, not
// a full scan. Such figures are estimates and are stored and shown as estimates (a table's estimated row count is
// marked in its versioned statistics as row_count_estimated).
export function up(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE profiler.field_profiles ADD COLUMN statistics_estimated boolean NOT NULL DEFAULT false;');
  // K13: the ID agent's progress (fields fingerprinted, then fields matched), shown while a profile maps IDs.
  pgm.sql('ALTER TABLE profiler.jobs ADD COLUMN id_steps_planned integer CHECK (id_steps_planned >= 0), ADD COLUMN id_steps_done integer CHECK (id_steps_done >= 0);');
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE profiler.jobs DROP COLUMN id_steps_done, DROP COLUMN id_steps_planned;');
  pgm.sql('ALTER TABLE profiler.field_profiles DROP COLUMN statistics_estimated;');
}
