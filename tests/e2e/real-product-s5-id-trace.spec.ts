import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createTenant } from '../../scripts/tenant-create.js';

// S5: ID trace across PostgreSQL, SQL Server and the workbook, checked against testbed/id-truth.json.
config({ path: '.env' });
const migrateUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for the ID trace walkthrough.'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString(); };
const adminPool = new Pool({ connectionString: migrateUrl() });
const postgres = new URL(process.env.DATABASE_URL_TESTBED ?? '');
if (!postgres.hostname || !process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('The local SQL Server and PostgreSQL testbeds are required.');
const truth = JSON.parse(readFileSync('testbed/id-truth.json', 'utf8')) as Record<string, { fields: Array<{ source: string; field: string; distinct: number }>; pairs: Array<{ left: string; right: string; shared: number }> }>;

async function connect(page: Page, data: Record<string, unknown>, workbook?: Buffer) {
  const draft = await page.request.post('/api/connections', { data }); expect(draft.status()).toBe(201);
  const { connectionId } = await draft.json() as { connectionId: string };
  if (workbook) expect((await page.request.post(`/api/connections/${connectionId}/workbooks`, { data: workbook, headers: { 'content-type': 'application/octet-stream' } })).ok()).toBeTruthy();
  expect((await page.request.post(`/api/connections/${connectionId}/test`)).ok()).toBeTruthy();
  expect((await page.request.post(`/api/connections/${connectionId}/activate`, { data: { scope: [] } })).ok()).toBeTruthy();
}

test('s5_id_trace_groups_patient_encounter_and_mrn_ids_across_three_systems_and_looks_up_a_value', async ({ page }) => {
  test.setTimeout(240_000);
  const tenantId = `ids-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 'id-trace-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId, name: 'ID trace workspace', displayName: 'Test Analyst', email, password });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Test Analyst$/ })).toBeVisible();
  await connect(page, { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: postgres.hostname, port: Number(postgres.port || 5432), database: postgres.pathname.slice(1), username: decodeURIComponent(postgres.username), password: decodeURIComponent(postgres.password), sslMode: 'disable' } });
  await connect(page, { connectorType: 'sql_server', displayName: 'SQL Server hospital', credential: { host: process.env.SQLSERVER_TESTBED_HOST, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE, username: process.env.SQLSERVER_TESTBED_USERNAME, password: process.env.SQLSERVER_TESTBED_PASSWORD, trustServerCertificate: true } });
  await connect(page, { connectorType: 'excel', displayName: 'Operations workbook' }, readFileSync('testbed/excel/hospital-operations.xlsx'));

  await page.goto('/lineage/ids');
  for (const [name, expected] of Object.entries(truth)) {
    if (name === '_note') continue;
    // Pick the identifier by its origin field, then check every field and its counts.
    await page.locator('.id-picker .ui-button').filter({ hasText: new RegExp(`^${expected.fields[0]!.field.split('.').at(-1)!} · `) }).click();
    await expect(page.locator('.id-tiles div').filter({ hasText: 'fields hold this ID' }).locator('b')).toHaveText(String(expected.fields.length));
    const table = page.locator('.lineage-detail table');
    const cards = page.locator('.id-path li');
    const comparison = cards.filter({has:page.getByText('Comparison field',{exact:true})});
    const sourceLabels: Record<string,string> = {postgres:'PostgreSQL testbed',sql_server:'SQL Server hospital',excel:'Operations workbook'};
    const homeSourceName=await comparison.locator('.faint').textContent();
    const homeSource=Object.keys(sourceLabels).find(source=>sourceLabels[source]===homeSourceName);
    const homeKey=`${homeSource}:${await comparison.locator('code').textContent()}`;
    await expect(cards).toHaveCount(expected.fields.length);
    for (const field of expected.fields) {
      const card = cards.filter({has:page.locator('code').and(page.getByText(field.field,{exact:true}))})
        .filter({has:page.getByText(sourceLabels[field.source]!,{exact:true})});
      const fieldKey=`${field.source}:${field.field}`;
      const distinct=field.distinct.toLocaleString('en-US');
      const pair=expected.pairs.find(item=>(item.left===homeKey&&item.right===fieldKey)||(item.right===homeKey&&item.left===fieldKey));
      if (fieldKey!==homeKey) expect(pair, `Truth for ${fieldKey} compared with ${homeKey}`).toBeDefined();
      const coverage=fieldKey===homeKey ? `${distinct} distinct values in the comparison field.`
        : `${pair!.shared.toLocaleString('en-US')} of ${distinct} distinct values match the comparison field.`;
      await expect(card.getByLabel('Field coverage')).toHaveText(coverage);
      await expect(card).not.toContainText('.;');
    }
    for (const field of expected.fields) await expect(table.locator('tr').filter({ has: page.locator('code', { hasText: new RegExp(`^${field.field.replaceAll('.', '\\.')}$`) }) })).toContainText(field.distinct.toLocaleString('en-US'));
    await page.screenshot({ path: `docs/acceptance/s5/id-trace-${name}.png`, fullPage: true });
  }
  await page.locator('.id-picker .ui-button').filter({ hasText: /^encounter_id · / }).click();
  await expect(page.locator('.lineage-detail table tr').filter({ hasText: 'Visits.visit_id' })).toContainText('Key changed · probable match, unverified');

  // Look up one MRN: found by fingerprint in each system that holds it; the value is not echoed back.
  const reader = new Pool({ connectionString: process.env.DATABASE_URL_TESTBED }); const mrn = (await reader.query<{ mrn: string }>('SELECT mrn FROM public.patients ORDER BY patient_id LIMIT 1')).rows[0]!.mrn; await reader.end();
  await page.getByLabel('ID value').fill(mrn);
  await page.getByRole('button', { name: 'Trace' }).click();
  await expect(page.getByRole('status')).toContainText('public.patients.mrn');
  await expect(page.getByRole('status')).toContainText('dbo.patients.mrn');
  await expect(page.getByRole('status')).not.toContainText(mrn);
  await expect(page.getByLabel('ID value')).toHaveValue('');
  await page.screenshot({ path: 'docs/acceptance/s5/id-lookup.png', fullPage: true });
});

test.afterAll(async () => { await adminPool.end(); });
