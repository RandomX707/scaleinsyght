import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { hashPassword } from '@scaleinsyght/api/server';
import { buildTestServer } from '../support/test-api.js';
import { startSqlParser } from '../support/sqlparse-server.js';

config({ path: '.env' });
const testUrl = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; lineage contracts are never skipped`); const url = new URL(value); url.pathname = '/si_test'; return url.toString(); };
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') }); const adminPool = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });
type DbtTruth = { models: Record<string, { declaredReads: string[]; columns?: Record<string, string[]> }>; gaps: Array<{ asset: string; reasonIncludes: string }>; modelsInDbtConnection: string[] };
const truth = JSON.parse(readFileSync('testbed/lineage-truth.json', 'utf8')) as { views: Record<'postgres' | 'sql_server', Record<string, { reads: string[]; columns: Record<string, string[]> }>>; dbt: DbtTruth; endToEnd: Record<string, string[]> };
let postgresId = '';
const tenantId = `lineage-${randomUUID()}`; const email = `admin@${tenantId}.synthetic.invalid`; const password = 'lineage-view-test-password';
let server: Awaited<ReturnType<typeof buildTestServer>>; let cookie = ''; let parser: Awaited<ReturnType<typeof startSqlParser>>;

async function flows(connectionId: string) {
  return withTenant(adminPool, tenantId, async (db) => (await db.query<{ from_name: string; to_name: string; granularity: string; evidence_method: string; evidence: number }>(
    `SELECT f.qualified_name AS from_name,t.qualified_name AS to_name,r.granularity,a.evidence_method,cardinality(a.evidence_ids) AS evidence
     FROM graph.relationships r JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id
     JOIN graph.assertions a ON a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id AND a.valid_to IS NULL
     WHERE r.tenant_id=$1 AND r.family='data_flow' AND t.source_id=$2 ORDER BY 1,2`, [tenantId, connectionId])).rows);
}

describe('contract 6 parsed view lineage on the testbed', () => {
  beforeAll(async () => {
    parser = await startSqlParser();
    process.env.CONNECTION_SECRET_KEY = Buffer.alloc(32, 43).toString('base64');
    await withTenant(adminPool, tenantId, async (db) => { await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]); await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)', [tenantId, email, hashPassword(password), 'Lineage User']); });
    server = await buildTestServer({ pool: appPool, sessionSecret: 'lineage-view-contract-secret-0123456789abcdef', testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => { await server?.close(); parser?.stop(); await appPool.end(); await adminPool.end(); delete process.env.CONNECTION_SECRET_KEY; });

  const connect = async (payload: Record<string, unknown>) => {
    const draft = await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload }); expect(draft.statusCode).toBe(201);
    const id = draft.json<{ connectionId: string }>().connectionId;
    expect((await server.inject({ method: 'POST', url: `/api/connections/${id}/test`, headers: { cookie } })).statusCode).toBe(200);
    const active = await server.inject({ method: 'POST', url: `/api/connections/${id}/activate`, headers: { cookie }, payload: { scope: [] } }); expect(active.statusCode).toBe(200);
    return id;
  };
  const expectViews = (rows: Awaited<ReturnType<typeof flows>>, expected: Record<string, { reads: string[]; columns: Record<string, string[]> }>) => {
    for (const [view, spec] of Object.entries(expected)) {
      expect(rows.filter((row) => row.granularity === 'dataset' && row.to_name === view).map((row) => row.from_name).sort()).toEqual([...spec.reads].sort());
      for (const [column, sources] of Object.entries(spec.columns)) {
        expect(rows.filter((row) => row.granularity === 'field' && row.to_name === `${view}.${column}`).map((row) => row.from_name).sort(), `${view}.${column}`).toEqual([...sources].sort());
      }
    }
    // Every edge carries parsed evidence; nothing flows into a table that is not a view.
    expect(rows.every((row) => row.evidence_method === 'parsed' && row.evidence >= 1)).toBe(true);
    const targets = new Set(Object.keys(expected));
    expect(rows.filter((row) => !targets.has(row.granularity === 'dataset' ? row.to_name : row.to_name.slice(0, row.to_name.lastIndexOf('.'))))).toEqual([]);
  };

  it('c6_postgres_view_sql_is_parsed_into_table_and_column_lineage_matching_truth', async () => {
    const url = new URL(process.env.DATABASE_URL_TESTBED ?? ''); if (!url.hostname) throw new Error('DATABASE_URL_TESTBED is required; run pnpm testbed:up first.');
    const id = await connect({ connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), sslMode: 'disable' } });
    expectViews(await flows(id), truth.views.postgres);
    postgresId = id;
  });
  it('c6_sql_server_view_sql_is_parsed_into_table_and_column_lineage_matching_truth', async () => {
    if (!process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('SQLSERVER_TESTBED_PASSWORD is required; run pnpm testbed:up first.');
    const id = await connect({ connectorType: 'sql_server', displayName: 'SQL Server testbed', credential: { host: process.env.SQLSERVER_TESTBED_HOST, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE, username: process.env.SQLSERVER_TESTBED_USERNAME, password: process.env.SQLSERVER_TESTBED_PASSWORD, trustServerCertificate: true } });
    expectViews(await flows(id), truth.views.sql_server);
  });
  it('c6_dbt_artifacts_uploaded_for_the_warehouse_give_declared_tables_parsed_columns_and_explicit_gaps', async () => {
    expect(postgresId).not.toBe('');
    let manifest: unknown; let catalog: unknown;
    try { manifest = JSON.parse(readFileSync('testbed/dbt/target/manifest.json', 'utf8')); catalog = JSON.parse(readFileSync('testbed/dbt/target/catalog.json', 'utf8')); }
    catch { throw new Error('testbed/dbt/target is missing; run pnpm testbed:dbt first.'); }
    const draft = await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { connectorType: 'dbt', displayName: 'Hospital dbt project', warehouseConnectionId: postgresId } });
    expect(draft.statusCode).toBe(201); const id = draft.json<{ connectionId: string }>().connectionId;
    const wrong = await server.inject({ method: 'POST', url: `/api/connections/${id}/dbt-artifacts`, headers: { cookie }, payload: { manifest: catalog, catalog: manifest } });
    expect(wrong.statusCode).toBe(400); expect(wrong.json()).toEqual({ error: 'dbt_manifest_invalid' });
    const uploaded = await server.inject({ method: 'POST', url: `/api/connections/${id}/dbt-artifacts`, headers: { cookie }, payload: { manifest, catalog } });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json<{ imported: { models: number; modelsNotInWarehouse: string[] } }>().imported).toMatchObject({ models: Object.keys(truth.dbt.models).length, modelsNotInWarehouse: truth.dbt.modelsInDbtConnection });
    const rows = await withTenant(adminPool, tenantId, async (db) => (await db.query<{ from_name: string; to_name: string; granularity: string; evidence_method: string }>(
      `SELECT f.qualified_name AS from_name,t.qualified_name AS to_name,r.granularity,a.evidence_method FROM graph.assertions a JOIN graph.relationships r ON r.tenant_id=a.tenant_id AND r.relationship_id=a.relationship_id
       JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id
       WHERE a.tenant_id=$1 AND a.collector_version='dbt-artifacts-v1' AND a.valid_to IS NULL ORDER BY 1,2`, [tenantId])).rows);
    for (const [model, spec] of Object.entries(truth.dbt.models)) {
      const declared = rows.filter((row) => row.granularity === 'dataset' && row.to_name === model);
      expect(declared.map((row) => row.from_name).sort(), model).toEqual([...spec.declaredReads].sort());
      expect(declared.every((row) => row.evidence_method === 'declared')).toBe(true);
      for (const [column, sources] of Object.entries(spec.columns ?? {})) {
        expect(rows.filter((row) => row.granularity === 'field' && row.to_name === `${model}.${column}`).map((row) => row.from_name).sort(), `${model}.${column}`).toEqual([...sources].sort());
      }
    }
    // billing.claims is visible to dbt but not to the product's read-only role: an explicit gap, never an invented edge.
    expect(rows.some((row) => row.from_name.startsWith('billing.'))).toBe(false);
    const gaps = await withTenant(adminPool, tenantId, async (db) => (await db.query<{ asset: string; reason: string }>(
      'SELECT a.qualified_name AS asset,g.reason FROM graph.gaps g JOIN graph.assets a ON a.tenant_id=g.tenant_id AND a.asset_id=ANY(g.between_asset_ids) WHERE g.tenant_id=$1 AND g.closed_by_assertion_id IS NULL', [tenantId])).rows);
    for (const expected of truth.dbt.gaps) expect(gaps.some((gap) => gap.asset === expected.asset && gap.reason.includes(expected.reasonIncludes)), expected.asset).toBe(true);
    // End to end: a mart column traced upstream through dbt and the staging view to its source column.
    for (const [column, upstream] of Object.entries(truth.endToEnd)) {
      const asset = await withTenant(adminPool, tenantId, async (db) => (await db.query<{ asset_id: string }>("SELECT asset_id FROM graph.assets WHERE tenant_id=$1 AND qualified_name=$2 AND active", [tenantId, column])).rows[0]!.asset_id);
      const path = (await server.inject({ method: 'GET', url: `/api/lineage?assetId=${asset}&direction=upstream`, headers: { cookie } })).json<{ assets: Array<{ qualified_name: string }> }>();
      expect(path.assets.map((item) => item.qualified_name).filter((name) => name !== column).sort()).toEqual([...upstream].sort());
    }
    // Uploading the same artifacts again adds no edges.
    const again = await server.inject({ method: 'POST', url: `/api/connections/${id}/dbt-artifacts`, headers: { cookie }, payload: { manifest, catalog } });
    expect(again.statusCode).toBe(200);
    const count = await withTenant(adminPool, tenantId, async (db) => Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM graph.assertions WHERE tenant_id=$1 AND collector_version='dbt-artifacts-v1' AND valid_to IS NULL", [tenantId])).rows[0]!.n));
    expect(count).toBe(rows.length);
  });
});
