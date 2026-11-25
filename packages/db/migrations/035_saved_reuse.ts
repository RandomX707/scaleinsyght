import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE runs.runs ADD COLUMN saved_reuse boolean NOT NULL DEFAULT false');
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE runs.runs DROP COLUMN saved_reuse');
}
