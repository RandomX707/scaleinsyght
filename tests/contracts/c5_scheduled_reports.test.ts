import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { activateConnection, approveGovernedVersion, createGovernedDraft } from '@scaleinsyght/registry';
import { createAnalyticPlan } from '@scaleinsyght/analytic';
import { claimDueSchedule, markScheduleSlotSkipped, markScheduleSlotStarted, persistReportSnapshot, startScheduledReportRun } from '@scaleinsyght/reports';
import { withTenant } from '@scaleinsyght/db';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = '/si_test'; return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const worker = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

describe('contract 5 governed reports and schedule slots', () => {
  afterAll(async () => { await app.end(); await worker.end(); await migrate.end(); });
  it('c5_daily_schedule_claim_dispatches_at_most_once_per_utc_slot', async () => {
    const tenantId = `scheduled-report-${crypto.randomUUID()}`;
    const users = await withTenant(migrate, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      const owner = await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id', [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')]);
      const reviewer = await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id', [tenantId, `${tenantId}-reviewer@synthetic.example`, hashPassword('synthetic-password')]);
      await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)", [tenantId]);
      return { ownerId: owner.rows[0]!.user_id, reviewerId: reviewer.rows[0]!.user_id };
    });
    const source = await activateConnection(app, { tenantId, principalId: users.ownerId, connectorType: 'postgres' });
    await withTenant(migrate, tenantId, async (db) => db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)", [tenantId, users.ownerId, source.connectionId]));
    const plan = await createAnalyticPlan({ question: 'How many catalog objects are listed?', runId: crypto.randomUUID(), sources: [{ sourceId: source.connectionId, agentId: source.agentId, groupId: source.sourceGroupId, groupVersion: 1 }] });
    const draft = await createGovernedDraft(app, { tenantId, principalId: users.ownerId, name: 'Daily catalog report', plan });
    await approveGovernedVersion(app, { tenantId, principalId: users.reviewerId, governedId: draft.governedId, version: draft.version });

    const server = await buildServer({ pool: app, sessionSecret: 's'.repeat(64), goldenAccounts: [
      { tenantId, email: `${tenantId}@synthetic.example` }, { tenantId, email: `${tenantId}-reviewer@synthetic.example` },
    ] });
    try {
      const ownerLogin = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}@synthetic.example`, password: 'synthetic-password' } });
      const ownerCookie = String(ownerLogin.headers['set-cookie']);
      const reviewerLogin = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}-reviewer@synthetic.example`, password: 'synthetic-password' } });
      const reviewerCookie = String(reviewerLogin.headers['set-cookie']);
      const report = await server.inject({ method: 'POST', url: '/api/me/reports', headers: { cookie: ownerCookie }, payload: { name: 'Daily catalog report', governedId: draft.governedId, version: 1 } });
      expect(report.statusCode).toBe(201);
      const reportId = report.json().reportId as string;
      expect((await server.inject({ method: 'GET', url: '/api/me/reports', headers: { cookie: ownerCookie } })).json().reports).toHaveLength(1);
      expect((await server.inject({ method: 'GET', url: '/api/me/reports', headers: { cookie: reviewerCookie } })).json().reports).toHaveLength(0);

      const scheduled = await server.inject({ method: 'POST', url: '/api/me/schedules', headers: { cookie: ownerCookie }, payload: { reportId, utcTime: '23:59' } });
      expect(scheduled.statusCode).toBe(201);
      expect(scheduled.json()).toMatchObject({ reportId, utcTime: '23:59', cadence: 'daily' });
      const scheduleId = scheduled.json().scheduleId as string;
      expect((await server.inject({ method: 'GET', url: '/api/me/schedules', headers: { cookie: reviewerCookie } })).json().schedules).toHaveLength(0);

      await withTenant(migrate, tenantId, async (db) => {
        await db.query("SELECT set_config('app.principal_id',$1,true)", [users.ownerId]);
        await db.query('UPDATE reports.schedules SET next_run_at=clock_timestamp()-interval \'1 minute\' WHERE tenant_id=$1 AND schedule_id=$2', [tenantId, scheduleId]);
      });
      const claim=await claimDueSchedule(worker);
      expect(claim).toMatchObject({ tenantId, scheduleId, reportId, ownerId: users.ownerId });
      const recovered=await claimDueSchedule(worker);
      expect(recovered).toMatchObject({scheduleId,dueSlot:claim!.dueSlot,runId:claim!.runId});
      const scheduledRun=await startScheduledReportRun(worker,claim!);
      expect(await startScheduledReportRun(worker,recovered!)).toEqual(scheduledRun);
      const scheduledEvents=await withTenant(migrate,tenantId,async(db)=>db.query<{count:number}>("SELECT count(*)::int AS count FROM runs.events WHERE tenant_id=$1 AND run_id=$2 AND event_type='scheduled_run_enqueued'",[tenantId,scheduledRun.runId]));
      expect(scheduledEvents.rows[0]!.count).toBe(1);
      await markScheduleSlotStarted(worker,recovered!);
      expect(await claimDueSchedule(worker)).toBeNull();
      await withTenant(migrate,tenantId,async(db)=>{
        await db.query("UPDATE runs.runs SET state='COMPLETED' WHERE tenant_id=$1 AND run_id=$2",[tenantId,scheduledRun.runId]);
        await db.query("INSERT INTO runs.analytic_answers(tenant_id,run_id,status,answer) VALUES($1,$2,'COMPLETED',$3::jsonb)",[tenantId,scheduledRun.runId,JSON.stringify({metric:'listed_count',bySource:[{sourceId:source.connectionId,connectorType:'postgres',value:12}],claims:[],evidence:[],trust:{groupCount:1,sourceCount:1,joins:['group']}})]);
      });
      await persistReportSnapshot(worker,scheduledRun.runId);
      const reports=await server.inject({method:'GET',url:'/api/me/reports',headers:{cookie:ownerCookie}});
      expect(reports.json().reports[0]).toMatchObject({reportId,latestRunId:scheduledRun.runId});
      const exported=await server.inject({method:'GET',url:`/api/me/reports/${reportId}/exports/pdf`,headers:{cookie:ownerCookie}});
      expect(exported.statusCode).toBe(200);
      expect(exported.rawPayload.subarray(0,5).toString()).toBe('%PDF-');
      const slot = await withTenant(migrate, tenantId, async (db) => {
        await db.query("SELECT set_config('app.principal_id',$1,true)", [users.ownerId]);
        return db.query<{ last_slot: Date; next_run_at: Date }>('SELECT last_slot,next_run_at FROM reports.schedules WHERE tenant_id=$1 AND schedule_id=$2', [tenantId, scheduleId]);
      });
      expect(slot.rows[0]!.last_slot).not.toBeNull();
      expect(slot.rows[0]!.next_run_at.getTime() - slot.rows[0]!.last_slot.getTime()).toBe(24 * 60 * 60 * 1000);

      expect((await server.inject({ method: 'DELETE', url: `/api/me/schedules/${scheduleId}`, headers: { cookie: ownerCookie } })).json()).toEqual({ disabled: true });
      const disabled = await withTenant(migrate, tenantId, async (db) => {
        await db.query("SELECT set_config('app.principal_id',$1,true)", [users.ownerId]);
        return db.query<{ enabled: boolean }>('SELECT enabled FROM reports.schedules WHERE tenant_id=$1 AND schedule_id=$2', [tenantId, scheduleId]);
      });
      expect(disabled.rows[0]!.enabled).toBe(false);
      const reenabled=await server.inject({method:'POST',url:'/api/me/schedules',headers:{cookie:ownerCookie},payload:{reportId,utcTime:'23:59'}});
      expect(reenabled.statusCode).toBe(201);
      await withTenant(migrate,tenantId,async(db)=>{
        await db.query("SELECT set_config('app.principal_id',$1,true)",[users.ownerId]);
        await db.query('DELETE FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND resource_id=$3',[tenantId,users.ownerId,source.connectionId]);
        await db.query("UPDATE reports.schedules SET next_run_at=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1 AND schedule_id=$2",[tenantId,scheduleId]);
      });
      const revokedSlot=await claimDueSchedule(worker);
      expect(revokedSlot).toMatchObject({scheduleId,reportId});
      await expect(startScheduledReportRun(worker,revokedSlot!)).rejects.toThrow('principal_not_entitled');
      await markScheduleSlotSkipped(worker,revokedSlot!,'principal_not_entitled');
      expect(await claimDueSchedule(worker)).toBeNull();
      const skipped=await withTenant(migrate,tenantId,async(db)=>{await db.query("SELECT set_config('app.principal_id',$1,true)",[users.ownerId]);return db.query<{state:string;safe_reason:string}>('SELECT state,safe_reason FROM reports.schedule_slots WHERE tenant_id=$1 AND schedule_id=$2 AND run_id=$3',[tenantId,scheduleId,revokedSlot!.runId]);});
      expect(skipped.rows[0]).toEqual({state:'skipped',safe_reason:'principal_not_entitled'});
    } finally { await server.close(); }
  });
});
