import { test, expect } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { config } from 'dotenv';
import { Client, Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { createTenant } from '../../scripts/tenant-create.js';

// S6: a source changes after it is profiled; a refresh from the Approval matrix finds each change by name and count,
// and an inferred sensitive column is dismissed with the decision recorded. Uses its own scratch database.
config({ path: '.env' });
const migrateUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for the nightly walkthrough.'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString(); };
const adminPool = new Pool({ connectionString: migrateUrl() });
const admin = (() => { const configured = process.env.DATABASE_URL_ADMIN; const url = configured ? new URL(configured) : new URL('postgresql://127.0.0.1:5432/postgres'); if (!configured) { url.username = userInfo().username; url.password = ''; } return url; })();
const database = 'si_test_nightly_walkthrough'; const reader = 'si_nightly_walkthrough_reader'; const readerPassword = randomBytes(18).toString('base64url');
const run = async (sql: string, db = database) => { const url = new URL(admin.toString()); url.pathname = `/${db}`; const client = new Client({ connectionString: url.toString() }); await client.connect(); try { await client.query(sql); } finally { await client.end(); } };

test('s6_refresh_from_the_approval_matrix_finds_source_changes_and_a_dismissal_is_recorded', async ({ page }) => {
  test.setTimeout(180_000);
  await run(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`, 'postgres'); await run(`CREATE DATABASE ${database}`, 'postgres');
  const role = new Client({ connectionString: admin.toString() }); await role.connect();
  try { const exists = await role.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [reader]); await role.query(`${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE ${reader} WITH LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`); await role.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${reader}`); } finally { await role.end(); }
  await run(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${reader};
    CREATE TABLE shop_orders(order_id integer PRIMARY KEY, amount numeric(9,2) NOT NULL); INSERT INTO shop_orders SELECT n, n FROM generate_series(1,100) n;
    CREATE TABLE customers(customer_id integer PRIMARY KEY, contact_email text NOT NULL); INSERT INTO customers SELECT n, 'person' || lpad(n::text,3,'0') || '@example.test' FROM generate_series(1,30) n;
    CREATE TABLE legacy_codes(code text PRIMARY KEY); INSERT INTO legacy_codes SELECT 'c' || n FROM generate_series(1,20) n;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader};`);
  const tenantId = `nightly-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 'nightly-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId, name: 'Nightly workspace', displayName: 'Test Analyst', email, password });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good afternoon, Test Analyst' })).toBeVisible();
  const draft = await page.request.post('/api/connections', { data: { connectorType: 'postgres', displayName: 'Shop database', credential: { host: admin.hostname, port: Number(admin.port || 5432), database, username: reader, password: readerPassword, sslMode: 'disable' } } });
  const { connectionId } = await draft.json() as { connectionId: string };
  expect((await page.request.post(`/api/connections/${connectionId}/test`)).ok()).toBeTruthy();
  expect((await page.request.post(`/api/connections/${connectionId}/activate`, { data: { scope: [] } })).ok()).toBeTruthy();

  await run(`ALTER TABLE shop_orders ADD COLUMN channel text; DROP TABLE legacy_codes; INSERT INTO customers SELECT n, 'person' || lpad(n::text,3,'0') || '@example.test' FROM generate_series(31,60) n;
    CREATE TABLE returns(return_id integer PRIMARY KEY); INSERT INTO returns SELECT generate_series(1,5); GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader};`);
  await page.goto('/approval-matrix');
  await expect(page.getByRole('heading', { name: "Last night's run" })).toBeVisible();
  await page.getByRole('button', { name: 'Run a refresh now' }).click();
  await expect(page.locator('.nightly-summary')).toContainText('1 source refreshed');
  const rows = page.locator('.findings table tbody tr');
  await expect(rows.filter({ hasText: 'public.shop_orders changed: added channel.' })).toContainText('Schema change');
  await expect(rows.filter({ hasText: 'public.legacy_codes was dropped from the source.' })).toContainText('Schema change');
  await expect(rows.filter({ hasText: 'public.customers went from 30 to 60 rows.' })).toContainText('Data anomaly');
  await expect(rows.filter({ hasText: 'New table public.returns with 1 column and 5 rows.' })).toContainText('New table');
  await page.screenshot({ path: 'docs/acceptance/s6/approval-matrix.png', fullPage: true });

  await page.getByRole('tab', { name: 'All' }).click();
  const sensitive = rows.filter({ hasText: 'public.customers.contact_email looks personal' });
  await sensitive.getByRole('button', { name: 'Dismiss' }).click();
  await expect(sensitive).toContainText('Dismissed');
  const review = await withTenant(adminPool, tenantId, (db) => db.query<{ decision: string; decided: boolean }>('SELECT decision,decided_by IS NOT NULL AS decided FROM profiler.tag_reviews WHERE tenant_id=$1', [tenantId]));
  expect(review.rows).toEqual([{ decision: 'dismissed', decided: true }]);
  await run(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`, 'postgres');
});

test.afterAll(async () => { await adminPool.end(); });
