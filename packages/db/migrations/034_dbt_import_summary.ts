import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE registry.connections ADD COLUMN dbt_import jsonb');
}
export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE registry.connections DROP COLUMN dbt_import');
}
