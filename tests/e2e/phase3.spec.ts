import { expect, test } from '@playwright/test';
import { signInToTestWorkspace } from '../support/e2e-auth.js';

test('empty_lineage_and_bi_reports_offer_source_setup_without_fixture_controls', async ({ page }) => {
  await signInToTestWorkspace(page, 'phase3-lineage@synthetic.example');
  await page.getByRole('link', { name: /Lineage/ }).click();
  await expect(page.getByRole('heading', { name: 'Lineage workspace' })).toBeVisible();
  await expect(page.getByText('No lineage to show yet')).toBeVisible();
  await expect(page.getByRole('button', { name: /synthetic|fixture|golden/i })).toHaveCount(0);

  const idTraceLink = page.getByRole('link', { name: 'ID trace' });
  await idTraceLink.focus();
  await expect(idTraceLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'ID trace' })).toBeVisible();
  await expect(page.getByRole('heading',{name:'No identifier fields yet'})).toBeVisible();

  await page.getByRole('navigation', { name: 'Lineage workspace views' }).getByRole('link', { name: 'BI reports', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'BI reports' })).toBeVisible();
  await expect(page.getByText('No reports connected')).toBeVisible();
});

test('empty_graph_does_not_offer_canned_inferred_assertions', async ({ page }) => {
  await signInToTestWorkspace(page, 'phase3-review@synthetic.example');
  await page.getByRole('link', { name: /Lineage/ }).click();
  await expect(page.getByRole('heading', { name: 'Lineage workspace' })).toBeVisible();
  await expect(page.locator('.lineage-edges')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept assertion' })).toHaveCount(0);
  const response = await page.evaluate(async () => fetch('/api/lineage/assets').then(result => result.json()) as Promise<{ assets: unknown[] }>);
  expect(response.assets).toEqual([]);
});
