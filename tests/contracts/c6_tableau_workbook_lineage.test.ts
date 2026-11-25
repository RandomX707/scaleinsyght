import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { getImpactRadius, listReports } from '@scaleinsyght/graph';
import { hashPassword } from '@scaleinsyght/api/server';
import { buildTestServer } from '../support/test-api.js';
import { startSqlParser } from '../support/sqlparse-server.js';

// S8: a Tableau workbook (.twb) uploaded for a warehouse connection becomes report-to-column lineage in the graph.
// Real PostgreSQL (si_test and the sample source) and the real SQLGlot service; nothing is mocked.
config({ path: '.env' });
const testUrl = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; Tableau lineage contracts are never skipped`); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); };
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') }); const adminPool = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });
const fixture = readFileSync('tests/golden/tableau/sample-operations.twb', 'utf8');
const tenantId = `tableau-${randomUUID()}`; const email = `admin@${tenantId}.synthetic.invalid`; const password = 'tableau-contract-password';
let server: Awaited<ReturnType<typeof buildTestServer>>; let cookie = ''; let parser: Awaited<ReturnType<typeof startSqlParser>>;
let warehouseId = ''; let tableauId = '';
const report = (sheet: string) => `Sample operations / ${sheet}`;

type Flow = { from_name: string; to_name: string; granularity: string; evidence_method: string; review_status: string; verification: string; evidence: number; transformation: string | null; valid: boolean };
async function flows(): Promise<Flow[]> {
  return withTenant(adminPool, tenantId, async (db) => (await db.query<Flow>(
    `SELECT f.qualified_name AS from_name,t.qualified_name AS to_name,r.granularity,a.evidence_method,a.review_status,a.verification,cardinality(a.evidence_ids) AS evidence,
       a.transformation->>'kind' AS transformation,a.valid_to IS NULL AS valid
     FROM graph.relationships r JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id
     JOIN graph.assertions a ON a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id
     WHERE r.tenant_id=$1 AND r.family='data_flow' AND t.source_id=$2 ORDER BY 1,2`, [tenantId, tableauId])).rows);
}
const current = (rows: Flow[], to: string, granularity = 'field') => rows.filter((row) => row.valid && row.to_name === to && row.granularity === granularity).map((row) => `${row.from_name} [${row.evidence_method}]`).sort();
async function gaps(): Promise<string[]> {
  return withTenant(adminPool, tenantId, async (db) => (await db.query<{ reason: string }>(
    `SELECT DISTINCT g.reason FROM graph.gaps g JOIN graph.assets a ON a.tenant_id=g.tenant_id AND a.asset_id=ANY(g.between_asset_ids)
     WHERE g.tenant_id=$1 AND a.source_id=$2 AND g.closed_by_assertion_id IS NULL ORDER BY 1`, [tenantId, tableauId])).rows.map((row) => row.reason));
}
const upload = (workbook: string) => server.inject({ method: 'POST', url: `/api/connections/${tableauId}/tableau-workbook`, headers: { cookie }, payload: { workbook } });

describe('contract 6 Tableau workbook lineage', () => {
  beforeAll(async () => {
    parser = await startSqlParser();
    process.env.CONNECTION_SECRET_KEY = Buffer.alloc(32, 47).toString('base64');
    await withTenant(adminPool, tenantId, async (db) => { await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]); await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)', [tenantId, email, hashPassword(password), 'Tableau User']); });
    server = await buildTestServer({ pool: appPool, sessionSecret: 'tableau-contract-secret-0123456789abcdef0123', testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).headers['set-cookie']).split(';')[0]!;
    const sample = new URL(process.env.DATABASE_URL_SAMPLE_SOURCE ?? ''); if (!sample.hostname) throw new Error('DATABASE_URL_SAMPLE_SOURCE is required; run pnpm db:setup:sample');
    const draft = await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { connectorType: 'postgres', displayName: 'Sample warehouse', credential: { host: sample.hostname, port: Number(sample.port || 5432), database: sample.pathname.slice(1), username: decodeURIComponent(sample.username), password: decodeURIComponent(sample.password), sslMode: 'disable' } } });
    warehouseId = draft.json<{ connectionId: string }>().connectionId;
    expect((await server.inject({ method: 'POST', url: `/api/connections/${warehouseId}/test`, headers: { cookie } })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: `/api/connections/${warehouseId}/activate`, headers: { cookie }, payload: { scope: [] } })).statusCode).toBe(200);
  }, 120_000);
  afterAll(async () => { await server?.close(); parser?.stop(); await appPool.end(); await adminPool.end(); delete process.env.CONNECTION_SECRET_KEY; });

  it('c6_tableau_workbook_is_checked_before_the_connection_activates', async () => {
    expect((await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { connectorType: 'tableau', displayName: 'No warehouse' } })).json()).toEqual({ error: 'tableau_warehouse_required' });
    expect((await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { connectorType: 'tableau', displayName: 'Unknown', warehouseConnectionId: randomUUID() } })).json()).toEqual({ error: 'tableau_warehouse_not_found' });
    const draft = await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { connectorType: 'tableau', displayName: 'Sample operations', warehouseConnectionId: warehouseId } });
    expect(draft.statusCode).toBe(201); tableauId = draft.json<{ connectionId: string }>().connectionId;
    for (const [body, error] of [
      ['<html/>', 'tableau_workbook_invalid'],
      ['<?xml version="1.0"?><!DOCTYPE workbook [<!ENTITY x SYSTEM "file:///etc/passwd">]><workbook>&x;</workbook>', 'tableau_workbook_invalid'],
      ['PK\u0003\u0004packaged workbook', 'tableau_twbx_unsupported'],
      ['<workbook><datasources/></workbook>', 'tableau_workbook_has_no_datasources'],
    ] as const) {
      const refused = await upload(body); expect(refused.statusCode).toBe(400); expect(refused.json()).toEqual({ error: error });
    }
    const state = await withTenant(adminPool, tenantId, async (db) => ({
      connection: (await db.query<{ status: string; connector_agent_id: string | null }>('SELECT status,connector_agent_id FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2', [tenantId, tableauId])).rows[0],
      assets: Number((await db.query<{ count: string }>('SELECT count(*) FROM graph.assets WHERE tenant_id=$1 AND source_id=$2', [tenantId, tableauId])).rows[0]!.count),
    }));
    expect(state).toEqual({ connection: { status: 'draft', connector_agent_id: null }, assets: 0 });
  });

  it('c6_tableau_worksheets_trace_to_warehouse_columns_with_evidence_on_every_edge_and_explicit_gaps', async () => {
    const uploaded = await upload(fixture);
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json<{ imported: Record<string, number> }>().imported).toMatchObject({ datasources: 4, worksheets: 5, calculatedFields: 5 });
    // Contract 2: the connector agent is created with the activation.
    const connection = await withTenant(adminPool, tenantId, (db) => db.query<{ status: string; connector_agent_id: string | null }>('SELECT status,connector_agent_id FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2', [tenantId, tableauId]));
    expect(connection.rows[0]!.status).toBe('active'); expect(connection.rows[0]!.connector_agent_id).not.toBeNull();

    const rows = await flows();
    // Tables: declared by the data source's relations, parsed from its custom SQL.
    expect(current(rows, 'Encounters by department', 'dataset')).toEqual(['public.departments [declared]', 'public.encounters [declared]']);
    expect(current(rows, 'Orders (custom SQL)', 'dataset')).toEqual(['public.departments [parsed]', 'public.encounters [parsed]', 'public.orders [parsed]']);
    // Columns mapped by metadata records are declared; custom SQL columns are parsed.
    expect(current(rows, 'Encounters by department.Department')).toEqual(['public.departments.department_name [declared]']);
    expect(current(rows, 'Encounters by department.department_id (departments)')).toEqual(['public.departments.department_id [declared]']);
    expect(current(rows, 'Orders (custom SQL).Order type')).toEqual(['public.orders.order_type [parsed]']);
    expect(current(rows, 'Orders (custom SQL).department_name')).toEqual(['public.departments.department_name [parsed]']);
    expect(current(rows, 'Orders (custom SQL).Order lines')).toEqual(['public.orders.order_id [parsed]']);
    expect(rows.find((row) => row.to_name === 'Orders (custom SQL).Order lines')?.transformation).toBe('derived');
    // Calculated fields come from the fields their formulas name, through other calculated fields too.
    expect(current(rows, 'Encounters by department.Encounter count')).toEqual(['Encounters by department.encounter_id [parsed]']);
    expect(current(rows, 'Encounters by department.Stay days')).toEqual(['Encounters by department.admitted_at [parsed]', 'Encounters by department.discharged_at [parsed]']);
    expect(current(rows, 'Encounters by department.Long stay')).toEqual(['Encounters by department.Stay days [parsed]']);
    expect(current(rows, 'Encounters by department.Above target')).toEqual(['Encounters by department.Encounter count [parsed]']);
    // Worksheets: the fields they place, declared by the workbook.
    expect(current(rows, report('Encounters by department'), 'report')).toEqual(['Encounters by department.Department [declared]', 'Encounters by department.Encounter count [declared]']);
    expect(current(rows, report('Orders by type'), 'report')).toEqual(['Orders (custom SQL).Order lines [declared]', 'Orders (custom SQL).Order type [declared]', 'Orders (custom SQL).department_name [declared]']);
    // Contract 6: evidence on every edge; an import never reviews or verifies anything; no structural edge counts as flow.
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((row) => row.evidence >= 1 && ['declared', 'parsed'].includes(row.evidence_method) && row.review_status === 'unreviewed' && row.verification === 'unverified')).toBe(true);
    // Every hop that cannot be followed is an explicit gap.
    expect(await gaps()).toEqual([
      'Budget workbook connects to excel-direct, not the linked warehouse, so its fields are not traced',
      'Claims archive reads billing.claims, which no connected source exposes',
      'Claims archive.Claim amount reads billing.claims.claim_amount, which no connected source exposes',
      'Encounters by department.Ward refers to ward_code, which the data source does not define',
    ]);
  });

  it('c6_tableau_impact_of_a_source_column_reaches_the_worksheets_built_on_it', async () => {
    const asset = async (name: string) => (await withTenant(adminPool, tenantId, (db) => db.query<{ asset_id: string }>('SELECT asset_id FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3', [tenantId, warehouseId, name]))).rows[0]!.asset_id;
    const tableauReports = async (column: string) => (await getImpactRadius(appPool, { tenantId, assetId: await asset(column) })).reports.filter((item) => item.tool === 'tableau').map((item) => item.name).sort();
    expect(await tableauReports('public.departments.department_name')).toEqual([report('Encounters by department'), report('Long stays'), report('Orders by type')]);
    // Through two calculated fields: admitted_at -> Stay days -> Long stay -> worksheet.
    expect(await tableauReports('public.encounters.admitted_at')).toEqual([report('Long stays')]);
    const listed = (await listReports(appPool, tenantId)).filter((item) => item.tool === 'tableau');
    expect(listed.map((item) => item.name).sort()).toEqual(['Budget', 'Claims', 'Encounters by department', 'Long stays', 'Orders by type'].map(report));
    expect(listed.every((item) => item.lineage_assertions > 0)).toBe(true);
  });

  it('c7_tableau_import_stores_no_sql_formula_literals_or_connection_details', async () => {
    const stored = await withTenant(adminPool, tenantId, async (db) => JSON.stringify((await db.query(
      `SELECT (SELECT json_agg(qualified_name) FROM graph.assets WHERE tenant_id=$1) AS assets,
              (SELECT json_agg(safe_metadata) FROM graph.evidence WHERE tenant_id=$1) AS evidence,
              (SELECT json_agg(json_build_array(explanation,transformation)) FROM graph.assertions WHERE tenant_id=$1) AS assertions,
              (SELECT json_agg(reason) FROM graph.gaps WHERE tenant_id=$1) AS gaps,
              (SELECT json_agg(json_build_array(display_name,source_ref)) FROM registry.connections WHERE tenant_id=$1) AS connections,
              (SELECT count(*) FROM registry.connection_secrets WHERE tenant_id=$1 AND connection_id=$2) AS tableau_secrets`, [tenantId, tableauId])).rows[0]));
    expect(stored).toContain('"tableau_secrets":"0"');
    for (const secret of ['cancelled-orders-marker', 'SELECT', 'COUNTD', 'DATEDIFF', 'Over a week marker', 'not_a_field', 'tableau_reader', 'warehouse.riverside.example', 'riverside_operations', 'budget-secret-path', 'Encounter target']) {
      expect(stored, secret).not.toContain(secret);
    }
  });

  it('c6_tableau_reupload_closes_edges_it_no_longer_proves_and_retires_objects_without_deleting', async () => {
    const before = await withTenant(adminPool, tenantId, (db) => db.query<{ count: string }>('SELECT count(*) FROM graph.assets WHERE tenant_id=$1 AND source_id=$2', [tenantId, tableauId]));
    // The workbook now maps Department to the department code and no longer has the Budget worksheet.
    const changed = fixture
      .replace('<remote-name>department_name</remote-name>\n            <remote-type>129</remote-type>\n            <local-name>[department_name]</local-name>\n            <parent-name>[departments]</parent-name>', '<remote-name>department_code</remote-name>\n            <remote-type>129</remote-type>\n            <local-name>[department_name]</local-name>\n            <parent-name>[departments]</parent-name>')
      .replace(/<worksheet name='Budget'>[\s\S]*?<\/worksheet>/, '');
    expect(changed).not.toBe(fixture);
    expect((await upload(changed)).statusCode).toBe(200);
    const rows = await flows();
    expect(current(rows, 'Encounters by department.Department')).toEqual(['public.departments.department_code [declared]']);
    // The earlier mapping is closed, not deleted, so past dates stay queryable.
    expect(rows.filter((row) => !row.valid && row.from_name === 'public.departments.department_name' && row.to_name === 'Encounters by department.Department')).toHaveLength(1);
    const retired = await withTenant(adminPool, tenantId, async (db) => ({
      budget: (await db.query<{ active: boolean }>('SELECT active FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3', [tenantId, tableauId, report('Budget')])).rows,
      count: (await db.query<{ count: string }>('SELECT count(*) FROM graph.assets WHERE tenant_id=$1 AND source_id=$2', [tenantId, tableauId])).rows[0]!.count,
    }));
    expect(retired).toEqual({ budget: [{ active: false }], count: before.rows[0]!.count });
  });
});
