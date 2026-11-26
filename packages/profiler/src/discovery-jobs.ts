import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@scaleinsyght/db';

/**
 * Background discovery (decision 57). Activating a connection queues one discovery job; a worker claims it under a
 * lease and runs the profile, writing its phase and progress as it goes so the Profile page can show live progress.
 * claim_token is the fencing token: it rises on every claim, and every write checks it, so a worker whose lease was
 * lost cannot overwrite the job. The tenant comes from the stored job row, never from a payload.
 */
export type DiscoveryJob = { tenantId: string; connectionId: string; jobId: string; token: number };
export type JobPhase = 'queued' | 'listing' | 'profiling' | 'relationships' | 'done';
export const DISCOVERY_LEASE_MS = Number(process.env.DISCOVERY_LEASE_MS ?? 120_000);
/** A job whose worker died this many times is failed rather than retried forever. */
export const DISCOVERY_MAX_CLAIMS = 3;

export class StaleDiscoveryJobError extends Error { constructor() { super('discovery_job_lost'); } }

/** Queues the discovery job for a connection inside the caller's tenant transaction; returns the open job. */
export async function queueDiscovery(client: PoolClient, tenantId: string, connectionId: string): Promise<{ jobId: string; state: string }> {
  await client.query(
    `INSERT INTO profiler.jobs(tenant_id,connection_id,job_type,state,phase) VALUES($1,$2,'discovery','QUEUED','queued')
     ON CONFLICT (tenant_id,connection_id) WHERE job_type='discovery' AND state IN ('QUEUED','RUNNING') DO NOTHING`, [tenantId, connectionId]);
  return (await latestDiscovery(client, tenantId, connectionId))!;
}

export async function latestDiscovery(client: PoolClient, tenantId: string, connectionId: string): Promise<{ jobId: string; state: string } | null> {
  const row = (await client.query<{ job_id: string; state: string }>(
    `SELECT job_id,state FROM profiler.jobs WHERE tenant_id=$1 AND connection_id=$2 AND job_type='discovery' ORDER BY created_at DESC LIMIT 1`, [tenantId, connectionId])).rows[0];
  return row ? { jobId: row.job_id, state: row.state } : null;
}

/** Claims the oldest queued discovery job, or one whose worker's lease ran out. Tests pass onlyTenant so parallel test
 * files never run each other's jobs; the worker never does. */
export async function claimDiscovery(pool: Pool, leaseMs = DISCOVERY_LEASE_MS, onlyTenant?: string): Promise<DiscoveryJob | null> {
  const client = await pool.connect();
  try {
    await client.query('RESET app.tenant_id'); await client.query('BEGIN');
    await client.query("SELECT set_config('app.worker_claim','enabled',true)");
    for (;;) {
      const due = await client.query<{ tenant_id: string; job_id: string; connection_id: string; claim_token: number }>(
        `SELECT tenant_id,job_id,connection_id,claim_token FROM profiler.jobs
         WHERE job_type='discovery' AND (state='QUEUED' OR (state='RUNNING' AND lease_expires_at<clock_timestamp())) AND ($1::text IS NULL OR tenant_id=$1)
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [onlyTenant ?? null]);
      const row = due.rows[0];
      if (!row) { await client.query('COMMIT'); return null; }
      if (row.claim_token >= DISCOVERY_MAX_CLAIMS) {
        await client.query(`UPDATE profiler.jobs SET state='FAILED',failure_code='discovery_abandoned',lease_expires_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND job_id=$2`, [row.tenant_id, row.job_id]);
        continue;
      }
      const claimed = await client.query<{ claim_token: number }>(
        `UPDATE profiler.jobs SET state='RUNNING',phase='listing',claim_token=claim_token+1,lease_expires_at=clock_timestamp()+make_interval(secs=>$3::double precision/1000),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND job_id=$2 RETURNING claim_token`, [row.tenant_id, row.job_id, leaseMs]);
      await client.query('COMMIT');
      return { tenantId: row.tenant_id, connectionId: row.connection_id, jobId: row.job_id, token: claimed.rows[0]!.claim_token };
    }
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** Records progress and renews the lease; throws if another worker now holds the job. */
export async function reportDiscovery(pool: Pool, job: DiscoveryJob, progress: { phase?: JobPhase; listed?: number; planned?: number; profiled?: number } = {}, leaseMs = DISCOVERY_LEASE_MS): Promise<void> {
  const updated = await withTenant(pool, job.tenantId, (client) => client.query(
    `UPDATE profiler.jobs SET phase=coalesce($4,phase),listed_count=coalesce($5,listed_count),planned_count=coalesce($6,planned_count),profiled_count=coalesce($7,profiled_count),
       lease_expires_at=clock_timestamp()+make_interval(secs=>$8::double precision/1000),updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND job_id=$2 AND claim_token=$3 AND state='RUNNING'`,
    [job.tenantId, job.jobId, job.token, progress.phase ?? null, progress.listed ?? null, progress.planned ?? null, progress.profiled ?? null, leaseMs]));
  if (!updated.rowCount) throw new StaleDiscoveryJobError();
}

/** Inside the profile's own transaction: confirms this worker still holds the job before anything is written. */
export async function holdDiscovery(client: PoolClient, job: DiscoveryJob): Promise<void> {
  const held = await client.query(`SELECT 1 FROM profiler.jobs WHERE tenant_id=$1 AND job_id=$2 AND claim_token=$3 AND state='RUNNING' FOR UPDATE`, [job.tenantId, job.jobId, job.token]);
  if (!held.rowCount) throw new StaleDiscoveryJobError();
}

export async function finishDiscovery(pool: Pool, job: DiscoveryJob, outcome: { state: 'COMPLETED' } | { state: 'FAILED' | 'PARTIAL'; failureCode: string }): Promise<boolean> {
  const updated = await withTenant(pool, job.tenantId, (client) => client.query(
    `UPDATE profiler.jobs SET state=$4,phase=CASE WHEN $4='COMPLETED' THEN 'done' ELSE phase END,failure_code=$5,lease_expires_at=NULL,state_version=state_version+1,updated_at=clock_timestamp()
     WHERE tenant_id=$1 AND job_id=$2 AND claim_token=$3 AND state='RUNNING'`,
    [job.tenantId, job.jobId, job.token, outcome.state, outcome.state === 'COMPLETED' ? null : outcome.failureCode]));
  return Boolean(updated.rowCount);
}

/** Keeps the lease alive while a single slow step (one large table) runs. */
export function heartbeat(pool: Pool, job: DiscoveryJob, leaseMs = DISCOVERY_LEASE_MS): { stop: () => void; lost: () => boolean } {
  let lost = false;
  const timer = setInterval(() => { void reportDiscovery(pool, job, {}, leaseMs).catch((error) => { if (error instanceof StaleDiscoveryJobError) lost = true; }); }, Math.max(1000, Math.floor(leaseMs / 4)));
  timer.unref?.();
  return { stop: () => clearInterval(timer), lost: () => lost };
}
