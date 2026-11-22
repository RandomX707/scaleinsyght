import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createAnalyticPlan, startAnalyticRun } from '@scaleinsyght/analytic';
import { hashPlan } from '@scaleinsyght/contracts';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = '/si_test'; return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

describe('contract 3 analytic plan validation', () => {
  afterAll(async () => { await app.end(); await migrate.end(); });
  it('c3_invalid_cycles_types_budgets_or_unauthorized_sources_never_queue_steps', async () => {
    const tenantId = `analytic-${crypto.randomUUID()}`;
    let principalId = '';
    await withTenant(migrate, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      principalId = (await db.query<{ user_id: string }>(
        "INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id",
        [tenantId, `${tenantId}@synthetic.example`],
      )).rows[0]!.user_id;
      await db.query(`INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)`, [tenantId]);
    });
    const source = await activateConnection(app, { tenantId, principalId, connectorType: 'postgres' });
    const plan = await createAnalyticPlan({
      question: 'Compare the synthetic source totals',
      runId: crypto.randomUUID(),
      sources: [{ sourceId: source.connectionId, agentId: source.agentId, groupId: source.sourceGroupId, groupVersion: 1 }],
    });
    const invalidPlan = { ...plan, budgets: { ...plan.budgets, max_runtime_s: 1801 } };
    await expect(startAnalyticRun(app, { tenantId, principalId, plan: invalidPlan })).rejects.toThrow('analytic_plan_invalid');
    await expect(startAnalyticRun(app, { tenantId, principalId, plan })).rejects.toThrow('principal_not_entitled');
    const cycle = { ...plan, steps: plan.steps.map((step) => ({ ...step, depends_on: [step.step_id] })) };
    cycle.plan_hash = await hashPlan({ ...cycle, plan_hash: '' });
    await expect(startAnalyticRun(app, { tenantId, principalId, plan: cycle })).rejects.toThrow('analytic_plan_cycle');
    const malformed = { ...plan, steps: plan.steps.map((step) => ({ ...step, inputs: { sql: 'SELECT * FROM real_table' } })) };
    malformed.plan_hash = await hashPlan({ ...malformed, plan_hash: '' });
    await expect(startAnalyticRun(app, { tenantId, principalId, plan: malformed })).rejects.toThrow('analytic_plan_invalid');
    const counts = await withTenant(migrate, tenantId, async (db) => ({
      runs: await db.query<{ count: string }>('SELECT count(*)::text AS count FROM runs.runs WHERE tenant_id=$1', [tenantId]),
      steps: await db.query<{ count: string }>('SELECT count(*)::text AS count FROM runs.steps WHERE tenant_id=$1', [tenantId]),
    }));
    expect(counts.runs.rows[0]?.count).toBe('0');
    expect(counts.steps.rows[0]?.count).toBe('0');
    await withTenant(migrate, tenantId, async (db) => {
      await db.query(`INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)`, [tenantId, principalId, source.connectionId]);
    });
    const stale = { ...plan, steps: plan.steps.map((step) => ({ ...step, group_version: step.group_version + 1 })) };
    stale.plan_hash = await hashPlan({ ...stale, plan_hash: '' });
    await expect(startAnalyticRun(app, { tenantId, principalId, plan: stale })).rejects.toThrow('source_group_version_not_pinned');
    const started = await startAnalyticRun(app, { tenantId, principalId, plan });
    expect(started.runId).toBe(plan.run_id);
    const persisted = await withTenant(migrate, tenantId, async (db) => ({
      run: await db.query<{ state: string }>('SELECT state FROM runs.runs WHERE tenant_id=$1 AND run_id=$2', [tenantId, plan.run_id]),
      steps: await db.query<{ count: string }>('SELECT count(*)::text AS count FROM runs.steps WHERE tenant_id=$1 AND run_id=$2 AND state=\'PENDING\'', [tenantId, plan.run_id]),
    }));
    expect(persisted.run.rows[0]?.state).toBe('RUNNING');
    expect(persisted.steps.rows[0]?.count).toBe('1');
    await withTenant(migrate, tenantId, async (db) => {
      await db.query("UPDATE runs.steps SET state='CANCELLED' WHERE tenant_id=$1 AND run_id=$2", [tenantId, plan.run_id]);
      await db.query("UPDATE runs.runs SET state='CANCELLED',state_version=state_version+1 WHERE tenant_id=$1 AND run_id=$2", [tenantId, plan.run_id]);
    });
  });
});
