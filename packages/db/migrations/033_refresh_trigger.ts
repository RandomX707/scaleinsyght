import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql("ALTER TABLE profiler.jobs ADD COLUMN scheduled boolean NOT NULL DEFAULT false");
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql("ALTER TABLE profiler.jobs DROP COLUMN scheduled");
}
