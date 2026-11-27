import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`ALTER TABLE registry.connections
    ADD COLUMN profile_query_timeout_ms integer CHECK (profile_query_timeout_ms BETWEEN 1 AND 120000),
    ADD COLUMN analytic_query_timeout_ms integer CHECK (analytic_query_timeout_ms BETWEEN 1 AND 120000)`);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE registry.connections DROP COLUMN profile_query_timeout_ms, DROP COLUMN analytic_query_timeout_ms');
}
