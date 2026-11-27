import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { createTenant } from '../../scripts/tenant-create.js';
import { activateAndWait } from '../support/e2e-profile.js';

// S9: the Dictionary for every connector type against testbed truth (testbed/dictionary/truth.json, testbed/truth.json),
// and the interactive HTML export opened offline with every request blocked. Spec docs/phases/dictionary-rebuild.md.
config({ path: '.env' });
const migrateUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for the Dictionary walkthrough.'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); };
const adminPool = new Pool({ connectionString: migrateUrl() });
const postgres = new URL(process.env.DATABASE_URL_TESTBED ?? '');
if (!postgres.hostname || !process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('The PostgreSQL and SQL Server testbeds are required; run pnpm testbed:up (it includes pnpm testbed:dictionary).');
type Procedure = { group: string; writes: Array<{ table: string; mode: string }>; reads: string[]; calls: string[]; parameters: string[]; encrypted: boolean };
const truth = JSON.parse(readFileSync('testbed/dictionary/truth.json', 'utf8')) as {
  sqlserver: { tables: string[]; views: string[]; functions: Record<string, { parameters: string[]; returns: string[][]; reads: string[] }>; procedures: Record<string, Procedure>; hardCodedLiterals: string[]; sqlSearch: { query: string; object: string } };
  postgres: { tables: string[]; views: string[]; functions: Record<string, { reads: string[]; parameters: string[] }>; withheldColumns: Record<string, string[]> };
  dbt: { models: string[]; descriptions: Record<string, string>; tests: Record<string, string[][]> };
  tableau: { workbook: string; calculatedFields: Record<string, string>; hiddenLiterals: string[] };
};
const excel = (JSON.parse(readFileSync('testbed/truth.json', 'utf8')) as { excel: { file: string; sheets: Array<{ name: string; columns: string[]; headers: string[] }> } }).excel;
const short = (name: string) => name.replace(/^(dbo|public)\./, '');
// Decision 64: list items, tabs and headings show an object's own name, without schema or argument list.
const title = (name: string) => name.replace(/\(.*\)$/s, '').split('.').at(-1)!;
// App captures; scripts/compose-ui-screens.ts pairs them with the prototype in docs/ui/screens.
const screen = (name: string) => `docs/acceptance/s9/${name}.png`;

async function connect(page: Page, data: Record<string, unknown>, workbook?: Buffer): Promise<string> {
  const draft = await page.request.post('/api/connections', { data }); expect(draft.status()).toBe(201);
  const { connectionId } = await draft.json() as { connectionId: string };
  if (workbook) expect((await page.request.post(`/api/connections/${connectionId}/workbooks`, { data: workbook, headers: { 'content-type': 'application/octet-stream' } })).ok()).toBeTruthy();
  expect((await page.request.post(`/api/connections/${connectionId}/test`)).ok()).toBeTruthy();
  await activateAndWait(page, connectionId);
  return connectionId;
}
async function profiled(page: Page, connectionId: string) {
  await expect.poll(async () => ((await (await page.request.get(`/api/connections/${connectionId}/profile`)).json()) as { profile: { state: string } | null }).profile?.state, { timeout: 120_000 }).toBe('COMPLETED');
}
async function openSource(page: Page, connectionId: string) {
  await page.goto(`/dictionary?connection=${connectionId}`);
  await expect(page.locator('.dict-card').first()).toBeVisible();
}
const side = (page: Page) => page.getByRole('navigation', { name: 'Objects' });
const group = (page: Page, label: string) => side(page).locator('.dict-group').filter({ has: page.locator('h3', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }) });
async function names(page: Page, label: string) { return (await group(page, label).locator('li .mono').allTextContents()).sort(); }

test.afterAll(async () => { await adminPool.end(); });

test('s9_dictionary_matches_testbed_truth_for_every_connector_type_and_exports_offline', async ({ page, browser }) => {
  test.setTimeout(480_000);
  const tenantId = `dictionary-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 'dictionary-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId, name: 'Dictionary workspace', displayName: 'Test Analyst', email, password });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Test Analyst$/ })).toBeVisible();

  const pg = await connect(page, { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: postgres.hostname, port: Number(postgres.port || 5432), database: postgres.pathname.slice(1), username: decodeURIComponent(postgres.username), password: decodeURIComponent(postgres.password), sslMode: 'disable' } });
  const sql = await connect(page, { connectorType: 'sql_server', displayName: 'SQL Server dictionary testbed', credential: { host: process.env.SQLSERVER_TESTBED_HOST, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: 'si_testbed_dictionary', username: process.env.SQLSERVER_TESTBED_USERNAME, password: process.env.SQLSERVER_TESTBED_PASSWORD, trustServerCertificate: true } });
  const workbook = await connect(page, { connectorType: 'excel', displayName: 'Operations workbook' }, readFileSync(excel.file));
  for (const id of [pg, sql, workbook]) await profiled(page, id);
  const dbt = await page.request.post('/api/connections', { data: { connectorType: 'dbt', displayName: 'Hospital dbt project', warehouseConnectionId: pg } }); expect(dbt.status()).toBe(201);
  const dbtId = (await dbt.json() as { connectionId: string }).connectionId;
  expect((await page.request.post(`/api/connections/${dbtId}/dbt-artifacts`, { data: { manifest: JSON.parse(readFileSync('testbed/dbt/target/manifest.json', 'utf8')), catalog: JSON.parse(readFileSync('testbed/dbt/target/catalog.json', 'utf8')) } })).ok()).toBeTruthy();
  const tableau = await page.request.post('/api/connections', { data: { connectorType: 'tableau', displayName: 'Riverside operations', warehouseConnectionId: pg } }); expect(tableau.status()).toBe(201);
  const tableauId = (await tableau.json() as { connectionId: string }).connectionId;
  expect((await page.request.post(`/api/connections/${tableauId}/tableau-workbook`, { data: { workbook: readFileSync(truth.tableau.workbook, 'utf8') } })).ok()).toBeTruthy();

  // Every connector is in the Source dropdown.
  await openSource(page, sql);
  // The list arrives separately from the page (the current source shows alone until then), so wait for it.
  for (const name of ['PostgreSQL testbed', 'SQL Server dictionary testbed', 'Operations workbook', 'Hospital dbt project', 'Riverside operations'])
    await expect.poll(async () => (await page.getByLabel('Source').locator('option').allTextContents()).join('|'), name).toContain(name);

  // SQL Server: landing, standard and custom objects, procedure tabs, encrypted state, SQL search, Show original.
  await expect(page.locator('.dict-card').first()).toContainText('No vendor dictionary imported');
  await page.screenshot({ path: screen('landing') });
  // Decision 64: Standard is every table, X_ tables included; the page opens on it.
  await expect(side(page).getByRole('tab', { name: /^Standard/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => names(page, 'Tables')).toEqual(truth.sqlserver.tables.map(title).sort());
  await side(page).getByRole('button', { name: 'encounters', exact: true }).click();
  const header = page.locator('.dict-header');
  await expect(header.getByRole('heading', { name: 'encounters' })).toBeVisible();
  await expect(header).toContainText('Standard table');
  // Drafted descriptions are shown and used as they are; approving is optional.
  await expect(header.locator('.dict-review')).toContainText('Drafted');
  await expect(header).not.toContainText('waiting for approval');
  await expect(page.locator('.dict-card', { hasText: 'Keys and indexes' })).toContainText('patients.patient_id');
  await page.screenshot({ path: screen('table'), fullPage: false });
  // Show in ER diagram opens the ER explorer on this table and its neighbours.
  await header.getByRole('button', { name: 'Show in ER diagram' }).click();
  await expect(page.getByText('Showing dbo.encounters and its direct neighbours')).toBeVisible();
  await expect(page.locator('.er-node h3')).toContainText(['dbo.encounters']);
  await page.screenshot({ path: screen('er') });
  // A jump across pages offers a way back that names where it came from (CLAUDE.md 10.2).
  await page.getByRole('button', { name: 'Back to Dictionary · encounters' }).click();
  await expect(page.locator('.dict-header').getByRole('heading', { name: 'encounters' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Back to/ })).toHaveCount(0);
  // Approve all for a search: one confirmation, then every drafted description it shows.
  await page.getByLabel('Search tables, columns or SQL code').fill('X_CENSUS');
  const approveAll = side(page).locator('.dict-approve-all');
  await expect(approveAll).toContainText('Descriptions matching this search: 2 drafted');
  await approveAll.getByRole('button', { name: 'Approve all' }).click();
  const confirm = page.getByRole('dialog', { name: 'Approve all drafted descriptions' });
  await expect(confirm).toContainText('Approve 2 drafted descriptions matching “X_CENSUS” on Standard?');
  await page.screenshot({ path: screen('approve-all') });
  await confirm.getByRole('button', { name: 'Approve 2' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'approved' })).toHaveText('2 descriptions approved.');
  // Approved, so the line says so and there is nothing left to approve.
  await expect(approveAll).toContainText('Descriptions matching this search: 2 approved');
  await expect(approveAll.getByRole('button', { name: 'Approve all' })).toHaveCount(0);
  await side(page).getByRole('button', { name: 'X_CENSUS_SNAP', exact: true }).click();
  await expect(header.locator('.dict-review')).toContainText('Approved by Test Analyst');
  await page.getByLabel('Search tables, columns or SQL code').fill('');
  await side(page).getByRole('tab', { name: /^Custom/ }).click();
  await expect.poll(() => names(page, 'Views')).toEqual(truth.sqlserver.views.map(title).sort());
  for (const [name, procedure] of Object.entries(truth.sqlserver.procedures)) await expect.poll(() => names(page, procedure.group), name).toContain(title(name));
  await expect(side(page).locator('.dict-group h3', { hasText: /^Custom tables/ })).toHaveCount(0);
  const routines = Object.values(truth.sqlserver.procedures); const encrypted = routines.filter((procedure) => procedure.encrypted).length;
  const routineCount = routines.length + Object.keys(truth.sqlserver.functions).length;
  await expect(side(page)).toContainText(`SQL captured for ${routineCount - encrypted} of ${routineCount} procedures and functions · ${encrypted} encrypted`);
  // A table-valued function: its inputs under Parameters, its returned columns listed apart (decision 64).
  const [tvf, tvfTruth] = Object.entries(truth.sqlserver.functions)[0]!;
  await side(page).getByRole('button', { name: title(tvf), exact: true }).click();
  await expect(header.locator('.dict-kv > div', { hasText: 'Returns' })).toContainText(`A table with ${tvfTruth.returns.length} columns`);
  await page.getByRole('tab', { name: `Parameters ${tvfTruth.parameters.length}` }).click();
  const parametersCard = page.locator('.dict-card', { hasText: 'Parameters' });
  for (const parameter of tvfTruth.parameters) await expect(parametersCard.locator('tbody').first()).toContainText(parameter);
  await expect(parametersCard).toContainText(`Returns a table with ${tvfTruth.returns.length} columns`);
  for (const [column] of tvfTruth.returns) await expect(parametersCard.locator('table').nth(1)).toContainText(column!);
  await page.screenshot({ path: screen('function-returns') });
  const loader = 'dbo.usp_X_LOAD_READMIT_FLAGS'; const expected = truth.sqlserver.procedures[loader]!;
  await side(page).getByRole('button', { name: short(loader), exact: true }).click();
  const what = page.locator('.dict-card', { hasText: 'What it does' });
  await expect(what).toContainText('TRUNCATE + INSERT'); await expect(what).toContainText('Parsed from SQL');
  for (const write of expected.writes) await expect(what).toContainText(short(write.table));
  for (const read of expected.reads) await expect(what).toContainText(short(read));
  await page.screenshot({ path: screen('procedure') });
  await page.getByRole('tab', { name: `Parameters ${expected.parameters.length}` }).click();
  for (const parameter of expected.parameters) await expect(page.locator('.dict-card', { hasText: 'Parameters' })).toContainText(parameter);
  await expect(page.locator('.dict-card', { hasText: 'Parameters' })).toContainText('Declared');
  await page.getByRole('tab', { name: /^Tables and columns/ }).click();
  await expect(page.locator('.dict-col.is-used').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Calls' }).click();
  for (const call of expected.calls) await expect(page.locator('.dict-card', { hasText: 'Called by' })).toContainText(short(call));
  await page.getByRole('tab', { name: 'SQL' }).click();
  const code = page.locator('.dict-code');
  await expect(code).toContainText('<number>');
  for (const literal of truth.sqlserver.hardCodedLiterals) await expect(code).not.toContainText(literal);
  await page.screenshot({ path: screen('procedure-sql') });
  await page.getByRole('button', { name: 'Show original' }).click();
  await expect(page.getByText('Original, fetched live from the source just now. It is not stored.')).toBeVisible();
  await expect(code).toContainText(truth.sqlserver.hardCodedLiterals[0]!);
  const secret = Object.entries(truth.sqlserver.procedures).find(([, procedure]) => procedure.encrypted)![0];
  await side(page).getByRole('button', { name: short(secret), exact: true }).click();
  await page.getByRole('tab', { name: 'SQL' }).click();
  await expect(page.locator('.dict-encrypted')).toContainText('Encrypted');
  await expect(header).toContainText('Encrypted');
  await page.screenshot({ path: screen('encrypted') });
  await page.getByLabel('Search tables, columns or SQL code').fill(truth.sqlserver.sqlSearch.query);
  const sqlGroup = group(page, 'In SQL code');
  await expect(sqlGroup).toContainText(short(truth.sqlserver.sqlSearch.object));
  await expect(sqlGroup.locator('.dict-snippet').first()).toContainText(/line \d+:/);
  await page.screenshot({ path: screen('search') });
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.locator('details.dict-card[open]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(page.locator('details.dict-card:not([open])')).toHaveCount(0);

  // PostgreSQL: tables, views and functions; tagged columns show withheld statistics.
  await openSource(page, pg);
  // Tables on Standard; views and functions on Custom (decision 64).
  await expect(side(page).getByRole('tab', { name: /^Standard/ })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => names(page, 'Tables')).toEqual(truth.postgres.tables.map(title).sort());
  for (const [table, columns] of Object.entries(truth.postgres.withheldColumns)) {
    await side(page).getByRole('button', { name: title(table), exact: true }).click();
    const card = page.locator('.dict-card', { hasText: 'Columns' });
    const showAll = card.getByRole('button', { name: /^Show all/ }); if (await showAll.count()) await showAll.click();
    for (const column of columns) await expect(card.locator('tr', { has: page.locator('.dict-colname', { hasText: new RegExp(`^${column}$`) }) })).toContainText('Withheld');
  }
  await side(page).getByRole('tab', { name: /^Custom/ }).click();
  await expect.poll(() => names(page, 'Views')).toEqual(truth.postgres.views.map(title).sort());
  await expect.poll(() => names(page, 'Functions')).toEqual(Object.keys(truth.postgres.functions).map(title).sort());
  const [fn, fnTruth] = Object.entries(truth.postgres.functions)[0]!;
  await side(page).getByRole('button', { name: title(fn), exact: true }).click();
  // The title is the short name; the full signature is under Details.
  await expect(header.getByRole('heading', { name: title(fn), exact: true })).toBeVisible();
  await expect(header.locator('.dict-kv > div', { hasText: 'Full signature' })).toContainText(fn);
  await expect(page.getByRole('tab', { name: `Parameters ${fnTruth.parameters.length}` })).toBeVisible();
  for (const read of fnTruth.reads) await expect(page.locator('.dict-card', { hasText: 'What it does' })).toContainText(short(read));

  // Excel: one object per sheet with the original headers.
  await openSource(page, workbook);
  await expect.poll(() => names(page, 'Sheets')).toEqual(excel.sheets.map((sheet) => sheet.name).sort());
  const sheet = excel.sheets[0]!;
  await side(page).getByRole('button', { name: sheet.name, exact: true }).click();
  const sheetColumns = page.locator('.dict-card', { hasText: 'Columns, with original headers' });
  for (const header of sheet.headers.filter((header, index) => header !== sheet.columns[index])) await expect(sheetColumns).toContainText(header);
  await page.locator('.dict-header').getByRole('button', { name: 'Ask about this' }).click();
  await page.getByRole('button', { name: `Back to Dictionary · ${sheet.name}` }).click();
  await expect(page.locator('.dict-header').getByRole('heading', { name: sheet.name })).toBeVisible();
  await page.screenshot({ path: screen('excel') });

  // dbt: models and sources with their descriptions (documented) and tests.
  await openSource(page, dbtId);
  // dbt models are built over the sources, so they are Custom (decision 64).
  await side(page).getByRole('tab', { name: /^Custom/ }).click();
  for (const model of truth.dbt.models) await expect.poll(() => names(page, 'Models')).toContain(title(model));
  for (const [model, description] of Object.entries(truth.dbt.descriptions)) {
    await side(page).getByRole('button', { name: title(model), exact: true }).click();
    await expect(page.locator('.dict-header')).toContainText(description);
    await expect(page.locator('.dict-header')).toContainText('From the dbt project');
  }
  const [testedModel, tests] = Object.entries(truth.dbt.tests)[0]!;
  await side(page).getByRole('button', { name: title(testedModel), exact: true }).click();
  const testCard = page.locator('.dict-card', { hasText: 'dbt tests' });
  for (const [column, name] of tests) await expect(testCard).toContainText(`${column} · ${name}`);
  await page.screenshot({ path: screen('dbt') });

  // Tableau: data sources, worksheets and calculated fields with scrubbed formulas.
  await openSource(page, tableauId);
  await side(page).getByRole('tab', { name: /^Custom/ }).click();
  for (const [field, formula] of Object.entries(truth.tableau.calculatedFields)) {
    await side(page).getByRole('button', { name: title(field), exact: true }).click();
    await expect(page.locator('.dict-code')).toHaveText(formula);
  }
  for (const literal of truth.tableau.hiddenLiterals) await expect(page.locator('.dict-code')).not.toContainText(literal);
  await page.screenshot({ path: screen('tableau') });

  // Export as interactive HTML: notice first, then one offline file that makes no requests.
  await openSource(page, sql);
  await page.getByRole('button', { name: 'Export as interactive HTML' }).click();
  const notice = page.getByRole('dialog', { name: 'Export as interactive HTML' });
  await expect(notice).toContainText('Not included: row data');
  await page.screenshot({ path: screen('export-notice') });
  const [download] = await Promise.all([page.waitForEvent('download'), notice.getByRole('button', { name: 'Export', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/^dictionary-\d{4}-\d{2}-\d{2}\.html$/);
  const file = test.info().outputPath('dictionary.html'); await download.saveAs(file);
  // Offline, and every request other than the file itself is recorded and refused.
  const offline = await browser.newContext({ offline: true }); const requests: string[] = [];
  const viewer = await offline.newPage();
  await viewer.route('**/*', (route) => { const url = route.request().url(); if (url === `file://${file}`) return route.continue(); requests.push(url); return route.abort(); });
  await viewer.setViewportSize({ width: 1440, height: 900 });
  await viewer.goto(`file://${file}`);
  // Item 5: the export looks and behaves like the Dictionary page: the same tabs, search, list and object view.
  const exportSide = viewer.getByRole('navigation', { name: 'Objects' });
  await expect(exportSide.getByRole('tab', { name: /^Standard/ })).toHaveAttribute('aria-selected', 'true');
  await expect(viewer.getByText(/^Exported from Scale Insyght on .*Metadata only: no row data\./)).toBeVisible();
  // One source: its name is not repeated on every row; rows show the short name with the schema as a small label.
  await expect(exportSide.locator('li .dict-schema').first()).toHaveText('dbo');
  await expect(exportSide.locator('li .mono')).toContainText(['departments']);
  // Search covers names, columns and SQL.
  await exportSide.getByLabel('Search tables, columns or SQL code').fill(truth.sqlserver.sqlSearch.query);
  await expect(exportSide.locator('.dict-group', { hasText: 'In SQL code' })).toContainText(title(truth.sqlserver.sqlSearch.object));
  await exportSide.getByLabel('Search tables, columns or SQL code').fill('');
  await exportSide.getByRole('tab', { name: /^Custom/ }).click();
  // A function: its parameters, the columns it returns and what it reads, exactly as the page shows them.
  const [exportFn, exportFnTruth] = Object.entries(truth.sqlserver.functions)[0]!;
  await exportSide.getByRole('button', { name: new RegExp(`^${title(exportFn)}`) }).click();
  const exportHeader = viewer.locator('.dict-header');
  await expect(exportHeader.getByRole('heading', { name: title(exportFn), exact: true })).toBeVisible();
  await expect(exportHeader.locator('.dict-kv > div', { hasText: 'Full name' })).toContainText(exportFn);
  await expect(viewer.locator('.dict-card', { hasText: 'What it does' })).toContainText(`Reads${exportFnTruth.reads.map(short).join('')}`);
  await viewer.getByRole('tab', { name: `Parameters ${exportFnTruth.parameters.length}` }).click();
  const exportParameters = viewer.locator('.dict-card', { hasText: 'Parameters' });
  for (const parameter of exportFnTruth.parameters) await expect(exportParameters.locator('table').first()).toContainText(parameter);
  await expect(exportParameters).toContainText(`Returns a table with ${exportFnTruth.returns.length} columns`);
  // A procedure that calls another: its Reads and Calls.
  const exportLoader = 'dbo.usp_X_LOAD_READMIT_FLAGS'; const exportLoaderTruth = truth.sqlserver.procedures[exportLoader]!;
  await exportSide.getByRole('button', { name: new RegExp(`^${title(exportLoader)}`) }).click();
  await expect(viewer.locator('.dict-card', { hasText: 'What it does' })).toContainText(`Reads${exportLoaderTruth.reads.map(short).join('')}`);
  await viewer.getByRole('tab', { name: 'Calls' }).click();
  for (const call of exportLoaderTruth.calls) await expect(viewer.locator('.dict-card', { hasText: 'Called by' })).toContainText(short(call));
  await viewer.getByRole('tab', { name: 'Overview' }).last().click();
  await viewer.screenshot({ path: screen('export-viewer') });
  await viewer.getByRole('button', { name: 'Collapse all' }).click();
  await expect(viewer.locator('details.dict-card[open]')).toHaveCount(0);
  await expect(viewer.locator('body')).not.toContainText(truth.sqlserver.hardCodedLiterals[0]!);
  expect(requests).toEqual([]);
  await offline.close();
  await expect(page.getByRole('status')).toContainText('recorded in the audit log');

  // Decision 64: Controls has no "Standard or custom" rules; the split comes from the object type.
  await page.goto(`/controls?connection=${sql}`);
  await expect(page.getByRole('heading', { name: 'When things change' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Standard or custom' })).toHaveCount(0);
});
