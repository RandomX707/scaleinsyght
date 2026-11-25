import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildTestServer as buildServer } from '../support/test-api.js';
import { hashPassword } from '@scaleinsyght/api/server';
import { createGoldenHubAdapters, getGoldenHubFixtures } from '../support/golden-hub-adapters.js';
import { withTenant } from '@scaleinsyght/db';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped or mocked`);
  const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString();
}
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });
const fixture = getGoldenHubFixtures();
const tenantId = `hub-metric-${crypto.randomUUID()}`;
let principalId = '';
let cookie = '';
let server: Awaited<ReturnType<typeof buildServer>>;

describe('contract 4 certified metrics through Semantics', () => {
  beforeAll(async () => {
    await withTenant(migrate, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      principalId = (await db.query<{ user_id: string }>(
        'INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id',
        [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')],
      )).rows[0]!.user_id;
      await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'semantics.metric.read',1,'READ','not_applicable',true)", [tenantId]);
      await db.query("INSERT INTO registry.capability_versions(tenant_id,capability_id,version,input_schema,output_schema) VALUES($1,'semantics.metric.read',1,'{}','{}')", [tenantId]);
      await db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'semantics.metric.read','active_customers')", [tenantId, principalId]);
      for (const adapter of fixture.adapters) {
        await db.query('INSERT INTO hub.adapters(tenant_id,product,connected,current_version) VALUES($1,$2,$3,$4)', [tenantId, adapter.product, adapter.connected, adapter.version]);
        await db.query('INSERT INTO hub.adapter_versions(tenant_id,product,version,fixture_key,capabilities) VALUES($1,$2,$3,$4,$5::jsonb)', [tenantId, adapter.product, adapter.version, adapter.fixtureKey, JSON.stringify(adapter.capabilities)]);
      }
      const semantics = fixture.adapters.find((adapter) => adapter.product === 'semantics')!;
      const metric = fixture.metrics[0]!;
      await db.query(`INSERT INTO hub.certified_metrics(tenant_id,metric_id,adapter_version,name,description,dimensions,unit,certified,fixture_key,source_asset)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`, [tenantId, metric.id, semantics.version, metric.name, metric.description, JSON.stringify(metric.dimensions), metric.unit, metric.certified, metric.fixtureKey, metric.sourceAsset]);
    });
    server = await buildServer({
      pool: appPool,
      sessionSecret: 's'.repeat(64),
      testAccounts: [{ tenantId, email: `${tenantId}@synthetic.example` }],
      hubAdapters: createGoldenHubAdapters(fixture),
    } as Parameters<typeof buildServer>[0]);
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}@synthetic.example`, password: 'synthetic-password' } });
    expect(login.statusCode).toBe(200);
    cookie = String(login.headers['set-cookie']);
  });

  afterAll(async () => { await server?.close(); await appPool.end(); await migrate.end(); });

  it('c4_certified_metric_uses_semantics_value_and_cites_adapter_evidence', async () => {
    const adapters = await server.inject({ method: 'GET', url: '/api/hub/adapters', headers: { cookie } });
    expect(adapters.statusCode).toBe(200);
    const metrics = await server.inject({ method: 'GET', url: '/api/semantics/metrics', headers: { cookie } });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({ metrics: [{ metricId: 'active_customers', certified: true, adapterVersion: 1 }] });

    const response = await server.inject({ method: 'POST', url: '/api/semantics/metrics/active_customers/query', headers: { cookie }, payload: {} });
    expect(response.statusCode).toBe(201);
    const result = response.json() as { runId: string; state: string; trustRoute: string; answer: { metric: string; bySource: Array<{ value: number }>; claims: Array<{ evidence_ids: string[] }>; evidence: Array<{ evidence_id: string; source_id: string; content_hash: string }>; metricDefinition: { name: string; unit: string } } };
    expect(result).toMatchObject({ state: 'COMPLETED', trustRoute: 'certified_metric', answer: { metric: 'active_customers', bySource: [{ value: 1284 }], metricDefinition: { name: 'Active customers', unit: 'customers' } } });
    const evidence = result.answer.evidence[0]!;
    expect(evidence.source_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(evidence.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.answer.claims[0]!.evidence_ids).toContain(evidence.evidence_id);
    expect(adapters.json()).toMatchObject({ adapters: [{ product: 'data_studio' }, { product: 'semantics', connected: true, version: 1 }] });
  });

  it('c5_certified_metric_run_persists_safe_events_and_resumes_without_duplicates', async () => {
    const response = await server.inject({ method: 'POST', url: '/api/semantics/metrics/active_customers/query', headers: { cookie }, payload: {} });
    expect(response.statusCode).toBe(201);
    const { runId } = response.json() as { runId: string };
    const resumedRun = await server.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: { cookie } });
    expect(resumedRun.statusCode).toBe(200);
    expect(resumedRun.json()).toMatchObject({ runId, state: 'COMPLETED', answer: { answer: { metric: 'active_customers', bySource: [{ value: 1284 }] } } });
    const first = await server.inject({ method: 'GET', url: `/api/runs/${runId}/events`, headers: { cookie } });
    const second = await server.inject({ method: 'GET', url: `/api/runs/${runId}/events`, headers: { cookie } });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const events = (first.json() as { events: Array<{ sequence: number; safe_payload: Record<string, unknown> }> }).events;
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    expect(JSON.stringify(events)).not.toMatch(/\b1284\b|result_rows|raw_sql|compiled_sql/i);
    const persisted = await withTenant(migrate, tenantId, async (db) => ({
      run: await db.query<{ state: string }>('SELECT state FROM runs.runs WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId]),
      result: await db.query('SELECT run_id FROM hub.metric_results WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId]),
      answer: await db.query('SELECT run_id FROM runs.analytic_answers WHERE tenant_id=$1 AND run_id=$2', [tenantId, runId]),
    }));
    expect(persisted.run.rows[0]?.state).toBe('COMPLETED');
    expect(persisted.result.rowCount).toBe(1);
    expect(persisted.answer.rowCount).toBe(1);
  });

  it('c1_semantics_metric_query_rechecks_entitlement_before_execution', async () => {
    await withTenant(migrate, tenantId, (db) => db.query("DELETE FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='semantics.metric.read'", [tenantId, principalId]));
    const response = await server.inject({ method: 'POST', url: '/api/semantics/metrics/active_customers/query', headers: { cookie }, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'metric_not_authorized' });
    const decision = await withTenant(migrate, tenantId, (db) => db.query<{ outcome: string; run_id: string | null }>(
      "SELECT outcome,run_id FROM runs.authz_decisions WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='semantics.metric.read' ORDER BY created_at DESC LIMIT 1", [tenantId, principalId],
    ));
    expect(decision.rows[0]).toEqual({ outcome: 'deny', run_id: null });
  });

  it('c7_disconnected_semantics_adapter_does_not_fallback_to_exploratory_sql', async () => {
    await withTenant(migrate, tenantId, (db) => db.query("UPDATE hub.adapters SET connected=false WHERE tenant_id=$1 AND product='semantics'", [tenantId]));
    const metrics = await server.inject({ method: 'GET', url: '/api/semantics/metrics', headers: { cookie } });
    const query = await server.inject({ method: 'POST', url: '/api/semantics/metrics/active_customers/query', headers: { cookie }, payload: {} });
    expect(metrics.json()).toEqual({ metrics: [] });
    expect(query.statusCode).toBe(503);
    expect(query.json()).toMatchObject({ error: 'hub_adapter_disconnected' });
  });

  it('phase1_to_phase3_api_routes_remain_available_when_semantics_is_disconnected', async () => {
    const [usage,connections,lineage]=await Promise.all([
      server.inject({method:'GET',url:'/api/usage',headers:{cookie}}),
      server.inject({method:'GET',url:'/api/connections',headers:{cookie}}),
      server.inject({method:'GET',url:'/api/lineage/assets',headers:{cookie}}),
    ]);
    expect(usage.statusCode).toBe(200);expect(connections.statusCode).toBe(200);expect(lineage.statusCode).toBe(200);
  });
});
