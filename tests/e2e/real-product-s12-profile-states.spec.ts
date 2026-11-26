import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createTenant } from '../../scripts/tenant-create.js';
import { activateAndWait, expectProfilePageCompletes } from '../support/e2e-profile.js';

// Bug 6 (test_emr on 4284): an active connection with no profile, a failed profile, and a duplicate connection.
// The Profile page shows the job's real state with a reason and Retry; the card offers Run profile now and Remove.
const platformUrl = new URL(process.env.DATABASE_URL_MIGRATE ?? ''); platformUrl.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`;
const appUrl = new URL(process.env.DATABASE_URL ?? ''); appUrl.pathname = platformUrl.pathname;
const pool = new Pool({ connectionString: platformUrl.toString() }); const appPool = new Pool({ connectionString: appUrl.toString() });
const source = new URL(process.env.DATABASE_URL_TESTBED ?? '');
const credential = { host: source.hostname, port: Number(source.port || 5432), database: source.pathname.slice(1), username: decodeURIComponent(source.username), password: decodeURIComponent(source.password), sslMode: 'disable' };

test('s12_profile_page_shows_real_job_states_retry_run_now_and_remove', async ({ page }) => {
  test.setTimeout(600_000);
  const tenantId = `profile-states-${randomUUID()}`; const email = `${tenantId}@example.test`; const password = 'profile-states-password';
  await createTenant(pool, { tenantId, name: 'Profile states', displayName: 'Reviewer', email, password });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/login?tenant=${tenantId}`); await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Reviewer/ })).toBeVisible();
  const add = async (name: string) => {
    const draft = await page.request.post('/api/connections', { data: { connectorType: 'postgres', displayName: name, credential } }); expect(draft.status()).toBe(201);
    return (await draft.json() as { connectionId: string }).connectionId;
  };

  // 1. An active connection that was never profiled (as test_emr was before the bug 5 fix): one stable state, and
  //    Run profile now starts it. The page never flips to "being prepared" or "not available".
  const userId = await withTenant(pool, tenantId, async (db) => (await db.query<{ user_id: string }>('SELECT user_id FROM core.users WHERE tenant_id=$1', [tenantId])).rows[0]!.user_id);
  const neverProfiled = await add('Warehouse copy');
  await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres', connectionId: neverProfiled });
  await page.goto('/connectors');
  const neverCard = page.locator('.connector-card').filter({ hasText: 'Warehouse copy' });
  await expect(neverCard).toContainText('Profile needed'); await expect(neverCard).toContainText('Last profile: not run yet');
  await page.goto(`/profile/${neverProfiled}`);
  await expect(page.getByRole('heading', { name: 'Not profiled yet' })).toBeVisible();
  await page.waitForTimeout(12_000); // longer than the old page's 20 × 500 ms wait
  await expect(page.getByRole('heading', { name: 'Not profiled yet' })).toBeVisible();
  await expect(page.getByText(/being prepared|not available yet/)).toHaveCount(0);
  await page.screenshot({ path: 'docs/acceptance/s12/not-profiled.png', fullPage: true });
  await page.getByRole('button', { name: 'Run profile now' }).click();
  await expectProfilePageCompletes(page);

  // 2. A failed profile shows the reason, what to do, and Retry; Retry runs it again to completion.
  await withTenant(pool, tenantId, (db) => db.query("UPDATE profiler.jobs SET state='FAILED',phase='listing',failure_code='source_ssl_not_supported' WHERE tenant_id=$1 AND connection_id=$2", [tenantId, neverProfiled]));
  await page.reload();
  await expect(page.getByRole('img', { name: 'Profiling stopped' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('The server doesn’t accept encrypted connections. Remove this connection and add it again with SSL mode set to Disable, if your network allows it.');
  await page.screenshot({ path: 'docs/acceptance/s12/failed.png', fullPage: true });
  await page.getByRole('button', { name: 'Retry' }).click();
  await expectProfilePageCompletes(page);
  await page.screenshot({ path: 'docs/acceptance/s12/completed.png', fullPage: true });

  // 3. A duplicate is removed from its card: history is kept, the agent is retired, the card is gone.
  const duplicate = await add('Warehouse copy (duplicate)');
  await activateAndWait(page, duplicate);
  await page.goto('/connectors');
  const dupCard = page.locator('.connector-card').filter({ hasText: 'Warehouse copy (duplicate)' });
  await expect(dupCard.getByRole('button', { name: 'Run profile now' })).toBeVisible();
  await dupCard.getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove Warehouse copy (duplicate)?' });
  await expect(dialog).toContainText('Everything already learned about it is kept as history');
  await dialog.getByRole('button', { name: 'Remove connection' }).click();
  await expect(dupCard).toHaveCount(0);
  await expect(page.locator('.connector-card').filter({ hasText: 'Warehouse copy' })).toHaveCount(1);
  const kept = await withTenant(pool, tenantId, (db) => db.query<{ status: string; agent: string; assets: number; active: number; secrets: number }>(
    `SELECT c.status,a.status AS agent,(SELECT count(*)::int FROM graph.assets g WHERE g.tenant_id=c.tenant_id AND g.source_id=c.connection_id) AS assets,
       (SELECT count(*)::int FROM graph.assets g WHERE g.tenant_id=c.tenant_id AND g.source_id=c.connection_id AND g.active) AS active,
       (SELECT count(*)::int FROM registry.connection_secrets s WHERE s.tenant_id=c.tenant_id AND s.connection_id=c.connection_id) AS secrets
     FROM registry.connections c JOIN registry.agents a ON a.tenant_id=c.tenant_id AND a.agent_id=c.connector_agent_id WHERE c.tenant_id=$1 AND c.connection_id=$2`, [tenantId, duplicate]));
  expect(kept.rows[0]).toMatchObject({ status: 'retired', agent: 'retired', active: 0, secrets: 0 });
  expect(kept.rows[0]!.assets).toBeGreaterThan(0); // history kept (contract 6)
});
