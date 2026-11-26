import type { MigrationBuilder } from 'node-pg-migrate';

// K10: every profile runs as a background job, not only the first discovery: "Run profile now", "Run a refresh now"
// (nightly on demand) and the scheduled nightly refresh are queued and claimed by the worker under the same lease and
// fencing rules (decision 57). A background job is one with a phase; profiles run directly (tests) have none. One open
// background job per connection, of any type.
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    DROP INDEX profiler.profiler_jobs_one_open_discovery;
    CREATE UNIQUE INDEX profiler_jobs_one_open_background ON profiler.jobs(tenant_id,connection_id)
      WHERE phase IS NOT NULL AND state IN ('QUEUED','RUNNING');
    DROP INDEX profiler.profiler_jobs_claimable;
    CREATE INDEX profiler_jobs_claimable ON profiler.jobs(created_at) WHERE phase IS NOT NULL AND state IN ('QUEUED','RUNNING');
    DROP POLICY jobs_worker_claim ON profiler.jobs;
    CREATE POLICY jobs_worker_claim ON profiler.jobs FOR ALL TO si_worker
      USING (current_setting('app.worker_claim',true)='enabled' AND phase IS NOT NULL AND state IN ('QUEUED','RUNNING'))
      WITH CHECK (current_setting('app.worker_claim',true)='enabled' AND phase IS NOT NULL);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    DROP POLICY jobs_worker_claim ON profiler.jobs;
    CREATE POLICY jobs_worker_claim ON profiler.jobs FOR ALL TO si_worker
      USING (current_setting('app.worker_claim',true)='enabled' AND job_type='discovery' AND state IN ('QUEUED','RUNNING'))
      WITH CHECK (current_setting('app.worker_claim',true)='enabled' AND job_type='discovery');
    DROP INDEX profiler.profiler_jobs_claimable;
    CREATE INDEX profiler_jobs_claimable ON profiler.jobs(created_at) WHERE job_type='discovery' AND state IN ('QUEUED','RUNNING');
    DROP INDEX profiler.profiler_jobs_one_open_background;
    CREATE UNIQUE INDEX profiler_jobs_one_open_discovery ON profiler.jobs(tenant_id,connection_id) WHERE job_type='discovery' AND state IN ('QUEUED','RUNNING');
  `);
}
