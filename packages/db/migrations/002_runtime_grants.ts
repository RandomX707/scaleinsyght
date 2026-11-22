import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, registry, runs TO si_app, si_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, registry, runs TO si_app, si_worker;
    REVOKE UPDATE, DELETE ON runs.events FROM si_app, si_worker;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`REVOKE ALL ON ALL TABLES IN SCHEMA core, registry, runs FROM si_app, si_worker;`);
}
