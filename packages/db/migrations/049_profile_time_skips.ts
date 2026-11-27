import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql("ALTER TABLE profiler.jobs ADD COLUMN time_skips jsonb CHECK (jsonb_typeof(time_skips) = 'array')");
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE profiler.jobs DROP COLUMN time_skips');
}
