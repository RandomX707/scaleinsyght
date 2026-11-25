import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { config } from 'dotenv';
import { Client, Pool } from 'pg';
import { createTenant } from '../../scripts/tenant-create.js';

// S11: Home answers follow decision 56. One case per display rule, each checked against SQL truth on the PostgreSQL
// testbed; form-only follow-ups make no new run. Lineage answers are covered by S4 and the excluded-table refusal by S10.
config({ path: '.env' });
const migrateUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for the Home walkthrough.'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); };
const adminPool = new Pool({ connectionString: migrateUrl() });
const testbed = process.env.DATABASE_URL_TESTBED ?? ''; const postgres = new URL(testbed);
if (!postgres.hostname) throw new Error('The PostgreSQL testbed is required; run pnpm testbed:up.');
const shot = (name: string) => `docs/acceptance/s11/${name}.png`;

async function truth(sql: string): Promise<Array<Record<string, string>>> {
  const client = new Client({ connectionString: testbed }); await client.connect();
  try { return (await client.query<Record<string, string>>(sql)).rows; } finally { await client.end(); }
}
const runPosts: string[] = [];
async function ask(page: Page, question: string) {
  await page.getByLabel('Ask a question').fill(question);
  await page.getByRole('button', { name: 'Send question' }).click();
}
async function answered(page: Page, count: number) {
  await expect(page.locator('.plan-line')).toHaveCount(count, { timeout: 120_000 });
}

test.afterAll(async () => { await adminPool.end(); });

test('s11_home_answers_take_the_form_code_chooses_and_form_follow_ups_do_not_rerun', async ({ page }) => {
  test.setTimeout(480_000);
  mkdirSync('docs/acceptance/s11', { recursive: true });
  const tenantId = `home-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 'home-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId, name: 'Home workspace', displayName: 'Test Analyst', email, password });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Test Analyst$/ })).toBeVisible();
  const draft = await page.request.post('/api/connections', { data: { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: postgres.hostname, port: Number(postgres.port || 5432), database: postgres.pathname.slice(1), username: decodeURIComponent(postgres.username), password: decodeURIComponent(postgres.password), sslMode: 'disable' } } });
  const { connectionId } = await draft.json() as { connectionId: string };
  expect((await page.request.post(`/api/connections/${connectionId}/test`)).ok()).toBeTruthy();
  expect((await page.request.post(`/api/connections/${connectionId}/activate`, { data: { scope: [] } })).ok()).toBeTruthy();
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') runPosts.push(request.url()); });
  await page.goto('/');

  // 1. One value: a sentence, the plan collapsed to one line, evidence in one collapsed drawer.
  const patients = (await truth('SELECT count(*)::text AS n FROM patients'))[0]!.n;
  await ask(page, 'How many patients are in the PostgreSQL testbed?');
  await expect(page.locator('.live-plan')).toBeVisible();
  await page.screenshot({ path: shot('plan-live') });
  await answered(page, 1);
  await expect(page.locator('.answer-claim').last()).toContainText(Number(patients).toLocaleString('en-US'));
  await expect(page.locator('.grouped-result')).toHaveCount(0);
  await expect(page.locator('.plan-line').last().locator(':scope > summary')).toHaveText(/^Answered from PostgreSQL testbed · 1 query · \d+ s$/);
  await expect(page.locator('.plan-line').last().getByRole('heading', { name: 'How this was answered' })).toBeHidden();
  const drawer = page.locator('.evidence-drawer').last();
  await expect(drawer.locator(':scope > summary')).toHaveText('SQL, sources and lineage (1 query)');
  await expect(drawer.locator('.evidence-list')).toBeHidden();
  await drawer.locator(':scope > summary').click();
  await expect(drawer.locator('.evidence-list')).toContainText(/SELECT count\(\*\)/);
  await page.screenshot({ path: shot('sentence') });

  // 2. "Just the number" reshows the same answer: no new run.
  let posts = runPosts.length;
  await ask(page, 'just give me the number');
  await expect(page.locator('.display-turn').last()).toContainText('Same answer, as a single number');
  await expect(page.locator('.display-turn').last()).toContainText(`Source result: ${patients}`);
  expect(runPosts.length).toBe(posts);

  // 3. 2 to 5 groups: a small table, no chart.
  await page.getByRole('button', { name: 'New chat' }).click();
  const types = await truth('SELECT order_type AS g,count(*)::text AS n FROM orders GROUP BY 1');
  expect(types.length).toBeGreaterThanOrEqual(2); expect(types.length).toBeLessThanOrEqual(5);
  await ask(page, 'How many orders are there of each order type in the PostgreSQL testbed?');
  await answered(page, 1);
  const small = page.locator('.grouped-result').last();
  await expect(small.locator('.bar-chart')).toHaveCount(0);
  await expect(small.locator('tbody tr')).toHaveCount(types.length);
  for (const row of types) await expect(small.locator('tbody tr').filter({ hasText: row.g! })).toContainText(Number(row.n).toLocaleString('en-US'));
  await page.screenshot({ path: shot('small-table') });

  // 4. 6 to 20 groups: a chart, no table; "Show as a table" is one click; follow-ups reshow without rerunning.
  await page.getByRole('button', { name: 'New chat' }).click();
  const departments = await truth('SELECT d.department_name AS g,count(*)::text AS n FROM orders o JOIN departments d USING (department_id) GROUP BY 1');
  expect(departments.length).toBeGreaterThanOrEqual(6); expect(departments.length).toBeLessThanOrEqual(20);
  await ask(page, 'How many orders does each department have in the PostgreSQL testbed?');
  await answered(page, 1);
  const chart = page.locator('.grouped-result').last();
  await expect(chart.locator('.bar-chart .bar-row')).toHaveCount(departments.length);
  await expect(chart.locator('table')).toHaveCount(0);
  for (const row of departments) await expect(chart.locator('.bar-row').filter({ hasText: row.g! })).toContainText(Number(row.n).toLocaleString('en-US'));
  await page.screenshot({ path: shot('chart') });
  await chart.getByRole('button', { name: 'Show as a table' }).click();
  await expect(chart.locator('tbody tr')).toHaveCount(departments.length);
  await expect(chart.locator('.bar-chart')).toHaveCount(0);
  posts = runPosts.length;
  await ask(page, 'can you put that in a table');
  await expect(page.locator('.display-turn').last()).toContainText('Same answer, shown as a table');
  await expect(page.locator('.display-turn').last().locator('tbody tr')).toHaveCount(departments.length);
  await ask(page, 'top 3');
  await expect(page.locator('.display-turn').last()).toContainText('Same answer, top 3');
  const top = [...departments].sort((a, b) => Number(b.n) - Number(a.n)).slice(0, 3);
  await expect(page.locator('.display-turn').last().locator('tbody tr')).toHaveCount(3);
  for (const row of top) await expect(page.locator('.display-turn').last()).toContainText(row.g!);
  expect(runPosts.length).toBe(posts);
  await page.screenshot({ path: shot('follow-ups') });
  // A follow-up that adds a condition is a new question: it runs.
  await ask(page, 'and how many of them were cancelled?');
  await expect.poll(() => runPosts.length).toBe(posts + 1);
  await answered(page, 2);

  // 5. More than 20 rows: a compact table and Show all.
  await page.getByRole('button', { name: 'New chat' }).click();
  const providers = await truth('SELECT provider_id::text AS g,count(*)::text AS n FROM encounters GROUP BY 1');
  expect(providers.length).toBeGreaterThan(20);
  // The plain wording "each provider" is refused by the verifier today (known issue K8); provider_id is shown by name (decision 45).
  await ask(page, 'How many encounters does each provider_id have in the PostgreSQL testbed?');
  await answered(page, 1);
  const compact = page.locator('.grouped-result').last();
  await expect(compact.locator('.bar-chart')).toHaveCount(0);
  await expect(compact.locator('tbody tr')).toHaveCount(10);
  await compact.getByRole('button', { name: `Show all ${providers.length}` }).click();
  await expect(compact.locator('tbody tr')).toHaveCount(providers.length);
  await page.screenshot({ path: shot('compact-table') });

  // 6. A refusal explains itself and offers a safe alternative.
  await page.getByRole('button', { name: 'New chat' }).click();
  await ask(page, 'List the names of the patients in the PostgreSQL testbed');
  await expect(page.getByRole('heading', { name: 'Protected information' })).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.plan-line').last().locator(':scope > summary')).toHaveText(/^Not answered · protected information/);
  await page.getByRole('button', { name: 'Ask for a count instead' }).click();
  await expect(page.getByLabel('Ask a question')).toHaveValue('How many records are there, without listing names or identifiers?');
  await page.screenshot({ path: shot('refusal') });
});
