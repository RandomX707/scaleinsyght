import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';
import { signInToTestWorkspace } from '../support/e2e-auth.js';

config({ path: '.env' });
const migrate = new URL(process.env.DATABASE_URL_MIGRATE ?? '');
migrate.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`;
const setupPool = new Pool({ connectionString: migrate.toString() });
test.afterAll(async () => setupPool.end());

async function createEmptyTenant() {
  const tenantId = `phase4-empty-${crypto.randomUUID()}`;
  const email = `owner@${tenantId}.synthetic.invalid`;
  await withTenant(setupPool, tenantId, async (db) => {
    await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$2)', [tenantId, 'Empty integration workspace']);
    await db.query('INSERT INTO core.users(tenant_id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [tenantId, email, 'Workspace Owner', hashPassword('golden-local-only')]);
  });
  return { tenantId, email };
}

test('hub_integrations_show_disconnected_empty_state_for_a_new_tenant', async ({ page }) => {
  const tenant = await createEmptyTenant();
  await signInToTestWorkspace(page, tenant.email);
  await page.getByRole('link', { name: 'Hub integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Hub integrations' })).toBeVisible();
  await expect(page.getByText('No integrations connected')).toBeVisible();
  await expect(page.getByText('This workspace has no connected Hub integrations.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Create FlowSpec/ })).toHaveCount(0);
  const state = await page.evaluate(async () => {
    const [adapters, metrics] = await Promise.all([
      fetch('/api/hub/adapters').then(response => response.json()),
      fetch('/api/semantics/metrics').then(response => response.json()),
    ]);
    return { adapters: adapters.adapters, metrics: metrics.metrics } as { adapters: unknown[]; metrics: unknown[] };
  });
  expect(state).toEqual({ adapters: [], metrics: [] });
});

test('hub_page_does_not_show_canned_metric_or_delivery_examples', async ({ page }) => {
  const tenant = await createEmptyTenant();
  await signInToTestWorkspace(page, tenant.email);
  await page.getByRole('link', { name: 'Hub integrations' }).click();
  await expect(page.getByText(/active customers|customer report|synthetic|fixture|golden/i)).toHaveCount(0);
  await expect(page.getByText('Handoffs will appear after a supported destination and a real report definition are connected.')).toBeVisible();
});
