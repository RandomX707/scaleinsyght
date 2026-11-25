import type { MigrationBuilder } from 'node-pg-migrate';

// K4: a worker may claim a step only while its run is PLANNING (the planning step) or RUNNING. Steps left open in a
// completed, failed, cancelled, expired, partial or blocked run, or one awaiting approval, are never claimed again.
// In claim mode the worker can see only those active runs, and the step queue policies require one.
const claimable = `nullif(current_setting('app.worker_claim', true), '') = 'enabled'
        AND (state = 'PENDING' OR (state IN ('CLAIMED','RUNNING') AND lease_expires_at <= clock_timestamp()))
        AND EXISTS (SELECT 1 FROM runs.runs r WHERE r.tenant_id = steps.tenant_id AND r.run_id = steps.run_id AND r.state IN ('PLANNING','RUNNING'))`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE POLICY worker_queue_active_runs ON runs.runs
      FOR SELECT TO si_worker
      USING (nullif(current_setting('app.worker_claim', true), '') = 'enabled' AND state IN ('PLANNING','RUNNING'));
    DROP POLICY worker_queue_read ON runs.steps;
    DROP POLICY worker_queue_claim ON runs.steps;
    CREATE POLICY worker_queue_read ON runs.steps FOR SELECT TO si_worker USING (${claimable});
    CREATE POLICY worker_queue_claim ON runs.steps FOR UPDATE TO si_worker USING (${claimable}) WITH CHECK (state IN ('CLAIMED','RUNNING'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  const previous = `nullif(current_setting('app.worker_claim', true), '') = 'enabled'
        AND (state = 'PENDING' OR (state IN ('CLAIMED','RUNNING') AND lease_expires_at <= clock_timestamp()))`;
  pgm.sql(`
    DROP POLICY worker_queue_claim ON runs.steps;
    DROP POLICY worker_queue_read ON runs.steps;
    CREATE POLICY worker_queue_read ON runs.steps FOR SELECT TO si_worker USING (${previous});
    CREATE POLICY worker_queue_claim ON runs.steps FOR UPDATE TO si_worker USING (${previous}) WITH CHECK (state IN ('CLAIMED','RUNNING'));
    DROP POLICY worker_queue_active_runs ON runs.runs;
  `);
}
