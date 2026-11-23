import { createHash } from 'node:crypto';
import { withRunTenant, withTenant } from '@scaleinsyght/db';
import { startAnalyticRun } from '@scaleinsyght/analytic';
import { AnalyticPlanSchema, hashPlan } from '@scaleinsyght/contracts';
import { getApprovedGovernedVersion } from '@scaleinsyght/registry';
import type { Pool } from 'pg';
import { safeEvidencePack } from './index.js';

export async function startScheduledReportRun(pool: Pool, due: { tenantId: string; scheduleId: string; reportId: string; ownerId: string; dueSlot: Date; runId: string }): Promise<{ runId: string }> {
  const existing=await withTenant(pool,due.tenantId,async(client)=>client.query<{run_id:string}>('SELECT run_id FROM runs.runs WHERE tenant_id=$1 AND run_id=$2',[due.tenantId,due.runId]));
  if(existing.rowCount){await recordScheduledRunEvent(pool,due);return{runId:existing.rows[0]!.run_id};}
  const report=await withTenant(pool,due.tenantId,async(client)=>{
    await client.query("SELECT set_config('app.principal_id',$1,true)",[due.ownerId]);
    const result=await client.query<{governed_id:string;version:number}>('SELECT governed_id,version FROM reports.definitions WHERE tenant_id=$1 AND report_id=$2 AND owner_id=$3',[due.tenantId,due.reportId,due.ownerId]);
    return result.rows[0]??null;
  });
  if(!report)throw new Error('scheduled_report_not_found');
  const approved=await getApprovedGovernedVersion(pool,{tenantId:due.tenantId,governedId:report.governed_id,version:report.version});
  const plan=AnalyticPlanSchema.parse({...approved.plan,run_id:due.runId,plan_hash:'0'.repeat(64)});plan.plan_hash=await hashPlan({...plan,plan_hash:''});
  const started=await startAnalyticRun(pool,{tenantId:due.tenantId,principalId:due.ownerId,plan,governed:{governedId:report.governed_id,version:report.version}});
  await recordScheduledRunEvent(pool,due,report.version);
  return started;
}
async function recordScheduledRunEvent(pool:Pool,due:{tenantId:string;scheduleId:string;ownerId:string;dueSlot:Date;runId:string},version?:number):Promise<void>{
  await withRunTenant(pool,due.runId,async(client,run)=>{
    const prior=await client.query("SELECT 1 FROM runs.events WHERE tenant_id=$1 AND run_id=$2 AND event_type='scheduled_run_enqueued' AND safe_payload->>'schedule_id'=$3",[run.tenant_id,due.runId,due.scheduleId]);
    if(prior.rowCount)return;
    const sequence=await client.query<{next_sequence:number}>('SELECT COALESCE(max(sequence),0)+1 AS next_sequence FROM runs.events WHERE tenant_id=$1 AND run_id=$2',[run.tenant_id,due.runId]);
    await client.query("INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,safe_payload) VALUES($1,$2,$3,'scheduled_run_enqueued',$4::jsonb)",[run.tenant_id,due.runId,sequence.rows[0]!.next_sequence,JSON.stringify({schedule_id:due.scheduleId,version:version??null,utc_slot:due.dueSlot.toISOString()})]);
  });
}

export async function persistReportSnapshot(pool: Pool, runId: string): Promise<void> {
  await withRunTenant(pool,runId,async(client,run)=>{
    const completed=await client.query<{state:string;plan_hash:string;answer:Record<string,unknown>|null;governed_id:string|null;version:number|null}>(
      `SELECT r.state,p.plan_hash,a.answer,g.governed_id,g.version FROM runs.runs r
       JOIN runs.analytic_plans p USING(tenant_id,run_id) LEFT JOIN runs.analytic_answers a USING(tenant_id,run_id)
       LEFT JOIN runs.governed_run_pins g USING(tenant_id,run_id) WHERE r.tenant_id=$1 AND r.run_id=$2`,[run.tenant_id,runId]);
    const row=completed.rows[0];if(!row||row.state!=='COMPLETED'||!row.answer||!row.governed_id||!row.version)return;
    await client.query("SELECT set_config('app.principal_id',$1,true)",[run.principal_id]);
    const definitions=await client.query<{report_id:string}>('SELECT report_id FROM reports.definitions WHERE tenant_id=$1 AND owner_id=$2 AND governed_id=$3 AND version=$4',[run.tenant_id,run.principal_id,row.governed_id,row.version]);
    for(const report of definitions.rows){
      const pack=safeEvidencePack({runId,planHash:row.plan_hash,answer:row.answer as unknown as Parameters<typeof safeEvidencePack>[0]['answer']});
      const contentHash=createHash('sha256').update(JSON.stringify(pack)).digest('hex');
      await client.query('INSERT INTO reports.snapshots(tenant_id,report_id,run_id,plan_hash,content_hash,safe_pack) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,report_id,run_id) DO NOTHING',[run.tenant_id,report.report_id,runId,row.plan_hash,contentHash,JSON.stringify(pack)]);
    }
  });
}
