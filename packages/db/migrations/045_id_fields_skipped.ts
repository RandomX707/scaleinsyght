import type { MigrationBuilder } from 'node-pg-migrate';

// test_emr (27 Nov 2026): one identifier field's values could not be read within the query time limit and the whole ID
// step failed. Such a field is now skipped and counted (decision 58), and the Profile page says so.
export function up(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE profiler.jobs ADD COLUMN id_fields_skipped integer NOT NULL DEFAULT 0 CHECK (id_fields_skipped >= 0);');
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE profiler.jobs DROP COLUMN id_fields_skipped;');
}
