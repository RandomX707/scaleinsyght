import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE POLICY worker_queue_read ON runs.steps
      FOR SELECT TO si_worker
      USING (
        nullif(current_setting('app.worker_claim', true), '') = 'enabled'
        AND (state = 'PENDING' OR (state IN ('CLAIMED','RUNNING') AND lease_expires_at <= clock_timestamp()))
      );
    CREATE POLICY worker_queue_claim ON runs.steps
      FOR UPDATE TO si_worker
      USING (
        nullif(current_setting('app.worker_claim', true), '') = 'enabled'
        AND (state = 'PENDING' OR (state IN ('CLAIMED','RUNNING') AND lease_expires_at <= clock_timestamp()))
      )
      WITH CHECK (state IN ('CLAIMED','RUNNING'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP POLICY worker_queue_claim ON runs.steps; DROP POLICY worker_queue_read ON runs.steps;`);
}
