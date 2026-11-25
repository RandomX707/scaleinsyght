import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { createTenant } from '../../scripts/tenant-create.js';

// Reproduces the Home thread bug reported on the review app: with SQL Server and "All sources" selected, asking a
// question (through the source-choice step) and then asking again lost earlier turns, filled Recent conversations with
// identical empty entries, and opening any of them showed an empty Home page.
config({ path: '.env' });
const migrateUrl = () => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required for the chat-thread walkthrough.'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString(); };
const adminPool = new Pool({ connectionString: migrateUrl() });
const postgres = new URL(process.env.DATABASE_URL_TESTBED ?? '');
if (!postgres.hostname || !process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('The local SQL Server and PostgreSQL testbeds are required.');

async function connect(page: Page, data: Record<string, unknown>) {
  const draft = await page.request.post('/api/connections', { data }); expect(draft.status()).toBe(201);
  const { connectionId } = await draft.json() as { connectionId: string };
  expect((await page.request.post(`/api/connections/${connectionId}/test`)).ok()).toBeTruthy();
  expect((await page.request.post(`/api/connections/${connectionId}/activate`, { data: { scope: [] } })).ok()).toBeTruthy();
}

async function answerLatest(page: Page, turns: number) {
  // The source-choice step is part of the same turn; it must never start a new conversation.
  const choice = page.getByRole('button', { name: 'Use SQL Server hospital' });
  const answered = page.locator('.answer-claim').nth(turns - 1);
  await expect(choice.or(answered)).toBeVisible({ timeout: 90_000 });
  if (await choice.isVisible()) await choice.click();
  await expect(answered).toBeVisible({ timeout: 90_000 });
}

test('s2b_one_thread_per_chat_with_every_turn_and_one_recent_entry', async ({ page }) => {
  test.setTimeout(300_000);
  const tenantId = `chat-${randomUUID()}`; const email = `analyst@${tenantId}.test.invalid`; const password = 'chat-thread-walkthrough-password-2026';
  await createTenant(adminPool, { tenantId, name: 'Chat thread workspace', displayName: 'Test Analyst', email, password });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good afternoon, Test Analyst' })).toBeVisible();
  await connect(page, { connectorType: 'sql_server', displayName: 'SQL Server hospital', credential: { host: process.env.SQLSERVER_TESTBED_HOST, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE, username: process.env.SQLSERVER_TESTBED_USERNAME, password: process.env.SQLSERVER_TESTBED_PASSWORD, trustServerCertificate: true } });
  await connect(page, { connectorType: 'postgres', displayName: 'PostgreSQL testbed', credential: { host: postgres.hostname, port: Number(postgres.port || 5432), database: postgres.pathname.slice(1), username: decodeURIComponent(postgres.username), password: decodeURIComponent(postgres.password), sslMode: 'disable' } });

  await page.goto('/');
  await page.getByText('All sources', { exact: true }).click();
  for (const name of ['SQL Server hospital', 'PostgreSQL testbed']) await expect(page.getByLabel(name, { exact: true })).toBeChecked();
  const posts: string[] = [];
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') posts.push(request.postData() ?? ''); });

  // First question, sent with an impatient double click.
  await page.getByLabel('Ask a question').fill('what are Orders per department');
  await page.getByRole('button', { name: 'Send question' }).dblclick();
  await answerLatest(page, 1);
  // Second question in the same chat.
  await page.getByLabel('Ask a question').fill('and how many orders are there in total?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await answerLatest(page, 2);

  // One conversation, every turn oldest first, scrolled to the newest.
  await expect(page).toHaveURL(/\/conversations\/[0-9a-f-]{36}$/);
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  await expect(page.locator('.question-bubble')).toHaveText(['what are Orders per department', 'and how many orders are there in total?']);
  await expect.poll(() => page.locator('.chat-scroll').evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 4)).toBe(true);
  await expect(page.locator('.answer-claim').last()).toBeInViewport();
  const stored = await withTenant(adminPool, tenantId, (client) => client.query<{ conversation_id: string; runs: string; answered: string }>(
    `SELECT c.conversation_id, count(r.run_id)::text AS runs, count(a.run_id)::text AS answered FROM runs.conversations c
     LEFT JOIN runs.runs r ON r.tenant_id=c.tenant_id AND r.conversation_id=c.conversation_id
     LEFT JOIN runs.analytic_answers a ON a.tenant_id=r.tenant_id AND a.run_id=r.run_id
     WHERE c.tenant_id=$1 GROUP BY c.conversation_id`, [tenantId]));
  expect(stored.rows.map((row) => row.conversation_id)).toEqual([conversationId]);
  expect(Number(stored.rows[0]!.answered)).toBe(2);

  // Recent conversations: one entry per real thread, titled from its first question.
  const recent = page.locator('.recent-list button');
  await expect(recent).toHaveCount(1);
  await expect(recent).toHaveText([/^\W*what are Orders per department$/]);
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.locator('.question-bubble')).toHaveCount(0);
  for (let index = 0; index < await recent.count(); index++) {
    await recent.nth(index).click();
    await expect(page).toHaveURL(new RegExp(`/conversations/${conversationId}$`));
    await expect(page.locator('.question-bubble')).toHaveText(['what are Orders per department', 'and how many orders are there in total?']);
  }
  await page.reload();
  await expect(page.locator('.question-bubble')).toHaveCount(2);
  await page.screenshot({ path: 'docs/acceptance/s2/home-thread.png', fullPage: true });
  // Every send carries a request id, so a double click or retry can never start a second run or thread.
  const ids = posts.map((body) => (JSON.parse(body) as { requestId?: string }).requestId);
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
});

test.afterAll(async () => { await adminPool.end(); });
