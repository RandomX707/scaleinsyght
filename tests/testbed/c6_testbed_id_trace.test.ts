import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { EncryptedArtifactStore } from '@scaleinsyght/artifacts';
import { withTenant } from '@scaleinsyght/db';
import { hashPassword } from '@scaleinsyght/api/server';
import { buildTestServer } from '../support/test-api.js';
import { startSqlParser } from '../support/sqlparse-server.js';
import { runQueuedDiscoveries } from '../support/discovery.js';

// S5: the ID agent fingerprints identifier values in PostgreSQL, SQL Server and the workbook and matches them across
// systems. Checked against testbed/id-truth.json, measured directly in each testbed.
config({ path: '.env' });
const testUrl = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; ID trace contracts are never skipped`); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString(); };
if (!process.env.ARTIFACT_MASTER_KEY) throw new Error('ARTIFACT_MASTER_KEY is required; set it in .env.');
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') }); const adminPool = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });
type Truth = Record<string, { fields: Array<{ source: string; field: string; distinct: number }>; pairs: Array<{ left: string; right: string; shared: number }> }>;
const truth = Object.fromEntries(Object.entries(JSON.parse(readFileSync('testbed/id-truth.json', 'utf8')) as Record<string, unknown>).filter(([key]) => key !== '_note')) as Truth;
const tenantId = `ids-${randomUUID()}`; const email = `admin@${tenantId}.synthetic.invalid`; const password = 'id-trace-test-password';
const volume = mkdtempSync(join(tmpdir(), 'si-ids-'));
let server: Awaited<ReturnType<typeof buildTestServer>>; let cookie = ''; let parser: Awaited<ReturnType<typeof startSqlParser>>;
const sourceKey: Record<string, string> = { postgres: 'postgres', sql_server: 'sql_server', excel: 'excel' };
type Entity = { entityId: string; label: string; fields: Array<{ field: string; connectorType: string; distinct: number; role: string; probable: boolean; sharedWithHome: number | null; tagged: boolean }> };

describe('S5 ID agent and ID trace on the testbed', () => {
  beforeAll(async () => {
    parser = await startSqlParser(8032);
    process.env.CONNECTION_SECRET_KEY = Buffer.alloc(32, 47).toString('base64');
    await withTenant(adminPool, tenantId, async (db) => { await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]); await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)', [tenantId, email, hashPassword(password), 'ID User']); });
    const store = new EncryptedArtifactStore(volume, Buffer.alloc(32, 23));
    server = await buildTestServer({ pool: appPool, sessionSecret: 'id-trace-contract-secret-0123456789abcdefghij', testAccounts: [{ tenantId, email }], artifactStore: store });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).headers['set-cookie']).split(';')[0]!;
    const pg = new URL(process.env.DATABASE_URL_TESTBED ?? ''); if (!pg.hostname || !process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('The PostgreSQL and SQL Server testbeds are required; run pnpm testbed:up.');
    for (const payload of [
      { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: pg.hostname, port: Number(pg.port || 5432), database: pg.pathname.slice(1), username: decodeURIComponent(pg.username), password: decodeURIComponent(pg.password), sslMode: 'disable' } },
      { connectorType: 'sql_server', displayName: 'SQL Server testbed', credential: { host: process.env.SQLSERVER_TESTBED_HOST, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE, username: process.env.SQLSERVER_TESTBED_USERNAME, password: process.env.SQLSERVER_TESTBED_PASSWORD, trustServerCertificate: true } },
      { connectorType: 'excel', displayName: 'Operations workbook' },
    ]) {
      const draft = await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload }); expect(draft.statusCode).toBe(201);
      const id = draft.json<{ connectionId: string }>().connectionId;
      if (payload.connectorType === 'excel') expect((await server.inject({ method: 'POST', url: `/api/connections/${id}/workbooks`, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: readFileSync('testbed/excel/hospital-operations.xlsx') })).statusCode).toBe(201);
      expect((await server.inject({ method: 'POST', url: `/api/connections/${id}/test`, headers: { cookie } })).statusCode).toBe(200);
      expect((await server.inject({ method: 'POST', url: `/api/connections/${id}/activate`, headers: { cookie }, payload: { scope: [] } })).statusCode).toBe(200);
      await runQueuedDiscoveries(tenantId, store);
    }
  });
  afterAll(async () => { await server?.close(); parser?.stop(); await appPool.end(); await adminPool.end(); rmSync(volume, { recursive: true, force: true }); delete process.env.CONNECTION_SECRET_KEY; });

  it('s5_identifier_fields_are_grouped_across_systems_with_counts_matching_truth', async () => {
    const entities = (await server.inject({ method: 'GET', url: '/api/ids/entities', headers: { cookie } })).json<{ entities: Entity[] }>().entities;
    for (const [name, expected] of Object.entries(truth)) {
      const key = (source: string, field: string) => `${sourceKey[source]}:${field}`;
      const wanted = new Set(expected.fields.map((field) => key(field.source, field.field)));
      const entity = entities.find((item) => item.fields.some((field) => wanted.has(`${field.connectorType}:${field.field}`)));
      expect(entity, name).toBeDefined();
      const found = new Set(entity!.fields.map((field) => `${field.connectorType}:${field.field}`));
      // Every field of this identifier is in the group, and no field of another identifier joins it.
      for (const field of wanted) expect(found.has(field), `${name}: ${field}`).toBe(true);
      for (const [other, otherTruth] of Object.entries(truth)) if (other !== name) for (const field of otherTruth.fields) expect(found.has(key(field.source, field.field)), `${name} must not hold ${field.field}`).toBe(false);
      const home = entity!.fields.find((field) => field.role === 'created')!;
      for (const field of entity!.fields.filter((item) => wanted.has(`${item.connectorType}:${item.field}`))) {
        const truthField = expected.fields.find((item) => key(item.source, item.field) === `${field.connectorType}:${field.field}`)!;
        expect(field.distinct, field.field).toBe(truthField.distinct);
        if (field === home) continue;
        const pair = expected.pairs.find((item) => [item.left, item.right].includes(`${field.connectorType}:${field.field}`) && [item.left, item.right].includes(`${home.connectorType}:${home.field}`));
        expect(field.sharedWithHome, `${field.field} found at ${home.field}`).toBe(pair!.shared);
        // Cross-system links are probable until reviewed, never verified.
        if (field.connectorType !== home.connectorType) expect(field.probable).toBe(true);
      }
    }
    // The workbook's Visit ID is the encounter ID under another name: matched, and shown as a changed key.
    const encounter = entities.find((item) => item.fields.some((field) => field.field === 'Visits.visit_id'))!;
    expect(encounter.fields.find((field) => field.field === 'Visits.visit_id')!.role).toBe('key changed');
  });

  it('s5_a_value_is_looked_up_by_fingerprint_without_being_stored', async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL_TESTBED }); const mrn = (await pg.query<{ mrn: string }>('SELECT mrn FROM public.patients ORDER BY patient_id LIMIT 1')).rows[0]!.mrn; await pg.end();
    const found = await server.inject({ method: 'POST', url: '/api/ids/lookup', headers: { cookie }, payload: { value: mrn } });
    expect(found.statusCode).toBe(200);
    const fields = found.json<{ matches: Array<{ field: string }> }>().matches.map((item) => item.field);
    expect(fields).toEqual(expect.arrayContaining(['public.patients.mrn', 'dbo.patients.mrn']));
    expect(JSON.stringify(found.json())).not.toContain(mrn);
    expect((await server.inject({ method: 'POST', url: '/api/ids/lookup', headers: { cookie }, payload: { value: 'NOT-A-REAL-ID-000' } })).json()).toEqual({ matches: [] });
    // Nothing in the graph holds the raw value.
    const stored = await withTenant(adminPool, tenantId, async (db) => (await db.query<{ n: string }>(
      `SELECT ((SELECT count(*) FROM graph.evidence WHERE tenant_id=$1 AND safe_metadata::text LIKE '%'||$2||'%')+(SELECT count(*) FROM graph.id_fields WHERE tenant_id=$1 AND (entity_hint LIKE '%'||$2||'%' OR format_pattern LIKE '%'||$2||'%')))::text AS n`, [tenantId, mrn])).rows[0]!.n);
    expect(stored).toBe('0');
  });
});
