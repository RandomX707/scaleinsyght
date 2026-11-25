import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { config } from 'dotenv';
import { Client, Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { hashPassword } from '@scaleinsyght/api/server';
import { claimDueNightly, connectorForConnection, runProfile } from '@scaleinsyght/profiler';
import { buildTestServer } from '../support/test-api.js';
import { startSqlParser } from '../support/sqlparse-server.js';

// S6: a source changes between runs (a column added, a table dropped, a new table, rows added); the nightly refresh
// finds each change, and the Approval matrix decisions are recorded. Uses its own scratch database, never the shared
// testbed.
config({ path: '.env' });
const testUrl = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE' | 'DATABASE_URL_WORKER') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; nightly contracts are never skipped`); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString(); };
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') }); const adminPool = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') }); const workerPool = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER') });
const admin = (() => { const configured = process.env.DATABASE_URL_ADMIN; const url = configured ? new URL(configured) : new URL('postgresql://127.0.0.1:5432/postgres'); if (!configured) { url.username = userInfo().username; url.password = ''; } return url; })();
const database = 'si_test_nightly_source'; const reader = 'si_nightly_reader'; const readerPassword = randomBytes(18).toString('base64url');
const tenantId = `nightly-${randomUUID()}`; const email = `admin@${tenantId}.synthetic.invalid`; const password = 'nightly-refresh-test-password';
let server: Awaited<ReturnType<typeof buildTestServer>>; let cookie = ''; let parser: Awaited<ReturnType<typeof startSqlParser>>; let connectionId = '';
const source = async (sql: string) => { const url = new URL(admin.toString()); url.pathname = `/${database}`; const client = new Client({ connectionString: url.toString() }); await client.connect(); try { await client.query(sql); } finally { await client.end(); } };
type Finding = { findingId: string; kind: string; subject: string; detail: Record<string, unknown>; status: string; jobId: string };
const findings = async () => (await server.inject({ method: 'GET', url: '/api/findings', headers: { cookie } })).json<{ findings: Finding[]; lastNight: { jobIds: string[]; connections: number } }>();

describe('S6 nightly refresh, findings and review', () => {
  beforeAll(async () => {
    parser = await startSqlParser(8033);
    const root = new Client({ connectionString: admin.toString() }); await root.connect();
    try {
      await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await root.query(`CREATE DATABASE ${database}`);
      const role = await root.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [reader]);
      await root.query(`${role.rowCount ? 'ALTER' : 'CREATE'} ROLE ${reader} WITH LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
      await root.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${reader}`);
    } finally { await root.end(); }
    await source(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${reader};
      CREATE TABLE shop_orders(order_id integer PRIMARY KEY, customer_id integer NOT NULL, amount numeric(9,2) NOT NULL);
      INSERT INTO shop_orders SELECT n, 1 + n % 30, n * 1.5 FROM generate_series(1,100) n;
      CREATE TABLE customers(customer_id integer PRIMARY KEY, contact_email text NOT NULL);
      INSERT INTO customers SELECT n, 'person' || lpad(n::text,3,'0') || '@example.test' FROM generate_series(1,30) n;
      CREATE TABLE legacy_codes(code text PRIMARY KEY); INSERT INTO legacy_codes SELECT 'c' || n FROM generate_series(1,20) n;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader};`);
    process.env.CONNECTION_SECRET_KEY = Buffer.alloc(32, 53).toString('base64');
    await withTenant(adminPool, tenantId, async (db) => { await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]); await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)', [tenantId, email, hashPassword(password), 'Nightly User']); });
    server = await buildTestServer({ pool: appPool, sessionSecret: 'nightly-refresh-contract-secret-0123456789abcdef', testAccounts: [{ tenantId, email }] });
    cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).headers['set-cookie']).split(';')[0]!;
    const draft = await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { connectorType: 'postgres', displayName: 'Shop database', credential: { host: admin.hostname, port: Number(admin.port || 5432), database, username: reader, password: readerPassword, sslMode: 'disable' } } });
    expect(draft.statusCode).toBe(201); connectionId = draft.json<{ connectionId: string }>().connectionId;
    expect((await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/test`, headers: { cookie } })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/activate`, headers: { cookie }, payload: { scope: [] } })).statusCode).toBe(200);
  });
  afterAll(async () => {
    await server?.close(); parser?.stop(); await appPool.end(); await adminPool.end(); await workerPool.end(); delete process.env.CONNECTION_SECRET_KEY;
    const root = new Client({ connectionString: admin.toString() }); await root.connect(); try { await root.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await root.end(); }
  });

  it('s6_first_profile_schedules_a_nightly_refresh_and_asks_to_confirm_an_inferred_sensitive_column', async () => {
    const first = await findings();
    expect(first.findings.map((item) => [item.kind, item.subject]).sort()).toEqual([['probable_relationship', 'public.shop_orders.customer_id → public.customers.customer_id'], ['sensitive_column', 'public.customers.contact_email']]);
    const schedule = await withTenant(adminPool, tenantId, async (db) => (await db.query<{ hours: number }>('SELECT extract(epoch FROM next_run_at-clock_timestamp())/3600 AS hours FROM profiler.nightly_schedules WHERE tenant_id=$1 AND connection_id=$2', [tenantId, connectionId])).rows[0]);
    expect(Number(schedule!.hours)).toBeGreaterThan(23); expect(Number(schedule!.hours)).toBeLessThanOrEqual(24);
  });

  it('s6_the_scheduled_refresh_finds_each_source_change_by_name_and_count', async () => {
    await source(`ALTER TABLE shop_orders ADD COLUMN channel text; DROP TABLE legacy_codes;
      INSERT INTO customers SELECT n, 'person' || lpad(n::text,3,'0') || '@example.test' FROM generate_series(31,60) n;
      CREATE TABLE returns(return_id integer PRIMARY KEY, order_id integer NOT NULL); INSERT INTO returns SELECT n, n FROM generate_series(1,5) n;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader};`);
    // The worker claims the due schedule across tenants and refreshes under the claimed tenant.
    await withTenant(adminPool, tenantId, (db) => db.query('UPDATE profiler.nightly_schedules SET next_run_at=clock_timestamp()-interval \'1 minute\' WHERE tenant_id=$1', [tenantId]));
    let due = await claimDueNightly(workerPool);
    while (due && due.tenantId !== tenantId) due = await claimDueNightly(workerPool);
    expect(due).toEqual({ tenantId, connectionId });
    const connector = await connectorForConnection(workerPool, tenantId, connectionId);
    try { await runProfile(workerPool, { tenantId, connectionId, connector, jobType: 'nightly' }); } finally { await connector.close?.(); }
    const result = await findings();
    const night = result.findings.filter((item) => result.lastNight.jobIds.includes(item.jobId)).map((item) => ({ kind: item.kind, subject: item.subject, detail: item.detail }));
    expect(night).toEqual(expect.arrayContaining([
      { kind: 'schema_change', subject: 'public.shop_orders', detail: { change: 'columns', added: ['channel'], removed: [], retyped: [] } },
      { kind: 'schema_change', subject: 'public.legacy_codes', detail: { change: 'dropped' } },
      { kind: 'data_anomaly', subject: 'public.customers', detail: { change: 'row_count', before: 30, after: 60 } },
      { kind: 'new_tables', subject: 'public.returns', detail: { columns: 2, rows: 5 } },
    ]));
    // The new table's order_id matches orders: proposed for review, not trusted.
    expect(night.filter((item) => item.kind === 'probable_relationship').map((item) => item.subject)).toEqual(['public.returns.order_id → public.shop_orders.order_id']);
    expect(night).toHaveLength(5);
    expect(result.lastNight.connections).toBe(1);
    expect(JSON.stringify(result)).not.toContain('@example.test');
  });

  it('s6_dismissing_an_inferred_tag_is_audited_and_survives_the_next_refresh', async () => {
    const sensitive = (await findings()).findings.find((item) => item.kind === 'sensitive_column')!;
    expect((await server.inject({ method: 'POST', url: `/api/findings/${sensitive.findingId}/decision`, headers: { cookie }, payload: { decision: 'rejected' } })).json()).toEqual({ status: 'rejected' });
    expect((await server.inject({ method: 'POST', url: `/api/findings/${sensitive.findingId}/decision`, headers: { cookie }, payload: { decision: 'approved' } })).statusCode).toBe(409);
    expect((await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/discover`, headers: { cookie }, payload: { jobType: 'profile' } })).statusCode).toBe(200);
    const stored = await withTenant(adminPool, tenantId, async (db) => (await db.query<{ tags: string[]; decision: string; decided_by: string | null }>(
      `SELECT p.sensitivity_tags AS tags,r.decision,r.decided_by::text FROM graph.assets a JOIN profiler.tag_reviews r ON r.tenant_id=a.tenant_id AND r.asset_id=a.asset_id
       JOIN LATERAL(SELECT sensitivity_tags FROM profiler.field_profiles WHERE tenant_id=a.tenant_id AND asset_id=a.asset_id ORDER BY profile_version DESC LIMIT 1)p ON true
       WHERE a.tenant_id=$1 AND a.qualified_name='public.customers.contact_email'`, [tenantId])).rows[0]);
    expect(stored).toMatchObject({ tags: [], decision: 'dismissed' }); expect(stored!.decided_by).toBeTruthy();
    // The dismissed tag raises no new finding on the next run.
    expect((await findings()).findings.filter((item) => item.kind === 'sensitive_column')).toHaveLength(1);
  });
  it('reports a timed-out view count as unavailable without a change finding', async () => {
    await source(`CREATE VIEW public.slow_count AS SELECT n FROM generate_series(1,30) AS n;
      GRANT SELECT ON public.slow_count TO ${reader};`);
    const url = new URL(admin);
    url.pathname = database;
    url.username = reader;
    url.password = readerPassword;
    const {createPostgresConnector}=await import('@scaleinsyght/connectors');
    const connector=createPostgresConnector({connectionString:url.toString(),statementTimeoutMs:500});
    try {
      await runProfile(workerPool,{tenantId,connectionId,connector,jobType:'profile'});
      await source(`CREATE OR REPLACE VIEW public.slow_count AS
        SELECT n FROM generate_series(1,30) AS n WHERE pg_sleep(1) IS NOT NULL;`);
      const run=await runProfile(workerPool,{tenantId,connectionId,connector,jobType:'nightly'});
      const result=await findings();
      const viewFindings=result.findings.filter(item=>item.jobId===run.jobId&&item.subject==='public.slow_count');
      expect(viewFindings.map(item=>item.detail)).toEqual([{change:'count_unavailable'}]);
    } finally {await connector.close();}
  });

});
