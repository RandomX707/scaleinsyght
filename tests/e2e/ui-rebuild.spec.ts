import { expect, test } from '@playwright/test';

test('ui_shell_matches_prototype_and_signed_in_identity', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('phase0-login@synthetic.example');
  await page.getByLabel('Password').fill('golden-local-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('img', { name: 'INSYGHT' }).first()).toBeVisible();
  await expect(page.getByText('Prototype · example data')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Good afternoon, Yashaswi' })).toBeVisible();
  await expect(page.getByText('Yashaswi', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /New chat/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Notifications/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /PLATFORM/i })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /Recent conversations/i })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/synthetic/i);
});

test('ui_notifications_new_and_earlier_groups', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('phase0-login@synthetic.example');
  await page.getByLabel('Password').fill('golden-local-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Earlier', exact: true })).toBeVisible();
});

test('ui_er_explorer_renders_a_connected_entity_map_and_controls_selects_a_source', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('phase1-profile@synthetic.example');
  await page.getByLabel('Password').fill('golden-local-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: /Connectors/ }).click();
  await page.locator('.page-heading').getByRole('button', { name: /Add connector/ }).click();
  await page.getByRole('button', { name: /Meridian Lumen/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Start profiling' }).click();
  await expect(page.getByRole('heading', { name: 'Discovery complete' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  const connectionId = await page.evaluate(async () => {
    const result = await (await fetch('/api/connections')).json() as { connections: Array<{ connectionId: string; connectorType: string; status: string }> };
    return result.connections.find(item => item.connectorType === 'postgres' && item.status === 'active')?.connectionId ?? '';
  });
  expect(connectionId).toBeTruthy();
  await page.goto(`/er?connection=${connectionId}`);
  await expect(page.getByRole('heading', { name: 'Entity relationships', exact: true })).toBeVisible();
  await expect(page.locator('.er-canvas')).toBeVisible();
  await expect(page.locator('.er-node').first()).toBeVisible();
  await page.goto(`/controls?connection=${connectionId}`);
  await expect(page.getByLabel('Controls connector')).toHaveValue(connectionId);
  await expect(page.getByRole('heading', { name: 'What to include' })).toBeVisible();
});
