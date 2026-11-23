import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface DueReportSchedule { tenantId: string; scheduleId: string; reportId: string; ownerId: string; dueSlot: Date; runId: string; }

export async function claimDueSchedule(pool: Pool): Promise<DueReportSchedule | null> {
  const client = await pool.connect();
  try {
    await client.query('RESET app.tenant_id'); await client.query('RESET app.worker_claim'); await client.query('BEGIN');
    await client.query("SELECT set_config('app.worker_claim','enabled',true)");
    let due = await client.query<{ tenant_id: string; schedule_id: string; report_id: string; owner_id: string; due_slot: Date; run_id:string }>(
      `SELECT tenant_id,schedule_id,report_id,owner_id,due_slot,run_id FROM reports.schedule_slots
       WHERE state='pending' ORDER BY due_slot,schedule_id LIMIT 1`);
    if (!due.rowCount) {
      const schedule = await client.query<{ tenant_id: string; schedule_id: string; report_id: string; owner_id: string; next_run_at: Date }>(
        `SELECT tenant_id,schedule_id,report_id,owner_id,next_run_at FROM reports.schedules
         WHERE enabled AND next_run_at<=clock_timestamp() ORDER BY next_run_at,schedule_id FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!schedule.rowCount) { await client.query('COMMIT'); return null; }
      const row = schedule.rows[0]!;
      const digest = createHash('sha256').update(`${row.tenant_id}:${row.schedule_id}:${row.next_run_at.toISOString()}`).digest('hex');
      const runId = `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
      await client.query('INSERT INTO reports.schedule_slots(tenant_id,schedule_id,due_slot,report_id,owner_id,run_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,schedule_id,due_slot) DO NOTHING', [row.tenant_id,row.schedule_id,row.next_run_at,row.report_id,row.owner_id,runId]);
      await client.query("UPDATE reports.schedules SET last_slot=$3::timestamptz,next_run_at=$3::timestamptz+interval '1 day' WHERE tenant_id=$1 AND schedule_id=$2", [row.tenant_id,row.schedule_id,row.next_run_at]);
      due = await client.query(`SELECT tenant_id,schedule_id,report_id,owner_id,due_slot,run_id FROM reports.schedule_slots WHERE tenant_id=$1 AND schedule_id=$2 AND due_slot=$3`,[row.tenant_id,row.schedule_id,row.next_run_at]);
    }
    const row=due.rows[0]!;
    await client.query('COMMIT');
    return { tenantId: row.tenant_id, scheduleId: row.schedule_id, reportId: row.report_id, ownerId: row.owner_id, dueSlot: row.due_slot, runId:row.run_id };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function markScheduleSlotStarted(pool: Pool, due: DueReportSchedule): Promise<void> {
  const client=await pool.connect();
  try {
    await client.query('RESET app.tenant_id'); await client.query('RESET app.worker_claim'); await client.query('BEGIN');
    await client.query("SELECT set_config('app.worker_claim','enabled',true)");
    await client.query("UPDATE reports.schedule_slots SET state='started',started_at=clock_timestamp() WHERE tenant_id=$1 AND schedule_id=$2 AND run_id=$3 AND state='pending'",[due.tenantId,due.scheduleId,due.runId]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function markScheduleSlotSkipped(pool:Pool,due:DueReportSchedule,reason:'governed_version_not_approved'|'governed_version_not_found'|'source_not_active'|'source_group_version_not_pinned'|'capability_not_available'|'principal_not_entitled'):Promise<void>{
  const client=await pool.connect();
  try {
    await client.query('RESET app.tenant_id'); await client.query('RESET app.worker_claim'); await client.query('BEGIN');
    await client.query("SELECT set_config('app.worker_claim','enabled',true)");
    const updated=await client.query("UPDATE reports.schedule_slots SET state='skipped',safe_reason=$4,started_at=clock_timestamp() WHERE tenant_id=$1 AND schedule_id=$2 AND run_id=$3 AND state='pending' RETURNING run_id",[due.tenantId,due.scheduleId,due.runId,reason]);
    if(!updated.rowCount)throw new Error('schedule_slot_not_pending');
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
