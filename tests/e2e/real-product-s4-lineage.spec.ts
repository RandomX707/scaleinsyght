import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createTenant } from '../../scripts/tenant-create.js';

// S4: lineage from parsed view SQL and an uploaded dbt project, checked against testbed/lineage-truth.json.
config({ path: '.env' });
const migrateUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for the lineage walkthrough.'); const url = new URL(value); url.pathname = '/si_test'; return url.toString(); };
const adminPool = new Pool({ connectionString: migrateUrl() });
const postgres = new URL(process.env.DATABASE_URL_TESTBED ?? '');
if (!postgres.hostname || !process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('The local SQL Server and PostgreSQL testbeds are required.');
type Truth = { views: Record<string, Record<string, { reads: string[] }>>; dbt: { models: Record<string, { declaredReads: string[]; columns?: Record<string, string[]> }>; gaps: Array<{ asset: string; reasonIncludes: string }> }; endToEnd: Record<string, string[]> };
const truth = JSON.parse(readFileSync('testbed/lineage-truth.json', 'utf8')) as Truth;
const target = 'testbed/dbt/target';

async function connect(page: Page, data: Record<string, unknown>) {
  const draft = await page.request.post('/api/connections', { data }); expect(draft.status()).toBe(201);
  const { connectionId } = await draft.json() as { connectionId: string };
  expect((await page.request.post(`/api/connections/${connectionId}/test`)).ok()).toBeTruthy();
  expect((await page.request.post(`/api/connections/${connectionId}/activate`, { data: { scope: [] } })).ok()).toBeTruthy();
}

test('s4_dbt_upload_view_sql_and_lineage_graph_columns_gaps_and_chat_answers_match_truth', async ({ page }) => {
  test.setTimeout(300_000);
  const tenantId = `lineage-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 'lineage-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId, name: 'Lineage workspace', displayName: 'Test Analyst', email, password });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good afternoon, Test Analyst' })).toBeVisible();
  // Views are parsed while each database is profiled.
  await connect(page, { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: postgres.hostname, port: Number(postgres.port || 5432), database: postgres.pathname.slice(1), username: decodeURIComponent(postgres.username), password: decodeURIComponent(postgres.password), sslMode: 'disable' } });
  await connect(page, { connectorType: 'sql_server', displayName: 'SQL Server hospital', credential: { host: process.env.SQLSERVER_TESTBED_HOST, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE, username: process.env.SQLSERVER_TESTBED_USERNAME, password: process.env.SQLSERVER_TESTBED_PASSWORD, trustServerCertificate: true } });

  // The dbt project is added through Add connector with its two artifacts.
  await page.goto('/connectors');
  await page.locator('.page-heading').getByRole('button', { name: /Add connector/ }).click();
  await page.getByLabel('Source type').selectOption('dbt');
  await expect(page.getByRole('heading', { name: 'Add a dbt project' })).toBeVisible();
  await page.getByLabel('Connection name').fill('Hospital dbt project');
  await page.getByLabel('Warehouse connection').selectOption({ label: 'PostgreSQL testbed' });
  await page.getByLabel('manifest.json').setInputFiles(`${target}/manifest.json`);
  await page.getByLabel('catalog.json').setInputFiles(`${target}/catalog.json`);
  await page.screenshot({ path: 'docs/acceptance/s4/add-dbt.png' });
  await page.getByRole('button', { name: 'Upload and import' }).click();
  await expect(page.getByRole('heading', { name: 'dbt project imported' })).toBeVisible();
  const models = Object.keys(truth.dbt.models).length;
  const declared = Object.values(truth.dbt.models).reduce((total, model) => total + model.declaredReads.length, 0) + 1; // plus billing.claims, which is a gap
  await expect(page.getByRole('status')).toContainText(`Imported ${models} models: ${declared - 1} table links declared by dbt`);
  await page.getByRole('button', { name: 'Close dialog' }).click();

  // Lineage graph: every table and view on a path, links with evidence, and the gaps from truth.
  await page.goto('/lineage');
  const datasets = new Set<string>();
  for (const views of Object.values(truth.views)) for (const [view, spec] of Object.entries(views)) { datasets.add(view); spec.reads.forEach((name) => datasets.add(name)); }
  for (const [model, spec] of Object.entries(truth.dbt.models)) { datasets.add(model); spec.declaredReads.forEach((name) => datasets.add(name)); }
  await expect(page.locator('.lineage-tiles div').filter({ hasText: 'tables and views' }).locator('b')).toHaveText(String(datasets.size));
  await expect(page.locator('.lineage-tiles div').filter({ hasText: 'probable or missing links' }).locator('b')).toHaveText(String(truth.dbt.gaps.length));
  await expect(page.getByRole('button', { name: /^Missing/ })).toContainText(String(truth.dbt.gaps.length));
  await page.screenshot({ path: 'docs/acceptance/s4/lineage-graph.png', fullPage: true });

  // A dbt model: its direct inputs are exactly the dependencies dbt declares, each labelled Declared.
  await page.getByRole('button', { name: 'analytics.mart_department_orders, show columns' }).click();
  const inputs = page.locator('.lineage-inputs li');
  await expect(inputs).toHaveCount(truth.dbt.models['analytics.mart_department_orders']!.declaredReads.length);
  for (const name of truth.dbt.models['analytics.mart_department_orders']!.declaredReads) await expect(inputs.filter({ hasText: name })).toContainText('Declared');

  // A column followed end to end through dbt and the staging view.
  const [column, upstream] = Object.entries(truth.endToEnd)[0]!;
  await page.getByRole('button', { name: `Column ${column}` }).click();
  await expect(page.getByRole('heading', { name: column })).toBeVisible();
  for (const name of upstream) await expect(page.locator('.lineage-detail table').getByRole('button', { name })).toBeVisible();
  await page.screenshot({ path: 'docs/acceptance/s4/lineage-column.png', fullPage: true });

  // The gap: billing.claims is visible to dbt but not to the product's read-only login.
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('button', { name: 'analytics.mart_order_claims, show columns' }).click();
  for (const gap of truth.dbt.gaps.filter((item) => !item.asset.includes('.claim_amount'))) await expect(page.locator('.lineage-inputs')).toContainText(gap.reasonIncludes);
  await page.getByRole('button', { name: 'Column analytics.mart_order_claims.claim_amount' }).click();
  await expect(page.locator('.lineage-detail table')).toContainText('billing.claims, which no connected source exposes');
  await page.screenshot({ path: 'docs/acceptance/s4/lineage-gap.png', fullPage: true });

  // Chat: where a column comes from, and what breaks if a source column changes, answered from the graph with evidence.
  await page.goto('/');
  await page.getByLabel('Ask a question').fill(`Where does ${column} in the PostgreSQL testbed come from?`);
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.locator('.answer-claim').first()).toContainText(`${column} comes from ${upstream.length} upstream objects`, { timeout: 90_000 });
  for (const name of upstream) await expect(page.locator('.lineage-steps').last()).toContainText(name);
  await expect(page.getByRole('button', { name: 'Open in Lineage' }).last()).toBeVisible();
  await page.screenshot({ path: 'docs/acceptance/s4/chat-lineage.png', fullPage: true });
  const downstream = ['analytics.mart_department_orders.order_amount', 'analytics.mart_order_claims.order_amount', 'analytics.stg_orders.amount', 'public.department_order_summary.order_amount'];
  await page.getByLabel('Ask a question').fill('What breaks if public.orders.amount changes in the PostgreSQL testbed?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.locator('.answer-claim').filter({ hasText: `${downstream.length} downstream objects read public.orders.amount` })).toBeVisible({ timeout: 90_000 });
  for (const name of downstream) await expect(page.locator('.lineage-steps').last()).toContainText(name);
  await page.getByRole('button', { name: 'Open in Lineage' }).last().click();
  await expect(page).toHaveURL(/\/lineage$/);
});

test.afterAll(async () => { await adminPool.end(); });
