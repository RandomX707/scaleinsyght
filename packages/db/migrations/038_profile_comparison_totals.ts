import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE profiler.jobs ADD COLUMN checked_count integer, ADD COLUMN changed_count integer');
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE profiler.jobs DROP COLUMN checked_count, DROP COLUMN changed_count');
}
