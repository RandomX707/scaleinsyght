import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createTenant } from '../../scripts/tenant-create.js';
import { activateAndWait } from '../support/e2e-profile.js';

// S8: a Tableau workbook (.twb) added through Add connector, shown as a tool card, its worksheets listed in BI reports
// and its data sources drawn in Lineage, checked against testbed/lineage-truth.json. No model calls.
config({ path: '.env' });
const migrateUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for the Tableau walkthrough.'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); };
const adminPool = new Pool({ connectionString: migrateUrl() });
const postgres = new URL(process.env.DATABASE_URL_TESTBED ?? '');
if (!postgres.hostname) throw new Error('The local PostgreSQL testbed is required; run pnpm testbed:up.');
type TableauTruth = { workbook: string; connectionName: string; datasets: Record<string, unknown>; fields: Record<string, string[]>; reports: Record<string, string[]>; endToEnd: Record<string, string[]>; upstreamGaps: Array<{ report: string; asset: string; reasonIncludes: string }> };
const truth = (JSON.parse(readFileSync('testbed/lineage-truth.json', 'utf8')) as { tableau: TableauTruth }).tableau;
const target = 'testbed/dbt/target';

async function connect(page: Page, data: Record<string, unknown>): Promise<string> {
  const draft = await page.request.post('/api/connections', { data }); expect(draft.status()).toBe(201);
  const { connectionId } = await draft.json() as { connectionId: string };
  expect((await page.request.post(`/api/connections/${connectionId}/test`)).ok()).toBeTruthy();
  await activateAndWait(page, connectionId);
  return connectionId;
}

test.afterAll(async () => { await adminPool.end(); });

test('s8_tableau_workbook_upload_card_reports_and_lineage_match_truth', async ({ page }) => {
  test.setTimeout(240_000);
  const tenantId = `tableau-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 'tableau-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId, name: 'Tableau workspace', displayName: 'Test Analyst', email, password });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Test Analyst$/ })).toBeVisible();

  // The warehouse and the dbt project it builds are set up through the API; S4 covers their screens.
  const warehouse = await connect(page, { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: postgres.hostname, port: Number(postgres.port || 5432), database: postgres.pathname.slice(1), username: decodeURIComponent(postgres.username), password: decodeURIComponent(postgres.password), sslMode: 'disable' } });
  const dbt = await page.request.post('/api/connections', { data: { connectorType: 'dbt', displayName: 'Hospital dbt project', warehouseConnectionId: warehouse } }); expect(dbt.status()).toBe(201);
  const dbtId = (await dbt.json() as { connectionId: string }).connectionId;
  expect((await page.request.post(`/api/connections/${dbtId}/dbt-artifacts`, { data: { manifest: JSON.parse(readFileSync(`${target}/manifest.json`, 'utf8')), catalog: JSON.parse(readFileSync(`${target}/catalog.json`, 'utf8')) } })).ok()).toBeTruthy();

  // The workbook is added through Add connector. A packaged .twbx is refused with what to do instead.
  await page.goto('/connectors');
  await page.locator('.page-heading').getByRole('button', { name: /Add connector/ }).click();
  await page.getByLabel('Source type').selectOption('tableau');
  await expect(page.getByRole('heading', { name: 'Add a Tableau workbook' })).toBeVisible();
  await page.getByLabel('Connection name').fill(truth.connectionName);
  await page.getByLabel('Warehouse connection').selectOption({ label: 'PostgreSQL testbed' });
  await page.getByLabel('Tableau workbook (.twb)').setInputFiles({ name: 'packaged.twbx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK packaged') });
  await page.getByRole('button', { name: 'Upload and import' }).click();
  await expect(page.getByRole('alert')).toContainText('Packaged workbooks (.twbx) are not read yet');
  await page.getByLabel('Tableau workbook (.twb)').setInputFiles(truth.workbook);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: 'docs/acceptance/s8/add-tableau.png' });
  await page.getByRole('button', { name: 'Upload and import' }).click();
  await expect(page.getByRole('heading', { name: 'Tableau workbook imported' })).toBeVisible();
  const worksheets = Object.keys(truth.reports).length; const datasources = Object.keys(truth.datasets).length;
  await expect(page.getByRole('status')).toContainText(`Imported ${worksheets} worksheets from ${datasources} data sources`);
  await expect(page.getByRole('status')).toContainText('0 missing links');
  await page.getByRole('button', { name: 'Close dialog' }).click();

  // The card follows the dbt card: warehouse, what was found, the last import, and no Profile, Dictionary or ER.
  const card = page.locator('.connector-card').filter({ has: page.getByRole('heading', { name: truth.connectionName }) });
  await expect(card).toContainText('Tableau');
  await expect(card).toContainText('Warehouse: PostgreSQL testbed');
  await expect(card).toContainText(`${worksheets} worksheets`);
  await expect(card).toContainText(`${datasources} data sources`);
  await expect(card).toContainText('Last import');
  for (const name of ['Reports', 'View lineage', 'Upload new workbook', 'Remove']) await expect(card.getByRole('button', { name })).toBeVisible();
  for (const name of ['Profile', 'Dictionary', 'ER diagram']) await expect(card.getByRole('button', { name })).toHaveCount(0);
  await page.screenshot({ path: 'docs/acceptance/s8/tableau-card.png' });

  // BI reports lists every worksheet as a Tableau report with linked flows; an uploaded file has nothing to open.
  await card.getByRole('button', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/bi-reports/);
  // Its own page (prototype V.reports): tool, what each report is built on, its lineage status from the whole upstream
  // path, and Open ↗ only for a report with a link. The seeded gap upstream of Claims is never shown as complete.
  await expect(page.getByRole('heading', { name: 'BI reports', level: 1 })).toBeVisible();
  const gapped = new Set(truth.upstreamGaps.map((gap) => gap.report));
  for (const [report, fields] of Object.entries(truth.reports)) {
    const row = page.getByRole('row').filter({ hasText: report.split(' / ').at(-1)! });
    await expect(row).toContainText('Tableau');
    for (const dataset of new Set(fields.map((field) => field.split('.')[0]!))) await expect(row).toContainText(dataset);
    await expect(row).toContainText('From an uploaded file');
    if (gapped.has(report)) await expect(row).toContainText('Gap in lineage');
    else await expect(row).not.toContainText('Gap in lineage');
  }
  await page.screenshot({ path: 'docs/acceptance/s8/bi-reports.png' });
  {
    const prototype = await page.context().browser()!.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await prototype.goto(pathToFileURL(resolve('docs/prototype/index.html')).href);
      await prototype.getByRole('button', { name: 'Sign in', exact: true }).click();
      await prototype.evaluate('go("reports")');
      await expect(prototype.getByRole('heading', { name: 'Reports' })).toBeVisible();
      mkdirSync('docs/acceptance/s8/prototype', { recursive: true });
      await prototype.screenshot({ path: 'docs/acceptance/s8/prototype/bi-reports.png' });
    } finally { await prototype.close(); }
  }

  // Lineage draws the Tableau data sources after the dbt marts they read.
  await page.goto('/lineage');
  await expect(page.locator('svg').getByText(`${truth.connectionName} · Tableau`, { exact: true })).toBeVisible();
  for (const dataset of Object.keys(truth.datasets)) await expect(page.getByRole('button', { name: `${dataset}, show columns` })).toBeVisible();
  await page.screenshot({ path: 'docs/acceptance/s8/lineage-tableau.png', fullPage: true });

  // End to end through the API the Lineage page uses: each worksheet reaches the operational columns in the truth.
  for (const [report, upstream] of Object.entries(truth.endToEnd)) {
    const reports = await (await page.request.get('/api/reports')).json() as { reports: Array<{ asset_id: string; name: string }> };
    const asset = reports.reports.find((item) => item.name === report)!;
    const path = await (await page.request.get(`/api/lineage?assetId=${asset.asset_id}&direction=upstream`)).json() as { assets: Array<{ qualified_name: string }> };
    expect(path.assets.map((item) => item.qualified_name).filter((name) => name.startsWith('public.')).sort(), report).toEqual([...upstream].sort());
  }
});
