import type { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { queueProfileJob } from './discovery-jobs.js';

/** Claims one connection whose nightly refresh is due, across tenants, and moves its next run a day on. The caller runs
 * the refresh under the claimed tenant. Claimed with FOR UPDATE SKIP LOCKED so two workers never refresh the same
 * connection at once. */
export async function claimDueNightly(pool: Pool, intervalHours = Number(process.env.NIGHTLY_INTERVAL_HOURS ?? 24)): Promise<{ tenantId: string; connectionId: string } | null> {
  const client = await pool.connect();
  try {
    await client.query('RESET app.tenant_id'); await client.query('BEGIN');
    await client.query("SELECT set_config('app.worker_claim','enabled',true)");
    const due = await client.query<{ tenant_id: string; connection_id: string }>(
      `SELECT tenant_id,connection_id FROM profiler.nightly_schedules WHERE next_run_at<=clock_timestamp() ORDER BY next_run_at,connection_id FOR UPDATE SKIP LOCKED LIMIT 1`);
    const row = due.rows[0];
    if (!row) { await client.query('COMMIT'); return null; }
    await client.query(`UPDATE profiler.nightly_schedules SET next_run_at=clock_timestamp()+make_interval(hours=>$3),last_started_at=clock_timestamp() WHERE tenant_id=$1 AND connection_id=$2`,
      [row.tenant_id, row.connection_id, Math.max(1, Math.round(intervalHours))]);
    await client.query('COMMIT');
    return { tenantId: row.tenant_id, connectionId: row.connection_id };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** K10: claims one due nightly refresh and queues it as a background job, as the worker does every loop. Returns null
 * when nothing is due; queued is false when the connection already had a profile queued or running. */
export async function queueDueNightly(pool: Pool, intervalHours?: number): Promise<{ tenantId: string; connectionId: string; jobId: string; state: string; queued: boolean } | null> {
  const due = await claimDueNightly(pool, intervalHours);
  if (!due) return null;
  const job = await withTenant(pool, due.tenantId, (client) => queueProfileJob(client, due.tenantId, due.connectionId, 'nightly', true));
  return { ...due, jobId: job.jobId, state: job.state, queued: job.queued };
}
