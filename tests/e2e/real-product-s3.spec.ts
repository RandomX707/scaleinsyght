import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { createTenant } from '../../scripts/tenant-create.js';

config({ path: '.env' });
const tenantUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for local S3 acceptance.'); const url = new URL(value); url.pathname = '/si_test'; return url.toString(); };
const adminPool = new Pool({ connectionString: tenantUrl() });
type ExcelTruth = {
  sheets: Array<{ name: string; rowCount: number; columnCount: number; columns: string[]; headers: string[] }>;
  expectedInferredSensitivity: Record<string, string[]>;
  nullRates: Record<string, number>;
  sensitiveColumns: Record<string, string[]>;
  relationships: Array<{ from: string; to: string; column: string; matches: number; sourceCount: number; confidence: number }>;
  answerChecks: { visitCount: number; visitsWithDischargeDate: number; cancelledCharges: number; chargeAmountByDepartmentTop5: Array<{ department: string; amount: number }>; averageVisitsPerPatientByDepartment: Array<{ department: string; average: number }>; patientCount: number };
};
const allTruth = JSON.parse(readFileSync('testbed/truth.json', 'utf8')) as { excel: ExcelTruth; rowCounts: Record<string, number> };
const truth = allTruth.excel;
const workbookPath = 'testbed/excel/hospital-operations.xlsx';
const databaseUrl = new URL(process.env.DATABASE_URL_TESTBED ?? ''); if (!databaseUrl.hostname) throw new Error('Run pnpm testbed:up before the S3 walkthrough.');
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
// The original header text for a normalised column key such as Patients.mrn -> Patients.MRN.
const displayName = (key: string) => { const [sheetName, column] = key.split('.') as [string, string]; const sheet = truth.sheets.find((item) => item.name === sheetName)!; return `${sheetName}.${sheet.headers[sheet.columns.indexOf(column)]}`; };

test('s3_empty_tenant_uploads_workbook_profiles_and_answers_with_evidence', async ({ page }) => {
  test.setTimeout(420_000);
  mkdirSync('docs/acceptance/s3', { recursive: true });
  const tenantId = `s3-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 's3-testbed-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId, name: 'Workbook test workspace', displayName: 'Test Analyst', email, password });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good afternoon, Test Analyst' })).toBeVisible();

  // A file that is not an .xlsx workbook is refused with a clear reason and nothing is stored.
  const rejectedDraft = await page.request.post('/api/connections', { data: { connectorType: 'excel', displayName: 'Not a workbook' } });
  expect(rejectedDraft.status()).toBe(201);
  const rejectedId = (await rejectedDraft.json() as { connectionId: string }).connectionId;
  const rejected = await page.request.post(`/api/connections/${rejectedId}/workbooks`, { headers: { 'content-type': 'application/octet-stream' }, data: readFileSync('testbed/dictionary.csv') });
  expect(rejected.status()).toBe(400); expect(await rejected.json()).toMatchObject({ error: 'excel_workbook_not_xlsx' });
  const stored = await withTenant(adminPool, tenantId, (client) => client.query('SELECT 1 FROM artifacts.workbooks WHERE tenant_id=$1 AND connection_id=$2', [tenantId, rejectedId]));
  expect(stored.rowCount).toBe(0);

  await page.goto('/connectors'); await expect(page.getByText(/No sources connected/)).toBeVisible();
  await page.screenshot({ path: 'docs/acceptance/s3/empty-connectors.png', fullPage: true });
  await page.locator('.page-heading').getByRole('button', { name: /Add connector/ }).click();
  await page.getByLabel('Source type').selectOption('excel');
  await expect(page.getByRole('heading', { name: 'Add an Excel workbook' })).toBeVisible();
  await page.getByLabel('Connection name').fill('Operations workbook');
  await page.getByLabel('Workbook file').setInputFiles(workbookPath);
  await expect(page.getByText('hospital-operations.xlsx')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose file' })).toBeVisible();
  await page.screenshot({ path: 'docs/acceptance/s3/add-workbook.png', fullPage: true });
  await page.getByRole('button', { name: 'Upload and test' }).click();
  await expect(page.getByRole('heading', { name: 'Choose scope' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText(`Workbook checked: ${truth.sheets.length} sheets`);
  for (const sheet of truth.sheets) await expect(page.getByRole('status')).toContainText(`${sheet.name}, ${sheet.rowCount.toLocaleString('en-US')} rows`);
  await page.getByRole('button', { name: 'Start profiling' }).click();
  await expect(page.getByRole('heading', { name: 'Discovery complete' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();

  const listed = await page.request.get('/api/connections'); expect(listed.ok()).toBeTruthy();
  const source = (await listed.json() as { connections: Array<{ connectionId: string; connectorType: string; status: string; agentId: string | null }> }).connections.find((item) => item.status === 'active' && item.connectorType === 'excel');
  expect(source?.agentId).toBeTruthy();
  const connectionId = source!.connectionId;
  const artifact = await withTenant(adminPool, tenantId, (client) => client.query<{ encrypted_size: number }>('SELECT encrypted_size FROM artifacts.workbooks WHERE tenant_id=$1 AND connection_id=$2', [tenantId, connectionId]));
  expect(artifact.rowCount).toBe(1); expect(Number(artifact.rows[0]!.encrypted_size)).toBeGreaterThan(readFileSync(workbookPath).length);

  // Profile: every sheet profiled; sensitive columns classified from the header notes.
  await page.goto(`/profile/${connectionId}`);
  await expect(page.locator('.profile-stats div').filter({ hasText: 'Objects profiled' }).locator('strong')).toHaveText(String(truth.sheets.length));
  const profile = await (await page.request.get(`/api/connections/${connectionId}/profile`)).json() as { classifications: Array<{ qualified_name: string; sensitivity_tags: string[] }> };
  const tagged = Object.fromEntries(profile.classifications.filter((item) => item.sensitivity_tags.length).map((item) => [item.qualified_name, item.sensitivity_tags]));
  expect(tagged).toEqual(truth.sensitiveColumns);
  for (const field of Object.keys(truth.sensitiveColumns)) await expect(page.locator('li').filter({ hasText: `${displayName(field)} ·` }).first()).toBeVisible();
  // The Registrations sheet has no header notes; its sensitive columns are still classified and marked inferred.
  for (const field of Object.keys(truth.expectedInferredSensitivity)) await expect(page.locator('li').filter({ hasText: `${displayName(field)} ·` }).first()).toContainText('inferred');
  await page.screenshot({ path: 'docs/acceptance/s3/profile.png', fullPage: true });

  // ER: the three sheet relationships, all inferred, with measured confidence.
  const er = await (await page.request.get(`/api/connections/${connectionId}/er`)).json() as { relationships: Array<{ from_name: string; to_name: string; evidence_method: string; confidence_score: number }> };
  const relationships = er.relationships.map((item) => ({ from: item.from_name, to: item.to_name, evidence: item.evidence_method, confidence: Number(item.confidence_score) })).sort((a, b) => a.from.localeCompare(b.from));
  expect(relationships).toEqual(truth.relationships.map((item) => ({ from: `${item.from}.${item.column}`, to: `${item.to}.${item.column}`, evidence: 'inferred', confidence: item.confidence })).sort((a, b) => a.from.localeCompare(b.from)));
  await page.getByRole('button', { name: 'Explore relationships' }).click();
  await expect(page.getByText(`${truth.relationships.length} relationships`)).toBeVisible();
  const visitsNode = page.locator('.er-node').filter({ has: page.locator('h3', { hasText: /^Visits$/ }) });
  await expect(visitsNode.locator('li span').filter({ hasText: /^Patient ID$/ })).toHaveCount(1);
  await expect(page.locator('.er-node li span').filter({ hasText: /_/ })).toHaveCount(0);
  await expect(page.locator('.er-link--inferred')).toHaveCount(truth.relationships.length);
  await page.screenshot({ path: 'docs/acceptance/s3/er.png', fullPage: true });

  // Dictionary: sheets and columns with null rates; statistics on tagged columns are withheld.
  await page.goto(`/dictionary?connection=${connectionId}`);
  for (const sheet of truth.sheets) await expect(page.locator('.dictionary-list summary').filter({ hasText: sheet.name })).toContainText(`${sheet.columnCount} fields`);
  const visits = page.locator('.dictionary-list details').filter({ has: page.locator('summary', { hasText: 'Visits' }) });
  await visits.locator('summary').click();
  const dischargedRate = (truth.nullRates['Visits.discharged_on']! * 100).toLocaleString('en-US', { maximumFractionDigits: 1 });
  await expect(visits.locator('li strong').filter({ hasText: /^Discharged On$/ })).toHaveCount(1);
  await expect(visits.locator('li').filter({ hasText: 'Discharged On' })).toContainText(`${dischargedRate}% empty`);
  await expect(visits.locator('li strong').filter({ hasText: /_/ })).toHaveCount(0);
  const patients = page.locator('.dictionary-list details').filter({ has: page.locator('summary', { hasText: 'Patients' }) });
  await patients.locator('summary').click();
  await expect(patients.locator('li').filter({ hasText: 'Phone' })).toContainText('statistics withheld');
  await expect(patients.locator('li').filter({ hasText: 'Phone' })).not.toContainText('% empty');
  const registrations = page.locator('.dictionary-list details').filter({ has: page.locator('summary', { hasText: 'Registrations' }) });
  await registrations.locator('summary').click();
  await expect(registrations.locator('li').filter({ hasText: 'Phone Number' })).toContainText('inferred');
  await page.screenshot({ path: 'docs/acceptance/s3/dictionary.png', fullPage: true });

  type Captured = { state: string; modelProvenance: Array<{ purpose: string; model: string; inputTokens: number; outputTokens: number; typedPlan: unknown }>; answer: { answer: { claims: Array<{ statement: string }>; evidence: Array<{ locator: string }>; bySource: Array<{ connectorType: string; value: number; rows?: Array<{ group_value: string; value: number }> }> } } };
  async function askChecked(question: string, expectedSources: number, sql: RegExp) {
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'POST',{timeout:15_000});
    await page.getByLabel('Ask a question').fill(question);
    await page.getByRole('button', { name: 'Send question' }).click();
    const response = await responsePromise;
    expect(response.status(), `${question}: ${JSON.stringify(await response.json())}`).toBe(201);
    const { runId } = await response.json() as { runId: string };
    let run: Captured | undefined;
    await expect.poll(async () => { run = await (await page.request.get(`/api/runs/${runId}`)).json() as Captured; return run.state; }, { timeout: 90_000 }).toBe('COMPLETED');
    expect(run!.modelProvenance.map((call) => call.purpose)).toEqual(['plan', 'answer']);
    for (const call of run!.modelProvenance) { expect(call.model).toBeTruthy(); expect(call.inputTokens).toBeGreaterThan(0); expect(call.outputTokens).toBeGreaterThan(0); }
    const answer = run!.answer.answer;
    expect(answer.bySource).toHaveLength(expectedSources); expect(answer.claims).toHaveLength(1); expect(answer.evidence).toHaveLength(expectedSources);
    for (const item of answer.evidence) expect(item.locator).toMatch(sql);
    await expect(page.locator('.answer-claim').last()).toHaveText(answer.claims[0]!.statement);
    await expect(page.locator('.answer-sources').last()).toContainText('Operations workbook');
    // Answers use the workbook's own header text, never the SQL identifiers.
    expect(answer.claims[0]!.statement).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    return { question, answer, provenance: run!.modelProvenance };
  }

  const checks = truth.answerChecks;
  await page.goto('/');
  const visitCount = await askChecked('How many visits are in the operations workbook?', 1, /count\(\*\).*FROM "main"\."Visits"/i);
  expect(visitCount.answer.bySource[0]!.value).toBe(checks.visitCount);
  expect(visitCount.answer.claims[0]!.statement).toContain(String(checks.visitCount));
  const discharged = await askChecked('and how many of them have a discharge date?', 1, /"discharged_on" IS NOT NULL/i);
  expect(discharged.answer.bySource[0]!.value).toBe(checks.visitsWithDischargeDate);
  expect(discharged.answer.claims[0]!.statement).toContain(String(checks.visitsWithDischargeDate));
  await page.screenshot({ path: 'docs/acceptance/s3/home-answer.png', fullPage: true });

  await page.getByRole('button', { name: 'New chat' }).click();
  const cancelled = await askChecked('How many charges in the workbook were cancelled?', 1, /"status" = \$1/i);
  expect(cancelled.answer.bySource[0]!.value).toBe(checks.cancelledCharges);
  expect(cancelled.answer.claims[0]!.statement).toContain(String(checks.cancelledCharges));

  await page.getByRole('button', { name: 'New chat' }).click();
  const top = await askChecked('Total charge amount by department in the workbook, top 5', 1, /sum\("amount"\).*GROUP BY "department".*LIMIT 5/i);
  expect(top.answer.bySource[0]!.rows?.map((row) => ({ department: row.group_value, amount: round(Number(row.value), 2) }))).toEqual(checks.chargeAmountByDepartmentTop5);
  await expect(page.locator('.bar-chart').last().locator('.bar-label')).toHaveText(checks.chargeAmountByDepartmentTop5.map((row) => row.department));
  await expect(page.locator('.group-summary').last()).toContainText(`Highest: ${checks.chargeAmountByDepartmentTop5[0]!.department}`);
  await expect(page.locator('.grouped-result').last().locator('th').first()).toHaveText('Department');
  await page.screenshot({ path: 'docs/acceptance/s3/home-group-by.png', fullPage: true });

  await page.getByRole('button', { name: 'New chat' }).click();
  const average = await askChecked('Average number of visits per patient by department in the workbook', 1, /avg/i);
  expect(average.answer.bySource[0]!.rows?.map((row) => ({ department: row.group_value, average: round(Number(row.value), 6) })).sort((a, b) => a.department.localeCompare(b.department))).toEqual(checks.averageVisitsPerPatientByDepartment.map((row) => ({ department: row.department, average: round(row.average, 6) })));
  await expect(page.locator('.bar-chart').last().locator('.bar-row')).toHaveCount(checks.averageVisitsPerPatientByDepartment.length);

  // Add the PostgreSQL testbed through the UI and compare patient counts across the two sources.
  await page.goto('/connectors');
  await page.locator('.page-heading').getByRole('button', { name: /Add connector/ }).click();
  await page.getByLabel('Connection name').fill('PostgreSQL testbed');
  await page.getByLabel('Host').fill(databaseUrl.hostname); await page.getByLabel('Port').fill(databaseUrl.port || '5432');
  await page.getByLabel('Database').fill(databaseUrl.pathname.slice(1)); await page.getByLabel('Username').fill(decodeURIComponent(databaseUrl.username)); await page.getByLabel('Password').fill(decodeURIComponent(databaseUrl.password));
  await page.getByLabel('SSL mode').selectOption('disable');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByRole('button', { name: 'Start profiling' }).click();
  await expect(page.getByRole('heading', { name: 'Discovery complete' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.goto('/');
  const compare = await askChecked("Does the workbook's Patients sheet have the same number of patients as the PostgreSQL testbed?", 2, /patients/i);
  const byType = Object.fromEntries(compare.answer.bySource.map((item) => [item.connectorType, item.value]));
  expect(byType).toEqual({ excel: checks.patientCount, postgres: allTruth.rowCounts.patients });
  for (const value of [checks.patientCount, allTruth.rowCounts.patients!]) expect(compare.answer.claims[0]!.statement).toContain(String(value));
  for (const name of ['Operations workbook', 'PostgreSQL testbed']) expect(compare.answer.claims[0]!.statement).toContain(name);
  expect(compare.answer.claims[0]!.statement).not.toMatch(/^yes\b/i);
  await page.screenshot({ path: 'docs/acceptance/s3/home-compare.png', fullPage: true });

  writeFileSync('docs/acceptance/s3/answer-evidence.json', JSON.stringify([visitCount, discharged, cancelled, top, average, compare].map(({ question, answer, provenance }) => ({ question, answer: answer.claims[0]!.statement, sql: answer.evidence.map((item) => item.locator), results: answer.bySource.map((item) => ({ connectorType: item.connectorType, value: item.value, rows: item.rows })), provenance })), null, 2) + '\n');
});

test.afterAll(async () => { await adminPool.end(); });
