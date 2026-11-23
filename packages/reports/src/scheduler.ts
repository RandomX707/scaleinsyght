import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface DueReportSchedule { tenantId: string; scheduleId: string; reportId: string; ownerId: string; dueSlot: Date; runId: string; }

type ScheduleCadence = 'daily' | 'weekly';
function zonedParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute! };
}

function localDateKey(parts: { year: number; month: number; day: number }): string {
  return `${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')}`;
}

function instantForWallTime(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const nominalUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  // Searching UTC minutes finds both fall-back instants (choose the earlier) and
  // avoids host-time-zone or fixed-offset assumptions. A spring-forward gap is invalid.
  for (let delta = -14 * 60; delta <= 14 * 60; delta += 1) {
    const candidate = new Date(nominalUtc + delta * 60_000);
    const parts = zonedParts(candidate, timeZone);
    if (parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute) return candidate;
  }
  throw new Error('schedule_local_time_does_not_exist');
}

export function nextScheduleInstant(input: { after: Date; cadence: ScheduleCadence; timeZone: string; localTime: string; weekday?: number }): Date {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)) throw new Error('invalid_schedule_time');
  if (input.cadence === 'weekly' && (!Number.isInteger(input.weekday) || input.weekday! < 1 || input.weekday! > 7)) throw new Error('invalid_schedule_weekday');
  const local = zonedParts(input.after, input.timeZone);
  const currentDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(currentDate.getTime() + offset * 86_400_000);
    const dateParts = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    if (input.cadence === 'weekly') {
      const isoWeekday = date.getUTCDay() || 7;
      if (isoWeekday !== input.weekday) continue;
    }
    try {
      const candidate = instantForWallTime(localDateKey(dateParts), input.localTime, input.timeZone);
      if (candidate.getTime() > input.after.getTime()) return candidate;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'schedule_local_time_does_not_exist') throw error;
    }
  }
  throw new Error('schedule_next_slot_unavailable');
}

export async function claimDueSchedule(pool: Pool, tenantFilter?:string): Promise<DueReportSchedule | null> {
  const client = await pool.connect();
  try {
    await client.query('RESET app.tenant_id'); await client.query('RESET app.worker_claim'); await client.query('BEGIN');
    await client.query("SELECT set_config('app.worker_claim','enabled',true)");
    let due = await client.query<{ tenant_id: string; schedule_id: string; report_id: string; owner_id: string; due_slot: Date; run_id:string }>(
      `SELECT tenant_id,schedule_id,report_id,owner_id,due_slot,run_id FROM reports.schedule_slots
       WHERE state='pending' AND ($1::text IS NULL OR tenant_id=$1) ORDER BY due_slot,schedule_id LIMIT 1`,[tenantFilter??null]);
    if (!due.rowCount) {
      const schedule = await client.query<{ tenant_id: string; schedule_id: string; report_id: string; owner_id: string; next_run_at: Date; cadence:ScheduleCadence; tenant_time_zone:string; local_time:string; local_weekday:number|null }>(
        `SELECT tenant_id,schedule_id,report_id,owner_id,next_run_at,cadence,tenant_time_zone,to_char(local_time,'HH24:MI') AS local_time,local_weekday FROM reports.schedules
         WHERE enabled AND next_run_at<=clock_timestamp() AND ($1::text IS NULL OR tenant_id=$1) ORDER BY next_run_at,schedule_id FOR UPDATE SKIP LOCKED LIMIT 1`,[tenantFilter??null]);
      if (!schedule.rowCount) { await client.query('COMMIT'); return null; }
      const row = schedule.rows[0]!;
      const nextRunAt=nextScheduleInstant({after:row.next_run_at,cadence:row.cadence,timeZone:row.tenant_time_zone,localTime:row.local_time,...(row.local_weekday===null?{}:{weekday:row.local_weekday})});
      const digest = createHash('sha256').update(`${row.tenant_id}:${row.schedule_id}:${row.next_run_at.toISOString()}`).digest('hex');
      const runId = `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
      await client.query('INSERT INTO reports.schedule_slots(tenant_id,schedule_id,due_slot,report_id,owner_id,run_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,schedule_id,due_slot) DO NOTHING', [row.tenant_id,row.schedule_id,row.next_run_at,row.report_id,row.owner_id,runId]);
      await client.query('UPDATE reports.schedules SET last_slot=$3::timestamptz,next_run_at=$4::timestamptz WHERE tenant_id=$1 AND schedule_id=$2', [row.tenant_id,row.schedule_id,row.next_run_at,nextRunAt]);
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
