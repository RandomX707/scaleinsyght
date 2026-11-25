import { test, expect, type Page, request as playwrightRequest } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { createTenant, hashPassword } from '../../scripts/tenant-create.js';
import { docxText, pdfText, pptxText, xlsxRows } from '../support/document-text.js';

// S7: a live answer is saved, reused as a starting plan, exported to PDF, workbook and slides, turned into a governed
// report approved by a second person, run on a schedule, and the source's dictionary exported. Every file is opened and
// its figures compared with testbed/truth.json.
config({ path: '.env' });
const migrateUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for the S7 walkthrough.'); const url = new URL(value); url.pathname = '/si_test'; return url.toString(); };
const adminPool = new Pool({ connectionString: migrateUrl() });
const postgres = new URL(process.env.DATABASE_URL_TESTBED ?? ''); if (!postgres.hostname) throw new Error('The PostgreSQL testbed is required.');
const truth = JSON.parse(readFileSync('testbed/truth.json', 'utf8')) as { rowCounts: Record<string, number>; answerChecks: { ordersPerDepartment: { postgres: Array<{ departmentId: number; departmentName: string; orderCount: number }> } } };
const expected = truth.answerChecks.ordersPerDepartment.postgres;
const question = 'How many orders does each department have in the PostgreSQL testbed?';

async function download(page: Page, button: string): Promise<Buffer> {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: button }).last().click();
  return readFileSync((await (await pending).path())!);
}
function expectFigures(text: string) { for (const row of expected) expect(text, row.departmentName).toContain(`${row.departmentName} (${row.departmentId}): ${row.orderCount}`); }

test('s7_saved_question_reuse_exports_governed_report_schedule_and_dictionary_match_truth', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const tenantId = `exports-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 'exports-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId, name: 'Exports workspace', displayName: 'Test Analyst', email, password });
  const approverEmail = `approver@${tenantId}.test.invalid`;
  await withTenant(adminPool, tenantId, async (db) => {
    const user = await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,display_name,password_hash) VALUES($1,$2,$3,$4) RETURNING user_id', [tenantId, approverEmail, 'Second Approver', hashPassword(password)]);
    await db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,allowed) VALUES($1,$2,'tenant.member',true)", [tenantId, user.rows[0]!.user_id]);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good afternoon, Test Analyst' })).toBeVisible();
  const draft = await page.request.post('/api/connections', { data: { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: postgres.hostname, port: Number(postgres.port || 5432), database: postgres.pathname.slice(1), username: decodeURIComponent(postgres.username), password: decodeURIComponent(postgres.password), sslMode: 'disable' } } });
  const { connectionId } = await draft.json() as { connectionId: string };
  expect((await page.request.post(`/api/connections/${connectionId}/test`)).ok()).toBeTruthy();
  expect((await page.request.post(`/api/connections/${connectionId}/activate`, { data: { scope: [] } })).ok()).toBeTruthy();

  // A live answer, rated useful and saved.
  await page.goto('/'); await page.getByLabel('Ask a question').fill(question); await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.locator('.answer-claim').first()).toBeVisible({ timeout: 90_000 });
  for (const row of expected) await expect(page.locator('.grouped-result table').last()).toContainText(row.departmentName);
  await page.getByRole('button', { name: 'Useful' }).click();
  await page.getByRole('button', { name: 'Save this question' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

  // Exports of the live answer, opened and checked.
  expectFigures(pdfText(await download(page, 'Export PDF')));
  const sheet = await xlsxRows(await download(page, 'Export workbook'), 'Figures');
  expect(sheet[0]).toEqual(['Question', question]);
  for (const row of expected) expect(sheet.some((cells) => cells[2] === row.departmentName && String(cells[3]) === String(row.departmentId) && cells[4] === row.orderCount), row.departmentName).toBe(true);
  expectFigures(await pptxText(await download(page, 'Export slides')));

  // Reused as a starting plan: the same typed plan runs again with no model call and gives the same figures.
  await page.goto('/my-agent');
  await expect(page.locator('.saved-question')).toContainText(question);
  await page.getByRole('button', { name: 'Start from this question' }).click();
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
  for (const row of expected) await expect(page.locator('.grouped-result table').last()).toContainText(String(row.orderCount), { timeout: 60_000 });
  await page.screenshot({ path: 'docs/acceptance/s7/saved-question-rerun.png', fullPage: true });
  const reruns = await withTenant(adminPool, tenantId, (db) => db.query<{ n: string }>("SELECT count(*)::text AS n FROM runs.model_provenance p JOIN runs.runs r USING(tenant_id,run_id) WHERE p.tenant_id=$1 AND r.conversation_id=$2", [tenantId, new URL(page.url()).pathname.split('/').at(-1)]));
  expect(reruns.rows[0]!.n).toBe('0');

  // Governed report from the saved question, approved by a second person, run on demand and on a schedule.
  const saved = await (await page.request.get('/api/me/saved-questions')).json() as { questions: Array<{ planId: string }> };
  const governed = await (await page.request.post('/api/governed-agents', { data: { name: 'Orders by department', planId: saved.questions[0]!.planId } })).json() as { governedId: string; version: number };
  const approver = await playwrightRequest.newContext({ baseURL: baseURL! });
  expect((await approver.post('/api/auth/login', { data: { tenantId, email: approverEmail, password } })).ok()).toBeTruthy();
  expect((await approver.post(`/api/governed-agents/${governed.governedId}/approve`, { data: { version: governed.version } })).ok()).toBeTruthy();
  await approver.dispose();
  const report = await (await page.request.post('/api/me/reports', { data: { name: 'Orders by department', governedId: governed.governedId, version: governed.version } })).json() as { reportId: string };
  expect((await page.request.post(`/api/me/reports/${report.reportId}/run`)).status()).toBe(201);
  await expect.poll(async () => ((await (await page.request.get('/api/me/reports')).json()) as { reports: Array<{ reportId: string; latestSnapshotId: string | null }> }).reports.find((item) => item.reportId === report.reportId)?.latestSnapshotId ?? null, { timeout: 60_000 }).not.toBeNull();
  const reportPdf = Buffer.from(await (await page.request.get(`/api/me/reports/${report.reportId}/exports/pdf`)).body());
  expectFigures(pdfText(reportPdf));
  const schedule = await (await page.request.post('/api/me/schedules', { data: { reportId: report.reportId, localTime: '06:00', cadence: 'daily' } })).json() as { scheduleId: string };
  const before = await withTenant(adminPool, tenantId, (db) => db.query<{ n: string }>('SELECT count(*)::text AS n FROM reports.snapshots WHERE tenant_id=$1', [tenantId]));
  await withTenant(adminPool, tenantId, (db) => db.query("UPDATE reports.schedules SET next_run_at=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1 AND schedule_id=$2", [tenantId, schedule.scheduleId]));
  await expect.poll(async () => Number((await withTenant(adminPool, tenantId, (db) => db.query<{ n: string }>('SELECT count(*)::text AS n FROM reports.snapshots WHERE tenant_id=$1', [tenantId]))).rows[0]!.n), { timeout: 90_000 }).toBeGreaterThan(Number(before.rows[0]!.n));

  // The source's dictionary in Markdown and Word: every table and column, statistics withheld on tagged columns.
  await page.goto(`/dictionary?connection=${connectionId}`);
  const markdown = (await download(page, 'Export Markdown')).toString('utf8');
  for (const table of Object.keys(truth.rowCounts)) expect(markdown).toContain(`## public.${table}`);
  expect(markdown).toMatch(/\| mrn \| text \| identifier \| withheld \| withheld \|/);
  const word = await docxText(await download(page, 'Export Word (.docx)'));
  for (const table of Object.keys(truth.rowCounts)) expect(word).toContain(`public.${table}`);
  await page.screenshot({ path: 'docs/acceptance/s7/dictionary-export.png', fullPage: true });
});

test.afterAll(async () => { await adminPool.end(); });
