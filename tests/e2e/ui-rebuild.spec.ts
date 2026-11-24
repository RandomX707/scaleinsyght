import { expect, test } from '@playwright/test';
import { workspaceForTestEmail } from '../support/e2e-auth.js';

test('signed_in_empty_tenant_shows_product_shell_without_seeded_content', async ({ page }) => {
  await page.goto(`/login?tenant=${encodeURIComponent(workspaceForTestEmail('phase0-login@synthetic.example'))}`);
  await page.getByLabel('Email').fill('phase0-login@synthetic.example');
  await page.getByLabel('Password').fill('golden-local-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('img', { name: 'INSYGHT' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /New chat/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Notifications/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Workspace/i })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /Platform/i })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /Recent conversations/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Add a connector/ })).toBeVisible();
  await expect(page.getByText(/Prototype · example data|Meridian|Riverside Health|golden:|synthetic/i)).toHaveCount(0);
});
