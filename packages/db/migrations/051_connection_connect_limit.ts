import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE registry.connections ADD COLUMN connect_timeout_ms integer CHECK (connect_timeout_ms BETWEEN 1 AND 120000)');
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE registry.connections DROP COLUMN connect_timeout_ms');
}
