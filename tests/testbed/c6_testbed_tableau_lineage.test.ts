import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { hashPassword } from '@scaleinsyght/api/server';
import { buildTestServer } from '../support/test-api.js';
import { startSqlParser } from '../support/sqlparse-server.js';

// S8 on the testbed: a hand-written .twb on the dbt marts, uploaded through the product, traced to the operational
// columns through the dbt lineage, compared with testbed/lineage-truth.json. Reads the testbed sources only.
config({ path: '.env' });
const testUrl = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; lineage contracts are never skipped`); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); };
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') }); const adminPool = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });
type TableauTruth = {
  workbook: string; connectionName: string;
  datasets: Record<string, { reads: string[]; method: 'declared' | 'parsed' }>; fields: Record<string, string[]>; reports: Record<string, string[]>;
  endToEnd: Record<string, string[]>; upstreamGaps: Array<{ report: string; asset: string; reasonIncludes: string }>;
};
const truth = (JSON.parse(readFileSync('testbed/lineage-truth.json', 'utf8')) as { tableau: TableauTruth }).tableau;
const tenantId = `tableau-testbed-${randomUUID()}`; const email = `admin@${tenantId}.synthetic.invalid`; const password = 'tableau-testbed-password';
let server: Awaited<ReturnType<typeof buildTestServer>>; let cookie = ''; let parser: Awaited<ReturnType<typeof startSqlParser>>;

describe('contract 6 Tableau workbook lineage on the testbed', () => {
  beforeAll(async () => {
    parser = await startSqlParser();
    process.env.CONNECTION_SECRET_KEY = Buffer.alloc(32, 53).toString('base64');
    await withTenant(adminPool, tenantId, async (db) => { await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]); await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)', [tenantId, email, hashPassword(password), 'Tableau Testbed User']); });
    server = await buildTestServer({ pool: appPool, sessionSecret: 'tableau-testbed-contract-secret-0123456789abc', testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => { await server?.close(); parser?.stop(); await appPool.end(); await adminPool.end(); delete process.env.CONNECTION_SECRET_KEY; });

  it('c6_tableau_worksheets_on_dbt_marts_trace_to_operational_columns_matching_truth', async () => {
    const url = new URL(process.env.DATABASE_URL_TESTBED ?? ''); if (!url.hostname) throw new Error('DATABASE_URL_TESTBED is required; run pnpm testbed:up first.');
    let manifest: unknown; let catalog: unknown;
    try { manifest = JSON.parse(readFileSync('testbed/dbt/target/manifest.json', 'utf8')); catalog = JSON.parse(readFileSync('testbed/dbt/target/catalog.json', 'utf8')); }
    catch { throw new Error('testbed/dbt/target is missing; run pnpm testbed:dbt first.'); }
    const post = (path: string, payload: Record<string, unknown>) => server.inject({ method: 'POST', url: path, headers: { cookie }, payload });
    const warehouse = (await post('/api/connections', { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), sslMode: 'disable' } })).json<{ connectionId: string }>().connectionId;
    expect((await post(`/api/connections/${warehouse}/test`, {})).statusCode).toBe(200);
    expect((await post(`/api/connections/${warehouse}/activate`, { scope: [] })).statusCode).toBe(200);
    const dbt = (await post('/api/connections', { connectorType: 'dbt', displayName: 'Hospital dbt project', warehouseConnectionId: warehouse })).json<{ connectionId: string }>().connectionId;
    expect((await post(`/api/connections/${dbt}/dbt-artifacts`, { manifest, catalog })).statusCode).toBe(200);
    const tableau = (await post('/api/connections', { connectorType: 'tableau', displayName: truth.connectionName, warehouseConnectionId: warehouse })).json<{ connectionId: string }>().connectionId;
    const uploaded = await post(`/api/connections/${tableau}/tableau-workbook`, { workbook: readFileSync(truth.workbook, 'utf8') });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json<{ imported: { gaps: number; worksheets: number } }>().imported).toMatchObject({ gaps: 0, worksheets: Object.keys(truth.reports).length });

    const rows = await withTenant(adminPool, tenantId, async (db) => (await db.query<{ from_name: string; to_name: string; granularity: string; evidence_method: string; evidence: number }>(
      `SELECT f.qualified_name AS from_name,t.qualified_name AS to_name,r.granularity,a.evidence_method,cardinality(a.evidence_ids) AS evidence
       FROM graph.relationships r JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id
       JOIN graph.assertions a ON a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id AND a.valid_to IS NULL
       WHERE r.tenant_id=$1 AND r.family='data_flow' AND t.source_id=$2 ORDER BY 1,2`, [tenantId, tableau])).rows);
    const into = (name: string, granularity: string) => rows.filter((row) => row.to_name === name && row.granularity === granularity);
    for (const [dataset, spec] of Object.entries(truth.datasets)) {
      expect(into(dataset, 'dataset').map((row) => row.from_name).sort(), dataset).toEqual([...spec.reads].sort());
      expect(into(dataset, 'dataset').every((row) => row.evidence_method === spec.method), dataset).toBe(true);
    }
    for (const [field, sources] of Object.entries(truth.fields)) expect(into(field, 'field').map((row) => row.from_name).sort(), field).toEqual([...sources].sort());
    for (const [report, fields] of Object.entries(truth.reports)) expect(into(report, 'report').map((row) => row.from_name).sort(), report).toEqual([...fields].sort());
    // Nothing beyond the truth, and evidence on every edge.
    const targets = new Set([...Object.keys(truth.datasets), ...Object.keys(truth.fields), ...Object.keys(truth.reports)]);
    expect(rows.filter((row) => !targets.has(row.to_name)).map((row) => row.to_name)).toEqual([]);
    expect(rows.every((row) => row.evidence >= 1)).toBe(true);

    // End to end: each worksheet reaches the operational columns through the Tableau fields, the dbt marts and the
    // staging views; the claim amount stops at an honest gap because billing.claims is not visible to the product.
    for (const [report, upstream] of Object.entries(truth.endToEnd)) {
      const asset = (await withTenant(adminPool, tenantId, (db) => db.query<{ asset_id: string }>('SELECT asset_id FROM graph.assets WHERE tenant_id=$1 AND qualified_name=$2 AND active', [tenantId, report]))).rows[0]!.asset_id;
      const path = (await server.inject({ method: 'GET', url: `/api/lineage?assetId=${asset}&direction=upstream`, headers: { cookie } })).json<{ assets: Array<{ asset_id: string; qualified_name: string }>; gaps: Array<{ between_asset_ids: string[]; reason: string }> }>();
      expect(path.assets.map((item) => item.qualified_name).filter((name) => name.startsWith('public.')).sort(), report).toEqual([...upstream].sort());
      for (const expected of truth.upstreamGaps.filter((gap) => gap.report === report)) {
        const gapAsset = path.assets.find((item) => item.qualified_name === expected.asset);
        expect(gapAsset, expected.asset).toBeDefined();
        expect(path.gaps.some((gap) => gap.between_asset_ids.includes(gapAsset!.asset_id) && gap.reason.includes(expected.reasonIncludes)), expected.asset).toBe(true);
      }
    }
  });
});
