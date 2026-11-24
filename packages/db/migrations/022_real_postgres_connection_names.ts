import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE registry.connections ADD COLUMN display_name text NOT NULL DEFAULT '';`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE registry.connections DROP COLUMN display_name;`);
}
