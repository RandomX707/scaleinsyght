import type { MigrationBuilder } from 'node-pg-migrate';

// Decision 57: the discovery profile of a newly activated connection runs as a background job, never inside the HTTP
// request. Activation queues one job; a worker claims it with FOR UPDATE SKIP LOCKED under a lease, writes its phase and
// progress as it goes, and fences every write with claim_token, so a stale worker (lease lost) can never overwrite the
// job. A worker takes the tenant from the stored job row, never from a payload (non-negotiable 4).
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE profiler.jobs
      ADD COLUMN phase text CHECK (phase IN ('queued','listing','profiling','relationships','done')),
      ADD COLUMN planned_count integer CHECK (planned_count >= 0),
      ADD COLUMN claim_token integer NOT NULL DEFAULT 0 CHECK (claim_token >= 0),
      ADD COLUMN lease_expires_at timestamptz,
      ADD COLUMN failure_code text CHECK (failure_code ~ '^[a-z_]{1,64}$');
    -- One open discovery job per connection: a repeated or concurrent activation finds it instead of queuing another.
    CREATE UNIQUE INDEX profiler_jobs_one_open_discovery ON profiler.jobs(tenant_id,connection_id)
      WHERE job_type='discovery' AND state IN ('QUEUED','RUNNING');
    CREATE INDEX profiler_jobs_claimable ON profiler.jobs(created_at) WHERE job_type='discovery' AND state IN ('QUEUED','RUNNING');
    -- The worker finds claimable jobs across tenants only inside a claim transaction, and only open discovery jobs.
    CREATE POLICY jobs_worker_claim ON profiler.jobs FOR ALL TO si_worker
      USING (current_setting('app.worker_claim',true)='enabled' AND job_type='discovery' AND state IN ('QUEUED','RUNNING'))
      WITH CHECK (current_setting('app.worker_claim',true)='enabled' AND job_type='discovery');
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    DROP POLICY jobs_worker_claim ON profiler.jobs;
    DROP INDEX profiler.profiler_jobs_claimable;
    DROP INDEX profiler.profiler_jobs_one_open_discovery;
    ALTER TABLE profiler.jobs DROP COLUMN failure_code, DROP COLUMN lease_expires_at, DROP COLUMN claim_token, DROP COLUMN planned_count, DROP COLUMN phase;
  `);
}
