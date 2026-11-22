import type { MigrationBuilder } from 'node-pg-migrate';
export async function up(pgm:MigrationBuilder):Promise<void>{pgm.sql(`ALTER TABLE registry.agent_versions ADD COLUMN status text NOT NULL DEFAULT 'approved' CHECK(status IN ('draft','approved'));`);}
export async function down(pgm:MigrationBuilder):Promise<void>{pgm.sql(`ALTER TABLE registry.agent_versions DROP COLUMN status;`);}
