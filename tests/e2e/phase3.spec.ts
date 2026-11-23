import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('phase3_lineage_id_trace_impact_reports_and_snapshot_compare_are_keyboard_accessible', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('analyst@north.example');
  await page.getByLabel('Password').fill('golden-local-only');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: /Lineage/ }).click();
  await expect(page.getByRole('heading', { name: 'Lineage workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Import synthetic Power BI reports' }).click();
  await expect(page.getByRole('status')).toContainText('Synthetic lineage imported');
  await page.getByRole('button', { name: 'Import synthetic dbt manifest' }).click();
  await expect(page.getByRole('status')).toContainText('Synthetic lineage imported');
  await page.getByLabel('Graph asset').selectOption({ label: 'dbt.customer_mart · dataset' });
  await expect(page.locator('.lineage-edges')).toContainText('Power BI.Customer Health');
  const idTraceLink=page.getByRole('link', { name: 'ID trace' });
  await idTraceLink.focus();
  await expect(idTraceLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'ID trace' })).toBeVisible();
  await expect(page.getByLabel('Identifier field')).toBeVisible();
  await page.getByRole('link', { name: 'Snapshot compare' }).click();
  await expect(page.getByRole('heading', { name: 'Snapshot compare' })).toBeVisible();
  await expect(page.getByLabel('Earlier snapshot')).toBeVisible();
  await expect(page.getByLabel('Later snapshot')).toBeVisible();
  await page.getByRole('link', { name: 'BI reports', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'BI reports' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Power BI.Customer Health' })).toHaveAttribute('href', '/demo/power-bi/customer-health');
});

test('c6_accepted_inference_stays_unverified_in_api_and_lineage_ui',async({page})=>{
  await page.goto('/login');
  await page.getByLabel('Email').fill('analyst@north.example');
  await page.getByLabel('Password').fill('golden-local-only');
  await page.getByRole('button',{name:'Sign in'}).click();
  await page.getByRole('link',{name:/Lineage/}).click();
  await page.getByRole('button',{name:'Import synthetic Power BI reports'}).click();
  await expect(page.getByRole('status')).toContainText('Synthetic lineage imported');
  await page.getByRole('button',{name:'Import synthetic dbt manifest'}).click();
  await expect(page.getByRole('status')).toContainText('Synthetic lineage imported');
  const latestDbtAsset=page.getByLabel('Graph asset').locator('option').filter({hasText:'dbt.customer_mart · dataset'}).last();
  await page.getByLabel('Graph asset').selectOption((await latestDbtAsset.getAttribute('value'))!);
  const accept=page.getByRole('button',{name:'Accept assertion'}).first();
  await expect(accept).toBeVisible();
  await accept.click();
  await expect(page.getByRole('status')).toContainText('Assertion accepted; its verification status is unchanged.');
  const reviewed=page.locator('.assertion-row').filter({hasText:'accepted'}).first();
  await expect(reviewed.getByText('Verification: unverified')).toBeVisible();
});
