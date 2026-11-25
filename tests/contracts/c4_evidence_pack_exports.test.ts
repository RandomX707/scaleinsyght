import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildTestServer as buildServer } from '../support/test-api.js';
import { hashPassword } from '@scaleinsyght/api/server';
import { activateConnection } from '@scaleinsyght/registry';
import { createAnalyticPlan, finalizeAnalyticRun, startAnalyticRun } from '@scaleinsyght/analytic';
import { completeStep, type StepClaim } from '@scaleinsyght/runner';
import { executeGoldenStep } from '../support/test-analytic-executor.js';
import { withTenant } from '@scaleinsyght/db';
import { safeEvidencePack } from '@scaleinsyght/reports';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const worker = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

describe('contract 4 reproducible evidence pack exports', () => {
  afterAll(async () => { await app.end(); await worker.end(); await migrate.end(); });
  it('c7_evidence_pack_rejects_identifier_values_in_cited_summaries', () => {
    expect(() => safeEvidencePack({runId:'golden-run',planHash:'a'.repeat(64),answer:{metric:'listed_count',bySource:[{sourceId:'golden-source',connectorType:'postgres',value:1}],claims:[{statement:'Customer email person@synthetic.example',evidence_ids:['golden-evidence']}],evidence:[],trust:{groupCount:1,sourceCount:1,joins:[]}}})).toThrow('evidence_pack_sensitive_value');
    expect(() => safeEvidencePack({runId:'golden-run',planHash:'a'.repeat(64),answer:{metric:'listed_count',bySource:[{sourceId:'golden-source',connectorType:'postgres',value:1}],claims:[],evidence:[{evidence_id:'golden-evidence',kind:'query',locator:'golden://fixture',content_hash:'b'.repeat(64),redacted_summary:'Customer ID: 123456789'}],trust:{groupCount:1,sourceCount:1,joins:[]}}})).toThrow('evidence_pack_sensitive_value');
    expect(() => safeEvidencePack({runId:'golden-run',planHash:'a'.repeat(64),answer:{metric:'listed_count',bySource:[{sourceId:'golden-source',connectorType:'postgres',value:1}],claims:[],evidence:[{evidence_id:'golden-evidence',kind:'query',locator:'golden://fixture?api_key=syntheticsecret',content_hash:'b'.repeat(64),redacted_summary:'Safe aggregate'}],trust:{groupCount:1,sourceCount:1,joins:[]}}})).toThrow('evidence_pack_sensitive_value');
  });
  it.each([
    ['pdf', 'application/pdf', '%PDF-'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PK'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PK'],
  ])('c4_evidence_pack_%s_reproduces_safe_run_figures', async (format, contentType, signature) => {
    const tenantId = `evidence-pack-${crypto.randomUUID()}`;
    await withTenant(migrate, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)', [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')]);
      await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)", [tenantId]);
    });
    const user = await withTenant(migrate, tenantId, async (db) => (await db.query<{ user_id: string }>('SELECT user_id FROM core.users WHERE tenant_id=$1', [tenantId])).rows[0]!.user_id);
    const source = await activateConnection(app, { tenantId, principalId: user, connectorType: 'postgres' });
    await withTenant(migrate, tenantId, async (db) => db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)", [tenantId, user, source.connectionId]));
    const plan = await createAnalyticPlan({ question: 'How many catalog objects are listed?', runId: crypto.randomUUID(), sources: [{ sourceId: source.connectionId, agentId: source.agentId, groupId: source.sourceGroupId, groupVersion: 1 }] });
    await startAnalyticRun(app, { tenantId, principalId: user, plan });
    const step = plan.steps[0]!;
    await withTenant(migrate, tenantId, async (db) => db.query("UPDATE runs.steps SET state='CLAIMED',attempt=1,fencing_token=1,lease_owner='evidence-pack-test',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3", [tenantId, plan.run_id, step.step_id]));
    const claim: StepClaim = { tenantId, runId: plan.run_id, stepId: step.step_id, workerId: 'evidence-pack-test', attempt: 1, fencingToken: 1 };
    const result = await executeGoldenStep({ step, question: plan.question, connectorType: 'postgres', groupId: source.sourceGroupId });
    expect(await completeStep(worker, claim, { resultRef: 'golden://phase2/evidence-pack', analyticResult: result })).toBe(true);
    expect(await finalizeAnalyticRun(worker, plan.run_id)).toBe('COMPLETED');

    const server = await buildServer({ pool: app, sessionSecret: 's'.repeat(64), testAccounts: [{ tenantId, email: `${tenantId}@synthetic.example` }] });
    try {
      const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}@synthetic.example`, password: 'synthetic-password' } });
      const response = await server.inject({ method: 'POST', url: `/api/runs/${plan.run_id}/evidence-pack`, headers: { cookie: String(login.headers['set-cookie']), 'content-type': 'application/json' }, payload: { format } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain(contentType);
      expect(response.rawPayload.subarray(0, signature.length).toString()).toBe(signature);
      const metadata = await withTenant(migrate, tenantId, async (db) => {
        await db.query("SELECT set_config('app.principal_id',$1,true)", [user]);
        return (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM reports.export_events WHERE tenant_id=$1', [tenantId])).rows[0]!.count;
      });
      expect(metadata).toBe(1);
    } finally { await server.close(); }
  });
});
